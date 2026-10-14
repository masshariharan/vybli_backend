'use strict';

/**
 * The money paths that move rupees without a call in between: earnings
 * maturing, withdrawals and their payouts (manual and RazorpayX), the
 * RazorpayX webhook signature, paid-message earnings and spend, and Google
 * Play refunds being taken back.
 *
 * Runs the real services against the local database. RazorpayX and Google
 * Play are replaced by stand-ins, so nothing here talks to a payment API.
 * Every account it makes is deleted at the end.
 *
 *   npm run test:payments
 */

require('dotenv').config();

const crypto = require('node:crypto');
const prisma = require('../src/config/prisma');
const env = require('../src/config/env');
const walletService = require('../src/services/wallet.service');
const payoutService = require('../src/services/payout.service');
const playBilling = require('../src/services/play_billing.service');
const razorpayx = require('../src/services/payouts/razorpayx.client');
const pricing = require('../src/services/pricing.service');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}
async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}
const num = (d) => Number(d);

const made = [];
const tag = crypto.randomBytes(3).toString('hex');

async function makeUser({ earner = true, verified = true, name = 'Asha' } = {}) {
  const user = await prisma.user.create({
    data: {
      phone: `90${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      profile: {
        create: {
          name: `${name} ${tag}`,
          age: 24,
          gender: earner ? 'female' : 'male',
          isEarner: earner,
          isVerified: verified,
        },
      },
    },
    include: { profile: true },
  });
  made.push(user.id);
  await walletService.getOrCreateWallet(user.id);
  return user;
}

async function wallet(userId) {
  return prisma.wallet.findUnique({ where: { userId } });
}

/** Gives her [amount] of matured, available earnings — the state a withdrawal starts from. */
async function giveAvailable(userId, amounts) {
  for (const amount of amounts) {
    await prisma.earning.create({
      data: {
        userId,
        amount,
        ratePerMinute: 0,
        minutes: 0,
        status: 'available',
        clearsAt: new Date(Date.now() - 1000),
      },
    });
  }
  const total = amounts.reduce((a, b) => a + b, 0);
  await prisma.wallet.update({
    where: { userId },
    data: { availableBalance: { increment: total }, totalEarnings: { increment: total } },
  });
}

// ── Stand-ins for the payment providers ─────────────────────────────────────

const rx = { contacts: 0, fundAccounts: 0, payouts: new Map(), next: null };
const realRx = { ...razorpayx };
function fakeRazorpayX() {
  razorpayx.createContact = async () => {
    rx.contacts += 1;
    return { id: `cont_${rx.contacts}` };
  };
  razorpayx.createUpiFundAccount = async () => {
    rx.fundAccounts += 1;
    return { id: `fa_${rx.fundAccounts}` };
  };
  razorpayx.createPayout = async ({ amountInr, withdrawalId }) => {
    if (rx.next) {
      const err = rx.next;
      rx.next = null;
      throw err;
    }
    // Idempotent on the withdrawal, as the real API is on its key.
    if (!rx.payouts.has(withdrawalId)) {
      rx.payouts.set(withdrawalId, {
        id: `pout_${rx.payouts.size + 1}_${tag}`,
        reference_id: withdrawalId,
        amount: Math.round(Number(amountInr) * 100),
        status: 'queued',
      });
    }
    return rx.payouts.get(withdrawalId);
  };
}
function restoreRazorpayX() {
  Object.assign(razorpayx, realRx);
}

const realListVoided = playBilling.listVoidedPurchases;

// ── The suites ──────────────────────────────────────────────────────────────

async function maturing() {
  section('Earnings maturing');
  const her = await makeUser();
  const past = new Date(Date.now() - 60_000);
  for (const [amount, callId] of [[60, null], [40, null]]) {
    const e = await prisma.earning.create({
      data: { userId: her.id, callId, amount, ratePerMinute: 0, minutes: 0, status: 'pending', clearsAt: past },
    });
    await prisma.walletTransaction.create({
      data: {
        walletId: (await wallet(her.id)).id,
        kind: 'earning',
        status: 'pending',
        title: 'Chat earnings',
        rupeeDelta: amount,
        referenceId: e.id,
      },
    });
  }
  // One not yet due — must stay where it is.
  await prisma.earning.create({
    data: {
      userId: her.id,
      amount: 25,
      ratePerMinute: 0,
      minutes: 0,
      status: 'pending',
      clearsAt: new Date(Date.now() + 3_600_000),
    },
  });
  await prisma.wallet.update({ where: { userId: her.id }, data: { pendingBalance: 125, totalEarnings: 125 } });

  // The app reads the wallet and its history together; each read releases.
  const results = await Promise.all(
    Array.from({ length: 6 }, () => walletService.releaseMaturedEarnings(her.id))
  );
  const w = await wallet(her.id);
  check('six concurrent releases credit the matured ₹100 exactly once', num(w.availableBalance) === 100, {
    available: num(w.availableBalance),
    results,
  });
  check('between them they report ₹100 released, not ₹600', results.reduce((a, b) => a + b, 0) === 100, results);
  check('pending keeps only what has not matured', num(w.pendingBalance) === 25, num(w.pendingBalance));
  const rows = await prisma.walletTransaction.findMany({ where: { walletId: w.id, kind: 'earning' } });
  check('their ledger rows are completed', rows.every((r) => r.status === 'completed'), rows.map((r) => r.status));
  check('a second pass releases nothing', (await walletService.releaseMaturedEarnings(her.id)) === 0);
}

async function manualWithdrawals() {
  section('Withdrawals — manual payouts');
  env.payouts.provider = 'manual';
  const min = env.economy.minWithdrawalInr;

  const him = await makeUser({ earner: false, name: 'Ravi' });
  let err = await rejects(payoutService.requestWithdrawal(him, { amount: min }));
  check('a paying account cannot withdraw', err && err.status >= 400, err?.message);

  const unverified = await makeUser({ verified: false });
  err = await rejects(payoutService.requestWithdrawal(unverified, { amount: min }));
  check('an unverified earner cannot withdraw', err && err.status >= 400, err?.message);

  const her = await makeUser();
  await giveAvailable(her.id, [min, min, min / 2]);
  err = await rejects(payoutService.requestWithdrawal(her, { amount: min }));
  check('nobody can withdraw without a UPI ID linked', err && err.status >= 400, err?.message);

  await walletService.setUpiAccount(her.id, { upiId: `asha.${tag}@okaxis` });
  const stored = await wallet(her.id);
  if (env.dataEncryptionKey) {
    check('the UPI ID is not stored in the clear', !String(stored.payoutUpiId).includes('@okaxis'));
  } else {
    console.log('  – DATA_ENCRYPTION_KEY unset here: UPI encryption not checked');
  }
  check('and reads back as entered', (await walletService.getUpiAccount(her.id)).upiId === `asha.${tag}@okaxis`);

  err = await rejects(payoutService.requestWithdrawal(her, { amount: min - 1 }));
  check(`below the ₹${min} minimum is refused`, err && err.status >= 400, err?.message);
  err = await rejects(payoutService.requestWithdrawal(her, { amount: min * 10 }));
  check('more than she has is refused', err && err.status >= 400, err?.message);
  check('and a refusal takes nothing', num((await wallet(her.id)).availableBalance) === min * 2.5);

  const first = await payoutService.requestWithdrawal(her, { amount: min });
  let w = await wallet(her.id);
  check('a withdrawal takes the amount out of her balance at once', num(w.availableBalance) === min * 1.5, num(w.availableBalance));
  check('and waits as `requested`', first.withdrawal.status === 'requested', first.withdrawal.status);
  check('with a pending ledger row for the amount', first.transaction.status === 'pending' && num(first.transaction.rupeeDelta) === -min, first.transaction);
  check('showing only a masked UPI ID', !first.withdrawal.upiMasked.includes(`asha.${tag}`), first.withdrawal.upiMasked);

  err = await rejects(payoutService.requestWithdrawal(her, { amount: min }));
  check('a second one while the first is open is refused', err?.code === 'WITHDRAWAL_IN_PROGRESS' || /already/i.test(err?.message ?? ''), err?.message);

  // Paid: settles her oldest earnings up to the amount.
  check('marking it paid works', await payoutService.markPaid(first.withdrawal.id, { utr: 'UTR123' }));
  check('and only once', !(await payoutService.markPaid(first.withdrawal.id)));
  const paidTx = await prisma.walletTransaction.findUnique({ where: { id: first.withdrawal.transactionId } });
  check('the ledger row completes, with the UTR', paidTx.status === 'completed' && paidTx.subtitle.includes('UTR123'), paidTx);
  const withdrawn = await prisma.earning.findMany({ where: { userId: her.id, status: 'withdrawn' } });
  check('exactly the earnings it paid are settled, oldest first', withdrawn.length === 1 && num(withdrawn[0].amount) === min, withdrawn.map((e) => num(e.amount)));
  check('a paid withdrawal cannot then be "failed"', !(await payoutService.fail(first.withdrawal.id, { status: 'failed' })));

  // The bank returns it: money back, once.
  check('a paid one can be reversed', await payoutService.fail(first.withdrawal.id, { status: 'reversed', reason: 'bank returned' }));
  check('but not twice', !(await payoutService.fail(first.withdrawal.id, { status: 'reversed' })));
  w = await wallet(her.id);
  check('the reversal puts the amount back exactly once', num(w.availableBalance) === min * 2.5, num(w.availableBalance));

  // Rejected by an admin: money back, once.
  const second = await payoutService.requestWithdrawal(her, { amount: min });
  const [r1, r2] = await Promise.all([
    payoutService.fail(second.withdrawal.id, { reason: 'Rejected by Vybli' }),
    payoutService.fail(second.withdrawal.id, { reason: 'Rejected by Vybli' }),
  ]);
  check('two simultaneous rejections refund once', [r1, r2].filter(Boolean).length === 1, [r1, r2]);
  w = await wallet(her.id);
  check('and she has all her money back', num(w.availableBalance) === min * 2.5, num(w.availableBalance));
  const rejTx = await prisma.walletTransaction.findUnique({ where: { id: second.withdrawal.transactionId } });
  check('its ledger row reads failed', rejTx.status === 'failed', rejTx.status);

  // A double tap: two requests at once for everything.
  const taps = await Promise.allSettled([
    payoutService.requestWithdrawal(her, {}),
    payoutService.requestWithdrawal(her, {}),
  ]);
  const ok = taps.filter((t) => t.status === 'fulfilled');
  w = await wallet(her.id);
  check('a double tap makes one withdrawal', ok.length === 1, taps.map((t) => t.status));
  check('and never takes her balance below zero', num(w.availableBalance) >= 0, num(w.availableBalance));
  const open = await prisma.withdrawal.count({ where: { userId: her.id, status: 'requested' } });
  check('leaving exactly one open', open === 1, open);
  check('the admin list filters by status', (await payoutService.list({ status: 'requested' })).rows.some((r) => r.userId === her.id));
  err = await rejects(payoutService.retry(ok[0].value.withdrawal.id));
  check('"retry" is refused while payouts are manual', err && err.status >= 400, err?.message);
}

async function razorpayxWithdrawals() {
  section('Withdrawals — RazorpayX payouts');
  env.payouts.provider = 'razorpayx';
  fakeRazorpayX();
  const min = env.economy.minWithdrawalInr;
  try {
    const her = await makeUser();
    await giveAvailable(her.id, [min, min, min]);
    await walletService.setUpiAccount(her.id, { upiId: `meena.${tag}@oksbi` });

    const a = await payoutService.requestWithdrawal(her, { amount: min });
    check('a withdrawal is sent straight away', a.withdrawal.status === 'processing', a.withdrawal.status);
    check('and carries the payout id', Boolean(a.withdrawal.providerPayoutId), a.withdrawal);

    const payout = rx.payouts.get(a.withdrawal.id);
    const event = { event: 'payout.processed', payload: { payout: { entity: { ...payout, status: 'processed', utr: 'RZPUTR1' } } } };
    await payoutService.handleRazorpayxEvent(event);
    await payoutService.handleRazorpayxEvent(event); // delivered twice
    let row = await prisma.withdrawal.findUnique({ where: { id: a.withdrawal.id } });
    check('the processed webhook marks it paid, with the UTR', row.status === 'paid' && row.utr === 'RZPUTR1', row);
    let w = await wallet(her.id);
    check('a webhook delivered twice changes nothing more', num(w.availableBalance) === min * 2, num(w.availableBalance));

    await payoutService.handleRazorpayxEvent({ event: 'payout.reversed', payload: { payout: { entity: { ...payout, status: 'reversed' } } } });
    w = await wallet(her.id);
    row = await prisma.withdrawal.findUnique({ where: { id: a.withdrawal.id } });
    check('a reversal webhook returns the money', row.status === 'reversed' && num(w.availableBalance) === min * 3, { status: row.status, available: num(w.availableBalance) });
    await payoutService.handleRazorpayxEvent({ event: 'contact.created', payload: {} });
    check('events that are not payouts are ignored', true);

    const b = await payoutService.requestWithdrawal(her, { amount: min });
    check('the same UPI ID reuses its fund account', rx.contacts === 1 && rx.fundAccounts === 1, { contacts: rx.contacts, fundAccounts: rx.fundAccounts });
    await payoutService.handleRazorpayxEvent({ event: 'payout.failed', payload: { payout: { entity: { ...rx.payouts.get(b.withdrawal.id), status: 'failed', status_details: { description: 'Beneficiary bank down' } } } } });
    row = await prisma.withdrawal.findUnique({ where: { id: b.withdrawal.id } });
    w = await wallet(her.id);
    check('a failed payout refunds her, with the reason', row.status === 'failed' && row.failureReason === 'Beneficiary bank down' && num(w.availableBalance) === min * 3, { row, available: num(w.availableBalance) });

    // RazorpayX says no (a 4xx): failed at once, money back.
    rx.next = new razorpayx.RazorpayXError('Invalid VPA', { status: 400 });
    const c = await payoutService.requestWithdrawal(her, { amount: min });
    w = await wallet(her.id);
    check('a definite refusal fails it and refunds', c.withdrawal.status === 'failed' && num(w.availableBalance) === min * 3, { status: c.withdrawal.status, available: num(w.availableBalance) });

    // RazorpayX unreachable (a 5xx): held, not lost, and sent on retry.
    rx.next = new razorpayx.RazorpayXError('Bad gateway', { status: 502 });
    const d = await payoutService.requestWithdrawal(her, { amount: min });
    w = await wallet(her.id);
    check('an uncertain failure keeps it requested, money held', d.withdrawal.status === 'requested' && num(w.availableBalance) === min * 2, { status: d.withdrawal.status, available: num(w.availableBalance) });
    check('noting why it has not gone', /Not sent yet/.test(d.withdrawal.failureReason ?? ''), d.withdrawal.failureReason);
    const retried = await payoutService.retry(d.withdrawal.id);
    check('a retry sends it', retried.status === 'processing', retried.status);
    const again = await payoutService.retry(d.withdrawal.id);
    check('retrying one already sent does not pay twice', again.status === 'processing' && rx.payouts.size === 3, { status: again.status, payouts: rx.payouts.size });
  } finally {
    restoreRazorpayX();
    env.payouts.provider = 'manual';
  }
}

function webhookSignature() {
  section('RazorpayX webhook signature');
  const secret = 'whsec_test';
  const body = Buffer.from(JSON.stringify({ event: 'payout.processed' }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  check('a correct signature verifies', razorpayx.verifyWebhookSignature(body, sig, secret));
  check('a changed body does not', !razorpayx.verifyWebhookSignature(Buffer.from('{"event":"payout.reversed"}'), sig, secret));
  check('a wrong secret does not', !razorpayx.verifyWebhookSignature(body, sig, 'other'));
  check('a short signature does not (and does not throw)', !razorpayx.verifyWebhookSignature(body, 'abc', secret));
  check('no secret configured verifies nothing', !razorpayx.verifyWebhookSignature(body, sig, ''));
  check('a missing signature verifies nothing', !razorpayx.verifyWebhookSignature(body, undefined, secret));
}

async function messages() {
  section('Paid messages — her earnings, his history');
  const her = await makeUser();
  const him = await makeUser({ earner: false, name: 'Ravi' });
  const convo = `conv_${tag}_1`;
  const share = pricing.earnerShare();
  const price = env.economy.messagePriceInr;

  await Promise.all(
    Array.from({ length: 5 }, () =>
      walletService.recordMessageEarning({ earnerId: her.id, senderId: him.id, senderName: 'Ravi', conversationId: convo, amountSpent: price })
    )
  );
  const rows = await prisma.earning.findMany({ where: { userId: her.id } });
  const expected = Number((5 * Number((price * share).toFixed(2))).toFixed(2));
  check('five messages at once make one earning for the day', rows.length === 1, rows.length);
  check('counting all five', rows[0]?.messages === 5, rows[0]?.messages);
  check(`worth her share of each (₹${expected})`, num(rows[0]?.amount) === expected, num(rows[0]?.amount));
  const w = await wallet(her.id);
  check('her pending balance grows by the same', num(w.pendingBalance) === expected, num(w.pendingBalance));
  const ledger = await prisma.walletTransaction.findMany({ where: { walletId: w.id, kind: 'earning' } });
  check('with one ledger row, kept in step', ledger.length === 1 && num(ledger[0].rupeeDelta) === expected && ledger[0].subtitle.includes('5 messages'), ledger);

  await walletService.recordMessageEarning({ earnerId: her.id, senderId: him.id, senderName: 'Ravi', conversationId: `conv_${tag}_2`, amountSpent: price });
  check('another chat is its own row', (await prisma.earning.count({ where: { userId: her.id } })) === 2);
  check('nothing is earned from a free message', (await walletService.recordMessageEarning({ earnerId: her.id, senderId: him.id, conversationId: convo, amountSpent: 0 })) === null);

  await Promise.all(
    Array.from({ length: 4 }, () => walletService.recordMessageSpend({ userId: him.id, peerName: 'Asha', conversationId: convo, price }))
  );
  const spend = await prisma.walletTransaction.findMany({ where: { wallet: { userId: him.id }, kind: 'message' } });
  check('his four messages are one history row', spend.length === 1, spend.length);
  check(`of −₹${4 * price}`, num(spend[0]?.rupeeDelta) === -4 * price, num(spend[0]?.rupeeDelta));
  check('reading "4 messages"', spend[0]?.subtitle.includes('4 messages'), spend[0]?.subtitle);
}

async function refunds() {
  section('Google Play refunds taken back');
  const provider = env.payments.provider;
  env.payments.provider = 'google_play';
  try {
    const him = await makeUser({ earner: false, name: 'Ravi' });
    const token = `tok_${tag}_recharge`;
    const vipToken = `tok_${tag}_vip`;
    await prisma.$transaction((tx) =>
      walletService.creditBalance({ userId: him.id, amount: 100, kind: 'purchase', title: '₹100 recharge', subtitle: 'Google Play', referenceId: 'pkg_100', purchaseToken: token, tx })
    );
    await prisma.wallet.update({ where: { userId: him.id }, data: { vipExpiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    await prisma.$transaction((tx) =>
      walletService.creditBalance({ userId: him.id, amount: 20, kind: 'purchase', title: 'VIP membership', subtitle: 'Google Play', referenceId: 'vip_week', purchaseToken: vipToken, tx })
    );
    playBilling.listVoidedPurchases = async () => [
      { purchaseToken: token, orderId: 'GPA.1' },
      { purchaseToken: vipToken, orderId: 'GPA.2' },
      { purchaseToken: 'someone-elses-token' },
      { orderId: 'no-token' },
    ];
    const first = await walletService.reverseVoidedPurchases();
    const second = await walletService.reverseVoidedPurchases();
    const w = await wallet(him.id);
    check('both refunded purchases are reversed', first === 2, first);
    check('and only once, however often it runs', second === 0, second);
    check('his balance loses exactly what was refunded', num(w.balance) === 0, num(w.balance));
    check('a refunded VIP purchase ends VIP', w.vipExpiresAt && w.vipExpiresAt.getTime() <= Date.now(), w.vipExpiresAt);
    const rows = await prisma.walletTransaction.findMany({ where: { walletId: w.id, title: 'Purchase refunded' } });
    check('each with a ledger row saying why', rows.length === 2, rows.length);
  } finally {
    playBilling.listVoidedPurchases = realListVoided;
    env.payments.provider = provider;
  }
}

function buyerTag() {
  section('Purchases tagged to their buyer');
  const a = playBilling.accountTag('user_a');
  check('the tag is stable for an account', a === playBilling.accountTag('user_a'));
  check('different for another', a !== playBilling.accountTag('user_b'));
  check('and does not reveal the account id', !a.includes('user_a') && /^[0-9a-f]{64}$/.test(a), a);
  let threw = false;
  try {
    walletService.assertBuyer({ obfuscatedAccountId: playBilling.accountTag('user_b') }, 'user_a');
  } catch {
    threw = true;
  }
  check("another account's purchase is refused", threw);
  let fine = true;
  try {
    walletService.assertBuyer({ obfuscatedAccountId: a }, 'user_a');
    walletService.assertBuyer({}, 'user_a');
  } catch {
    fine = false;
  }
  check('its own, or an untagged older one, is accepted', fine);
}

(async () => {
  try {
    await maturing();
    await manualWithdrawals();
    await razorpayxWithdrawals();
    webhookSignature();
    await messages();
    await refunds();
    buyerTag();
  } catch (err) {
    failed += 1;
    console.error('\nCrashed:', err);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: made } } }).catch((err) =>
      console.error('cleanup failed:', err.message)
    );
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    // Background work (notifications, activity) holds handles open.
    process.exit(failed ? 1 : 0);
  }
})();
