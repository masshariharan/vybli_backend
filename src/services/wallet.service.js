'use strict';

const prisma = require('../config/prisma');
const env = require('../config/env');
const activity = require('./activity.service');
const { errors } = require('../utils/errors');
const notificationService = require('./notification.service');
const playBillingService = require('./play_billing.service');
const { emitToUser } = require('../sockets/bus');

/**
 * Money.
 *
 * One currency throughout: plain rupees. Callers spend from their wallet
 * balance, earners accrue rupees the same way. Both live on one wallet row so
 * a call can debit one figure and credit the other atomically.
 *
 * Three rules hold everywhere in this file:
 *
 *  1. **The client never supplies an amount.** It names a package or a call;
 *     the server prices it. An endpoint that accepted `amount` would be a
 *     free-money endpoint.
 *  2. **Every balance change writes a ledger row** in the same transaction, so
 *     a balance can always be explained by the rows behind it.
 *  3. **Debits are conditional updates.** Spending uses `balance: { gte: n }`
 *     in the WHERE clause rather than read-then-write, so two calls billing
 *     at once cannot both pass a check and drive the balance negative.
 */

async function getOrCreateWallet(userId) {
  return (
    (await prisma.wallet.findUnique({ where: { userId } })) ??
    prisma.wallet.create({ data: { userId } })
  );
}

async function getSummary(userId) {
  const wallet = await getOrCreateWallet(userId);
  // Rolling matured earnings forward on read means a pending balance becomes
  // available without a scheduler running.
  await releaseMaturedEarnings(userId);
  return prisma.wallet.findUnique({ where: { userId } }) ?? wallet;
}

function getBalance(userId) {
  return prisma.wallet
    .findUnique({ where: { userId }, select: { balance: true } })
    .then((w) => Number(w?.balance ?? 0));
}

/**
 * Charges an amount, or fails.
 *
 * The guard is in the WHERE clause: `updateMany` with `balance: { gte: amount
 * }` touches zero rows when the balance is short, and Postgres serialises the
 * two updates if a second call tries to bill at the same instant. Reading the
 * balance and then writing it back would let both pass.
 */
async function spend({
  userId,
  amount,
  title,
  subtitle = '',
  referenceId = null,
  tx = prisma,
}) {
  if (amount <= 0) return { charged: 0, balance: await getBalance(userId) };

  const { count } = await tx.wallet.updateMany({
    where: { userId, balance: { gte: amount } },
    data: { balance: { decrement: amount } },
  });

  if (count === 0) {
    const balance = await tx.wallet
      .findUnique({ where: { userId }, select: { balance: true } })
      .then((w) => Number(w?.balance ?? 0));
    throw errors.insufficientBalance(amount, balance);
  }

  const wallet = await tx.wallet.findUnique({ where: { userId } });

  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      kind: 'call',
      status: 'completed',
      title,
      subtitle,
      rupeeDelta: -amount,
      referenceId,
    },
  });

  return { charged: amount, balance: Number(wallet.balance) };
}

/** Credits the wallet balance — a purchase or a bonus. */
async function creditBalance({
  userId,
  amount,
  kind = 'purchase',
  title,
  subtitle = '',
  referenceId = null,
  purchaseToken = null,
  tx = prisma,
}) {
  const wallet = await tx.wallet.upsert({
    where: { userId },
    create: { userId, balance: amount },
    update: { balance: { increment: amount } },
  });

  await tx.walletTransaction.create({
    data: {
      walletId: wallet.id,
      kind,
      status: 'completed',
      title,
      subtitle,
      rupeeDelta: amount,
      referenceId,
      purchaseToken,
    },
  });

  return wallet;
}

// ── Purchases ───────────────────────────────────────────────────────────────

function listPackages() {
  return prisma.rechargePackage.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { priceInr: 'asc' }],
  });
}

function listVipPlans() {
  return prisma.vipPlan.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { days: 'asc' }],
  });
}

