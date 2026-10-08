-- Firebase SMS OTP usage and cost monitoring for the admin panel. Read-only
-- with respect to sign-in: nothing in the OTP or Firebase path touches these.

-- CreateTable
CREATE TABLE "sms_usage_days" (
    "day" TEXT NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "verified" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "regions" JSONB,
    "freeSms" INTEGER NOT NULL DEFAULT 0,
    "paidSms" INTEGER NOT NULL DEFAULT 0,
    "unpricedSms" INTEGER NOT NULL DEFAULT 0,
    "rateUsd" DECIMAL(10,4) NOT NULL,
    "usdToInr" DECIMAL(10,4) NOT NULL,
    "freePerDay" INTEGER NOT NULL,
    "estCostUsd" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "estCostInr" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_usage_days_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "sms_billing_days" (
    "day" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "cost" DECIMAL(14,4) NOT NULL,
    "credits" DECIMAL(14,4) NOT NULL,
    "netCost" DECIMAL(14,4) NOT NULL,
    "netCostInr" DECIMAL(14,4) NOT NULL,
    "billedSms" DECIMAL(14,2) NOT NULL,
    "conversionRate" DECIMAL(14,6),
    "exportedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_billing_days_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "sms_monitor_state" (
    "id" TEXT NOT NULL DEFAULT 'sms',
    "rateUsd" DECIMAL(10,4),
    "usdToInr" DECIMAL(10,4),
    "freePerDay" INTEGER,
    "pricingUpdatedAt" TIMESTAMP(3),
    "usageSyncedAt" TIMESTAMP(3),
    "usageAttemptAt" TIMESTAMP(3),
    "usageError" TEXT,
    "usageDataThrough" TIMESTAMP(3),
    "billingSyncedAt" TIMESTAMP(3),
    "billingAttemptAt" TIMESTAMP(3),
    "billingError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_monitor_state_pkey" PRIMARY KEY ("id")
);
