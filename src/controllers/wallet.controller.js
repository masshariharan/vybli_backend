'use strict';

const walletService = require('../services/wallet.service');
const serialize = require('../utils/serialize');
const env = require('../config/env');
const { ok, created, paginated } = require('../utils/respond');
const { q } = require('../middleware/validate');
const { toSkipTake } = require('../validators/common');

/**
 * Lets the app find out, before starting a purchase, whether this
 * deployment actually requires payment — mirrors `/livekit/status`. A dev
 * server with no provider configured credits recharges/VIP purchases
 * directly and has no Play Billing product to buy, so the client should
 * never open the Play Store purchase sheet against one.
 */
function paymentsStatus(_req, res) {
  return ok(
    res,
    {
      provider: env.payments.provider,
      requires_payment: env.payments.configured,
    },
    'Payments status'
  );
}

async function summary(req, res) {
  const wallet = await walletService.getSummary(req.userId);
  return ok(
    res,
    {
      wallet: serialize.walletSummary(wallet, {
        isEarner: req.user.profile?.isEarner ?? false,
      }),
    },
    'Wallet'
  );
}

async function packages(req, res) {
  const rows = await walletService.listPackages();
  return ok(res, { packages: rows.map(serialize.rechargePackage) }, 'Recharge packages');
}

/**
 * Recharges the wallet.
 *
 * The body names a package; the price and bonus come from the database. An
 * endpoint that accepted an amount would be a free-money endpoint. On a
 * deployment with Google Play Billing wired in, `purchase_token` is the
 * token the client's Play Billing purchase returned — verified against the
 * Play Developer API before anything is credited (see
 * `wallet.service.purchase`).
 */
async function purchase(req, res) {
  const result = await walletService.purchase(req.user, {
    packageId: req.body.package_id,
    purchaseToken: req.body.purchase_token,
  });

  return created(
    res,
    {
      wallet: serialize.walletSummary(result.wallet, {
        isEarner: req.user.profile?.isEarner ?? false,
      }),
      amount_added: result.amountAdded,
      reference: result.reference,
      package: serialize.rechargePackage(result.package),
    },
    'Payment successful'
  );
}

async function vipPlans(req, res) {
  const rows = await walletService.listVipPlans();
  return ok(res, { plans: rows.map(serialize.vipPlan) }, 'VIP plans');
}

/**
 * Buys a VIP plan.
 *
 * The body names a plan; the price, days and bonus come from the database,
 * exactly like {@link purchase}.
 */
async function purchaseVip(req, res) {
  const result = await walletService.purchaseVip(req.user, {
    planId: req.body.plan_id,
    purchaseToken: req.body.purchase_token,
  });

  return created(
    res,
    {
      wallet: serialize.walletSummary(result.wallet, {
        isEarner: req.user.profile?.isEarner ?? false,
      }),
      vip_expires_at: result.expiresAt.toISOString(),
      bonus_inr: serialize.money(result.plan.bonusInr),
      plan: serialize.vipPlan(result.plan),
    },
    "You're a VIP now"
  );
}

async function transactions(req, res) {
  const params = q(req);
  const { skip, take } = toSkipTake(params);
  const { rows, total } = await walletService.listTransactions(req.user, {
    kind: params.kind,
    skip,
    take,
  });
  return paginated(
    res,
    rows.map(serialize.walletTransaction),
    { page: params.page, limit: params.limit, total }
  );
}

async function earnings(req, res) {
  const params = q(req);
  const { skip, take } = toSkipTake(params);
  const { rows, total } = await walletService.listEarnings(req.userId, { skip, take });
  return paginated(res, rows.map(serialize.earning), {
    page: params.page,
    limit: params.limit,
    total,
  });
}

async function withdraw(req, res) {
  const result = await walletService.withdraw(req.user, { amount: req.body.amount });
  const wallet = await walletService.getSummary(req.userId);
  return ok(
    res,
    {
      transaction: serialize.walletTransaction(result.transaction),
      amount: result.amount,
      wallet: serialize.walletSummary(wallet, { isEarner: true }),
    },
    "Withdrawal requested — we'll notify you"
  );
}

async function getUpiAccount(req, res) {
  const account = await walletService.getUpiAccount(req.userId);
  return ok(res, { upi_account: serialize.upiAccount(account) }, 'UPI account');
}

async function setUpiAccount(req, res) {
  const account = await walletService.setUpiAccount(req.userId, {
    upiId: req.body.upi_id,
  });
  return ok(
    res,
    { upi_account: serialize.upiAccount(account) },
    'UPI account'
  );
}

module.exports = {
  summary,
  packages,
  paymentsStatus,
  purchase,
  vipPlans,
  purchaseVip,
  transactions,
  earnings,
  withdraw,
  getUpiAccount,
  setUpiAccount,
};
