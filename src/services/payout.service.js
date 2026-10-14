'use strict';

/**
 * Withdrawals: an earner's available balance, paid out to her UPI ID.
 *
 * The life of one:
 *
 *   requested ──submit──▶ processing ──webhook──▶ paid
 *       │                     │
 *       │                     └──webhook──▶ failed / reversed  (money back)
 *       └──admin──▶ paid (manual) / failed (rejected, money back)
 *
 * **The money moves once, up front.** Requesting takes the amount out of her
 * available balance in the same database transaction that records the
 * withdrawal and its ledger row — a conditional decrement, so two taps cannot
 * both spend the same rupees. Every later step only ever *returns* it (a
 * failure, a reversal, a rejection), and only once: each status change is a
 * guarded update from the states it is allowed to leave, so a webhook
 * delivered twice, or racing an admin, changes nothing the second time.
 *
 * **RazorpayX is never asked twice.** The payout is created with the
 * withdrawal's own id as its idempotency key, so a retry after a timeout gets
 * back the payout already made rather than paying again.
 */

const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const env = require('../config/env');
const fieldCrypto = require('../utils/fieldCrypto');
const { errors } = require('../utils/errors');
const activity = require('./activity.service');
const notificationService = require('./notification.service');
const { emitToUser } = require('../sockets/bus');
const razorpayx = require('./payouts/razorpayx.client');

/** States a withdrawal can still move on from. */
const OPEN = ['requested', 'processing'];

function money(n) {
  return Number(Number(n).toFixed(2));
}

function upiHash(upiId) {
  return crypto.createHash('sha256').update(String(upiId).trim().toLowerCase()).digest('hex');
}

// ── Requesting ──────────────────────────────────────────────────────────────

/**
 * Takes [amount] (or everything available) out of her available balance and
 * records the withdrawal, then hands it to RazorpayX when payouts are
 * automatic. Answers as soon as it is recorded; whether the payout itself
 * succeeds arrives later, by webhook, as a notification and a ledger update.
 */
async function requestWithdrawal(user, { amount } = {}) {
  const walletService = require('./wallet.service');
  if (!user.profile?.isEarner) throw errors.notAnEarnerAccount();
  if (!user.profile?.isVerified) throw errors.withdrawalRequiresVerification();

  await walletService.releaseMaturedEarnings(user.id);
  const wallet = await walletService.getOrCreateWallet(user.id);
  if (!wallet.payoutUpiId) throw errors.withdrawalRequiresUpiAccount();

  const available = money(wallet.availableBalance);
  const requested = money(amount ?? available);
  if (requested < env.economy.minWithdrawalInr) {
    throw errors.withdrawalBelowMinimum(env.economy.minWithdrawalInr);
  }
  if (requested > available) {
    throw errors.badRequest('That is more than your available balance.', {
      available,
      requested,
    });
  }

  // One open withdrawal at a time: a second request while one is still on
  // its way is almost always a double tap, and refusing it keeps her history
  // readable and the payout queue honest.
  const open = await prisma.withdrawal.findFirst({
    where: { userId: user.id, status: { in: OPEN } },
    select: { id: true },
  });
  if (open) {
    throw errors.conflict(
      'A withdrawal is already on its way. You can request another once it arrives.',
      'WITHDRAWAL_IN_PROGRESS'
    );
  }

  const upiMasked = fieldCrypto.maskUpi(fieldCrypto.open(wallet.payoutUpiId));
  const provider = env.payouts.provider;

  const withdrawal = await prisma.$transaction(async (tx) => {
    const { count } = await tx.wallet.updateMany({
      where: { userId: user.id, availableBalance: { gte: requested } },
      data: { availableBalance: { decrement: requested } },
    });
    if (count === 0) throw errors.badRequest('That is more than your available balance.');

    const created = await tx.withdrawal.create({
      data: { userId: user.id, amount: requested, upiMasked, provider, status: 'requested' },
    });
    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        kind: 'withdrawal',
        status: 'pending',
        title: 'Withdrawal requested',
        subtitle: `To ${upiMasked} • usually within minutes`,
        rupeeDelta: -requested,
        referenceId: created.id,
      },
    });
    return tx.withdrawal.update({
      where: { id: created.id },
      data: { transactionId: transaction.id },
      include: { user: { include: { profile: true } } },
    });
  });

  activity.record({
    userId: user.id,
    type: 'wallet_activity',
    relatedEntityId: withdrawal.id,
    description: `Requested a withdrawal of ₹${requested}`,
    metadata: { kind: 'withdrawal', amount_inr: requested, provider },
    status: 'pending',
  });
  emitToUser(user.id, 'wallet:updated', {});

  if (provider === 'razorpayx') {
    // Answered either way: a payout that could not be created yet stays
    // `requested` for a retry, with her money held, not lost.
    await submit(withdrawal.id).catch((err) =>
      console.error(`[payouts] could not submit ${withdrawal.id}`, err.message)
    );
  }

  const transaction = await prisma.walletTransaction.findUnique({
    where: { id: withdrawal.transactionId },
  });
  return { withdrawal: await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } }), transaction, amount: requested };
}