/**
 * Buys a recharge package.
 *
 * **The price and the bonus come from the database, never from the
 * request.** That is the part that has to be true whoever takes the money.
 * The wallet balance is credited `priceInr + bonusInr` — there is no separate
 * "quantity" any more, since what is paid and what is credited are the same
 * unit.
 *
 * Who takes it is `env.payments.provider`, and there are exactly three
 * honest behaviours here:
 *
 *  * **Google Play Billing** verifies `purchaseToken` against the Play
 *    Developer API before crediting anything — see
 *    {@link verifyOrReplayGooglePlayPurchase}. Unlike the collection flow
 *    this replaced, there is no order-then-webhook round trip: the Play
 *    Billing SDK already did the collecting on-device, and this call either
 *    proves that happened or it does not.
 *  * **Development**, with no provider configured, credits the wallet
 *    directly so the wallet and ledger screens have something real to
 *    render. The transaction says so in words — `subtitle` carries "no
 *    payment taken" — because a ledger row that reads like a purchase, for
 *    money nobody paid, is the kind of record somebody later reconciles
 *    against a bank statement.
 *  * **Production with no provider refuses.** It cannot reach here at all:
 *    `env` will not let the process boot without `PAYMENT_PROVIDER`. The
 *    guard stays anyway, because the previous version of this function was
 *    an authenticated HTTP endpoint that credited money for free, and that
 *    is not a mistake worth being able to make twice.
 */
async function purchase(user, { packageId, purchaseToken }) {
  const pkg = await prisma.rechargePackage.findUnique({ where: { id: packageId } });
  if (!pkg || !pkg.isActive) throw errors.notFound('Package', 'PACKAGE_NOT_FOUND');

  if (env.payments.provider === 'google_play') {
    const totalCredit = Number(pkg.priceInr) + Number(pkg.bonusInr);
    const { wallet: updated, alreadyProcessed } = await verifyOrReplayGooglePlayPurchase({
      userId: user.id,
      productId: pkg.id,
      purchaseToken,
      amount: totalCredit,
      title: `₹${pkg.priceInr} recharge`,
      subtitle: 'Google Play',
      referenceId: pkg.id,
    });

    if (!alreadyProcessed) {
      await notificationService.notify({
        userId: user.id,
        kind: 'wallet',
        title: 'Money added',
        body: `₹${totalCredit} is now in your wallet.`,
        data: { package_id: pkg.id, amount: totalCredit },
      });
      emitToUser(user.id, 'wallet:updated', { balance: Number(updated.balance) });
      activity.record({
        userId: user.id,
        type: 'transaction',
        relatedEntityId: pkg.id,
        description: `Recharged ₹${totalCredit} for ₹${pkg.priceInr}`,
        metadata: {
          kind: 'purchase',
          amount: totalCredit,
          amount_inr: Number(pkg.priceInr),
          method: 'google_play',
        },
        status: 'completed',
      });
    }

    return {
      requiresPayment: false,
      wallet: updated,
      package: pkg,
      amountAdded: totalCredit,
      reference: `VYB${Date.now().toString().slice(-8)}`,
    };
  }

  if (!env.payments.creditsWithoutPayment) {
    throw errors.paymentsUnavailable();
  }

  await getOrCreateWallet(user.id);
  const totalCredit = Number(pkg.priceInr) + Number(pkg.bonusInr);

  const updated = await prisma.$transaction(async (tx) =>
    creditBalance({
      userId: user.id,
      amount: totalCredit,
      kind: 'purchase',
      title: `₹${pkg.priceInr} recharge`,
      subtitle: `no payment taken (${env.payments.provider})`,
      referenceId: pkg.id,
      tx,
    })
  );

  await notificationService.notify({
    userId: user.id,
    kind: 'wallet',
    title: 'Money added',
    body: `₹${totalCredit} is now in your wallet.`,
    data: { package_id: pkg.id, amount: totalCredit },
  });

  emitToUser(user.id, 'wallet:updated', { balance: Number(updated.balance) });

  activity.record({
    userId: user.id,
    type: 'transaction',
    relatedEntityId: pkg.id,
    description: `Recharged ₹${totalCredit} for ₹${pkg.priceInr}`,
    metadata: {
      kind: 'purchase',
      amount: totalCredit,
      amount_inr: Number(pkg.priceInr),
      method: env.payments.provider,
    },
    status: 'completed',
  });

  return {
    requiresPayment: false,
    wallet: updated,
    package: pkg,
    amountAdded: totalCredit,
    reference: `VYB${Date.now().toString().slice(-8)}`,
  };
}

