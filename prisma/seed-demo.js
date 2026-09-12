'use strict';

const { createPrismaClient } = require('../src/config/prismaClient');
const demoUsers = require('./demo-users.json');

const prisma = createPrismaClient();

/**
 * The 22 demo profiles, ported from the Flutter app's own mock data.
 *
 * Same names, cities, prices, languages and presence — so an app pointed at
 * this backend looks exactly like the one running on mocks, except every row
 * is real and every action goes through the API.
 *
 * These are complete accounts, not fixtures: each has a phone number, a
 * profile, a wallet and settings rows. You can sign in as any of them (the OTP
 * is printed in dev) and see the product from the earner's side.
 *
 * Marked `isDemo`, which is what lets them answer for themselves when
 * `DEMO_AUTO_RESPOND` is on. It no longer depends on `npm run seed` having run
 * — the city and language ids these profiles carry are catalogue slugs the app
 * resolves, not rows that have to exist first.
 */

/** Demo numbers occupy a reserved block so they cannot collide with a real one. */
const demoPhone = (index) => String(8800000000 + index);

async function seedUser(user, index) {
  const phone = demoPhone(index);

  // Keyed on the phone rather than a stored id, so re-running updates the same
  // account instead of creating a second one.
  const existing = await prisma.user.findFirst({
    where: { dialCode: '+91', phone, deletedAt: null },
    include: { profile: true },
  });

  const profileData = {
    name: user.name,
    age: user.age,
    gender: user.gender,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    cityId: user.cityId,
    goal: user.isEarner ? 'earnMoney' : 'makeFriends',
    isEarner: user.isEarner,
    isVerified: user.isVerified,
    voiceEnabled: user.voiceEnabled,
    videoEnabled: user.videoEnabled,
    voiceRatePerMinute: user.voiceRatePerMinute,
    videoRatePerMinute: user.videoRatePerMinute,
    rating: user.rating,
    // The mock carries a rating with no calls behind it. Giving it a plausible
    // denominator means the average survives a real rating being added.
    ratedCalls: user.rating > 0 ? Math.max(1, Math.round(user.totalCalls * 0.4)) : 0,
    totalCalls: user.totalCalls,
    presence: user.presence,
    lastSeen: new Date(),
    onboardingStatus: 'ONBOARDING_COMPLETED',
    isDemo: true,
  };

  const userId = existing
    ? existing.id
    : (
        await prisma.user.create({
          data: {
            dialCode: '+91',
            phone,
            wallet: { create: { balance: 500 } },
            privacySettings: { create: {} },
            notificationSettings: { create: {} },
            discoverySettings: { create: {} },
          },
        })
      ).id;

  await prisma.userProfile.upsert({
    where: { userId },
    create: { userId, ...profileData },
    update: profileData,
  });

  // Privacy has to agree with the profile, or discovery would advertise a call
  // type the guard then refuses.
  await prisma.privacySettings.upsert({
    where: { userId },
    create: {
      userId,
      allowVoiceCalls: user.voiceEnabled,
      allowVideoCalls: user.videoEnabled,
    },
    update: {
      allowVoiceCalls: user.voiceEnabled,
      allowVideoCalls: user.videoEnabled,
    },
  });

  await prisma.wallet.upsert({
    where: { userId },
    create: { userId, balance: 500 },
    update: {},
  });

  // Codes, as the mock data and the app both carry them — there is no
  // catalogue table to resolve a name against any more.
  await prisma.userLanguage.deleteMany({ where: { userId } });
  if (user.languages.length > 0) {
    await prisma.userLanguage.createMany({
      data: user.languages.map((code) => ({ userId, languageCode: code })),
      skipDuplicates: true,
    });
  }

  // A verified earner's flag is set on the profile above. There is no separate
  // verification record to write: the `Verification` model went with the voice
  // check it belonged to, so this block had been calling a model that no longer
  // exists — it only survived because nothing lints a dead branch.

  return { id: userId, phone, name: user.name };
}

/**
 * A little history between the demo accounts themselves.
 *
 * Not visible to a new sign-up — history is per-user — but it means signing in
 * as a demo earner shows a populated Recent tab and a real conversation, which
 * is the side of the product a fresh account cannot otherwise see.
 */
