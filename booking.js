// Wrenqo customer self-booking — server module (Postgres-backed).
//
// The companion to the app's BookingService (lib/services.dart) and the
// Stage 2 design in the app repo's server/sync-endpoint.js, rebuilt on
// Postgres instead of staging JSON files. The module is
// dependency-light: 'pg' is injected (the caller creates the Pool and
// passes it in via ctx), and mail goes through the caller's sendMail.
//
// Usage:
//   const booking = require('./booking.js');
//   const bookingHandler = booking.registerBookingRoutes({ pool, sendMail });
//   // inside http.createServer (async):
//   if (booking.isBookingRoute(req.method, urlPath)) {
//     if (!bookingHandler) { booking.handleBookingUnavailable(req, res, urlPath); return; }
//     if (await bookingHandler(req, res, urlPath)) return;
//   }
//
// ctx:
//   pool     — a pg Pool for the booking database. Required. The
//              booking tables are created lazily by this module on
//              first use (idempotent DDL, retried after a failure), so
//              deploys need no manual SQL step.
//   sendMail — ({ to, subject, text }) => Promise<boolean>. Required.
//
// Routes (the app's exact contract):
//   POST /api/book/register       { code, shopName, email, enabled? }
//                                 -> 200 { ok: true }
//   GET  /api/book?shop=<code>    -> 200 { ok: true, shopName,
//                                 requests: [...] } newest first;
//                                 404 { ok: false } when the code is
//                                 unknown — the app reads 404 here as
//                                 "booking page is not set up yet".
//   GET  /book/<code>             -> the public booking page (standalone
//                                 HTML); unknown or disabled code -> a
//                                 friendly standalone 404 page.
//   POST /api/book/<code>         { customerName, phone, email, address,
//                                 trade, service, preferredDate, notes }
//                                 -> 200 { ok: true, id, mailed };
//                                 stores the request and emails the shop.
//   POST /api/book/<id>/respond   { status: 'accepted' | 'declined' }
//                                 -> 200 { ok: true }; on 'accepted' a
//                                 best-effort confirmation goes to the
//                                 customer.
//
// Fail-safe (mirrors sync.js): when the database is unreachable, the
// list answers 404 (the app's "not set up" signal), the public page
// answers the friendly 404 page, and writes answer 503 — a down
// database never takes booking down with a crash or a wrong answer.
'use strict';

const crypto = require('crypto');

const MAX_BODY_BYTES = 100000; // mirrors the live server's body caps
const MAX_REQUESTS_LISTED = 500;
// App-generated codes: shop-name slug + '-' + 4 random characters.
const CODE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/; // same shape as server.js

