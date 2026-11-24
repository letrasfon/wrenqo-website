# QuickBooks Online setup for Wrenqo

The server code is ready (`quickbooks.js` in this folder). The Intuit
developer app is **not** — only the user can create it, because it
lives in the user's own Intuit account. Nothing here needs a secret
value written down; the credentials go straight into Railway env vars.

## 1. Create an Intuit developer account

1. Go to https://developer.intuit.com and sign up / sign in with the
   Intuit account that owns the QuickBooks company (use the Wrenqo
   Google account, hellowrenqo@gmail.com, so the app stays with the
   business, not a personal inbox).
2. Open the **Developer Dashboard** → **Create an app** → choose
   **QuickBooks Online API**.

## 2. Create the app

1. Name it **Wrenqo** (the name the shop sees when it connects).
2. Under **Keys & OAuth**, copy the **Client ID** and **Client
   Secret** — these become the Railway env vars below. Never paste
   them into chat, email or a file.
3. Add this exact **Redirect URI** (production):

   `https://wrenqo.com/api/quickbooks/callback`

   It must match character for character, or Intuit refuses the
   sign-in.
4. Under **Scopes**, tick **com.intuit.quickbooks.accounting** only.
   Nothing else is needed.

## 3. Sandbox first, production second

- Intuit gives every app a **Sandbox** company (test data, fake
  customers/invoices). Use it first: connect a sandbox company from
  the app and check `/api/quickbooks/status` returns connected.
- **Production** (a real shop's QuickBooks) needs Intuit's app
  review for production keys. Apply for production access from the
  developer dashboard only after the sandbox round-trip works.

## 4. Railway env vars

In the Railway project (steadfast-illumination → wrenqo-website →
Variables), add:

| Variable | Value |
| --- | --- |
| `QB_CLIENT_ID` | Client ID from step 2 |
| `QB_CLIENT_SECRET` | Client Secret from step 2 |
| `QB_REDIRECT_URI` | `https://wrenqo.com/api/quickbooks/callback` |

Then click **Deploy** in the staged-changes bar (Railway quirk: a
variable that only appears in the list is staged, not live, until
Deploy is clicked). No code change or redeploy of files is needed —
the endpoints read the env vars at request time.

## 5. How to test it

1. In the Wrenqo app, open Settings → QuickBooks → Connect (once the
   app calls `GET /api/quickbooks/connect` with its sign-in token).
   It redirects to Intuit; sign in with the QuickBooks account and
   approve the connection.
2. Intuit redirects back to
   `/api/quickbooks/callback` — the page should say "QuickBooks
   connected".
3. `GET /api/quickbooks/status` (with the app's token) should return
   `{ "ok": true, "connected": true, "realmId": "..." }`.

## 6. What is NOT built yet (honest status)

- **Token encryption at rest**: tokens are stored in plaintext in
  the `qb_tokens` table. Encrypt them (AES-256-GCM, key from env
  `QB_TOKEN_KEY`) before real customer data flows through this.
- **Token refresh**: access tokens live 1 hour; the stored refresh
  token must be exchanged before it expires (100 days). No refresh
  job exists yet.
- **Real invoice/customer sync**: `/api/quickbooks/export-invoice`
  only *maps* an invoice to QuickBooks' shape — nothing is sent to
  Intuit. Posting invoices and mapping local customer ids to
  QuickBooks customer ids is the next build.
- **Disconnect**: no endpoint yet to delete a business's tokens.