async function seedInteractions(seeded) {
  const earners = seeded.filter((s) => s.isEarner);
  const callers = seeded.filter((s) => !s.isEarner);
  if (earners.length === 0 || callers.length === 0) return 0;

  let created = 0;

  for (let i = 0; i < Math.min(4, callers.length); i += 1) {
    const caller = callers[i];
    const earner = earners[i % earners.length];
    const [userAId, userBId] =
      caller.id < earner.id ? [caller.id, earner.id] : [earner.id, caller.id];

    const friendship = await prisma.friendship.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
    });
    if (friendship) continue;

    const now = new Date();
    await prisma.friendRequest.upsert({
      where: {
        requesterId_addresseeId: { requesterId: caller.id, addresseeId: earner.id },
      },
      create: {
        requesterId: caller.id,
        addresseeId: earner.id,
        status: 'accepted',
        message: 'Hi! Would love to connect on Vybli.',
        respondedAt: now,
      },
      update: { status: 'accepted', respondedAt: now },
    });

    await prisma.friendship.create({ data: { userAId, userBId } });

    const conversation = await prisma.conversation.create({
      data: { userAId, userBId, lastMessageAt: now },
    });

    await prisma.message.createMany({
      data: [
        {
          conversationId: conversation.id,
          senderId: caller.id,
          text: 'Hi! Would love to connect on Vybli.',
          status: 'read',
          createdAt: new Date(now.getTime() - 3 * 3600_000),
        },
        {
          conversationId: conversation.id,
          senderId: earner.id,
          text: 'Hey! Thanks for reaching out 👋',
          status: 'read',
          createdAt: new Date(now.getTime() - 2.5 * 3600_000),
        },
        {
          conversationId: conversation.id,
          senderId: caller.id,
          text: 'Free for a call later?',
          status: 'delivered',
          createdAt: new Date(now.getTime() - 40 * 60_000),
        },
      ],
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { unreadForA: userAId === earner.id ? 1 : 0, unreadForB: userBId === earner.id ? 1 : 0 },
    });

    // A finished call between them, so Recent is not empty either.
    const durationSeconds = 180 + i * 120;
    const minutes = Math.ceil(durationSeconds / 60);
    const rate = 12;
    const endedAt = new Date(now.getTime() - (i + 1) * 3600_000);

    await prisma.call.create({
      data: {
        callerId: caller.id,
        calleeId: earner.id,
        type: i % 2 === 0 ? 'voice' : 'video',
        status: 'ended',
        endReason: 'hungUp',
        startedAt: new Date(endedAt.getTime() - durationSeconds * 1000),
        connectedAt: new Date(endedAt.getTime() - durationSeconds * 1000),
        endedAt,
        durationSeconds,
        amountSpent: minutes * rate,
        ratePerMinute: rate,
        rating: 5,
      },
    });

    created += 1;
  }

  return created;
}

async function main() {
  // Refused outright rather than guarded by a comment. These are 22 complete
  // accounts with names, ratings and call counts that no one earned; writing
  // them into a production database puts fabricated people in front of real
  // ones, and there is no undo that leaves the id space clean.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed demo accounts with NODE_ENV=production. These are not ' +
        'people, and a production database must not contain them.'
    );
  }

  console.info('[demo] seeding demo accounts');

  const seeded = [];

  for (let i = 0; i < demoUsers.length; i += 1) {
    const result = await seedUser(demoUsers[i], i);
    seeded.push({ ...result, isEarner: demoUsers[i].isEarner });
  }

  console.info(`[demo] ${seeded.length} accounts (${seeded.filter((s) => s.isEarner).length} earners)`);

  const interactions = await seedInteractions(seeded);
  console.info(`[demo] ${interactions} sample conversations and calls`);

  console.info('\n[demo] sign in as any of these — the OTP is printed by the server:');
  for (const s of seeded.slice(0, 5)) {
    console.info(`  +91 ${s.phone}  ${s.name}${s.isEarner ? ' (earner)' : ''}`);
  }
  console.info(`  …and ${Math.max(0, seeded.length - 5)} more, numbers run consecutively.`);
}

main()
  .catch((err) => {
    console.error('[demo] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
