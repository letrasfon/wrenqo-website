// Wrenqo QuickBooks Online — OAuth scaffolding (server module).
//
// Connects a shop's own QuickBooks Online account so invoices (and
// later customers) can sync both ways. This module is scaffolding:
// the OAuth flow and the invoice mapping are real, but nothing is
// sent to Intuit yet and no background sync runs.
//
//   GET  /api/quickbooks/connect        (Bearer) -> 302 to Intuit's
//                          authorization page (needs QB_CLIENT_ID +
//                          QB_REDIRECT_URI env vars, else 503
//                          'QuickBooks not configured')
//   GET  /api/quickbooks/callback       (Intuit redirects here with
//                          ?code=...&realmId=...&state=...) -> exchanges
//                          the code for tokens (QB_CLIENT_SECRET) and
//                          stores them business-scoped in qb_tokens;
//                          without the env vars or a database it
//                          answers 503
//   GET  /api/quickbooks/status         (Bearer) -> { ok, connected }
//   POST /api/quickbooks/export-invoice (Bearer) { invoice } -> the
//                          invoice mapped to QuickBooks Online's
//                          invoice shape. MAPPING ONLY — nothing is
//                          sent to Intuit.
//
// The mapping reuses the app's QuickBooks-format CSV export
// (lib/services.dart ExportService.exportForQuickBooks) as the source
// of truth: one line per line item, tax as its own row, drafts skipped.
// QBO shape: CustomerRef / DocNumber / TxnDate / DueDate / Line[] of
// SalesItemLineDetail + TxnTaxDetail for the tax.
//
// SECURITY NOTE (launch-later): OAuth tokens are stored in plaintext
// in qb_tokens. Token encryption at rest (e.g. AES-256-GCM with a key
// from env QB_TOKEN_KEY) must land before real customer data flows
// through this — the table shape already isolates tokens per business,
// but a database leak today would expose them.
//
// Env vars (Railway; the user creates them in the Intuit developer
// portal — see QB_SETUP.md):
//   QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI
//   (redirect URI must be exactly https://wrenqo.com/api/quickbooks/callback)
//
// Usage:
//   const qb = require('./quickbooks.js');
//   const qbHandler = qb.registerQuickBooksRoutes({ pool, verifyAuthToken, authKey });
//   // pool may be null (status answers {connected:false}; connect and
//   // callback answer 503 'QuickBooks storage unavailable').
//   // authKey is the token-signing key string (server.js authKey()).
//   if (qb.isQuickBooksRoute(req.method, urlPath)) { ... }
'use strict';

const crypto = require('crypto');

// 64 KB is plenty for one invoice JSON; the app's invoices are small.
const MAX_BODY_BYTES = 64 * 1024;
const STATE_TTL_MS = 10 * 60 * 1000;
const QB_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_SCOPE = 'com.intuit.quickbooks.accounting';

const QB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS qb_tokens (
  business_id        TEXT PRIMARY KEY,
  realm_id           TEXT NOT NULL DEFAULT '',
  access_token       TEXT NOT NULL,
  refresh_token      TEXT NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// ------------------------------------------------------------ http helpers
// Mirrors sync.js / portal.js conventions: JSON responses, a byte-capped
// body read, and a 400 on unparseable JSON instead of a silent {}.

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function htmlRes(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(body));
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
    return JSON.parse(raw || '{}');
  } catch (e) {
    jsonRes(res, 400, { ok: false, error: 'invalid JSON' });
    return null;
  }
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

