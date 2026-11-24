// Wrenqo cloud sync — server module (Postgres-backed, foundation v1).
//
// This is the copy wired into server.js (integration steps live in
// NOTES.md in the wrenqo-sync folder). One deliberate change from that
// source: the router's error catch maps database/connection failures to
// 503 { ok:false, error:'sync unavailable' } instead of a generic 500,
// so a down database degrades sync honestly and never affects the site. The module is dependency-light: the only
// external package it needs is 'pg', and even that is injected — the
// caller creates the Pool and passes it in via ctx.
//
// Usage:
//   const { registerSyncRoutes } = require('./sync.js');
//   const syncHandler = registerSyncRoutes({ pool, verifyToken });
//   // inside http.createServer (which must be async once this is wired):
//   if (await syncHandler(req, res, urlPath)) return;
//
// ctx:
//   pool        — a pg Pool connected to the sync database (schema.sql
//                 applied). Required.
//   verifyToken — optional (req) => email | null, called with the raw
//                 request; must validate the "Authorization: Bearer
//                 <token>" header against the SAME token format the live
//                 server issues in /api/auth/verify-otp (base64url JSON
//                 payload {email, exp} + '.' + HMAC-SHA256 base64url,
//                 key = AUTH_SECRET || POLAR_WEBHOOK_SECRET). When
//                 omitted, ctx.verifyAuthToken (a (token) => email|null
//                 function, e.g. the live server's verifyAuthToken) is
//                 wrapped instead; when that is omitted too, an internal
//                 copy of the live server's verifier is used with
//                 ctx.authKey || AUTH_SECRET || POLAR_WEBHOOK_SECRET.
//
// Routes (all require a valid Bearer token; 401 otherwise):
//   POST /api/sync/push   { records: [{ entity, id, data, updated_at,
//                         deleted }] } -> { ok, accepted, serverTime }
//   GET  /api/sync/pull?since=<iso>    -> { ok, records, serverTime,
//                                           hasMore }
//   POST /api/team/invite              -> { ok, code, expiresAt }
//                         (owner only)
//   POST /api/team/join   { code }     -> { ok, businessId, role }
//
// Tenancy rule (hard): a caller only ever touches the records of the
// business they belong to. Business resolution: the caller's memberships
// are read by email; a technician membership (an explicit join) wins
// over the caller's own auto-created business; with no membership at
// all, a business is auto-created with the caller as owner.
'use strict';

const crypto = require('crypto');

// Same entity set as the app's local SQLite tables (database.dart) and
// the Stage 2 prepared sync code. 'messages' is the in-app messaging
// entity: a message record is generic JSON { id, conversationKey,
// senderName, text, at } where conversationKey is 'job:<jobId>' |
// 'customer:<customerId>' | 'team:<businessId>'. Messages sync through
// the same Postgres table, Bearer auth and business scoping as every
// other entity — no new table, no new endpoint. Push notifications
// (FCM) are a separate job: they need a Firebase project and are NOT
// part of this sync entity; the app polls/pulls for new messages.
const SYNC_ENTITIES = new Set([
  'customers', 'jobs', 'quotes', 'invoices', 'price_book', 'equipment', 'reminders',
  'messages',
]);
const MAX_PUSH_RECORDS = 500; // mirrors the Stage 2 MAX_SYNC_CHANGES
const MAX_PULL_RECORDS = 5000;
const MAX_BODY_BYTES = 1000000; // mirrors the Stage 2 sync body cap
const MAX_SMALL_BODY_BYTES = 100000;
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L look-alikes
const INVITE_CODE_LENGTH = 6;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

