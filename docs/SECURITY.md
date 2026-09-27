# Security and privacy

What protects user data in Vybli, what each protection is for, and what it
does not cover. Read this before changing anything under `src/utils/e2ee.js`,
`src/services/e2ee.service.js` or the app's `lib/data/remote/e2ee/`.

## End-to-end encrypted chat

**The server cannot read chat messages.** Each phone encrypts a message
before sending it and decrypts what it receives. The server stores and relays
ciphertext, plus the per-device wrapped keys that let the intended phones open
it. `src/utils/e2ee.js` holds the exact envelope format. The app implements it
in `lib/data/remote/e2ee/e2ee_envelope.dart`, and a test checks that app code
byte for byte against an independent Node implementation
(`tests/lib/e2ee-reference.js`).

| Piece | Where |
| --- | --- |
| Device key directory (public keys only) | `e2ee_devices` table, `/e2ee/devices/*`, `/conversations/:id/keys` |
| Envelope shape checks and the device-set check on send | `utils/e2ee.parseEnvelope`, `e2eeService.assertEnvelopeCoversConversation` |
| Private keys | The phone's Keychain / EncryptedSharedPreferences, never sent anywhere and excluded from backup |
| Encrypt / decrypt | The app's `E2eeService`, used by `HttpChatRepository` and the socket binder |

**Scheme.** Each install has an X25519 identity key. Each message gets a
fresh AES-256-GCM key. That key is then wrapped once for every active device
of both people, including the sender's own devices. The wrap key comes from
HKDF over two X25519 exchanges, one ephemeral-to-recipient and one
sender-static-to-recipient (HPKE auth mode). The second exchange
authenticates the sending device. The associated data binds the conversation,
the sender and the device, so a ciphertext can't be replayed into another
chat or credited to another sender. Payloads are padded to 64-byte buckets.

**What the server still sees.** Who talks to whom, when, how often, the
approximate message size, and delivery and read status. This metadata is
needed for routing, unread counts, receipts and billing.

**Trust in keys.** The server hands out public keys, so a malicious server
could substitute its own. The app defends against that in three ways:

- **Pinning.** The app remembers every device key it has seen (trust on first
  use). If a known device later appears with a different key, it refuses
  that device.
- **New-device notice.** When a known contact adds a device, the app flags
  it.
- **Security code.** Chat menu → Encryption shows a code both people can
  compare, as Signal and WhatsApp do.

The server itself refuses to change the key registered for an existing
device id.

**Known limits.** These are deliberate, and should be revisited if they
become a problem:

- **No forward secrecy.** If a phone's private key is stolen, the thief can
  read past messages sent to that phone. Adding forward secrecy needs a
  Double Ratchet, and a ratchet needs message history stored on the phone
  instead of re-read from the server.
- **A new install can't read older history.** A reinstall gets a new key and
  there is no key backup. Older messages show as "can't be decrypted on this
  device".
- **In-call chat and call media aren't end-to-end encrypted.** They're
  protected by TLS and LiveKit's transport encryption only. LiveKit supports
  frame-level E2EE, and the call's key could be delivered in an encrypted
  envelope. That's the natural next step.

**Moderation.** Administrators can't read chats. The panel shows each
encrypted message as "🔒 End-to-end encrypted", and message search only finds
old plaintext rows. A reporter can attach the last 20 messages their own
phone decrypted. The server checks that each attached message id belongs to
that conversation, and records the sender and time from its own rows. It
can't verify the text, and the panel says so.

**Notifications.** Push and in-app notifications for encrypted messages say
"Sent you a message". Nothing readable reaches FCM or the `notifications`
table.

### Rollout

1. **Deploy the backend first.** The new app needs the `/e2ee` endpoints. An
   updated app talking to an old server can't register a key, so it can't
   send.
2. **Ship the app update.** New apps always encrypt. An old app still works
   while `E2EE_REQUIRED=false`: its messages are stored readable, as before,
   and it shows encrypted messages as "Update Vybli to read it".
3. **Know the transition cost.** A new app can't message someone who has
   never opened an encrypting build. The send fails with "needs to update
   Vybli". This is deliberate: falling back to plaintext without saying so
   would defeat the guarantee.
4. Once most users are on the new build, set **`E2EE_REQUIRED=true`**. The
   server then refuses plaintext sends (`426 E2EE_REQUIRED`) and never
   receives a readable message again.
5. Optionally, after that, blank the old plaintext rows. See the `text`
   column on `messages` where `envelope IS NULL`.

## Disappearing messages: 24 hours or 7 days

Each chat has a timer, **7 days by default**, that either person can switch
to **24 hours** from the chat menu → Disappearing messages
(`PATCH /conversations/:id/timer`). Both apps are told at once
(`conversation:timer`). Each message stores its own `expiresAt` when it's
sent, so a change applies to new messages only: messages already sent keep
their expiry. Nothing ever outlives the 7-day ceiling described below.

## Messages are deleted after 7 days

Every chat message is deleted for both people once it's older than
`MESSAGE_RETENTION_DAYS` (default 7). The rows are removed, ciphertext
included (`services/retention.service.js`):

- **Hourly purge.** It runs on boot and then every hour. It deletes in
  batches, recomputes the unread counters of the conversations it touched,
  and removes the matching "new message" notifications.
- **Reads apply the cut-off too.** This covers the app's thread view, chat
  previews and the admin panel, so an expired message is never shown in the
  hour before the purge reaches it. The app filters as well.
- **Conversations are kept.** Pins, mutes and the pair itself stay; only
  their messages age out.
- **Report evidence is kept.** It's a safety record the reporter handed over
  deliberately. Expiring it would let someone erase the case against them by
  waiting a week.

Users are told in three places: the Profile screen, Privacy Settings → Message
preferences, and the top of every chat ("Messages disappear after 7 days").
The app's copy comes from `kMessageRetentionDays` in
`lib/data/models/chat.dart`. Change it in the same release as the server
setting.

## Other protections

- **Sessions.** Refresh tokens are stored hashed and rotated on every use.
  If a token that was already rotated is replayed after a 30-second grace
  period, every session for that account is revoked, so a stolen copy stops
  working. JWTs are verified with `HS256` only.
- **Sockets.** Live sockets are re-checked every 30 seconds. An account that
  is suspended, deleted or signed out everywhere loses its open sockets.
  (Before this, a socket stayed open until the phone closed it.)
  `message:send` over the socket now applies the same schema, onboarding
  check and rate limit as the HTTP route.
- **Presence.** A blocked user can no longer watch the presence of the
  person who blocked them.
- **OTP.**
  - The routes are off unless an SMS provider is configured or
    `OTP_DEV_MODE` is on.
  - A code that couldn't be delivered is burned.
  - Wrong guesses are capped per number per day across all codes
    (`OTP_MAX_DAILY_FAILURES`).
  - Rate limits key on the normalised number.
  - Old codes are purged hourly.
- **Onboarding.** Gender, and with it the earner role, can't be changed
  through the onboarding routes after sign-up.
- **Data at rest.** Payout UPI IDs are encrypted with AES-256-GCM under
  `DATA_ENCRYPTION_KEY` (`utils/fieldCrypto.js`). They're masked in
  transaction lines and notifications. Without the key they're stored
  readable, and the boot log warns about it.
- **Attachments.** The server doesn't store image URLs on plaintext
  attachments. The app only loads attachment images from the API's own host.
  An arbitrary URL would leak the recipient's IP address to the sender.
- **Errors.** Socket acks and `/health` no longer echo internal error text.
