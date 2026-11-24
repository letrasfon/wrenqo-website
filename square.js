// Wrenqo Square — OAuth scaffolding (server module).
//
// Connects a shop's own Square account so the shop can take card
// payments (in-person Tap to Pay / dip / swipe, and in-app) from its
// own customers. This is the PLATFORM model: each US shop connects
// its OWN Square account, and the card money goes to that shop's
// Square account (Square's 2.6% + 15c per in-person payment, on the
// shop's free tier). Wrenqo (Pakistan) never touches the card money
// and is never the merchant of record for a shop's jobs.
//
// This module is scaffolding: the OAuth connect flow and token
// storage are real, but no payment is taken yet and no background
// sync runs. Taking a payment (the Mobile Payments SDK in the app +
// a server-side charge/payment call) is the next build.
//
//   GET  /api/square/connect   (Bearer) -> 302 to Square's
//                          authorization page (needs the app id for
//                          the selected env, else 503 'Square not
//                          configured')
//   GET  /api/square/callback  (Square redirects here with
//                          ?code=...&state=...) -> exchanges the code
//                          for tokens (client_secret_post) and stores
//                          them business-scoped in square_tokens;
//                          without the env vars or a database it
//                          answers 503
//   GET  /api/square/status    (Bearer) -> { ok, connected }
//   GET  /api/square/authorize (Bearer) -> { ok, accessToken,
//                          locationId, merchantId, environment }
//                          The shop's own OAuth access token + the
//                          location the Mobile Payments SDK must be
//                          authorized with. The token belongs to the
//                          shop, is handed to the shop's own phone
//                          only, and the app holds it in memory for
//                          one payment session — it is never written
//                          to disk, never synced, never logged.
//   POST /api/square/charge    (Bearer) { invoiceId, amountCents,
//                          paymentId } -> VERIFIES a payment the
//                          Mobile Payments SDK already took in the
//                          app: re-reads the payment from Square
//                          with the merchant token and only answers
//                          ok when the payment is COMPLETED and the
//                          amount matches. The app records the
//                          payment on the invoice only after this
//                          answer, so a tampered client cannot invent
//                          a payment. The SDK charges the card
//                          itself — there is no card nonce in this
//                          SDK's API (no sourceId on Payment), so
//                          there is no CreatePayment-with-nonce call
//                          to make; the server's job is verification,
//                          not charging.
//
// Tokens are stored PER ENVIRONMENT (square_tokens PK is
// (business_id, environment)): a shop can hold a sandbox token and
// a production token at the same time, and flipping SQUARE_ENV
// never mixes them up. A migration in ensureSchema() upgrades the
// original single-row table (PK business_id) in place.
//
// Environments: SQUARE_ENV selects 'sandbox' (default) or
// 'production'. Both environments use the same Square hosts — the
// credentials decide which side the tokens belong to:
//   sandbox:    SQUARE_SANDBOX_APP_ID + SQUARE_SANDBOX_APP_SECRET
//   production: SQUARE_APP_ID + SQUARE_APP_SECRET
// Scopes requested: PAYMENTS_WRITE PAYMENTS_READ
// MERCHANT_PROFILE_READ (the app must have these permissions
// enabled in the Square developer dashboard — see SQUARE_SETUP.md).
//
// SECURITY NOTE (launch-later): OAuth tokens are stored in plaintext
// in square_tokens. Token encryption at rest (e.g. AES-256-GCM with a
// key from env SQUARE_TOKEN_KEY) must land before real customer data
// flows through this — the table shape already isolates tokens per
// business, but a database leak today would expose them.
//
// Env vars (Railway; the user creates them in the Square developer
// portal — see SQUARE_SETUP.md):
//   SQUARE_ENV ('sandbox' or 'production'; default 'sandbox')
//   SQUARE_APP_ID, SQUARE_APP_SECRET (production — already added)
//   SQUARE_SANDBOX_APP_ID, SQUARE_SANDBOX_APP_SECRET (sandbox)
//   (redirect URI is fixed: https://wrenqo.com/api/square/callback)
//
// Usage:
//   const sq = require('./square.js');
//   const sqHandler = sq.registerSquareRoutes({ pool, verifyAuthToken, authKey });
//   // pool may be null (status answers {connected:false}; connect and
//   // callback answer 503 'Square storage unavailable').
//   // authKey is the token-signing key string (server.js authKey()).
//   if (sq.isSquareRoute(req.method, urlPath)) { ... }
'use strict';