// ------------------------------------------------------------ http helpers
// Mirrors the live server.js conventions (its jsonRes + the prepared sync
// code's body reader): JSON responses, a byte-capped body read, and a 400
// on unparseable JSON instead of a silent {}.

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
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
async function readJsonBody(req, res, maxBytes) {
  let raw = '';
  try {
    raw = await readBody(req, maxBytes || MAX_SMALL_BODY_BYTES);
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

// ------------------------------------------------------------------- auth

function bearerToken(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

// Verbatim-equivalent of the live server.js verifyAuthToken, with the
// key passed in (the live one reads AUTH_SECRET || POLAR_WEBHOOK_SECRET
// via its authKey()).
function verifyTokenString(token, key) {
  if (!key || !token) return null;
  const dot = String(token).lastIndexOf('.');
  if (dot < 0) return null;
  const payload = String(token).slice(0, dot);
  const sig = String(token).slice(dot + 1);
  const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.email || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return String(data.email);
  } catch (e) {
    return null;
  }
}

function buildVerifyToken(ctx) {
  if (typeof ctx.verifyToken === 'function') return ctx.verifyToken;
  if (typeof ctx.verifyAuthToken === 'function') {
    const verifyAuthToken = ctx.verifyAuthToken;
    return (req) => verifyAuthToken(bearerToken(req));
  }
  const key = String(ctx.authKey || process.env.AUTH_SECRET || process.env.POLAR_WEBHOOK_SECRET || '');
  return (req) => verifyTokenString(bearerToken(req), key);
}

// Returns the caller's lowercased email, or null after sending a 401.
async function requireAuth(req, res, verifyToken) {
  const email = await verifyToken(req);
  if (!email) {
    jsonRes(res, 401, { ok: false, error: 'invalid token' });
    return null;
  }
  return String(email).trim().toLowerCase();
}

// ------------------------------------------------------- business tenancy

async function findMembership(db, email) {
  // A technician membership is an explicit join, so it wins over the
  // caller's own (possibly auto-created, empty) business.
  const out = await db.query(
    `SELECT business_id, role FROM members WHERE email = $1
     ORDER BY (role = 'technician') DESC, joined_at ASC LIMIT 1`,
    [email]
  );
  if (!out.rows.length) return null;
  return { businessId: out.rows[0].business_id, role: out.rows[0].role };
}

// The caller's business: their membership if they have one, otherwise a
// fresh business owned by them (created in a transaction; the partial
// unique index on members(email) WHERE role='owner' makes a concurrent
// first-sync race resolve to a re-read instead of a second business).
async function resolveBusiness(pool, email) {
  const existing = await findMembership(pool, email);
  if (existing) return existing;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      'INSERT INTO businesses (owner_email) VALUES ($1) RETURNING id',
      [email]
    );
    const businessId = created.rows[0].id;
    await client.query(
      `INSERT INTO members (business_id, email, role) VALUES ($1, $2, 'owner')`,
      [businessId, email]
    );
    await client.query('COMMIT');
    return { businessId, role: 'owner' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e && e.code === '23505') {
      const again = await findMembership(pool, email);
      if (again) return again;
    }
    throw e;
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------- push/pull

function validateRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const entity = r.entity;
  const id = r.id === undefined || r.id === null ? '' : String(r.id);
  const updatedMs = Date.parse(String(r.updated_at || ''));
  const deleted = r.deleted === true;
  const data = r.data === undefined ? null : r.data;
  const dataIsObject = data !== null && typeof data === 'object' && !Array.isArray(data);
  if (!SYNC_ENTITIES.has(entity)) return null;
  if (!id || id.length > 128) return null;
  if (Number.isNaN(updatedMs)) return null;
  if (!deleted && !dataIsObject) return null;
  if (data !== null && !dataIsObject) return null;
  return {
    entity,
    id,
    data: deleted && data === null ? null : data,
    updatedAt: new Date(updatedMs).toISOString(),
    deleted,
  };
}

const UPSERT_SQL = `
  INSERT INTO sync_records (business_id, entity, record_id, data, updated_at, deleted)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (business_id, entity, record_id) DO UPDATE
    SET data = EXCLUDED.data,
        updated_at = EXCLUDED.updated_at,
        deleted = EXCLUDED.deleted,
        received_at = now()
    WHERE EXCLUDED.updated_at > sync_records.updated_at`;

async function handleSyncPush(req, res, pool, verifyToken) {
  const email = await requireAuth(req, res, verifyToken);
  if (!email) return;
  const data = await readJsonBody(req, res, MAX_BODY_BYTES);
  if (data === null) return;
  if (!Array.isArray(data.records)) {
    return jsonRes(res, 400, { ok: false, error: 'records must be an array' });
  }
  if (data.records.length > MAX_PUSH_RECORDS) {
    return jsonRes(res, 400, { ok: false, error: 'too many records (max 500)' });
  }
  const records = [];
  for (const r of data.records) {
    const v = validateRecord(r);
    if (!v) return jsonRes(res, 400, { ok: false, error: 'invalid record in records' });
    records.push(v);
  }
  const biz = await resolveBusiness(pool, email);
  // Server-side role rule (the app UI also blocks this, but the server
  // is the authority): a technician can create and update records, but
  // can never delete the business's records. Delete tombstones from a
  // technician are skipped, not rejected, so the rest of the batch
  // still syncs and the app's queue drains normally.
  const isTechnician = biz.role === 'technician';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let accepted = 0;
    let skippedDeletes = 0;
    for (const rec of records) {
      if (isTechnician && rec.deleted) {
        skippedDeletes += 1;
        continue;
      }
      const out = await client.query(UPSERT_SQL, [
        biz.businessId,
        rec.entity,
        rec.id,
        rec.data === null ? null : JSON.stringify(rec.data),
        rec.updatedAt,
        rec.deleted,
      ]);
      // rowCount is 0 when the stored copy was newer (last-write-wins
      // kept the server copy) — that record is not counted as accepted.
      accepted += out.rowCount;
    }
    await client.query('COMMIT');
    return jsonRes(res, 200, {
      ok: true,
      accepted,
      skippedDeletes,
      serverTime: new Date().toISOString(),
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function handleSyncPull(req, res, pool, verifyToken) {
  const email = await requireAuth(req, res, verifyToken);
  if (!email) return;
  let sinceMs = 0;
  try {
    const since = new URL(req.url, 'http://localhost').searchParams.get('since');
    const parsed = since ? Date.parse(since) : NaN;
    if (!Number.isNaN(parsed)) sinceMs = parsed;
  } catch (e) {
    sinceMs = 0; // unparseable URL: fall back to a full pull
  }
  const biz = await resolveBusiness(pool, email);
  const out = await pool.query(
    `SELECT entity, record_id, data, updated_at, deleted FROM sync_records
     WHERE business_id = $1 AND updated_at > $2
     ORDER BY updated_at ASC, entity ASC, record_id ASC
     LIMIT $3`,
    [biz.businessId, new Date(sinceMs).toISOString(), MAX_PULL_RECORDS]
  );
  const records = out.rows.map((r) => ({
    entity: r.entity,
    id: r.record_id,
    data: r.data,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    deleted: r.deleted,
  }));
  return jsonRes(res, 200, {
    ok: true,
    records,
    serverTime: new Date().toISOString(),
    // True when the cap was hit: the client should pull again with
    // since = the last record's updated_at.
    hasMore: out.rows.length === MAX_PULL_RECORDS,
  });
}

// ------------------------------------------------------------------- team

function generateInviteCode() {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_ALPHABET[crypto.randomInt(0, INVITE_ALPHABET.length)];
  }
  return code;
}

async function handleTeamInvite(req, res, pool, verifyToken) {
  const email = await requireAuth(req, res, verifyToken);
  if (!email) return;
  const biz = await resolveBusiness(pool, email);
  if (biz.role !== 'owner') {
    return jsonRes(res, 403, { ok: false, error: 'only the business owner can invite' });
  }
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  // Codes are the table's primary key; regenerate on the (very unlikely)
  // collision with an existing code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      await pool.query(
        `INSERT INTO invite_codes (code, business_id, created_by, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [code, biz.businessId, email, expiresAt.toISOString()]
      );
      return jsonRes(res, 200, { ok: true, code, expiresAt: expiresAt.toISOString() });
    } catch (e) {
      if (!e || e.code !== '23505') throw e;
    }
  }
  return jsonRes(res, 500, { ok: false, error: 'could not create invite code' });
}

async function handleTeamJoin(req, res, pool, verifyToken) {
  const email = await requireAuth(req, res, verifyToken);
  if (!email) return;
  const data = await readJsonBody(req, res, MAX_SMALL_BODY_BYTES);
  if (data === null) return;
  const code = String(data.code || '').trim().toUpperCase();
  if (!code) {
    return jsonRes(res, 400, { ok: false, error: 'code required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT code, business_id, expires_at, used_by FROM invite_codes WHERE code = $1 FOR UPDATE',
      [code]
    );
    if (!found.rows.length) {
      await client.query('ROLLBACK');
      return jsonRes(res, 400, { ok: false, error: 'invalid invite code' });
    }
    const invite = found.rows[0];
    // Already a member of that business (e.g. its owner, or a technician
    // re-entering a code): report the existing role, don't consume it.
    const member = await client.query(
      'SELECT role FROM members WHERE business_id = $1 AND email = $2',
      [invite.business_id, email]
    );
    if (member.rows.length) {
      await client.query('COMMIT');
      return jsonRes(res, 200, { ok: true, businessId: invite.business_id, role: member.rows[0].role });
    }
    if (invite.used_by) {
      await client.query('ROLLBACK');
      return jsonRes(res, 400, { ok: false, error: 'invite code already used' });
    }
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK');
      return jsonRes(res, 400, { ok: false, error: 'invite code expired' });
    }
    await client.query(
      `INSERT INTO members (business_id, email, role) VALUES ($1, $2, 'technician')
       ON CONFLICT (business_id, email) DO NOTHING`,
      [invite.business_id, email]
    );
    await client.query('UPDATE invite_codes SET used_by = $2 WHERE code = $1', [code, email]);
    await client.query('COMMIT');
    return jsonRes(res, 200, { ok: true, businessId: invite.business_id, role: 'technician' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ router

// Returns an async route handler (req, res, urlPath) => boolean: true
// when the request matched a sync/team route (response fully handled),
// false when it did not (the caller falls through to its own routing).
// urlPath is the query-stripped path, exactly as the live server.js
// computes it.
function registerSyncRoutes(ctx) {
  if (!ctx || !ctx.pool) {
    throw new Error('registerSyncRoutes: ctx.pool (a pg Pool) is required');
  }
  const pool = ctx.pool;
  const verifyToken = buildVerifyToken(ctx);
  return async function syncRouteHandler(req, res, urlPath) {
    try {
      if (req.method === 'POST' && urlPath === '/api/sync/push') {
        await handleSyncPush(req, res, pool, verifyToken);
        return true;
      }
      if (req.method === 'GET' && urlPath === '/api/sync/pull') {
        await handleSyncPull(req, res, pool, verifyToken);
        return true;
      }
      if (req.method === 'POST' && urlPath === '/api/team/invite') {
        await handleTeamInvite(req, res, pool, verifyToken);
        return true;
      }
      if (req.method === 'POST' && urlPath === '/api/team/join') {
        await handleTeamJoin(req, res, pool, verifyToken);
        return true;
      }
      return false;
    } catch (err) {
      console.error('sync route error', err);
      if (!res.headersSent) {
        // Every unhandled throw in the handlers above is a database
        // failure (auth and validation answer directly): connection
        // errors carry a syscall code (ECONNREFUSED, ETIMEDOUT, ...) or
        // a SQLSTATE in the 08xxx connection-exception class.
        const code = String((err && err.code) || '');
        const isDbFailure =
          code.startsWith('08') ||
          ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EPIPE'].includes(code) ||
          /connect|connection|timeout/i.test(String((err && err.message) || ''));
        if (isDbFailure) {
          jsonRes(res, 503, { ok: false, error: 'sync unavailable' });
        } else {
          jsonRes(res, 500, { ok: false, error: 'sync failed' });
        }
      }
      return true;
    }
  };
}

module.exports = { registerSyncRoutes, SYNC_ENTITIES };
