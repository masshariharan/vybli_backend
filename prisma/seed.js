'use strict';

const { createPrismaClient } = require('../src/config/prismaClient');
const seedData = require('./seed-data.json');

const prisma = createPrismaClient();

/**
 * Reference data.
 *
 * Cities are extracted from the Flutter app's own catalogue, so the two agree
 * on ids from day one — a `city_id` of `chennai` means the same row on both
 * sides.
 *
 * Languages are not seeded and no longer can be. That catalogue is static, so
 * it ships inside the app rather than in a table this has to keep in step; the
 * server stores only the codes a profile was saved with.
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

async function seedCities() {
  for (const city of seedData.cities) {
    await prisma.city.upsert({
      where: { id: city.id },
      create: city,
      update: {
        name: city.name,
        state: city.state,
        country: city.country,
        isPopular: city.isPopular,
        // Carried on re-seed as well as on create: coordinates were added to
        // existing rows by a later migration, and an update that skipped them
        // would leave every city already in the database unable to answer
        // "where am I".
        latitude: city.latitude ?? null,
        longitude: city.longitude ?? null,
        region: city.region ?? null,
      },
    });
  }
  return seedData.cities.length;
}

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

  const cities = await seedCities();
  console.info(`[seed] ${cities} cities`);

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
