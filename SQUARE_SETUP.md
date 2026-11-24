# Square card payments setup for Wrenqo

The server code is ready (`square.js` in this folder). The Square
developer app is **already created** (name **Wrenqo**) and the
production credentials are **already in Railway** — only the sandbox
credentials and the app-side work are left. Nothing here needs a
secret value written down; the credentials go straight into Railway
env vars.

## What is already done

- **Square developer account** created at developer.squareup.com
  (account: hellowrenqo@gmail.com, business name Wrenqo,
  website https://wrenqo.com).
- **Application "Wrenqo"** created; audience "All Square sellers";
  purpose "Accept payments".
- **Redirect URI** added in the app's OAuth settings (production):

  `https://wrenqo.com/api/square/callback`

  It must match character for character, or Square refuses the
  sign-in.
- **Railway env vars added** (wrenqo-website → Variables, Deploy
  clicked so they are live):

  | Variable | Value |
  | --- | --- |
  | `SQUARE_APP_ID` | Production Application ID |
  | `SQUARE_APP_SECRET` | Production Application Secret |

  Never paste these values into chat, email or a file. The
  Application ID is public by design; the Application Secret is
  not — keep a copy in a password manager, never anywhere shared.

## 1. Sandbox credentials (still needed)

The server defaults to the sandbox (`SQUARE_ENV` unset = sandbox),
so nothing can move real money until the user deliberately flips
it. For sandbox testing the sandbox credentials are still needed:

1. In the Square developer dashboard, open the **Wrenqo** app →
   **Credentials** → switch the Sandbox / Production toggle to
   **Sandbox**.
2. Copy the **Sandbox Application ID** and the **Sandbox Access
   token** is NOT needed — what is needed is the sandbox
   **Application Secret**: open the **OAuth** section (Sandbox
   toggle still on) → **Sandbox Application Secret** → Show → copy.
3. In Railway (steadfast-illumination → wrenqo-website →
   Variables), add:

   | Variable | Value |
   | --- | --- |
   | `SQUARE_SANDBOX_APP_ID` | Sandbox Application ID |
   | `SQUARE_SANDBOX_APP_SECRET` | Sandbox Application Secret |

   Then click **Deploy** in the staged-changes bar (Railway quirk:
   a variable that only appears in the list is staged, not live,
   until Deploy is clicked). No code change or redeploy of files is
   needed — the endpoints read the env vars at request time.

## 2. Scopes — check they are enabled

The server asks Square for these scopes on connect:

`PAYMENTS_WRITE PAYMENTS_READ MERCHANT_PROFILE_READ`

In the developer dashboard, open the **Wrenqo** app → **OAuth** →
**Permissions** and make sure **Payments** (read + write) and
**Merchant** (read) are enabled. If a scope is missing, Square
refuses the connect with an error page instead of asking the shop
to approve.

## 3. How to test it (sandbox)

1. In the Wrenqo app, open Settings → Square → Connect (once the
   app calls `GET /api/square/connect` with its sign-in token).
   It redirects to Square; sign in with a **Square sandbox test
   seller account** (created in the developer dashboard under
   Sandbox → Test accounts) and approve the connection.
2. Square redirects back to `/api/square/callback` — the page
   should say "Square connected".
3. `GET /api/square/status` (with the app's token) should return
   `{ "ok": true, "connected": true, "merchantId": "..." }`.

To test production, set the Railway variable `SQUARE_ENV` to
`production` (Deploy after adding it) and repeat the flow with a
real US Square seller account. Leave `SQUARE_ENV` unset or
`sandbox` until then.

## 4. The platform model — whose money is whose

Card payments are processed on **each US shop's own Square
account**, never on Wrenqo's account:

- The shop connects its own Square account to Wrenqo (the OAuth
  flow above). Wrenqo stores that shop's access token, scoped to
  that shop's business.
- When the shop takes a card payment in the app, the money lands in
  the shop's Square account, minus Square's fee (2.6% + 15¢ per
  in-person payment on Square's free tier, paid by the shop).
- Wrenqo (Pakistan) is never the merchant of record for a shop's
  jobs and never touches the card money. That is why Wrenqo needs
  no US company for this.

## 5. The squareup.com/activate notice

The production Credentials page shows: "You must activate your
Square account for payments by visiting squareup.com/activate
before you can process card payments in production." That notice
is about **Wrenqo's own Square merchant account** (processing
payments on Wrenqo's own account). It does **not** block the OAuth
connect flow for other sellers — the flow above connects a shop's
account, not Wrenqo's.

**Working assumption, to verify at test time:** the OAuth connect
and token exchange work while Wrenqo's own account stays
unactivated, because no payment is ever taken on Wrenqo's account.
This has NOT been confirmed with Square yet — the first sandbox
connect test (step 3) is the check. If Square blocks the OAuth
flow until the developer account is activated, that changes the
plan and must be flagged before any production step.

## 6. What is built now (v1.0.13, 2026-11-25) — and what is NOT

**Built:**
- **Taking a payment**: the app's invoice screen has "Take card
  payment" (sent/partial invoices, remaining balance). The Square
  Mobile Payments SDK (`square_mobile_payments_sdk` 2026.10.3)
  shows Square's card screen (tap / dip / swipe, or a paired
  Reader) and charges the card on the phone.
- **Server verification**: `POST /api/square/charge` re-reads the
  payment from Square with the merchant token and only answers ok
  when the payment is COMPLETED for exactly the invoiced amount.
  The invoice records the payment only after that answer. There is
  no card nonce in this SDK's API, so there is no
  CreatePayment-with-nonce call — verification is the design, not
  a shortcut.
- **Authorize endpoint**: `GET /api/square/authorize` hands the
  app the shop's OAuth token + location id for one payment session
  (in memory only, never stored in the app).
- **Per-environment tokens**: `square_tokens` is keyed by
  (business, environment) — sandbox and production tokens coexist.
- **App setup done**: Android compileSdk 37 / minSdk 28, Square
  Maven repo + SDK dep, no code shrinking, Jetifier on,
  MainApplication init, Bluetooth + phone-state permissions; iOS
  deployment target 17.1, AppDelegate init, Square setup run script
  phase, Bluetooth usage description. Settings has a Square tile
  next to QuickBooks.

**Still NOT built:**
- **Token refresh**: Square access tokens expire (30 days for
  OAuth tokens); the stored refresh token must be exchanged before
  it expires. No refresh job exists yet — a 401 surfaces as
  "Reconnect Square in Settings" and the shop reconnects by hand.
- **Token encryption at rest**: tokens are stored in plaintext in
  the `square_tokens` table. Encrypt them (AES-256-GCM, key from
  env `SQUARE_TOKEN_KEY`) before real customer data flows through
  this.
- **Disconnect**: no endpoint yet to delete a business's tokens.
- **Phone-only Tap to Pay vs Reader**: the SDK decides per phone
  at payment time (it offers tap-to-pay on the phone itself when
  no reader is paired and the phone supports it). Only a real
  device test proves it — not verified yet.
- **End-to-end sandbox charge**: needs a real phone + a sandbox
  test seller + the mock-reader UI taps (an agent cannot drive
  those — a human taps the floater, adds a reader, starts the
  payment, taps a card).

## 7. How to test the payment (sandbox, real phone)

1. Connect Square first (section 3 above) with a sandbox test
   seller account.
2. In the app, open an invoice that is sent (or partial) with a
   balance left. Tap **Take card payment**.
3. The app asks for location permission (Bluetooth too, for a
   reader). Square's card screen opens.
4. In Sandbox there are no physical readers: use the mock reader
   UI (Square's floating button) to add a contactless & chip
   reader, then tap a mock card.
5. When the payment completes, the app asks the server to verify
   it. On success the payment appears on the invoice as
   "Card (Square)" and the balance drops (partial, or paid).
6. If the payment was stored offline by Square instead, the app
   says so and records nothing — check again after it uploads.

## 8. Trade-offs the user can change with one word

- **minSdk 28 / iOS 17.1**: the Square SDK requires them. That
  drops Android 8 and older phones, and iPhones that cannot run
  iOS 17. Say the word and the SDK comes out — but card payments
  go with it.
- **No surcharge, no tip**: a card payment charges exactly the
  invoice balance. Square's fee (2.6% + 15¢) comes out of the
  shop's Square account.
- **Token on the phone**: the SDK needs the shop's OAuth token on
  the device to authorize. It is the shop's own token, held in
  memory for one payment session, never stored or synced. The
  alternative is no in-person SDK payments at all.