const BOOKING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS booking_shops (
  code       TEXT PRIMARY KEY,
  shop_name  TEXT,
  email      TEXT,
  enabled    BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS booking_requests (
  id             TEXT PRIMARY KEY,
  code           TEXT REFERENCES booking_shops(code),
  customer_name  TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  trade          TEXT,
  service        TEXT,
  preferred_date TEXT,
  notes          TEXT,
  status         TEXT DEFAULT 'pending',
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_requests_code_idx
  ON booking_requests (code, created_at DESC);
`;

// ------------------------------------------------------------ http helpers
// Mirrors sync.js / the live server.js conventions: JSON responses, a
// byte-capped body read, and a 400 on unparseable JSON.

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

// Resolves the parsed body, or null after sending a 400.
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

// ------------------------------------------------------------- lazy schema
// Same pattern as the sync integration in server.js: the first booking
// query runs the DDL once per process; a failed attempt is forgotten so
// the next booking call retries.

function schemaFirstPool(rawPool) {
  let schemaPromise = null;
  function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = rawPool.query(BOOKING_SCHEMA_SQL).catch((e) => {
        schemaPromise = null; // let the next booking call retry
        throw e;
      });
    }
    return schemaPromise;
  }
  return {
    query: async (...args) => {
      await ensureSchema();
      return rawPool.query(...args);
    },
    connect: async () => {
      await ensureSchema();
      return rawPool.connect();
    },
  };
}

// ---------------------------------------------------------------- routing

const RESPOND_RE = /^\/api\/book\/([^/]+)\/respond$/;
const SUBMIT_RE = /^\/api\/book\/([^/]+)$/;
const PAGE_RE = /^\/book\/([^/]+)$/;

// Classifies a request as a booking route, or null when it is not one.
// 'register' is checked before 'submit' because /api/book/register also
// matches the submit shape.
function routeKind(method, urlPath) {
  if (method === 'POST' && urlPath === '/api/book/register') return 'register';
  if (method === 'POST' && RESPOND_RE.test(urlPath)) return 'respond';
  if (method === 'POST' && SUBMIT_RE.test(urlPath)) return 'submit';
  if (method === 'GET' && urlPath === '/api/book') return 'list';
  if (method === 'GET' && PAGE_RE.test(urlPath)) return 'page';
  return null;
}

function isBookingRoute(method, urlPath) {
  return routeKind(method, urlPath) !== null;
}

function pathSegment(urlPath, re) {
  const m = re.exec(urlPath);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}

// ------------------------------------------------------------ public pages

function pageShell(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; color: #1c2b3a; }
  .band { background: #0F2A43; color: #fff; padding: 28px 20px 22px; }
  .band .wrap { max-width: 560px; margin: 0 auto; }
  .brand { color: #E8A317; font-weight: 700; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; margin: 0 0 6px; }
  .band h1 { margin: 0; font-size: 26px; line-height: 1.25; }
  .band p { margin: 8px 0 0; color: #c9d6e2; font-size: 15px; }
  main { max-width: 560px; margin: 0 auto; padding: 22px 20px 8px; }
  label { display: block; font-weight: 600; font-size: 15px; margin: 18px 0 6px; }
  label .req { color: #b3261e; }
  input, textarea { width: 100%; font-size: 16px; padding: 14px; border: 1px solid #b9c6d2; border-radius: 10px; background: #fff; color: #1c2b3a; }
  input:focus, textarea:focus { outline: 2px solid #E8A317; border-color: #E8A317; }
  textarea { min-height: 96px; resize: vertical; }
  button { width: 100%; margin-top: 24px; background: #E8A317; color: #0F2A43; font-size: 17px; font-weight: 700; padding: 16px; border: 0; border-radius: 10px; cursor: pointer; }
  button:disabled { opacity: 0.6; }
  .error { display: none; margin-top: 16px; background: #fdecea; color: #b3261e; border: 1px solid #f2b8b1; padding: 12px 14px; border-radius: 10px; font-size: 15px; }
  .done { background: #e9f6ec; border: 1px solid #a9d7b2; padding: 18px; border-radius: 10px; font-size: 16px; }
  footer { max-width: 560px; margin: 0 auto; padding: 18px 20px 30px; color: #7a8b9c; font-size: 13px; text-align: center; }
</style>
</head>
<body>
${inner}
<footer>Powered by Wrenqo</footer>
</body>
</html>`;
}

function bookingPageHtml(shop) {
  const shopName = shop.shop_name || 'this business';
  const codeJson = JSON.stringify(shop.code);
  const inner = `
<header class="band"><div class="wrap">
  <p class="brand">Wrenqo booking</p>
  <h1>Book with ${escapeHtml(shopName)}</h1>
  <p>Tell us what you need and ${escapeHtml(shopName)} will get back to you to confirm a time.</p>
</div></header>
<main>
  <form id="bookForm" novalidate>
    <label for="fName">Your name <span class="req">*</span></label>
    <input id="fName" name="customerName" type="text" autocomplete="name" required>
    <label for="fPhone">Phone</label>
    <input id="fPhone" name="phone" type="tel" autocomplete="tel">
    <label for="fEmail">Email</label>
    <input id="fEmail" name="email" type="email" autocomplete="email">
    <label for="fAddress">Service address</label>
    <input id="fAddress" name="address" type="text" autocomplete="street-address">
    <label for="fService">Service needed <span class="req">*</span></label>
    <input id="fService" name="service" type="text" required>
    <label for="fDate">Preferred date</label>
    <input id="fDate" name="preferredDate" type="date">
    <label for="fNotes">Anything we should know</label>
    <textarea id="fNotes" name="notes"></textarea>
    <div class="error" id="bookError"></div>
    <button type="submit" id="bookSubmit">Send booking request</button>
  </form>
  <div class="done" id="bookDone" hidden>
    <strong>Thanks — your request has been sent.</strong><br>
    ${escapeHtml(shopName)} has received it and will be in touch to confirm your booking.
  </div>
</main>
<script>
(function () {
  var code = ${codeJson};
  var form = document.getElementById('bookForm');
  var errorBox = document.getElementById('bookError');
  var submitBtn = document.getElementById('bookSubmit');
  function val(id) { return document.getElementById(id).value.trim(); }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    errorBox.style.display = 'none';
    var payload = {
      customerName: val('fName'),
      phone: val('fPhone'),
      email: val('fEmail'),
      address: val('fAddress'),
      service: val('fService'),
      preferredDate: val('fDate'),
      notes: val('fNotes')
    };
    if (!payload.customerName || !payload.service) {
      errorBox.textContent = 'Please add your name and the service you need.';
      errorBox.style.display = 'block';
      return;
    }
    if (!payload.phone && !payload.email) {
      errorBox.textContent = 'Please add a phone number or an email so we can reach you.';
      errorBox.style.display = 'block';
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    fetch('/api/book/' + encodeURIComponent(code), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok && body.ok) {
          form.hidden = true;
          document.getElementById('bookDone').hidden = false;
        } else {
          errorBox.textContent = body.error || 'Something went wrong — please try again.';
          errorBox.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send booking request';
        }
      });
    }).catch(function () {
      errorBox.textContent = 'No connection — please check your internet and try again.';
      errorBox.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send booking request';
    });
  });
})();
</script>`;
  return pageShell('Book with ' + shopName, inner);
}

function bookingNotActiveHtml() {
  const inner = `
<header class="band"><div class="wrap">
  <p class="brand">Wrenqo booking</p>
  <h1>This booking link is not active</h1>
  <p>Please contact the business directly to book.</p>
</div></header>
<main>
  <p>The business may have changed its booking link or turned online booking off. Calling or emailing them directly is the quickest way to book.</p>
</main>`;
  return pageShell('Booking link not active — Wrenqo', inner);
}

// ------------------------------------------- answers when booking is down
// Used both when booking is not configured at all (handleBookingUnavailable,
// exported for server.js) and when the database fails mid-request: the list
// keeps its 404 "not set up" meaning, the page keeps its friendly 404, and
// writes answer an honest 503.

function sendUnavailable(req, res, urlPath) {
  const kind = routeKind(req.method, urlPath);
  if (kind === 'list') {
    return jsonRes(res, 404, { ok: false, error: 'booking not set up' });
  }
  if (kind === 'page') {
    return htmlRes(res, 404, bookingNotActiveHtml());
  }
  return jsonRes(res, 503, { ok: false, error: 'booking unavailable' });
}

function handleBookingUnavailable(req, res, urlPath) {
  sendUnavailable(req, res, urlPath);
  return true;
}

// ---------------------------------------------------------------- handlers

function validCode(code) {
  return code.length >= 3 && code.length <= 60 && CODE_RE.test(code);
}

async function findShop(db, code) {
  const out = await db.query(
    'SELECT code, shop_name, email, enabled FROM booking_shops WHERE code = $1',
    [code]
  );
  return out.rows.length ? out.rows[0] : null;
}

async function handleRegister(req, res, db) {
  const data = await readJsonBody(req, res);
  if (data === null) return;
  const code = String(data.code || '').trim();
  const shopName = String(data.shopName || '').trim();
  const email = String(data.email || '').trim();
  if (!validCode(code)) {
    return jsonRes(res, 400, { ok: false, error: 'code must be 3-60 lowercase letters, digits or dashes' });
  }
  if (!EMAIL_RE.test(email)) {
    return jsonRes(res, 400, { ok: false, error: 'valid email required' });
  }
  // A non-boolean `enabled` counts as "not given" (default true), so an
  // old client sending something unexpected cannot break registration.
  const enabled = typeof data.enabled === 'boolean' ? data.enabled : true;
  await db.query(
    `INSERT INTO booking_shops (code, shop_name, email, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO UPDATE
       SET shop_name = EXCLUDED.shop_name,
           email = EXCLUDED.email,
           enabled = EXCLUDED.enabled`,
    [code, shopName, email, enabled]
  );
  return jsonRes(res, 200, { ok: true });
}

async function handleList(req, res, db) {
  let shopCode = '';
  try {
    shopCode = new URL(req.url, 'http://localhost').searchParams.get('shop') || '';
  } catch (e) {
    shopCode = '';
  }
  const shop = shopCode ? await findShop(db, shopCode) : null;
  if (!shop) {
    return jsonRes(res, 404, { ok: false, error: 'booking not set up' });
  }
  // Listing still works for a disabled shop — it can see past requests;
  // only new submissions are blocked.
  const out = await db.query(
    `SELECT id, customer_name, phone, email, address, trade, service,
            preferred_date, notes, status, created_at
     FROM booking_requests WHERE code = $1
     ORDER BY created_at DESC LIMIT $2`,
    [shop.code, MAX_REQUESTS_LISTED]
  );
  const requests = out.rows.map((r) => ({
    id: r.id,
    customerName: r.customer_name || '',
    phone: r.phone || '',
    email: r.email || '',
    address: r.address || '',
    trade: r.trade || '',
    service: r.service || '',
    preferredDate: r.preferred_date ? String(r.preferred_date) : null,
    notes: r.notes || '',
    status: r.status || 'pending',
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || ''),
  }));
  return jsonRes(res, 200, { ok: true, shopName: shop.shop_name || '', requests });
}

