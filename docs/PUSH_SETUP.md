# Push notifications — setup

What makes a call ring and a message arrive on a phone that does not currently
have Vybli open. Without the two environment variables below, everything in the
app still works and no notification is ever sent — the server says so once, at
startup:

```
[boot] FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are not set. Push
notifications are disabled: calls and messages will only reach phones that
currently have the app open and connected.
```

## Why a service account is needed now and was not before

Firebase has been in this server since sign-in moved to phone verification, but
only as an *oracle*: verifying an ID token means checking a signature against
Google's public certificates, which needs no credential at all. That is why
`FIREBASE_PROJECT_ID` alone has been enough.

Sending a message to a device is a privileged call. It needs a service account —
an identity Google can bill and rate-limit — which is the one new requirement
here.

## The two values

1. Firebase console → ⚙ **Project settings** → **Service accounts**
2. **Generate new private key** → downloads a JSON file
3. From that file, take exactly two fields:

   | JSON field     | Environment variable     |
   | -------------- | ------------------------ |
   | `client_email` | `FIREBASE_CLIENT_EMAIL`  |
   | `private_key`  | `FIREBASE_PRIVATE_KEY`   |

4. Paste both into Railway → the API service → **Variables**.

`FIREBASE_PRIVATE_KEY` is a multi-line PEM. Paste it **with its `\n` escapes
intact, exactly as the JSON has it** — `env.js` converts them back to real
newlines. Reformatting it by hand is the usual cause of an opaque crypto error
at the first send.

`FIREBASE_PROJECT_ID` is already set, and must be the same project.

**Treat the JSON file as a password.** It can send notifications to every
installed copy of the app. Do not commit it; the two variables above are the
only parts that should leave your machine.

## Confirming it works

After the deploy, the startup warning above should be gone. Then, from a phone
with the app installed and signed in:

1. Background the app (home button — not swiped away, for the first test).
2. From another account, send that user a message.
3. The notification appears within a second or two.

Then the harder case: swipe the app away entirely and call that account from
another phone. The ring should take over the screen with Answer and Decline on
it.

If messages arrive but calls do not, the cause is almost always battery
optimisation on that handset rather than anything here — see below.

## How it is delivered

Two shapes of message, for two different reasons. See `src/services/push.service.js`.

| | Chat message | Call |
| --- | --- | --- |
| FCM payload | `notification` + `data` | `data` only |
| Drawn by | Android itself | The app |
| Priority | high | high, with a 45-second TTL |
| Why | Survives a dozing phone and an OEM that kills background isolates — no Dart has to run | A ring needs two buttons, a full-screen takeover and a ringtone, none of which the OS-rendered block can express |

The TTL is why a phone that comes back onto the network two minutes later does
not start ringing at a call that ended long ago: FCM drops the message instead
of delivering it late.

## Tokens

- One row per install, in `device_tokens`, keyed on the token itself.
- The client registers on **every launch**, not once at sign-up — FCM rotates
  tokens on reinstall, on a restore to a new phone, and on its own schedule.
- Registering a token that already belongs to another account **moves** it. A
  phone belongs to whoever is signed in on it now.
- Signing out deletes the row, using the session that is about to end.
- A token FCM rejects as unregistered is deleted on the spot — see `prune`.

## What this does not cover

- **iOS.** The Dart is written and platform-agnostic, but the Apple half is not
  done: it needs an APNs auth key uploaded to the Firebase console, plus the
  Push Notifications and Background Modes capabilities in Xcode. Until then an
  iOS build registers a token that can never be delivered to.
- **Aggressive OEM power management.** Xiaomi, Oppo, vivo and others kill
  background processes hard enough to delay or drop a data-only message, which
  is the call path. There is no server-side fix; the app already asks for the
  battery-optimisation exemption for location, and the same dialog is what
  helps here.
- **A ring while the app is force-stopped.** Android delivers nothing at all to
  an app the user has force-stopped from Settings, by design.