/**
 * Buys a VIP plan.
 *
 * Same shape and the same three-way split as `purchase` — see its doc
 * comment. The one difference from a recharge: membership stacks on top of
 * whatever is left rather than resetting from today, so buying a second plan
 * while the first is still running extends it instead of throwing days away.
 * The stacking math is computed once, immediately before the credit — unlike
 * the old order-then-webhook design, verification is synchronous now, so
 * there is only one moment this ever runs, not two to keep in sync.
 */
async function purchaseVip(user, { planId, purchaseToken }) {
  const plan = await prisma.vipPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) throw errors.notFound('Plan', 'PLAN_NOT_FOUND');

  if (env.payments.provider === 'google_play') {
    const bonus = Number(plan.bonusInr);
    const { wallet: updated, expiresAt, alreadyProcessed } = await verifyOrReplayGooglePlayVip({
      userId: user.id,
      productId: plan.id,
      purchaseToken,
      plan,
    });

    if (!alreadyProcessed) {
      await notificationService.notify({
        userId: user.id,
        kind: 'wallet',
        title: "You're a VIP now",
        body: `Free chat and ₹${bonus} bonus until ${expiresAt.toDateString()}.`,
        data: { plan_id: plan.id, vip_expires_at: expiresAt.toISOString() },
      });
      emitToUser(user.id, 'wallet:updated', {
        balance: Number(updated.balance),
        vip_expires_at: expiresAt.toISOString(),
      });
      activity.record({
        userId: user.id,
        type: 'transaction',
        relatedEntityId: plan.id,
        description: `Bought VIP (${plan.days} days) for ₹${plan.priceInr}`,
        metadata: {
          kind: 'vipPurchase',
          days: plan.days,
          bonus_inr: bonus,
          amount_inr: Number(plan.priceInr),
          method: 'google_play',
        },
        status: 'completed',
      });
    }

    return { requiresPayment: false, wallet: updated, plan, expiresAt };
  }

  if (!env.payments.creditsWithoutPayment) {
    throw errors.paymentsUnavailable();
  }

  const wallet = await getOrCreateWallet(user.id);
  const now = new Date();
  const base = wallet.vipExpiresAt && wallet.vipExpiresAt > now ? wallet.vipExpiresAt : now;
  const expiresAt = new Date(base.getTime() + plan.days * 86_400_000);
  const bonus = Number(plan.bonusInr);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { userId: user.id },
      data: { vipExpiresAt: expiresAt },
    });
    return creditBalance({
      userId: user.id,
      amount: bonus,
      kind: 'purchase',
      title: 'VIP membership',
      subtitle: `no payment taken (${env.payments.provider})`,
      referenceId: plan.id,
      tx,
    });
  });

  await notificationService.notify({
    userId: user.id,
    kind: 'wallet',
    title: "You're a VIP now",
    body: `Free chat and ₹${bonus} bonus until ${expiresAt.toDateString()}.`,
    data: { plan_id: plan.id, vip_expires_at: expiresAt.toISOString() },
  });

  emitToUser(user.id, 'wallet:updated', {
    balance: Number(updated.balance),
    vip_expires_at: expiresAt.toISOString(),
  });

  activity.record({
    userId: user.id,
    type: 'transaction',
    relatedEntityId: plan.id,
    description: `Bought VIP (${plan.days} days) for ₹${plan.priceInr}`,
    metadata: {
      kind: 'vipPurchase',
      days: plan.days,
      bonus_inr: bonus,
      amount_inr: Number(plan.priceInr),
      method: env.payments.provider,
    },
    status: 'completed',
  });

  return { requiresPayment: false, wallet: updated, plan, expiresAt };
}

// ── Google Play Billing ─────────────────────────────────────────────────────