// ── Sending (RazorpayX) ─────────────────────────────────────────────────────

/**
 * The contact and UPI fund account to pay her through — made once and kept on
 * her wallet, made again only if she has linked a different UPI ID since.
 */
async function ensureFundAccount(userId) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    include: { user: { include: { profile: true } } },
  });
  const upiId = fieldCrypto.open(wallet.payoutUpiId);
  const hash = upiHash(upiId);
  if (wallet.payoutFundAccountId && wallet.payoutFundAccountFor === hash) {
    return wallet.payoutFundAccountId;
  }

  let contactId = wallet.payoutContactId;
  if (!contactId) {
    const contact = await razorpayx.createContact({
      name: wallet.user?.profile?.name,
      userId,
    });
    contactId = contact.id;
  }
  const fundAccount = await razorpayx.createUpiFundAccount({ contactId, upiId });
  await prisma.wallet.update({
    where: { userId },
    data: {
      payoutContactId: contactId,
      payoutFundAccountId: fundAccount.id,
      payoutFundAccountFor: hash,
    },
  });
  return fundAccount.id;
}

/**
 * Creates the RazorpayX payout for a `requested` withdrawal and moves it to
 * `processing`. A definite refusal (a bad UPI ID, say) fails it and returns
 * her money; anything uncertain leaves it `requested` to be retried.
 */
async function submit(withdrawalId) {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal || withdrawal.status !== 'requested') return withdrawal;

  try {
    const fundAccountId = await ensureFundAccount(withdrawal.userId);
    const payout = await razorpayx.createPayout({
      fundAccountId,
      amountInr: withdrawal.amount,
      withdrawalId: withdrawal.id,
    });
    await prisma.withdrawal.updateMany({
      where: { id: withdrawal.id, status: 'requested' },
      data: {
        status: 'processing',
        provider: 'razorpayx',
        providerPayoutId: payout.id,
        failureReason: null,
      },
    });
    // RazorpayX can answer with a payout already settled (a retry of one
    // that went through) — apply what it says straight away.
    await applyPayoutState(payout);
  } catch (err) {
    if (err instanceof razorpayx.RazorpayXError && err.isDefinite) {
      await fail(withdrawal.id, {
        status: 'failed',
        reason: err.message || 'The payout was refused.',
      });
    } else {
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { failureReason: `Not sent yet: ${err.message}` },
      });
      throw err;
    }
  }
  return prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
}

// ── Results ─────────────────────────────────────────────────────────────────

/** Marks it paid: the ledger row completes, she is told, earnings settle. */
async function markPaid(withdrawalId, { utr } = {}) {
  const now = new Date();
  const { count } = await prisma.withdrawal.updateMany({
    where: { id: withdrawalId, status: { in: OPEN } },
    data: { status: 'paid', utr: utr ?? null, processedAt: now, failureReason: null },
  });
  if (count === 0) return false;

  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (withdrawal.transactionId) {
    await prisma.walletTransaction.update({
      where: { id: withdrawal.transactionId },
      data: {
        status: 'completed',
        title: 'Withdrawn',
        subtitle: `To ${withdrawal.upiMasked}${utr ? ` • UTR ${utr}` : ''}`,
      },
    });
  }
  await settleEarnings(withdrawal.userId, Number(withdrawal.amount));

  await notificationService.notify({
    userId: withdrawal.userId,
    kind: 'transaction',
    title: 'Withdrawal paid',
    body: `₹${money(withdrawal.amount)} has been sent to ${withdrawal.upiMasked}.`,
    data: { withdrawal_id: withdrawal.id, amount: money(withdrawal.amount), utr: utr ?? null },
  });
  emitToUser(withdrawal.userId, 'wallet:updated', {});
  activity.record({
    userId: withdrawal.userId,
    type: 'wallet_activity',
    relatedEntityId: withdrawal.id,
    description: `Withdrawal of ₹${money(withdrawal.amount)} paid`,
    metadata: { kind: 'withdrawal_paid', amount_inr: money(withdrawal.amount), utr: utr ?? null },
    status: 'completed',
  });
  return true;
}

/**
 * Fails (or reverses) it and puts the money back in her available balance —
 * once. A `paid` withdrawal can still be `reversed` (the bank returned it),
 * which returns the money too.
 */
