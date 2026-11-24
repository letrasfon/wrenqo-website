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
const SQUARE_SCOPE = 'PAYMENTS_WRITE PAYMENTS_READ MERCHANT_PROFILE_READ';
const SQUARE_REDIRECT_URI = 'https://wrenqo.com/api/square/callback';

const SQUARE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS square_tokens (
  business_id         TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL DEFAULT '',
  access_token        TEXT NOT NULL,
  refresh_token       TEXT,
  expires_at          TIMESTAMPTZ,
  refresh_expires_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
      schemaPromise = rawPool.query(SQUARE_SCHEMA_SQL).catch((e) => {
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
        `INSERT INTO square_tokens (business_id, merchant_id, access_token, refresh_token, expires_at, refresh_expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (business_id) DO UPDATE SET
           merchant_id = EXCLUDED.merchant_id,
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           updated_at = now()`,
        [
          verified.businessId,
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
      'Your Square account is connected to Wrenqo. Card payments are ' +
      'the next step — taking a payment from the app is not built yet, ' +
      'and your invoices keep working inside Wrenqo either way. ' +
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
        'SELECT merchant_id FROM square_tokens WHERE business_id = $1',
        [businessId]
      );
      if (!rows.length) return jsonRes(res, 200, { ok: true, connected: false });
      return jsonRes(res, 200, { ok: true, connected: true, merchantId: rows[0].merchant_id });
    } catch (e) {
      if (isDbFailure(e)) return jsonRes(res, 503, { ok: false, error: 'square unavailable' });
      throw e;
    }
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