/**
 * Verifies a Play Billing purchase token and credits a recharge exactly once.
 *
 * Three steps, in this order, none skippable:
 *
 *  1. **Look first.** A `WalletTransaction` already carrying this
 *     `purchaseToken` means this exact purchase was already credited — a
 *     retried request, the app resending after a dropped response. Returning
 *     the current wallet is correct, not a bug, for the same reason a
 *     re-delivered webhook used to no-op under the old design.
 *  2. **Verify against Google**, never against what the client claims it
 *     paid. A cancelled, refunded, or unrecognised token credits nothing.
 *  3. **Credit inside one transaction**, with `purchaseToken` on the ledger
 *     row. If two requests for the same token race past step 1 at once, the
 *     column's unique constraint lets exactly one `create` win — the other
 *     hits `P2002` and is treated the same as "already processed," not as an
 *     error.
 *
 * The purchase is consumed — which also acknowledges it — only after the
 * credit has committed, so a consume failure (logged, not thrown; see
 * `play_billing.service.consumeProductPurchase`) never leaves money credited
 * with no ledger row to explain it.
 */
async function verifyOrReplayGooglePlayPurchase({
  userId,
  productId,
  purchaseToken,
  amount,
  title,
  subtitle,
  referenceId,
}) {
  if (!purchaseToken) throw errors.purchaseTokenRequired();

  const existing = await prisma.walletTransaction.findUnique({ where: { purchaseToken } });
  if (existing) {
    return { wallet: await getOrCreateWallet(userId), alreadyProcessed: true };
  }

  const verified = await playBillingService.verifyProductPurchase({ productId, purchaseToken });
  if (!verified) throw errors.purchaseNotVerified();

  await getOrCreateWallet(userId);

  let wallet;
  try {
    wallet = await prisma.$transaction(async (tx) =>
      creditBalance({ userId, amount, kind: 'purchase', title, subtitle, referenceId, purchaseToken, tx })
    );
  } catch (err) {
    if (err.code === 'P2002') {
      return { wallet: await getOrCreateWallet(userId), alreadyProcessed: true };
    }
    throw err;
  }

  playBillingService.consumeProductPurchase({ productId, purchaseToken }).catch(() => {});

  return { wallet, alreadyProcessed: false };
}

/**
 * Same three-step shape as {@link verifyOrReplayGooglePlayPurchase}, for a VIP
 * plan — the one difference being the `vipExpiresAt` stacking update, which
 * has to commit atomically with the credit: if the ledger insert loses a race
 * (`P2002`), the whole transaction — expiry update included — rolls back with
 * it, so a losing request never partially extends VIP without also crediting
 * the bonus.
 */
async function verifyOrReplayGooglePlayVip({ userId, productId, purchaseToken, plan }) {
  if (!purchaseToken) throw errors.purchaseTokenRequired();

  const existing = await prisma.walletTransaction.findUnique({ where: { purchaseToken } });
  if (existing) {
    const wallet = await getOrCreateWallet(userId);
    return { wallet, expiresAt: wallet.vipExpiresAt, alreadyProcessed: true };
  }

  const verified = await playBillingService.verifyProductPurchase({ productId, purchaseToken });
  if (!verified) throw errors.purchaseNotVerified();

  const before = await getOrCreateWallet(userId);
  const now = new Date();
  const base = before.vipExpiresAt && before.vipExpiresAt > now ? before.vipExpiresAt : now;
  const expiresAt = new Date(base.getTime() + plan.days * 86_400_000);
  const bonus = Number(plan.bonusInr);

  let wallet;
  try {
    wallet = await prisma.$transaction(async (tx) => {
      await tx.wallet.update({ where: { userId }, data: { vipExpiresAt: expiresAt } });
      return creditBalance({
        userId,
        amount: bonus,
        kind: 'purchase',
        title: 'VIP membership',
        subtitle: 'Google Play',
        referenceId: plan.id,
        purchaseToken,
        tx,
      });
    });
  } catch (err) {
    if (err.code === 'P2002') {
      const current = await getOrCreateWallet(userId);
      return { wallet: current, expiresAt: current.vipExpiresAt, alreadyProcessed: true };
    }
    throw err;
  }

  playBillingService.consumeProductPurchase({ productId, purchaseToken }).catch(() => {});

  return { wallet, expiresAt, alreadyProcessed: false };
}