const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const SQUARE_AUTHORIZE_URL = 'https://connect.squareup.com/oauth2/authorize';
const SQUARE_TOKEN_URL = 'https://connect.squareup.com/oauth2/token';
const SQUARE_API_BASE = 'https://connect.squareup.com';
const SQUARE_API_VERSION = '2025-01-23';
const SQUARE_SCOPE = 'PAYMENTS_WRITE PAYMENTS_READ MERCHANT_PROFILE_READ';
const SQUARE_REDIRECT_URI = 'https://wrenqo.com/api/square/callback';

// A charge request is a few hundred bytes; 64 KB is far more than
// enough and keeps a bad client from stuffing the server.
const MAX_BODY_BYTES = 64 * 1024;
// A charge is at most $100,000 — far above any real invoice, and a
// hard cap so a bad client cannot ask Square for an absurd amount.
const MAX_CHARGE_CENTS = 10000000;

const SQUARE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS square_tokens (
  business_id         TEXT NOT NULL,
  environment         TEXT NOT NULL DEFAULT 'sandbox',
  merchant_id         TEXT NOT NULL DEFAULT '',
  access_token        TEXT NOT NULL,
  refresh_token       TEXT,
  expires_at          TIMESTAMPTZ,
  refresh_expires_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, environment)
);
CREATE TABLE IF NOT EXISTS square_charges (
  id                  TEXT PRIMARY KEY,
  business_id         TEXT NOT NULL,
  invoice_id          TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL,
  payment_id          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT '',
  receipt_url         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, payment_id)
);
`;

// Upgrades the original square_tokens table (PK business_id, no
// environment column) to the per-environment shape. Runs once per
// process via ensureSchema(); idempotent — the DO block only fires
// when the old single-column primary key is still there. The live
// table has no real seller connected yet (the sandbox connect test
// has not run), so this is a no-rows migration in practice.
const SQUARE_MIGRATION_SQL = `
ALTER TABLE square_tokens ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'sandbox';
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'square_tokens_pkey'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (business_id)'
  ) THEN
    ALTER TABLE square_tokens DROP CONSTRAINT square_tokens_pkey;
    ALTER TABLE square_tokens ADD PRIMARY KEY (business_id, environment);
  END IF;