function qbPage(title, body) {
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
      schemaPromise = rawPool.query(QB_SCHEMA_SQL).catch((e) => {
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

function isQuickBooksRoute(method, urlPath) {
  if (method === 'GET' && urlPath === '/api/quickbooks/connect') return true;
  if (method === 'GET' && urlPath === '/api/quickbooks/callback') return true;
  if (method === 'GET' && urlPath === '/api/quickbooks/status') return true;
  if (method === 'POST' && urlPath === '/api/quickbooks/export-invoice') return true;
  return false;
}

function handleQuickBooksUnavailable(req, res, urlPath) {
  return jsonRes(res, 503, { ok: false, error: 'quickbooks unavailable' });
}

function registerQuickBooksRoutes(ctx) {
  if (!ctx || typeof ctx.verifyAuthToken !== 'function') {
    throw new Error('registerQuickBooksRoutes: ctx.verifyAuthToken is required');
  }
  const verifyAuthToken = ctx.verifyAuthToken;
  // pool is optional: null means no token storage (status is false,
  // connect/callback answer 503).
  const pool = ctx.pool ? schemaFirstPool(ctx.pool) : null;
  const stateKey = String(
    ctx.authKey || process.env.AUTH_SECRET || process.env.POLAR_WEBHOOK_SECRET || ''
  );

  function qbConfigured() {
    return Boolean(String(process.env.QB_CLIENT_ID || '').trim()) &&
      Boolean(String(process.env.QB_REDIRECT_URI || '').trim());
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

  // 'YYYY-MM-DD' from an ISO date/datetime string; '' when unparseable.
  function isoDate(value) {
    const t = Date.parse(String(value || ''));
    if (Number.isNaN(t)) return '';
    return new Date(t).toISOString().slice(0, 10);
  }

  async function handleConnect(req, res) {
    const email = verifyAuthToken(bearerToken(req));
    if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
    if (!qbConfigured()) {
      return jsonRes(res, 503, { ok: false, error: 'QuickBooks not configured' });
    }
    if (!pool) {
      return jsonRes(res, 503, { ok: false, error: 'QuickBooks storage unavailable' });
    }
    const businessId = await businessIdForEmail(email);
    if (!businessId) {
      return jsonRes(res, 503, { ok: false, error: 'QuickBooks storage unavailable' });
    }
    const state = signState(email, businessId);
    if (!state) {
      return jsonRes(res, 503, { ok: false, error: 'QuickBooks not configured' });
    }
    const params = new URLSearchParams({
      client_id: String(process.env.QB_CLIENT_ID).trim(),
      redirect_uri: String(process.env.QB_REDIRECT_URI).trim(),
      response_type: 'code',
      scope: QB_SCOPE,
      state,
    });
    res.writeHead(302, { Location: QB_AUTHORIZE_URL + '?' + params.toString() });
    return res.end();
  }

  async function handleCallback(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      return htmlRes(res, 400, qbPage('QuickBooks', 'That link looks broken — please try connecting again from the Wrenqo app.'));
    }
    const code = String(url.searchParams.get('code') || '');
    const realmId = String(url.searchParams.get('realmId') || '');
    const state = String(url.searchParams.get('state') || '');
    if (!code || !realmId) {
      return htmlRes(res, 400, qbPage('QuickBooks not connected', 'Intuit did not return a code. Please try connecting again from the Wrenqo app.'));
    }
    const verified = verifyState(state);
    if (!verified) {
      return htmlRes(res, 400, qbPage('QuickBooks not connected', 'That sign-in link expired or is not valid. Please try connecting again from the Wrenqo app.'));
    }
    if (!qbConfigured() || !String(process.env.QB_CLIENT_SECRET || '').trim()) {
      return htmlRes(res, 503, qbPage('QuickBooks not configured', 'The QuickBooks connection is not set up on the server yet.'));
    }
    if (!pool) {
      return htmlRes(res, 503, qbPage('QuickBooks not available', 'The QuickBooks connection storage is not reachable right now. Please try again later.'));
    }
    // Exchange the authorization code for tokens (10 s cap, like the
    // server's other outbound calls).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let tokenData = null;
    try {
      const basic = Buffer.from(
        String(process.env.QB_CLIENT_ID).trim() + ':' + String(process.env.QB_CLIENT_SECRET).trim()
      ).toString('base64');
      const tokenRes = await fetch(QB_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + basic,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: String(process.env.QB_REDIRECT_URI).trim(),
        }).toString(),
        signal: controller.signal,
      });
      if (!tokenRes.ok) {
        console.error('quickbooks token exchange failed', tokenRes.status);
        return htmlRes(res, 502, qbPage('QuickBooks not connected', 'Intuit refused the sign-in. Please try connecting again from the Wrenqo app.'));
      }
      tokenData = await tokenRes.json();
    } catch (e) {
      console.error('quickbooks token exchange error', e.message);
      return htmlRes(res, 502, qbPage('QuickBooks not connected', 'Intuit could not be reached. Please try connecting again from the Wrenqo app.'));
    } finally {
      clearTimeout(timer);
    }
    if (!tokenData || !tokenData.access_token || !tokenData.refresh_token) {
      return htmlRes(res, 502, qbPage('QuickBooks not connected', 'Intuit returned an incomplete sign-in. Please try connecting again from the Wrenqo app.'));
    }
    const now = Date.now();
    const expiresAt = new Date(now + Number(tokenData.expires_in || 3600) * 1000).toISOString();
    const refreshExpiresAt = tokenData.x_refresh_token_expires_in
      ? new Date(now + Number(tokenData.x_refresh_token_expires_in) * 1000).toISOString()
      : null;
    try {
      await pool.query(
        `INSERT INTO qb_tokens (business_id, realm_id, access_token, refresh_token, expires_at, refresh_expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (business_id) DO UPDATE SET
           realm_id = EXCLUDED.realm_id,
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           updated_at = now()`,
        [verified.businessId, realmId, tokenData.access_token, tokenData.refresh_token, expiresAt, refreshExpiresAt]
      );
    } catch (e) {
      if (isDbFailure(e)) {
        return htmlRes(res, 503, qbPage('QuickBooks not available', 'The QuickBooks connection storage is not reachable right now. Please try again later.'));
      }
      throw e;
    }
    return htmlRes(res, 200, qbPage(
      'QuickBooks connected',
      'Your QuickBooks Online account is connected to Wrenqo. ' +
      'Nothing is synced yet — invoice sync is the next step, and your ' +
      'invoices keep working inside Wrenqo either way. You can close this page.'
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
        'SELECT realm_id FROM qb_tokens WHERE business_id = $1',
        [businessId]
      );
      if (!rows.length) return jsonRes(res, 200, { ok: true, connected: false });
      return jsonRes(res, 200, { ok: true, connected: true, realmId: rows[0].realm_id });
    } catch (e) {
      if (isDbFailure(e)) return jsonRes(res, 503, { ok: false, error: 'quickbooks unavailable' });
      throw e;
    }
  }

  // Maps one of our invoices to QuickBooks Online's invoice shape.
  // MAPPING ONLY — nothing is sent to Intuit. Field mapping mirrors
  // the app's QuickBooks-format CSV export (one line per line item,
  // tax as its own row, drafts skipped): the CSV's InvoiceNo is
  // DocNumber, Customer is CustomerRef, InvoiceDate/DueDate are
  // TxnDate/DueDate, and each Item row becomes a SalesItemLineDetail.
  async function handleExportInvoice(req, res) {
    const email = verifyAuthToken(bearerToken(req));
    if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const inv = body.invoice;
    if (!inv || typeof inv !== 'object' || Array.isArray(inv)) {
      return jsonRes(res, 400, { ok: false, error: 'invoice is required' });
    }
    if (String(inv.status || '').toLowerCase() === 'draft') {
      return jsonRes(res, 400, { ok: false, error: 'draft invoices are not exported' });
    }
    const number = String(inv.number || '').trim();
    const customerId = String(inv.customerId || '').trim();
    const customerName = String(inv.customerName || '').trim();
    const items = Array.isArray(inv.items) ? inv.items : [];
    const taxCents = Number(inv.taxCents || 0);
    if (!number || !customerId || !items.length) {
      return jsonRes(res, 400, { ok: false, error: 'invoice needs a number, a customerId and at least one line item' });
    }
    for (const li of items) {
      if (!li || typeof li !== 'object' ||
          !String(li.description || '').trim() ||
          !Number.isFinite(Number(li.priceCents)) || Number(li.priceCents) < 0) {
        return jsonRes(res, 400, { ok: false, error: 'each line item needs a description and a priceCents of 0 or more' });
      }
    }
    if (!Number.isFinite(taxCents) || taxCents < 0) {
      return jsonRes(res, 400, { ok: false, error: 'taxCents must be 0 or more' });
    }
    const lines = items.map((li) => {
      const amount = Number(li.priceCents) / 100;
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: amount,
        Description: String(li.description).trim(),
        SalesItemLineDetail: {
          // '1' is QuickBooks' default Services item. A real sync maps
          // each line to the shop's own QuickBooks items instead.
          ItemRef: { value: '1' },
          Qty: 1,
          UnitPrice: amount,
        },
      };
    });
    const qbInvoice = {
      CustomerRef: { value: customerId, name: customerName || undefined },
      DocNumber: number,
      TxnDate: isoDate(inv.createdAt) || undefined,
      DueDate: isoDate(inv.dueDate) || undefined,
      Line: lines,
    };
    if (taxCents > 0) {
      // The CSV export puts tax on its own "Sales Tax" row; in the
      // QBO API the same tax goes on TxnTaxDetail (QuickBooks needs a
      // matching tax code in the company file for it to stick).
      qbInvoice.TxnTaxDetail = { TotalTax: taxCents / 100 };
    }
    const notes = [
      'Mapping only — nothing was sent to Intuit.',
      'CustomerRef uses your local customer id: the customer must exist in QuickBooks first, and a real sync maps local customer ids to QuickBooks customer ids.',
      "Line items use QuickBooks' default Services item (ItemRef '1'); a real sync maps each line to the shop's own QuickBooks items.",
    ];
    if (taxCents > 0) {
      notes.push('Tax is mapped to TxnTaxDetail; QuickBooks needs a matching tax code in the company file.');
    }
    return jsonRes(res, 200, { ok: true, quickbooksInvoice: qbInvoice, notes });
  }

  return async function quickbooksHandler(req, res, urlPath) {
    try {
      if (req.method === 'GET' && urlPath === '/api/quickbooks/connect') {
        await handleConnect(req, res);
        return true;
      }
      if (req.method === 'GET' && urlPath === '/api/quickbooks/callback') {
        await handleCallback(req, res);
        return true;
      }
      if (req.method === 'GET' && urlPath === '/api/quickbooks/status') {
        await handleStatus(req, res);
        return true;
      }
      if (req.method === 'POST' && urlPath === '/api/quickbooks/export-invoice') {
        await handleExportInvoice(req, res);
        return true;
      }
      return false;
    } catch (err) {
      console.error('quickbooks route error', err);
      if (!res.headersSent) {
        if (isDbFailure(err)) {
          jsonRes(res, 503, { ok: false, error: 'quickbooks unavailable' });
        } else {
          jsonRes(res, 500, { ok: false, error: 'quickbooks failed' });
        }
      }
      return true;
    }
  };
}

module.exports = { registerQuickBooksRoutes, isQuickBooksRoute, handleQuickBooksUnavailable };
