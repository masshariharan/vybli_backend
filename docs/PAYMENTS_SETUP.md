# Payments setup guide

This is the manual configuration checklist for turning on real money movement in
Vybli: wallet recharges/VIP purchases (money in) and earner withdrawals (money out).

**Status: leg 1 (collection) is implemented.** `wallet.service.js`,
`wallet.controller.js` and `play_billing.service.js` all exist and do what §5
below describes — what's left is the human side: creating the Play Console
in-app products, creating the service account, and pasting its credentials
into the environment.
Leg 2 (payouts, §6) is **not** implemented — `withdraw()` writes a `pending`
ledger row and stops there. It is deliberately provider-agnostic: nothing
about it depends on how leg 1 collects money, so choosing a payout provider
(RazorpayX Payouts, Cashfree Payouts, or a manual bank transfer process) is a
separate decision that can be made independently, whenever payouts are ready
to automate.

Recharge and VIP purchases are **Google Play in-app products**, bought
on-device through the Play Store's own purchase sheet — whatever payment
methods the user has configured there (a saved card, UPI via Google Pay,
carrier billing, Play balance) is what they see. Vybli's own UI never
collects payment details of any kind; it only asks the Play Billing SDK to
start a purchase and hands the resulting token to this server.

## 1. The architecture, in one paragraph

Vybli does **not** need a "marketplace split payment" product. A wallet
recharge and an earner's payout are not the same transaction — one user's
₹500 top-up might fund calls to five different earners over the following
weeks, so there's no 1:1 transaction to split at purchase time. Instead, this
is the standard two-leg design every gig/creator platform uses:

- **Leg 1 — collection.** Google Play Billing collects money from a buyer,
  through the Play Store, into Vybli's Play Console payments account. This is
  where the wallet gets credited — only once this server has verified the
  purchase against Google's own records.
- **Leg 2 — payout.** Separately, whenever an earner withdraws, a payout call
  (to whichever provider is chosen — see the note above) sends money from
  Vybli's own account straight to the earner's UPI ID. This is where the 70%
  earner / 30% platform split actually happens — not at collection time, but
  as ledger math the backend already does (see `wallet.service.js`) when a
  call completes and an `Earning` row is created.

## 2. Why Google Play Billing, and not a payment gateway, for collection

Google Play's Developer Program Policy requires apps distributed through the
Play Store to use Google Play Billing for the sale of in-app digital content —
which explicitly includes "dating"-adjacent virtual goods and any
consumable/expendable in-app currency or credit. A wallet top-up used to place
calls falls squarely in that category regardless of whether it is labelled
"coins" or a plain rupee amount — the label does not change the classification,
the transaction does. Using a third-party gateway (Razorpay, Cashfree, or
similar) for this specific purchase would violate that policy and risk the
app's Play Store listing. This is why the collection leg is Play Billing and
not the gateway that was previously wired in here.

None of this applies to the payout leg (§6): paying an earner is not a sale of
digital content to the app's own user, so any payout provider remains a valid,
independent choice for that leg.

## 3. Accounts and catalogue to set up (do this first — it has the longest lead time)