async function fail(withdrawalId, { status = 'failed', reason } = {}) {
  const from = status === 'reversed' ? [...OPEN, 'paid'] : OPEN;
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal || !from.includes(withdrawal.status)) return false;

  const refunded = await prisma.$transaction(async (tx) => {
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: { in: from } },
      data: { status, failureReason: reason ?? null, processedAt: new Date() },
    });
    if (count === 0) return false;
    await tx.wallet.update({
      where: { userId: withdrawal.userId },
      data: { availableBalance: { increment: Number(withdrawal.amount) } },
    });
    if (withdrawal.transactionId) {
      await tx.walletTransaction.update({
        where: { id: withdrawal.transactionId },
        data: {
          status: 'failed',
          title: status === 'reversed' ? 'Withdrawal reversed' : 'Withdrawal failed',
          subtitle: 'Returned to your balance',
        },
      });
    }
    return true;
  });
  if (!refunded) return false;

  await notificationService.notify({
    userId: withdrawal.userId,
    kind: 'transaction',
    title: status === 'reversed' ? 'Withdrawal reversed' : 'Withdrawal failed',
    body:
      `₹${money(withdrawal.amount)} is back in your available balance. ` +
      'Check your UPI ID and try again.',
    data: { withdrawal_id: withdrawal.id, amount: money(withdrawal.amount) },
  });
  emitToUser(withdrawal.userId, 'wallet:updated', {});
  activity.record({
    userId: withdrawal.userId,
    type: 'wallet_activity',
    relatedEntityId: withdrawal.id,
    description: `Withdrawal of ₹${money(withdrawal.amount)} ${status}`,
    metadata: { kind: `withdrawal_${status}`, reason: reason ?? null },
    status: 'failed',
  });
  return true;
}

/**
 * Marks her oldest available earnings `withdrawn`, up to [amount] — so a
 * partial withdrawal settles only what it paid, not everything she had.
 */
async function settleEarnings(userId, amount) {
  const rows = await prisma.earning.findMany({
    where: { userId, status: 'available' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, amount: true },
  });
  const ids = [];
  let left = amount + 0.001;
  for (const row of rows) {
    if (Number(row.amount) > left) break;
    left -= Number(row.amount);
    ids.push(row.id);
  }
  if (ids.length) {
    await prisma.earning.updateMany({ where: { id: { in: ids } }, data: { status: 'withdrawn' } });
  }
}

/** Applies a RazorpayX payout entity's status to its withdrawal. */
async function applyPayoutState(payout) {
  if (!payout?.id) return;
  const withdrawal = await prisma.withdrawal.findFirst({
    where: {
      OR: [{ providerPayoutId: payout.id }, ...(payout.reference_id ? [{ id: payout.reference_id }] : [])],
    },
  });
  if (!withdrawal) return;
  if (!withdrawal.providerPayoutId) {
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { providerPayoutId: payout.id },
    });
  }
  const reason = payout.status_details?.description || payout.failure_reason || null;
  switch (payout.status) {
    case 'processed':
      await markPaid(withdrawal.id, { utr: payout.utr });
      break;
    case 'reversed':
      await fail(withdrawal.id, { status: 'reversed', reason });
      break;
    case 'failed':
    case 'rejected':
    case 'cancelled':
      await fail(withdrawal.id, { status: 'failed', reason });
      break;
    default:
      // queued, pending, processing — on its way.
      await prisma.withdrawal.updateMany({
        where: { id: withdrawal.id, status: 'requested' },
        data: { status: 'processing' },
      });
  }
}

/**
 * A RazorpayX webhook, already verified. Payout events carry the payout
 * entity; everything else is ignored.
 */
async function handleRazorpayxEvent(event) {
  const payout = event?.payload?.payout?.entity;
  if (!payout || !String(event.event || '').startsWith('payout.')) return;
  await applyPayoutState(payout);
}

// ── Admin ───────────────────────────────────────────────────────────────────

async function list({ status, skip = 0, take = 50 } = {}) {
  const allowed = ['requested', 'processing', 'paid', 'failed', 'reversed'];
  const where = allowed.includes(status) ? { status } : {};
  const [rows, total] = await Promise.all([
    prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { user: { include: { profile: true } } },
    }),
    prisma.withdrawal.count({ where }),
  ]);
  return { rows, total };
}

/** Sends a `requested` withdrawal again — for one that could not be sent. */
async function retry(withdrawalId) {
  if (env.payouts.provider !== 'razorpayx') {
    throw errors.badRequest('Payouts are manual — mark it paid once you have sent it.');
  }
  return submit(withdrawalId);
}

/**
 * Brings open withdrawals up to date with RazorpayX — a webhook that never
 * arrived is caught here. Run periodically.
 */
async function reconcile() {
  if (env.payouts.provider !== 'razorpayx') return 0;
  const open = await prisma.withdrawal.findMany({
    where: { status: { in: OPEN } },
    take: 200,
  });
  let changed = 0;
  for (const w of open) {
    try {
      if (w.providerPayoutId) {
        await applyPayoutState(await razorpayx.fetchPayout(w.providerPayoutId));
      } else if (Date.now() - w.createdAt.getTime() > 60_000) {
        // Never got out of the door — try again.
        await submit(w.id);
      }
      changed++;
    } catch (err) {
      console.error(`[payouts] reconcile ${w.id} failed`, err.message);
    }
  }
  return changed;
}

module.exports = {
  requestWithdrawal,
  submit,
  markPaid,
  fail,
  applyPayoutState,
  handleRazorpayxEvent,
  list,
  retry,
  reconcile,
};