// ── Earnings ────────────────────────────────────────────────────────────────

/**
 * Credits an earner for a finished call.
 *
 * The unique constraint on `Earning.callId` is the duplicate guard — a retried
 * request or a double socket event hits the constraint instead of paying
 * twice, and the catch below treats that as success because the money is
 * already there.
 *
 * Earnings land in `pending` and mature after 48h, which is what the earning
 * screens promise.
 */
async function recordEarning({ userId, callId, amountSpent, minutes, tx = prisma }) {
  if (amountSpent <= 0 || minutes <= 0) return null;

  const amount = Number((amountSpent * env.economy.earnerShare).toFixed(2));
  if (amount <= 0) return null;

  const clearsAt = new Date(Date.now() + env.economy.earningClearHours * 3600_000);

  try {
    const wallet = await tx.wallet.upsert({
      where: { userId },
      create: { userId, totalEarnings: amount, pendingBalance: amount },
      update: {
        totalEarnings: { increment: amount },
        pendingBalance: { increment: amount },
      },
    });

    const earning = await tx.earning.create({
      data: {
        userId,
        callId,
        amount,
        minutes,
        ratePerMinute: Number((amount / minutes).toFixed(2)),
        status: 'pending',
        clearsAt,
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        kind: 'earning',
        status: 'pending',
        title: 'Call earnings',
        subtitle: `${minutes} min • clears in ${env.economy.earningClearHours} hrs`,
        rupeeDelta: amount,
        referenceId: callId,
      },
    });

    activity.record({
      userId,
      type: 'earning',
      relatedEntityId: callId,
      description: `Earned ₹${amount} from a ${minutes} min call`,
      metadata: {
        amount_inr: amount,
        minutes,
        amount_spent: amountSpent,
        clears_at: clearsAt.toISOString(),
      },
      status: 'pending',
    });

    return earning;
  } catch (err) {
    // P2002 — an earning for this call already exists. Not a failure: the
    // money was credited by whichever attempt got there first.
    if (err.code === 'P2002') return null;
    throw err;
  }
}

/**
 * Moves matured earnings from pending to available.
 *
 * Called on read rather than by a cron, so a deployment without a scheduler
 * still behaves correctly. Idempotent — only rows still marked `pending` move.
 */
async function releaseMaturedEarnings(userId) {
  const matured = await prisma.earning.findMany({
    where: { userId, status: 'pending', clearsAt: { lte: new Date() } },
    select: { id: true, amount: true, callId: true },
  });
  if (matured.length === 0) return 0;

  const total = matured.reduce((sum, e) => sum + Number(e.amount), 0);
  const ids = matured.map((e) => e.id);
  // Ledger rows reference the call, not the earning, so they are settled by
  // call id.
  const callIds = matured.map((e) => e.callId);

  await prisma.$transaction([
    prisma.earning.updateMany({
      where: { id: { in: ids } },
      data: { status: 'available' },
    }),
    prisma.wallet.update({
      where: { userId },
      data: {
        pendingBalance: { decrement: total },
        availableBalance: { increment: total },
      },
    }),
    prisma.walletTransaction.updateMany({
      where: {
        wallet: { userId },
        kind: 'earning',
        status: 'pending',
        referenceId: { in: callIds },
      },
      data: { status: 'completed' },
    }),
  ]);

  return total;
}

/** Whether a wallet has a payable account. */
function hasLinkedUpiAccount(wallet) {
  return Boolean(wallet.payoutUpiId);
}

/** The linked UPI account. */
async function getUpiAccount(userId) {
  const wallet = await getOrCreateWallet(userId);
  if (!hasLinkedUpiAccount(wallet)) return { linked: false };
  return {
    linked: true,
    upiId: wallet.payoutUpiId,
  };
}

/**
 * Links (or replaces) the payout UPI ID.
 *
 * Replacing rather than appending: a person has exactly one UPI ID money
 * goes to, not a list to manage, and a stale second ID left over from
 * a typo has no way to become "the" ID again.
 */
