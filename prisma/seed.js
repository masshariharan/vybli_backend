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
/**
 * Every row spells out every flag, so an upsert also clears a flag an older
 * build had set — a package that was "popular" last release stops being it.
 */
const RECHARGE_PACKAGES = [
  { id: 'pkg_25', priceInr: 25, bonusInr: 0, isPopular: false, isBestValue: false, tagline: '5 min of voice', sortOrder: 1 },
  { id: 'pkg_50', priceInr: 50, bonusInr: 5, isPopular: false, isBestValue: false, tagline: '11 min of voice', sortOrder: 2 },
  { id: 'pkg_100', priceInr: 100, bonusInr: 15, isPopular: true, isBestValue: false, tagline: '23 min of voice', sortOrder: 3 },
  { id: 'pkg_200', priceInr: 200, bonusInr: 35, isPopular: false, isBestValue: false, tagline: '47 min of voice', sortOrder: 4 },
  { id: 'pkg_500', priceInr: 500, bonusInr: 100, isPopular: false, isBestValue: true, tagline: '30 min of video', sortOrder: 5 },
  { id: 'pkg_1000', priceInr: 1000, bonusInr: 250, isPopular: false, isBestValue: false, tagline: '62 min of video', sortOrder: 6 },
  { id: 'pkg_2000', priceInr: 2000, bonusInr: 600, isPopular: false, isBestValue: false, tagline: '130 min of video', sortOrder: 7 },
];

/** VIP plans. 1 / 2 / 3 months, priced in days so a month never has to mean
 * a fixed number of calendar days at purchase time. */
const VIP_PLANS = [
  { id: 'vip_1m', days: 30, priceInr: 99, bonusInr: 20, callDiscountPct: 10, isBest: false, sortOrder: 1 },
  { id: 'vip_2m', days: 60, priceInr: 179, bonusInr: 45, callDiscountPct: 10, isBest: false, sortOrder: 2 },
  { id: 'vip_3m', days: 90, priceInr: 249, bonusInr: 75, callDiscountPct: 15, isBest: true, sortOrder: 3 },
];

/**
 * Upserts `rows`, then retires every row of the table this build no longer
 * declares. An upsert alone never removes anything, so a package dropped from
 * the list above would otherwise stay on sale forever.
 *
 * Retired, not deleted: purchase ledger rows reference these ids.
 */
async function converge(model, rows) {
  for (const row of rows) {
    await model.upsert({
      where: { id: row.id },
      create: { ...row, isActive: true },
      update: { ...row, isActive: true },
    });
  }
  const { count } = await model.updateMany({
    where: { id: { notIn: rows.map((r) => r.id) }, isActive: true },
    data: { isActive: false },
  });
  return { active: rows.length, retired: count };
}

async function seedPackages() {
  return converge(prisma.rechargePackage, RECHARGE_PACKAGES);
}

async function seedVipPlans() {
  return converge(prisma.vipPlan, VIP_PLANS);
}

async function main() {
  console.info('[seed] starting');

  const packages = await seedPackages();
  console.info(`[seed] ${packages.active} recharge packages (${packages.retired} retired)`);

  const vipPlans = await seedVipPlans();
  console.info(`[seed] ${vipPlans.active} VIP plans (${vipPlans.retired} retired)`);

  console.info('[seed] done');
}

main()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
