'use strict';

const { createPrismaClient } = require('../src/config/prismaClient');

const prisma = createPrismaClient();

/**
 * The rows the product cannot sell anything without.
 *
 * What the server genuinely owns: what a recharge costs and what a VIP plan
 * buys. Nothing else writes these two tables — there is no admin endpoint and
 * no panel screen for them — so the constants below are the single definition
 * of those prices, and this file is the only way they reach Postgres.
 *
 * **Run automatically, on every boot**, by `docker-entrypoint.sh`, right after
 * the migrations. Every write is an upsert keyed on a fixed id, so re-running
 * converges the database onto whatever the deployed image declares: correct on
 * a fresh environment and on an existing one alike, and safe to run twice.
 * It used to be a manual `npm run seed`, which is the step that gets
 * forgotten — the deployed database was never seeded, so the wallet had
 * nothing to offer and the recharge screen had nothing to show.
 *
 * Neither catalogue is here, and neither can be. Cities and languages are
 * static reference data that ships inside the Flutter app, so there is no
 * table to keep in step with it — the server stores only the id and the codes
 * a profile was saved with.
 *
 * Idempotent throughout: every write is an upsert, so this can be re-run after
 * a migration without duplicating anything or clobbering live rows.
 */

/**
 * Recharge packages. Priced here so a change is a row update, not a release.
 *
 * The wallet balance is credited `priceInr + bonusInr` — what the caller pays
 * plus whatever bonus is thrown in for free. No separate "quantity" any more:
 * the rupee paid and the rupee credited are the same unit.
 */
const RECHARGE_PACKAGES = [
  { id: 'pkg_100', priceInr: 100, bonusInr: 0, sortOrder: 1 },
  {
    id: 'pkg_500',
    priceInr: 500,
    bonusInr: 25,
    tagline: 'Good for ~40 min of voice',
    sortOrder: 2,
  },
  {
    id: 'pkg_1000',
    priceInr: 1000,
    bonusInr: 100,
    isPopular: true,
    tagline: 'Most people pick this',
    sortOrder: 3,
  },
  {
    id: 'pkg_2500',
    priceInr: 2500,
    bonusInr: 350,
    tagline: 'Great for daily callers',
    sortOrder: 4,
  },
  {
    id: 'pkg_5000',
    priceInr: 5000,
    bonusInr: 1000,
    isBestValue: true,
    tagline: 'Best value',
    sortOrder: 5,
  },
];

/** VIP plans. 1 / 2 / 3 months, priced in days so a month never has to mean
 * a fixed number of calendar days at purchase time. */
const VIP_PLANS = [
  { id: 'vip_1m', days: 30, priceInr: 899, bonusInr: 250, sortOrder: 1 },
  {
    id: 'vip_2m',
    days: 60,
    priceInr: 1299,
    bonusInr: 350,
    isBest: true,
    sortOrder: 2,
  },
  { id: 'vip_3m', days: 90, priceInr: 1899, bonusInr: 520, sortOrder: 3 },
];

async function seedPackages() {
  for (const pkg of RECHARGE_PACKAGES) {
    await prisma.rechargePackage.upsert({
      where: { id: pkg.id },
      create: pkg,
      update: pkg,
    });
  }
  return RECHARGE_PACKAGES.length;
}

async function seedVipPlans() {
  for (const plan of VIP_PLANS) {
    await prisma.vipPlan.upsert({
      where: { id: plan.id },
      create: plan,
      update: plan,
    });
  }
  return VIP_PLANS.length;
}

async function main() {
  console.info('[seed] starting');

  const packages = await seedPackages();
  console.info(`[seed] ${packages} recharge packages`);

  const vipPlans = await seedVipPlans();
  console.info(`[seed] ${vipPlans} VIP plans`);

  console.info('[seed] done');
}

main()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