async function setUpiAccount(userId, { upiId }) {
  await prisma.wallet.upsert({
    where: { userId },
    create: {
      userId,
      payoutUpiId: upiId,
    },
    update: {
      payoutUpiId: upiId,
    },
  });
  activity.record({
    userId,
    type: 'wallet_activity',
    description: 'Linked a payout UPI ID',
    metadata: { kind: 'upi_account_linked' },
  });
  return getUpiAccount(userId);
}

/**
 * Withdraws the available balance.
 *
 * Debited conditionally, like a call spend — `availableBalance: { gte: amount }`
 * so two withdrawal taps cannot both succeed.
 */
async function withdraw(user, { amount } = {}) {
  if (!user.profile?.isEarner) throw errors.notAnEarnerAccount();
  if (!user.profile?.isVerified) throw errors.withdrawalRequiresVerification();

  await releaseMaturedEarnings(user.id);
  const wallet = await getOrCreateWallet(user.id);
  if (!hasLinkedUpiAccount(wallet)) throw errors.withdrawalRequiresUpiAccount();

  const available = Number(wallet.availableBalance);
  const requested = amount ?? available;

  if (requested < env.economy.minWithdrawalInr) {
    throw errors.withdrawalBelowMinimum(env.economy.minWithdrawalInr);
  }
  if (requested > available) {
    throw errors.badRequest('That is more than your available balance.', {
      available,
      requested,
    });
  }

  const { count } = await prisma.wallet.updateMany({
    where: { userId: user.id, availableBalance: { gte: requested } },
    data: { availableBalance: { decrement: requested } },
  });
  if (count === 0) throw errors.badRequest('That is more than your available balance.');

  const transaction = await prisma.walletTransaction.create({
    data: {
      walletId: wallet.id,
      kind: 'withdrawal',
      // Pending until a real payout provider confirms it.
      status: 'pending',
      title: 'Withdrawal requested',
      subtitle: `To ${wallet.payoutUpiId} • 1–2 business days`,
      rupeeDelta: -requested,
    },
  });

  await prisma.earning.updateMany({
    where: { userId: user.id, status: 'available' },
    data: { status: 'withdrawn' },
  });

  await notificationService.notify({
    userId: user.id,
    kind: 'transaction',
    title: 'Withdrawal requested',
    body: `₹${requested} is on its way to ${wallet.payoutUpiId}.`,
    data: { transaction_id: transaction.id, amount: requested },
  });

  activity.record({
    userId: user.id,
    type: 'wallet_activity',
    relatedEntityId: transaction.id,
    description: `Requested a withdrawal of ₹${requested}`,
    metadata: { kind: 'withdrawal', amount_inr: requested },
    status: 'pending',
  });

  return { transaction, amount: requested };
}

// ── Ledger ──────────────────────────────────────────────────────────────────

/**
 * Transaction history.
 *
 * A friends account never earns or withdraws, so those kinds are filtered out
 * for them — an "Earnings +₹120" row on a wallet with no earnings panel is a
 * contradiction the client had to work around before.
 */
async function listTransactions(user, { kind, skip, take }) {
  const wallet = await getOrCreateWallet(user.id);
  const where = { walletId: wallet.id };

  if (kind) {
    where.kind = kind === 'purchase' ? { in: ['purchase', 'bonus'] } : kind;
  } else if (!user.profile?.isEarner) {
    where.kind = { notIn: ['earning', 'withdrawal'] };
  }

  const [rows, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  return { rows, total };
}

function listEarnings(userId, { skip, take }) {
  return Promise.all([
    prisma.earning.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.earning.count({ where: { userId } }),
  ]).then(([rows, total]) => ({ rows, total }));
}

module.exports = {
  getOrCreateWallet,
  getSummary,
  getBalance,
  spend,
  creditBalance,
  listPackages,
  purchase,
  listVipPlans,
  purchaseVip,
  recordEarning,
  releaseMaturedEarnings,
  withdraw,
  listTransactions,
  listEarnings,
  getUpiAccount,
  setUpiAccount,
};
