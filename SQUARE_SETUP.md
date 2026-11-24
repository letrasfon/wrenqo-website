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

## 6. What is NOT built yet (honest status)

- **Taking a payment**: no charge or payment is taken anywhere
  yet. The app side (Square Mobile Payments SDK, `square_mobile_payments_sdk`)
  and a server-side payment call are the next build.
- **Token refresh**: Square access tokens expire (30 days for
  OAuth tokens); the stored refresh token must be exchanged before
  it expires. No refresh job exists yet.
- **Token encryption at rest**: tokens are stored in plaintext in
  the `square_tokens` table. Encrypt them (AES-256-GCM, key from
  env `SQUARE_TOKEN_KEY`) before real customer data flows through
  this.
- **Disconnect**: no endpoint yet to delete a business's tokens.
- **Phone-only Tap to Pay vs Reader**: unverified whether Square's
  Mobile Payments SDK exposes phone-only Tap to Pay or needs a
  Square Reader (~$59). The app build will confirm this.
