// Wrenqo customer portal + owner web dashboard — server module
// (Postgres-backed).
//
// Two read-only web views over the data the app already syncs
// (sync_records, written by ./sync.js):
//
//   Customer portal — the shop gives one customer a private link,
//   /portal/<code>. The customer sees their own jobs and invoices
//   (with balances) — nothing else, no sign-in, the unguessable code
//   is the key, exactly like the booking page. The app registers the
//   code per customer (POST /api/portal/register).
//
//   Owner dashboard — /dashboard. The owner signs in with the same
//   email one-time code as the app (/api/auth/*) and sees the whole
//   business read-only: jobs, customers, invoices and what is owed.
//
// Fail-safe, mirroring booking/sync: with no DATABASE_URL (or an
// unreachable database) the API answers 503, the pages answer with a
// friendly "not available" page, and nothing else in the server is
// affected. Tables this module owns (portal_links) are created lazily.
//
// Usage:
//   const portal = require('./portal.js');
//   const portalHandler = portal.registerPortalRoutes({ pool, verifyAuthToken });
//   if (portal.isPortalRoute(req.method, urlPath)) { ... }

const MAX_BODY_BYTES = 64 * 1024;

const PORTAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portal_links (
  code TEXT PRIMARY KEY,
  business_id TEXT,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  shop_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// ------------------------------------------------------------ http helpers

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

function schemaFirstPool(rawPool) {
  let schemaPromise = null;
  function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = rawPool.query(PORTAL_SCHEMA_SQL).catch((e) => {
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

// ------------------------------------------------------------ data shaping

function parseItems(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function invoiceTotals(data) {
  const items = parseItems(data.items);
  const subtotal = items.reduce(
    (sum, li) => sum + (parseInt(li && li.priceCents, 10) || 0),
    0,
  );
  const taxBps = parseInt(data.taxRateBps, 10) || 0;
  const tax = Math.round((subtotal * taxBps) / 10000);
  return { subtotal, tax, total: subtotal + tax };
}

async function loadBusinessRecords(pool, businessId) {
  const { rows } = await pool.query(
    `SELECT entity, record_id, data, deleted FROM sync_records
      WHERE business_id = $1`,
    [businessId],
  );
  const byEntity = new Map();
  for (const row of rows) {
    if (row.deleted) continue;
    if (!byEntity.has(row.entity)) byEntity.set(row.entity, []);
    byEntity.get(row.entity).push(row.data || {});
  }
  return byEntity;
}

function shapeInvoices(records, payments) {
  const paidByInvoice = new Map();
  for (const p of payments) {
    const key = String(p.invoiceId || '');
    paidByInvoice.set(key, (paidByInvoice.get(key) || 0) + (parseInt(p.amountCents, 10) || 0));
  }
  return records.map((inv) => {
    const totals = invoiceTotals(inv);
    const paid = paidByInvoice.get(String(inv.id || '')) || 0;
    return {
      number: inv.number || '',
      title: inv.title || '',
      status: inv.status || '',
      totalCents: totals.total,
      paidCents: paid,
      balanceCents: Math.max(0, totals.total - paid),
      dueDate: inv.dueDate || null,
      createdAt: inv.createdAt || null,
    };
  });
}

function shapeJobs(records) {
  return records
    .map((j) => ({
      title: j.title || '',
      status: j.status || '',
      scheduledAt: j.scheduledAt || null,
      address: j.address || '',
      priceCents: parseInt(j.priceCents, 10) || 0,
      customerId: j.customerId || '',
    }))
    .sort((a, b) => String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')));
}

// ------------------------------------------------------------------- pages

function pageShell(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — Wrenqo</title>
<style>
  body { margin:0; font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background:#F5F7FA; color:#1A2A3A; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 20px 16px 40px; }
  header { background:#0F2A43; color:#fff; padding: 22px 16px; }
  header .wrap { padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  header p { margin: 0; color:#C7D3E0; font-size: 14px; }
  .brand { color:#E8A317; font-weight: 800; letter-spacing: .4px; font-size: 13px; text-transform: uppercase; }
  .card { background:#fff; border:1px solid #E2E8F0; border-radius: 14px; padding: 16px; margin-top: 14px; }
  .card h2 { font-size: 16px; margin: 0 0 10px; color:#0F2A43; }
  .row { display:flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-top: 1px solid #EEF2F6; }
  .row:first-of-type { border-top: none; }
  .muted { color:#5A6B7C; font-size: 13px; }
  .amt { font-weight: 700; white-space: nowrap; }
  .due { color:#B3261E; font-weight: 700; }
  .ok { color:#1E7D4D; font-weight: 700; }
  .chip { display:inline-block; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background:#E8F0FE; color:#0F2A43; }
  input { width: 100%; box-sizing: border-box; padding: 13px; font-size: 16px; border: 1px solid #CBD5E1; border-radius: 10px; margin: 6px 0 12px; }
  button { background:#E8A317; color:#0A1E30; border: none; font-weight: 800; font-size: 16px; padding: 14px 18px; border-radius: 10px; width: 100%; cursor: pointer; }
  button.secondary { background:#fff; border: 1px solid #CBD5E1; color:#0F2A43; margin-top: 10px; }
  .err { color:#B3261E; font-size: 14px; min-height: 18px; }
  footer { text-align:center; color:#5A6B7C; font-size: 12px; margin-top: 26px; }
</style>
</head>
<body>
${inner}
</body>
</html>`;
}

function portalPage(code, shopName) {
  const inner = `
<header><div class="wrap">
  <div class="brand">Wrenqo customer portal</div>
  <h1>${escapeHtml(shopName || 'Your service shop')}</h1>
  <p>Your jobs and invoices, kept up to date by your shop.</p>
</div></header>
<div class="wrap">
  <div id="content"><div class="card"><p class="muted">Loading your information…</p></div></div>
  <footer>Powered by Wrenqo · This page only shows your own jobs and invoices.</footer>
</div>
<script>
  var CODE = ${JSON.stringify(code)};
  function cents(c) { return '$' + (c / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
  function dateStr(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'}); }
  function statusLabel(s) { return ({scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Finished', invoiced: 'Invoiced', paid: 'Paid', draft: 'Draft', sent: 'Sent', partial: 'Partially paid', overdue: 'Overdue'})[s] || s; }
  fetch('/api/portal/data?code=' + encodeURIComponent(CODE))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var el = document.getElementById('content');
      if (!d.ok) { el.innerHTML = '<div class="card"><h2>Not available</h2><p class="muted">' + (d.error || 'This portal link is not active.') + '</p></div>'; return; }
      var html = '';
      html += '<div class="card"><h2>Your jobs</h2>';
      if (!d.jobs.length) html += '<p class="muted">No jobs on record yet.</p>';
      d.jobs.forEach(function(j) {
        html += '<div class="row"><div><div>' + j.title + '</div><div class="muted">' + dateStr(j.scheduledAt) + (j.address ? ' · ' + j.address : '') + '</div></div><span class="chip">' + statusLabel(j.status) + '</span></div>';
      });
      html += '</div>';
      html += '<div class="card"><h2>Your invoices</h2>';
      if (!d.invoices.length) html += '<p class="muted">No invoices yet.</p>';
      d.invoices.forEach(function(inv) {
        html += '<div class="row"><div><div>Invoice ' + inv.number + '</div><div class="muted">' + statusLabel(inv.status) + (inv.dueDate ? ' · Due ' + dateStr(inv.dueDate) : '') + '</div></div><div style="text-align:right"><div class="amt">' + cents(inv.totalCents) + '</div>' +
          (inv.balanceCents > 0 ? '<div class="due">Balance ' + cents(inv.balanceCents) + '</div>' : '<div class="ok">Paid in full</div>') + '</div></div>';
      });
      html += '</div>';
      if (d.totalBalanceCents > 0) html += '<div class="card"><h2>Total balance due: ' + cents(d.totalBalanceCents) + '</h2><p class="muted">Questions about a job or an invoice? Contact ' + (d.shopName || 'your shop') + ' directly.</p></div>';
      el.innerHTML = html;
    })
    .catch(function() {
      document.getElementById('content').innerHTML = '<div class="card"><h2>Could not load</h2><p class="muted">Please check your connection and refresh.</p></div>';
    });
</script>`;
  return pageShell('Customer portal', inner);
}

function dashboardPage() {
  const inner = `
<header><div class="wrap">
  <div class="brand">Wrenqo</div>
  <h1>Your business dashboard</h1>
  <p>Jobs, customers and invoices — the same data as your app, on the big screen. Read-only.</p>
</div></header>
<div class="wrap">
  <div id="signin" class="card">
    <h2>Sign in</h2>
    <p class="muted">Use the email you sign in to the Wrenqo app with. We email you a 6-digit code — no password.</p>
    <div id="step-email">
      <input id="email" type="email" placeholder="you@yourshop.com" autocomplete="email">
      <button id="send-code">Email me a code</button>
    </div>
    <div id="step-code" style="display:none">
      <input id="code" inputmode="numeric" placeholder="6-digit code">
      <button id="verify">Sign in</button>
      <button id="back" class="secondary">Use a different email</button>
    </div>
    <p class="err" id="err"></p>
  </div>
  <div id="content"></div>
  <footer>Wrenqo dashboard · Read-only — make changes in the app.</footer>
</div>
<script>
  var token = localStorage.getItem('wrenqo_dashboard_token') || '';
  function cents(c) { return '$' + (c / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
  function dateStr(s) { if (!s) return ''; var d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}); }
  function err(msg) { document.getElementById('err').textContent = msg || ''; }
  document.getElementById('send-code').onclick = function() {
    var email = document.getElementById('email').value.trim();
    if (!email) { err('Enter your email first.'); return; }
    err('');
    fetch('/api/auth/request-otp', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: email})})
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok) { err(d.error || 'Could not send the code.'); return; }
        document.getElementById('step-email').style.display = 'none';
        document.getElementById('step-code').style.display = 'block';
      })
      .catch(function() { err('Network error — try again.'); });
  };
  document.getElementById('back').onclick = function() {
    document.getElementById('step-email').style.display = 'block';
    document.getElementById('step-code').style.display = 'none';
  };
  document.getElementById('verify').onclick = function() {
    var email = document.getElementById('email').value.trim();
    var code = document.getElementById('code').value.trim();
    err('');
    fetch('/api/auth/verify-otp', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: email, code: code})})
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok || !d.token) { err(d.error || 'That code did not work.'); return; }
        token = d.token;
        localStorage.setItem('wrenqo_dashboard_token', token);
        load();
      })
      .catch(function() { err('Network error — try again.'); });
  };
  function load() {
    if (!token) return;
    fetch('/api/dashboard/data', {headers: {'Authorization': 'Bearer ' + token}})
      .then(function(r) { if (r.status === 401) { localStorage.removeItem('wrenqo_dashboard_token'); token = ''; throw new Error('auth'); } return r.json(); })
      .then(function(d) {
        if (!d.ok) throw new Error('load');
        document.getElementById('signin').style.display = 'none';
        var html = '';
        html += '<div class="card"><h2>Overview</h2>' +
          '<div class="row"><span>Customers</span><span class="amt">' + d.counts.customers + '</span></div>' +
          '<div class="row"><span>Jobs</span><span class="amt">' + d.counts.jobs + '</span></div>' +
          '<div class="row"><span>Invoices</span><span class="amt">' + d.counts.invoices + '</span></div>' +
          '<div class="row"><span>Owed to you</span><span class="due">' + cents(d.totalBalanceCents) + '</span></div>' +
          '<button class="secondary" id="signout">Sign out</button></div>';
        html += '<div class="card"><h2>Jobs</h2>';
        if (!d.jobs.length) html += '<p class="muted">No jobs synced yet. Jobs appear here after the app syncs.</p>';
        d.jobs.slice(0, 30).forEach(function(j) {
          html += '<div class="row"><div><div>' + j.title + '</div><div class="muted">' + (d.customerNames[j.customerId] || '') + (j.scheduledAt ? ' · ' + dateStr(j.scheduledAt) : '') + '</div></div><span class="chip">' + j.status + '</span></div>';
        });
        html += '</div>';
        html += '<div class="card"><h2>Invoices</h2>';
        if (!d.invoices.length) html += '<p class="muted">No invoices synced yet.</p>';
        d.invoices.slice(0, 30).forEach(function(inv) {
          html += '<div class="row"><div><div>Invoice ' + inv.number + '</div><div class="muted">' + inv.status + '</div></div><div style="text-align:right"><div class="amt">' + cents(inv.totalCents) + '</div>' + (inv.balanceCents > 0 ? '<div class="due">Balance ' + cents(inv.balanceCents) + '</div>' : '<div class="ok">Paid in full</div>') + '</div></div>';
        });
        html += '</div>';
        document.getElementById('content').innerHTML = html;
        document.getElementById('signout').onclick = function() { localStorage.removeItem('wrenqo_dashboard_token'); location.reload(); };
      })
      .catch(function(e) { if (String(e.message) !== 'auth') err('Could not load your data — refresh to try again.'); });
  }
  if (token) load();
</script>`;
  return pageShell('Dashboard', inner);
}

function unavailablePage(what) {
  return pageShell(
    what,
    `<div class="wrap"><div class="card"><h2>Not available right now</h2>
     <p class="muted">This page needs the Wrenqo cloud service, which is not reachable at the moment. Please try again later — your data in the app is unaffected.</p></div></div>`,
  );
}

// ------------------------------------------------------------------ routes

function isPortalRoute(method, urlPath) {
  if (method === 'POST' && urlPath === '/api/portal/register') return true;
  if (method === 'GET' && urlPath === '/api/portal/data') return true;
  if (method === 'GET' && urlPath.startsWith('/portal/')) return true;
  if (method === 'GET' && urlPath === '/dashboard') return true;
  if (method === 'GET' && urlPath === '/api/dashboard/data') return true;
  return false;
}

function handlePortalUnavailable(req, res, urlPath) {
  if (urlPath.startsWith('/api/')) {
    return jsonRes(res, 503, { ok: false, error: 'portal unavailable' });
  }
  return htmlRes(res, 503, unavailablePage('Wrenqo'));
}

function registerPortalRoutes(ctx) {
  if (!ctx || !ctx.pool) {
    throw new Error('registerPortalRoutes: ctx.pool (a pg Pool) is required');
  }
  if (typeof ctx.verifyAuthToken !== 'function') {
    throw new Error('registerPortalRoutes: ctx.verifyAuthToken is required');
  }
  const pool = schemaFirstPool(ctx.pool);
  const verifyAuthToken = ctx.verifyAuthToken;

  async function businessIdForEmail(email) {
    try {
      const { rows } = await pool.query(
        `SELECT business_id FROM members WHERE email = $1
          ORDER BY (role = 'owner') DESC LIMIT 1`,
        [String(email || '').toLowerCase()],
      );
      return rows.length ? rows[0].business_id : null;
    } catch (e) {
      return null; // members table may not exist until first sync
    }
  }

  return async function portalHandler(req, res, urlPath) {
    // -- portal register (the app, per customer) -------------------------
    if (req.method === 'POST' && urlPath === '/api/portal/register') {
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const code = String(body.code || '').trim();
      const customerId = String(body.customerId || '').trim();
      if (!code || !customerId) {
        jsonRes(res, 400, { ok: false, error: 'code and customerId are required' });
        return true;
      }
      try {
        const businessId = await businessIdForEmail(body.email);
        await pool.query(
          `INSERT INTO portal_links (code, business_id, customer_id, customer_name, shop_name, email)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (code) DO UPDATE SET business_id = EXCLUDED.business_id,
             customer_id = EXCLUDED.customer_id, customer_name = EXCLUDED.customer_name,
             shop_name = EXCLUDED.shop_name, email = EXCLUDED.email`,
          [
            code,
            businessId,
            customerId,
            String(body.customerName || ''),
            String(body.shopName || ''),
            String(body.email || '').toLowerCase(),
          ],
        );
        jsonRes(res, 200, { ok: true });
      } catch (e) {
        if (isDbFailure(e)) {
          jsonRes(res, 503, { ok: false, error: 'portal unavailable' });
        } else {
          console.error('portal register error', e.message);
          jsonRes(res, 500, { ok: false, error: 'could not register portal' });
        }
      }
      return true;
    }

    // -- portal data (public, by code) ------------------------------------
    if (req.method === 'GET' && urlPath === '/api/portal/data') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const code = String(query.get('code') || '').trim();
      if (!code) {
        jsonRes(res, 400, { ok: false, error: 'code is required' });
        return true;
      }
      try {
        const { rows } = await pool.query(
          'SELECT * FROM portal_links WHERE code = $1',
          [code],
        );
        if (!rows.length) {
          jsonRes(res, 404, { ok: false, error: 'This portal link is not active.' });
          return true;
        }
        const link = rows[0];
        let jobs = [];
        let invoices = [];
        if (link.business_id) {
          const records = await loadBusinessRecords(pool, link.business_id);
          jobs = shapeJobs(
            (records.get('jobs') || []).filter(
              (j) => String(j.customerId || '') === link.customer_id,
            ),
          );
          invoices = shapeInvoices(
            (records.get('invoices') || []).filter(
              (i) => String(i.customerId || '') === link.customer_id,
            ),
            records.get('payments') || [],
          );
        }
        jsonRes(res, 200, {
          ok: true,
          shopName: link.shop_name,
          customerName: link.customer_name,
          jobs,
          invoices,
          totalBalanceCents: invoices.reduce((s, i) => s + i.balanceCents, 0),
        });
      } catch (e) {
        if (isDbFailure(e)) {
          jsonRes(res, 503, { ok: false, error: 'portal unavailable' });
        } else {
          console.error('portal data error', e.message);
          jsonRes(res, 500, { ok: false, error: 'could not load portal' });
        }
      }
      return true;
    }

    // -- portal page --------------------------------------------------------
    if (req.method === 'GET' && urlPath.startsWith('/portal/')) {
      const code = decodeURIComponent(urlPath.slice('/portal/'.length));
      let shopName = '';
      try {
        const { rows } = await pool.query(
          'SELECT shop_name FROM portal_links WHERE code = $1',
          [code],
        );
        if (!rows.length) {
          htmlRes(res, 404, unavailablePage('Portal not found'));
          return true;
        }
        shopName = rows[0].shop_name;
      } catch (e) {
        htmlRes(res, 503, unavailablePage('Customer portal'));
        return true;
      }
      htmlRes(res, 200, portalPage(code, shopName));
      return true;
    }

    // -- dashboard page -----------------------------------------------------
    if (req.method === 'GET' && urlPath === '/dashboard') {
      htmlRes(res, 200, dashboardPage());
      return true;
    }

    // -- dashboard data (owner, Bearer auth) --------------------------------
    if (req.method === 'GET' && urlPath === '/api/dashboard/data') {
      const header = String(req.headers['authorization'] || '');
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const email = verifyAuthToken(token);
      if (!email) {
        jsonRes(res, 401, { ok: false, error: 'invalid token' });
        return true;
      }
      try {
        const businessId = await businessIdForEmail(email);
        if (!businessId) {
          jsonRes(res, 200, {
            ok: true,
            counts: { customers: 0, jobs: 0, invoices: 0 },
            jobs: [],
            invoices: [],
            customerNames: {},
            totalBalanceCents: 0,
          });
          return true;
        }
        const records = await loadBusinessRecords(pool, businessId);
        const customers = records.get('customers') || [];
        const customerNames = {};
        for (const c of customers) customerNames[String(c.id || '')] = c.name || '';
        const invoices = shapeInvoices(
          records.get('invoices') || [],
          records.get('payments') || [],
        );
        jsonRes(res, 200, {
          ok: true,
          counts: {
            customers: customers.length,
            jobs: (records.get('jobs') || []).length,
            invoices: invoices.length,
          },
          jobs: shapeJobs(records.get('jobs') || []),
          invoices,
          customerNames,
          totalBalanceCents: invoices.reduce((s, i) => s + i.balanceCents, 0),
        });
      } catch (e) {
        if (isDbFailure(e)) {
          jsonRes(res, 503, { ok: false, error: 'dashboard unavailable' });
        } else {
          console.error('dashboard data error', e.message);
          jsonRes(res, 500, { ok: false, error: 'could not load dashboard' });
        }
      }
      return true;
    }

    return false;
  };
}

module.exports = { registerPortalRoutes, isPortalRoute, handlePortalUnavailable };
