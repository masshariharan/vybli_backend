-- VIP call discount: each plan says how much it takes off voice and video
-- calls, and the wallet remembers the rate the current membership earned.
ALTER TABLE "vip_plans" ADD COLUMN "callDiscountPct" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "wallets" ADD COLUMN "vipCallDiscountPct" INTEGER NOT NULL DEFAULT 0;