async function handlePage(req, res, db, urlPath) {
  const code = pathSegment(urlPath, PAGE_RE);
  const shop = code ? await findShop(db, code) : null;
  if (!shop || shop.enabled === false) {
    return htmlRes(res, 404, bookingNotActiveHtml());
  }
  return htmlRes(res, 200, bookingPageHtml(shop));
}

async function handleSubmit(req, res, db, sendMail, urlPath) {
  const code = pathSegment(urlPath, SUBMIT_RE);
  const data = await readJsonBody(req, res);
  if (data === null) return;
  const shop = code ? await findShop(db, code) : null;
  if (!shop) {
    return jsonRes(res, 404, { ok: false, error: 'booking not set up' });
  }
  if (shop.enabled === false) {
    return jsonRes(res, 404, { ok: false, error: 'booking is off' });
  }
  const customerName = String(data.customerName || '').trim();
  const service = String(data.service || '').trim();
  const phone = String(data.phone || '').trim();
  const email = String(data.email || '').trim();
  if (!customerName || !service) {
    return jsonRes(res, 400, { ok: false, error: 'your name and the service you need are required' });
  }
  if (!phone && !email) {
    return jsonRes(res, 400, { ok: false, error: 'a phone number or email is required so the business can reach you' });
  }
  if (email && !EMAIL_RE.test(email)) {
    return jsonRes(res, 400, { ok: false, error: 'valid email required' });
  }
  const record = {
    id: crypto.randomBytes(16).toString('hex'),
    code: shop.code,
    customerName,
    phone,
    email,
    address: String(data.address || '').trim(),
    trade: String(data.trade || '').trim(),
    service,
    preferredDate: String(data.preferredDate || '').trim() || null,
    notes: String(data.notes || '').trim(),
  };
  await db.query(
    `INSERT INTO booking_requests
       (id, code, customer_name, phone, email, address, trade, service, preferred_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      record.id, record.code, record.customerName, record.phone, record.email,
      record.address, record.trade, record.service, record.preferredDate, record.notes,
    ]
  );
  const text = [
    'New booking request for ' + (shop.shop_name || shop.code),
    '',
    'Customer: ' + record.customerName,
    'Phone: ' + (record.phone || '-'),
    'Email: ' + (record.email || '-'),
    'Address: ' + (record.address || '-'),
    'Trade: ' + (record.trade || '-'),
    'Service: ' + record.service,
    'Preferred date: ' + (record.preferredDate || '-'),
    'Notes: ' + (record.notes || '-'),
    '',
    'This request is also waiting for you in the Wrenqo app — open',
    'Bookings there to accept or decline it.',
  ].join('\n');
  let mailed = false;
  try {
    mailed = !!(await sendMail({
      to: shop.email,
      subject: 'New booking request — ' + record.service,
      text,
    }));
  } catch (e) {
    console.error('booking mail error', e);
    mailed = false;
  }
  return jsonRes(res, 200, { ok: true, id: record.id, mailed });
}

async function handleRespond(req, res, db, sendMail, urlPath) {
  const id = pathSegment(urlPath, RESPOND_RE);
  const data = await readJsonBody(req, res);
  if (data === null) return;
  const status = String(data.status || '');
  if (status !== 'accepted' && status !== 'declined') {
    return jsonRes(res, 400, { ok: false, error: "status must be 'accepted' or 'declined'" });
  }
  const found = await db.query(
    `SELECT b.id, b.customer_name, b.email, b.service, b.trade, b.preferred_date,
            s.shop_name AS shop_name
     FROM booking_requests b
     LEFT JOIN booking_shops s ON s.code = b.code
     WHERE b.id = $1`,
    [id]
  );
  if (!found.rows.length) {
    return jsonRes(res, 404, { ok: false, error: 'booking not found' });
  }
  await db.query('UPDATE booking_requests SET status = $1 WHERE id = $2', [status, id]);
  const booking = found.rows[0];
  if (status === 'accepted' && booking.email) {
    const text = [
      'Hi ' + (booking.customer_name || 'there') + ',',
      '',
      'Good news — your booking request with ' +
        (booking.shop_name || 'the business') + ' has been accepted.',
      '',
      'Service: ' + (booking.service || booking.trade || '-'),
      'Preferred date: ' + (booking.preferred_date || '-'),
      '',
      'The business will be in touch to confirm the time.',
      '',
      'Thanks,',
      'The Wrenqo team',
    ].join('\n');
    try {
      const sent = await sendMail({ to: booking.email, subject: 'Your booking is accepted', text });
      if (!sent) console.error('booking confirmation mail failed for', booking.id);
    } catch (e) {
      console.error('booking confirmation mail error', e);
    }
  }
  return jsonRes(res, 200, { ok: true });
}

// ------------------------------------------------------------------ router

// Returns an async route handler (req, res, urlPath) => boolean: true
// when the request matched a booking route (response fully handled),
// false when it did not. urlPath is the query-stripped path, exactly as
// the live server.js computes it.
function registerBookingRoutes(ctx) {
  if (!ctx || !ctx.pool) {
    throw new Error('registerBookingRoutes: ctx.pool (a pg Pool) is required');
  }
  if (typeof ctx.sendMail !== 'function') {
    throw new Error('registerBookingRoutes: ctx.sendMail({to, subject, text}) is required');
  }
  const db = schemaFirstPool(ctx.pool);
  const sendMail = ctx.sendMail;
  return async function bookingRouteHandler(req, res, urlPath) {
    const kind = routeKind(req.method, urlPath);
    if (!kind) return false;
    try {
      if (kind === 'register') await handleRegister(req, res, db);
      else if (kind === 'list') await handleList(req, res, db);
      else if (kind === 'page') await handlePage(req, res, db, urlPath);
      else if (kind === 'submit') await handleSubmit(req, res, db, sendMail, urlPath);
      else if (kind === 'respond') await handleRespond(req, res, db, sendMail, urlPath);
      return true;
    } catch (err) {
      console.error('booking route error', err);
      if (!res.headersSent) {
        if (isDbFailure(err)) {
          // Same answers as the not-configured stub, per route kind.
          sendUnavailable(req, res, urlPath);
        } else if (kind === 'page') {
          htmlRes(res, 500, pageShell('Something went wrong — Wrenqo',
            '<main><p>Something went wrong loading this page. Please try again in a moment.</p></main>'));
        } else {
          jsonRes(res, 500, { ok: false, error: 'booking failed' });
        }
      }
      return true;
    }
  };
}

module.exports = { registerBookingRoutes, isBookingRoute, handleBookingUnavailable };