END $$;
`;

// ------------------------------------------------------------ http helpers
// Mirrors quickbooks.js conventions: JSON responses and an HTML page
// for the browser-side callback result.

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function htmlRes(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function bearerToken(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Body reading with a hard cap (mirrors quickbooks.js): a body over
// the cap is rejected, not read into memory.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooBig = true;
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('body too large'));
      resolve(raw);
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req, res) {
  let raw = '';
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    jsonRes(res, 400, { ok: false, error: 'body too large' });
    return null;
  }
  try {
    const data = JSON.parse(raw || '{}');
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      jsonRes(res, 400, { ok: false, error: 'invalid JSON' });
      return null;
    }
    return data;
  } catch (e) {
    jsonRes(res, 400, { ok: false, error: 'invalid JSON' });
    return null;
  }
}

function isDbFailure(err) {
  const code = String((err && err.code) || '');
  return (
    code.startsWith('08') ||
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EPIPE'].includes(code) ||
    /connect|connection|timeout/i.test(String((err && err.message) || ''))
  );
}

function sqPage(title, body) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
    escapeHtml(title) + ' — Wrenqo</title></head><body style="font-family:sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#0F2A43">' +
    '<h1>' + escapeHtml(title) + '</h1><p>' + body + '</p>' +
    '<p><a href="/">Back to wrenqo.com</a></p></body></html>';
}

// ------------------------------------------------------------- lazy schema

function schemaFirstPool(rawPool) {
  let schemaPromise = null;
  function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await rawPool.query(SQUARE_SCHEMA_SQL);
        // Upgrade a pre-existing single-environment table in place.
        await rawPool.query(SQUARE_MIGRATION_SQL);
      })().catch((e) => {
        schemaPromise = null;
        throw e;
      });
    }
    return schemaPromise;
  }
  return {
    async query(text, params) {
      await ensureSchema();
      return rawPool.query(text, params);
    },
  };
}

// ------------------------------------------------------------------ routes

function isSquareRoute(method, urlPath) {
  if (method === 'GET' && urlPath === '/api/square/connect') return true;
  if (method === 'GET' && urlPath === '/api/square/callback') return true;
  if (method === 'GET' && urlPath === '/api/square/status') return true;
  if (method === 'GET' && urlPath === '/api/square/authorize') return true;
  if (method === 'POST' && urlPath === '/api/square/charge') return true;
  return false;
}

function handleSquareUnavailable(req, res, urlPath) {
  return jsonRes(res, 503, { ok: false, error: 'square unavailable' });
}

function registerSquareRoutes(ctx) {
  if (!ctx || typeof ctx.verifyAuthToken !== 'function') {
    throw new Error('registerSquareRoutes: ctx.verifyAuthToken is required');
  }
  const verifyAuthToken = ctx.verifyAuthToken;
  // pool is optional: null means no token storage (status is false,
  // connect/callback answer 503).
  const pool = ctx.pool ? schemaFirstPool(ctx.pool) : null;
  const stateKey = String(
    ctx.authKey || process.env.AUTH_SECRET || process.env.POLAR_WEBHOOK_SECRET || ''
  );

  // 'production' only when SQUARE_ENV says so; anything else (unset,
  // 'sandbox', a typo) is sandbox. Sandbox is the safe default: no
  // real money can move until the user deliberately flips the env.
  function squareEnv() {
    return String(process.env.SQUARE_ENV || 'sandbox').trim().toLowerCase() === 'production'
      ? 'production'
      : 'sandbox';
  }

  // Both environments talk to the same Square hosts; the credentials
  // decide which side the tokens belong to.
  function squareCreds() {
    if (squareEnv() === 'production') {
      return {
        appId: String(process.env.SQUARE_APP_ID || '').trim(),
        appSecret: String(process.env.SQUARE_APP_SECRET || '').trim(),
      };
    }
    return {
      appId: String(process.env.SQUARE_SANDBOX_APP_ID || '').trim(),
      appSecret: String(process.env.SQUARE_SANDBOX_APP_SECRET || '').trim(),
    };
  }

  function squareConfigured() {
    return Boolean(squareCreds().appId);
  }

  // The caller's business id (owner-first, like portal.js), or null
  // when there is no members table to ask.
  async function businessIdForEmail(email) {
    if (!pool) return null;
    try {
      const { rows } = await pool.query(
        `SELECT business_id FROM members WHERE email = $1
          ORDER BY (role = 'owner') DESC LIMIT 1`,
        [String(email || '').toLowerCase()]
      );
      return rows.length ? rows[0].business_id : null;
    } catch (e) {
      return null; // members table may not exist until first sync
    }
  }

  // OAuth state: signed, 10-minute, carries the email + business so
  // the callback needs no server-side session. Same HMAC shape as the
  // app's auth tokens (base64url payload + '.' + HMAC-SHA256).
  function signState(email, businessId) {
    if (!stateKey) return null;
    const payload = Buffer.from(JSON.stringify({
      email,
      businessId,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_MS / 1000,
      nonce: crypto.randomBytes(8).toString('hex'),
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', stateKey).update(payload).digest('base64url');
    return payload + '.' + sig;
  }

  function verifyState(state) {
    if (!stateKey || !state) return null;
    const dot = String(state).lastIndexOf('.');
    if (dot < 0) return null;
    const payload = String(state).slice(0, dot);
    const sig = String(state).slice(dot + 1);
    const expected = crypto.createHmac('sha256', stateKey).update(payload).digest('base64url');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data.email || !data.businessId || !data.exp) return null;
      if (data.exp < Math.floor(Date.now() / 1000)) return null;
      return { email: String(data.email), businessId: String(data.businessId) };
    } catch (e) {
      return null;
    }
  }

  async function handleConnect(req, res) {
    const email = verifyAuthToken(bearerToken(req));
    if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
    if (!squareConfigured()) {
      return jsonRes(res, 503, { ok: false, error: 'Square not configured' });
    }
    if (!pool) {
      return jsonRes(res, 503, { ok: false, error: 'Square storage unavailable' });
    }
    const businessId = await businessIdForEmail(email);
    if (!businessId) {
      return jsonRes(res, 503, { ok: false, error: 'Square storage unavailable' });
    }
    const state = signState(email, businessId);
    if (!state) {
      return jsonRes(res, 503, { ok: false, error: 'Square not configured' });
    }
    const params = new URLSearchParams({
      client_id: squareCreds().appId,
      redirect_uri: SQUARE_REDIRECT_URI,
      response_type: 'code',
      scope: SQUARE_SCOPE,
      state,
    });
    res.writeHead(302, { Location: SQUARE_AUTHORIZE_URL + '?' + params.toString() });
    return res.end();
  }

  async function handleCallback(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      return htmlRes(res, 400, sqPage('Square', 'That link looks broken — please try connecting again from the Wrenqo app.'));
    }
    const error = String(url.searchParams.get('error') || '');
    if (error) {
      return htmlRes(res, 400, sqPage('Square not connected', 'Square said the sign-in was declined (' + escapeHtml(error) + '). Please try connecting again from the Wrenqo app.'));
    }
    const code = String(url.searchParams.get('code') || '');
    const state = String(url.searchParams.get('state') || '');
    if (!code) {
      return htmlRes(res, 400, sqPage('Square not connected', 'Square did not return a code. Please try connecting again from the Wrenqo app.'));
    }
    const verified = verifyState(state);
    if (!verified) {
      return htmlRes(res, 400, sqPage('Square not connected', 'That sign-in link expired or is not valid. Please try connecting again from the Wrenqo app.'));
    }
    const creds = squareCreds();
    if (!creds.appId || !creds.appSecret) {
      return htmlRes(res, 503, sqPage('Square not configured', 'The Square connection is not set up on the server yet.'));
    }
    if (!pool) {
      return htmlRes(res, 503, sqPage('Square not available', 'The Square connection storage is not reachable right now. Please try again later.'));
    }
    // Exchange the authorization code for tokens. Square uses
    // client_secret_post: client_id + client_secret in the JSON body
    // (not an Authorization header). 10 s cap, like the server's
    // other outbound calls.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let tokenData = null;
    try {
      const tokenRes = await fetch(SQUARE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: creds.appId,
          client_secret: creds.appSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: SQUARE_REDIRECT_URI,
        }),
        signal: controller.signal,
      });
      if (!tokenRes.ok) {
        console.error('square token exchange failed', tokenRes.status);
        return htmlRes(res, 502, sqPage('Square not connected', 'Square refused the sign-in. Please try connecting again from the Wrenqo app.'));
      }
      tokenData = await tokenRes.json();
    } catch (e) {
      console.error('square token exchange error', e.message);
      return htmlRes(res, 502, sqPage('Square not connected', 'Square could not be reached. Please try connecting again from the Wrenqo app.'));
    } finally {
      clearTimeout(timer);
    }
    if (!tokenData || !tokenData.access_token || !tokenData.merchant_id) {
      return htmlRes(res, 502, sqPage('Square not connected', 'Square returned an incomplete sign-in. Please try connecting again from the Wrenqo app.'));
    }
    try {
      await pool.query(
        `INSERT INTO square_tokens (business_id, environment, merchant_id, access_token, refresh_token, expires_at, refresh_expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (business_id, environment) DO UPDATE SET
           merchant_id = EXCLUDED.merchant_id,
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           updated_at = now()`,
        [
          verified.businessId,
          squareEnv(),
          String(tokenData.merchant_id),
          String(tokenData.access_token),
          tokenData.refresh_token ? String(tokenData.refresh_token) : null,
          tokenData.expires_at ? String(tokenData.expires_at) : null,
          tokenData.refresh_token_expires_at ? String(tokenData.refresh_token_expires_at) : null,
        ]
      );
    } catch (e) {
      if (isDbFailure(e)) {
        return htmlRes(res, 503, sqPage('Square not available', 'The Square connection storage is not reachable right now. Please try again later.'));
      }
      throw e;
    }
    return htmlRes(res, 200, sqPage(
      'Square connected',
      'Your Square account is connected to Wrenqo. From an invoice, ' +
      'use "Take card payment" to take a card payment from your ' +
      'customer — the money lands in this Square account. ' +
      'You can close this page.'
    ));
  }

  async function handleStatus(req, res) {
    const email = verifyAuthToken(bearerToken(req));
    if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
    if (!pool) return jsonRes(res, 200, { ok: true, connected: false });
    const businessId = await businessIdForEmail(email);
    if (!businessId) return jsonRes(res, 200, { ok: true, connected: false });
    try {
      const { rows } = await pool.query(
        'SELECT merchant_id FROM square_tokens WHERE business_id = $1 AND environment = $2',
        [businessId, squareEnv()]
      );
      if (!rows.length) return jsonRes(res, 200, { ok: true, connected: false });
      return jsonRes(res, 200, { ok: true, connected: true, merchantId: rows[0].merchant_id });
    } catch (e) {
      if (isDbFailure(e)) return jsonRes(res, 503, { ok: false, error: 'square unavailable' });
      throw e;
    }
  }

  // The shop's stored OAuth token for the current environment, or
  // null when the shop has not connected that environment yet.
  // Tokens are business-scoped; the business id always comes from
  // the server-side token, never from the client.
  async function merchantTokenFor(businessId) {
    if (!pool) return null;
    const { rows } = await pool.query(
      'SELECT merchant_id, access_token FROM square_tokens WHERE business_id = $1 AND environment = $2',
      [businessId, squareEnv()]
    );
    if (!rows.length) return null;
    return { merchantId: rows[0].merchant_id, accessToken: rows[0].access_token };
  }

  // One Square API call with a 10 s cap, like the server's other
  // outbound calls. Returns { status, data } where data is the
  // parsed JSON body (or null). A network failure throws.
  async function squareFetch(path, accessToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(SQUARE_API_BASE + path, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Square-Version': SQUARE_API_VERSION,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      return { status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  // GET /api/square/authorize — the credentials the Mobile Payments
  // SDK needs on the phone: the shop's own OAuth access token and
  // the location id to authorize against. The location comes from
  // Square's Locations API (first ACTIVE location), so the shop
  // never has to paste a location id anywhere.
  //
  // SECURITY: this hands the shop's OAuth token to the shop's own
  // phone. That is how Square's Mobile Payments SDK is designed —
  // authorization happens on the device — and the token is the
  // shop's own, not Wrenqo's. The app holds it in memory for one
  // payment session and never writes it to disk, never syncs it,
  // and never logs it. If the token is ever leaked, the shop can
  // revoke it from Square's dashboard (OAuth → Revoke).
  async function handleAuthorize(req, res) {
    const email = verifyAuthToken(bearerToken(req));
    if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
    if (!pool) {
      return jsonRes(res, 503, { ok: false, error: 'Square storage unavailable' });
    }
    const businessId = await businessIdForEmail(email);
    if (!businessId) {
      return jsonRes(res, 503, { ok: false, error: 'Square storage unavailable' });
    }
    const token = await merchantTokenFor(businessId);
    if (!token) {
      return jsonRes(res, 409, { ok: false, error: 'square_not_connected' });
    }
    let locations = null;
    try {
      const { status, data } = await squareFetch('/v2/locations', token.accessToken);
      if (status === 401) {
        return jsonRes(res, 502, { ok: false, error: 'square_token_expired' });
      }
      if (status !== 200 || !data || !Array.isArray(data.locations)) {
        console.error('square locations failed', status);
        return jsonRes(res, 502, { ok: false, error: 'square unavailable' });
      }
      locations = data.locations;
    } catch (e) {
      console.error('square locations error', e.message);
      return jsonRes(res, 502, { ok: false, error: 'square unavailable' });
    }
    if (!locations.length) {
      return jsonRes(res, 502, { ok: false, error: 'square_no_location' });
    }
    const active = locations.find((l) => l.status === 'ACTIVE') || locations[0];
    if (!active || !active.id) {
      return jsonRes(res, 502, { ok: false, error: 'square_no_location' });
    }
    return jsonRes(res, 200, {
      ok: true,
      accessToken: token.accessToken,
      locationId: String(active.id),
      merchantId: token.merchantId,
      environment: squareEnv(),
    });
  }

  // POST /api/square/charge — VERIFIES a payment the Mobile Payments
  // SDK already took in the app. The SDK charges the card on the
  // phone (autocomplete); the app sends the Square payment id here,
  // and this endpoint re-reads that payment from Square with the
  // merchant token. It only answers ok when the payment exists, is
  // COMPLETED, and its amount matches the invoice balance the app
  // asked to charge. The app records the payment on the invoice
  // only after this answer, so a tampered client cannot invent a
  // payment, replay someone else's payment id, or change the amount.
  //
  // Idempotency: a verified payment is stored in square_charges keyed
  // by (business, payment_id). A retry of the same payment id returns
  // the stored result instead of calling Square again, so a flaky
  // connection can never record the same payment twice. A second,
  // separate payment on the same invoice has a different Square
  // payment id and is a different row.
  async function handleCharge(req, res) {
    const email = verifyAuthToken(bearerToken(req));
    if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
    const data = await readJsonBody(req, res);
    if (!data) return;
    const invoiceId = String(data.invoiceId || '').trim();
    const paymentId = String(data.paymentId || '').trim();
    const amountCents = data.amountCents;
    if (!invoiceId || invoiceId.length > 128) {
      return jsonRes(res, 400, { ok: false, error: 'invalid invoiceId' });
    }
    if (!paymentId || paymentId.length > 128) {
      return jsonRes(res, 400, { ok: false, error: 'invalid paymentId' });
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_CHARGE_CENTS) {
      return jsonRes(res, 400, { ok: false, error: 'invalid amountCents' });
    }
    if (!pool) {
      return jsonRes(res, 503, { ok: false, error: 'Square storage unavailable' });
    }
    const businessId = await businessIdForEmail(email);
    if (!businessId) {
      return jsonRes(res, 503, { ok: false, error: 'Square storage unavailable' });
    }
    const token = await merchantTokenFor(businessId);
    if (!token) {
      return jsonRes(res, 409, { ok: false, error: 'square_not_connected' });
    }
    // Already verified? Return the stored result — never verify or
    // record the same Square payment twice.
    try {
      const { rows } = await pool.query(
        'SELECT status, receipt_url FROM square_charges WHERE business_id = $1 AND payment_id = $2',
        [businessId, paymentId]
      );
      if (rows.length) {
        return jsonRes(res, 200, {
          ok: true,
          duplicate: true,
          paymentId,
          status: rows[0].status,
          receiptUrl: rows[0].receipt_url || null,
        });
      }
    } catch (e) {
      if (isDbFailure(e)) return jsonRes(res, 503, { ok: false, error: 'square unavailable' });
      throw e;
    }
    // Re-read the payment from Square with the merchant token.
    let payment = null;
    try {
      const { status, data: sq } = await squareFetch(
        '/v2/payments/' + encodeURIComponent(paymentId),
        token.accessToken
      );
      if (status === 401) {
        return jsonRes(res, 502, { ok: false, error: 'square_token_expired' });
      }
      if (status === 404) {
        return jsonRes(res, 404, { ok: false, error: 'square_payment_not_found' });
      }
      if (status !== 200 || !sq || !sq.payment) {
        console.error('square payment lookup failed', status);
        return jsonRes(res, 502, { ok: false, error: 'square unavailable' });
      }
      payment = sq.payment;
    } catch (e) {
      console.error('square payment lookup error', e.message);
      return jsonRes(res, 502, { ok: false, error: 'square unavailable' });
    }
    // The payment must belong to this merchant, be finished, and be
    // for exactly the amount the app asked to charge.
    if (payment.merchant_id && token.merchantId && payment.merchant_id !== token.merchantId) {
      console.error('square payment merchant mismatch', businessId);
      return jsonRes(res, 409, { ok: false, error: 'square_payment_mismatch' });
    }
    if (payment.status !== 'COMPLETED') {
      return jsonRes(res, 409, {
        ok: false,
        error: 'square_payment_not_completed',
        status: String(payment.status || ''),
      });
    }
    const money = payment.amount_money || {};
    if (money.currency !== 'USD' || Number(money.amount) !== amountCents) {
      console.error('square payment amount mismatch', businessId, invoiceId);
      return jsonRes(res, 409, { ok: false, error: 'square_amount_mismatch' });
    }
    const receiptUrl = payment.receipt_url ? String(payment.receipt_url) : null;
    try {
      await pool.query(
        `INSERT INTO square_charges (id, business_id, invoice_id, amount_cents, payment_id, status, receipt_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (business_id, payment_id) DO NOTHING`,
        [
          'sqcharge_' + crypto.randomBytes(12).toString('hex'),
          businessId,
          invoiceId,
          amountCents,
          paymentId,
          'COMPLETED',
          receiptUrl,
        ]
      );
    } catch (e) {
      if (isDbFailure(e)) return jsonRes(res, 503, { ok: false, error: 'square unavailable' });
      throw e;
    }
    return jsonRes(res, 200, {
      ok: true,
      paymentId,
      status: 'COMPLETED',
      receiptUrl,
    });
  }

  return async function squareHandler(req, res, urlPath) {
    try {
      if (req.method === 'GET' && urlPath === '/api/square/connect') {
        await handleConnect(req, res);
        return true;
      }
      if (req.method === 'GET' && urlPath === '/api/square/callback') {
        await handleCallback(req, res);
        return true;
      }
      if (req.method === 'GET' && urlPath === '/api/square/status') {
        await handleStatus(req, res);
        return true;
      }
      if (req.method === 'GET' && urlPath === '/api/square/authorize') {
        await handleAuthorize(req, res);
        return true;
      }
      if (req.method === 'POST' && urlPath === '/api/square/charge') {
        await handleCharge(req, res);
        return true;
      }
      return false;
    } catch (err) {
      console.error('square route error', err);
      if (!res.headersSent) {
        if (isDbFailure(err)) {
          jsonRes(res, 503, { ok: false, error: 'square unavailable' });
        } else {
          jsonRes(res, 500, { ok: false, error: 'square failed' });
        }
      }
      return true;
    }
  };
}

module.exports = { registerSquareRoutes, isSquareRoute, handleSquareUnavailable };