1. **Google Play Console developer account** — [play.google.com/console](https://play.google.com/console),
   if the app does not already have one. Requires the one-time registration
   fee and identity verification; approval is typically same-day but can take
   longer.
2. **Merchant/payments profile** — Play Console → Setup → Payments profile.
   Required before any in-app product can be sold.
3. **One in-app product per catalogue row** — Play Console → your app →
   Monetize → Products → In-app products → Create product. The product ID
   must exactly match the `id` of the corresponding `RechargePackage` or
   `VipPlan` row (`pkg_100`, `pkg_500`, `vip_1m`, …; see `prisma/seed.js`) —
   this server treats the catalogue id and the Play SKU as the same thing, so
   there is no separate mapping table to keep in sync. Set each product's
   price to match the row's `priceInr`, and mark it **active**.
4. **A service account for server-to-server verification** — Play Console →
   Setup → API access → link (or create) a Google Cloud project, then create
   a service account there and grant it, under Play Console's own Account
   permissions for that service account: "View app information and download
   bulk reports" and "Manage orders and subscriptions". Create a JSON key for
   it — this is what `PLAY_BILLING_SERVICE_ACCOUNT_EMAIL` /
   `PLAY_BILLING_SERVICE_ACCOUNT_PRIVATE_KEY` come from.

## 4. Environment variables to add

Extend the existing `# ── Payments ──` section in `.env` / `.env.example`:

```
PAYMENT_PROVIDER=google_play

PLAY_BILLING_PACKAGE_NAME=com.hariharan.vybli
PLAY_BILLING_SERVICE_ACCOUNT_EMAIL=xxxxx@xxxxx.iam.gserviceaccount.com
PLAY_BILLING_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`PLAY_BILLING_PACKAGE_NAME` is the Android `applicationId` (see
`android/app/build.gradle` in the Flutter project). The private key must be on
ONE line, in double quotes, with the `\n` sequences left exactly as the
downloaded JSON key file shows them — same format `FIREBASE_PRIVATE_KEY`
already uses above it.

`src/config/env.js` reads these into `env.payments.googlePlay` and fails
production boot if `PAYMENT_PROVIDER` is unset at all, and additionally fails
boot if it is set to `google_play` but any of the three values above is
missing.

## 5. Purchase flow (collection)

This is the flow `wallet.service.js`'s `purchase()`/`purchaseVip()` comments
already name: *verify the purchase token against Google before crediting
anything — never from the client's own say-so.* Concretely:

1. Client (via the `in_app_purchase` Flutter plugin) queries the product
   details for a `package_id`/`plan_id` and starts a purchase. The Play Store
   app itself handles collecting payment — Vybli's UI never sees a card
   number, a UPI PIN, or any other payment credential.
2. Play Billing hands the client a `purchaseToken` for the completed purchase.
3. Client calls `POST /wallet/purchase` (or `/wallet/vip/purchase`) with
   `package_id`/`plan_id` and `purchase_token`.
4. Server looks up the package/plan's real price from the database (never
   trusts a client-sent amount), then verifies the token against the Play
   Developer API (`purchases.products.get`, via `play_billing.service.js`).
   Only a token Google itself reports as `purchaseState: 0` (purchased)
   credits anything.
5. On a verified purchase, the server credits the wallet (and, for VIP,
   extends `vipExpiresAt`) inside one database transaction, with the
   purchase token recorded on the `WalletTransaction` row — its unique
   constraint is what stops the same purchase from ever being credited twice,
   whether from a retried request or the client resending after a dropped
   response.
6. The server then **consumes** the product via the Play Developer API
   (`purchases.products.consume`), which both acknowledges it (required
   within 3 days or Google auto-refunds) and makes the same product
   purchasable again — every catalogue row here is meant to be bought
   repeatedly, so nothing is ever left "used up" on Google's side.

There is no order-creation step and no webhook to wait for — unlike a payment
gateway checkout, the Play Billing SDK already did the collecting on-device
by the time the app calls this server at all, so verification is a single
synchronous request/response.

Money must **never** be credited from the client's purchase-success callback
alone — that is the client's own claim, not proof of payment. Only a
verified `purchases.products.get` response credits anything.

## 6. Withdrawal flow (payout) — not yet implemented

1. Client calls `POST /wallet/withdraw` (already true today) — no amount, all
   of `availableBalance`.
2. Server re-checks `VerificationState.verified` and a linked
   `payoutUpiId` (already enforced today, `WITHDRAWAL_REQUIRES_UPI_ID`).
3. Server debits `availableBalance` and writes a `pending` `WalletTransaction`
   inside one DB transaction (existing pattern — conditional `updateMany`
   with `gte`, not read-then-write).
4. **Not yet built:** an actual payout API call that sends money to the
   earner's `payoutUpiId` and flips the ledger row to `completed` (or reverses
   the debit on failure). Until this is wired in, withdrawals stay `pending`
   for manual/off-platform reconciliation. The provider for this leg is an
   open choice — RazorpayX Payouts, Cashfree Payouts, or any UPI payout API —
   independent of Google Play Billing above, and does not require re-adding a
   payment gateway to the collection side.

## 7. The 30/70 split

No provider configuration needed for this — it's application logic. When a
call completes and an `Earning` row is created (already implemented), the
amount credited to `pendingBalance` is `env.economy.earnerShare` (70% by
default) of whatever the call was worth, with the other 30% simply *not*
credited anywhere on the earner's ledger — it stays Vybli's revenue by
default, since Vybli's own account already holds 100% of what was collected
in leg 1. No transfer of the 30% is needed; only the earner's 70% ever
leaves the account, via the payout leg in §6 once it exists.

## 8. Google Play's own cut

Play Billing takes its standard service fee (15% on the first $1M/year of a
developer's revenue, 30% above that, as of this writing — confirm current
rates in the Play Console before launch) out of every in-app product sale
before the remainder reaches Vybli's payments account. That fee is
independent of, and unrelated to, the 70/30 earner/platform split in §7 —
Vybli's 30% is computed on the *rupee amount a caller spent*, not on whatever
Vybli itself nets after Google's fee.

## 9. Compliance notes (not legal advice — get an actual answer for your entity)

- Payouts to individuals (the earners) at scale may trigger TDS obligations
  (e.g. Section 194-O style withholding for platforms facilitating payments to
  service providers) — confirm with an accountant whether Vybli needs to
  deduct and file TDS on earner payouts before this goes live with real money.
- GST treatment of the platform's share depends on how Vybli is structured
  (commission vs. principal) and on how Google Play's own fee is treated —
  same caveat, get real accounting advice before launch, not after.

## 10. Testing checklist before flipping `PAYMENT_PROVIDER` in production

- [ ] Create a **license tester** account (Play Console → Setup → License
      testing) so purchases can be tested without real charges.
- [ ] A recharge completes end-to-end against a real (test) Play Billing
      purchase, and the wallet balance updates only after this server's
      verification call succeeds — not merely after the on-device purchase
      sheet closes.
- [ ] A purchase token that Google reports as not `purchased` (cancelled,
      pending, refunded) is rejected with `PURCHASE_NOT_VERIFIED` and credits
      nothing.
- [ ] Submitting the same `purchase_token` twice (simulating a retried
      request) does not double-credit the wallet.
- [ ] A VIP purchase stacks correctly on top of an already-active
      membership rather than resetting `vipExpiresAt`.
- [ ] `npm test` still passes with `PAYMENT_PROVIDER=none` (the existing
      dev-mode "no payment taken" path) so local development without Play
      Console credentials keeps working.
