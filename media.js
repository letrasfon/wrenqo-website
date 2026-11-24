// Wrenqo media upload/download — server module.
//
// Job photos, signatures and voice notes uploaded from the app so the
// owner can see a technician's media from another device / the web
// dashboard. (Photos/voice/signatures never leave the device in the
// app today; this endpoint is the server half of that gap.)
//
//   POST /api/media/upload   { name, mime, data } (base64 JSON)
//                           -> 200 { ok: true, id, url }
//   GET  /api/media/:id      -> the file bytes (business-scoped)
//
// Images only (jpeg/png/webp), max 10 MB, magic-byte checked against
// the claimed mime. Files live under MEDIA_DIR (default
// ./media-uploads). Metadata goes to Postgres (media_files) when a
// pool is given, otherwise to media-files.jsonl next to this module —
// the same fail-safe split as the other modules: no DATABASE_URL
// still works, an unwritable directory answers 503, a missing token
// answers 401. No public access without a Bearer token, and a
// business can only fetch its own files (in JSONL mode the uploader's
// email is the scope).
//
// NOTE: on Railway the upload directory is the container's ephemeral
// disk — files are lost on redeploy, exactly like the jsonl stores.
// Durable storage (e.g. Cloudflare R2 / S3, with MEDIA_DIR pointing
// at a mounted volume or an object-store adapter) is the next step;
// this module is the API + metadata shape for it.
//
// Usage:
//   const media = require('./media.js');
//   const mediaHandler = media.registerMediaRoutes({ pool, verifyAuthToken });
//   // pool may be null (JSONL mode). verifyAuthToken is required.
//   if (media.isMediaRoute(req.method, urlPath)) { ... }
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 10 MB of file bytes is ~13.4 MB of base64, plus the JSON wrapper.
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME = {
  'image/jpeg': { ext: '.jpg', magic: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: '.png', magic: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  'image/webp': { ext: '.webp', magic: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};

const MEDIA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS media_files (
  id          TEXT PRIMARY KEY,
  business_id TEXT,
  owner_email TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL,
  size        BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_files_business_idx
  ON media_files (business_id);
`;

// ------------------------------------------------------------ http helpers
// Mirrors sync.js / portal.js conventions: JSON responses, a byte-capped
// body read, and a 400 on unparseable JSON instead of a silent {}.

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
      schemaPromise = rawPool.query(MEDIA_SCHEMA_SQL).catch((e) => {
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

// ---------------------------------------------------------- metadata store
// Postgres when a pool is given, otherwise a JSONL file next to this
// module (same shape as the server's other jsonl stores).

function jsonlPath() {
  return path.join(__dirname, 'media-files.jsonl');
}

function readJsonlRecords() {
  try {
    const p = jsonlPath();
    if (!fs.existsSync(p)) return [];
    const out = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* skip bad line */ }
    }
    return out;
  } catch (e) {
    return [];
  }
}

function mediaDir() {
  return String(process.env.MEDIA_DIR || path.join(__dirname, 'media-uploads'));
}

// ------------------------------------------------------------------ routes

function isMediaRoute(method, urlPath) {
  if (method === 'POST' && urlPath === '/api/media/upload') return true;
  if (method === 'GET' && urlPath.startsWith('/api/media/')) return true;
  return false;
}

function handleMediaUnavailable(req, res, urlPath) {
  return jsonRes(res, 503, { ok: false, error: 'media unavailable' });
}

function registerMediaRoutes(ctx) {
  if (!ctx || typeof ctx.verifyAuthToken !== 'function') {
    throw new Error('registerMediaRoutes: ctx.verifyAuthToken is required');
  }
  const verifyAuthToken = ctx.verifyAuthToken;
  // pool is optional: null means JSONL metadata mode (no DATABASE_URL).
  const pool = ctx.pool ? schemaFirstPool(ctx.pool) : null;

  // The caller's business id (owner-first, like portal.js), or null
  // when there is no members table to ask (JSONL mode).
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

  async function findRecord(id) {
    if (pool) {
      const { rows } = await pool.query(
        'SELECT id, business_id, owner_email, name, mime, size FROM media_files WHERE id = $1',
        [id]
      );
      return rows.length ? rows[0] : null;
    }
    return readJsonlRecords().find((r) => String(r.id) === id) || null;
  }

  async function storeRecord(rec) {
    if (pool) {
      await pool.query(
        `INSERT INTO media_files (id, business_id, owner_email, name, mime, size)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rec.id, rec.businessId, rec.ownerEmail, rec.name, rec.mime, rec.size]
      );
      return;
    }
    fs.appendFileSync(jsonlPath(), JSON.stringify(rec) + '\n');
  }

  function canAccess(rec, email, businessId) {
    if (!rec) return false;
    // Postgres mode: business-scoped. JSONL mode: the uploader's email.
    if (rec.businessId) return businessId !== null && String(rec.businessId) === String(businessId);
    if (rec.ownerEmail) return String(rec.ownerEmail).toLowerCase() === String(email).toLowerCase();
    return false;
  }

  async function handleUpload(req, res) {
    const email = verifyAuthToken(bearerToken(req));
    if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const name = String(body.name || '').trim();
    const mime = String(body.mime || '').trim().toLowerCase();
    const data = String(body.data || '');
    if (!name || name.length > 200) {
      return jsonRes(res, 400, { ok: false, error: 'name required (max 200 chars)' });
    }
    const allowed = ALLOWED_MIME[mime];
    if (!allowed) {
      return jsonRes(res, 400, { ok: false, error: 'only jpeg, png and webp images are accepted' });
    }
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.replace(/\s+/g, ''))) {
      return jsonRes(res, 400, { ok: false, error: 'data must be base64' });
    }
    let buf;
    try {
      buf = Buffer.from(data, 'base64');
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: 'data must be base64' });
    }
    if (buf.length === 0 || buf.length > MAX_FILE_BYTES) {
      return jsonRes(res, 400, { ok: false, error: 'file must be between 1 byte and 10 MB' });
    }
    // Magic bytes must match the claimed mime — a renamed .exe (or any
    // other file) is rejected even if the client calls it image/png.
    if (!allowed.magic(buf)) {
      return jsonRes(res, 400, { ok: false, error: 'file contents do not match the claimed image type' });
    }
    const id = crypto.randomUUID();
    const safeName = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file';
    const dir = mediaDir();
    const filePath = path.join(dir, id + allowed.ext);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, buf);
    } catch (e) {
      console.error('media upload write failed', e.message);
      return jsonRes(res, 503, { ok: false, error: 'media storage unavailable' });
    }
    const businessId = await businessIdForEmail(email);
    const rec = {
      id,
      businessId: businessId || null,
      ownerEmail: String(email).toLowerCase(),
      name: safeName,
      mime,
      size: buf.length,
      at: new Date().toISOString(),
    };
    try {
      await storeRecord(rec);
    } catch (e) {
      try { fs.unlinkSync(filePath); } catch (e2) { /* ignore */ }
      if (isDbFailure(e)) {
        return jsonRes(res, 503, { ok: false, error: 'media unavailable' });
      }
      console.error('media metadata store failed', e.message);
      return jsonRes(res, 503, { ok: false, error: 'media unavailable' });
    }
    return jsonRes(res, 200, { ok: true, id, url: '/api/media/' + id });
  }

  async function handleDownload(req, res, urlPath) {
    const email = verifyAuthToken(bearerToken(req));
    if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
    const id = decodeURIComponent(urlPath.slice('/api/media/'.length)).split('/')[0];
    if (!id || !/^[A-Za-z0-9-]+$/.test(id)) {
      return jsonRes(res, 404, { ok: false, error: 'not found' });
    }
    let rec;
    try {
      rec = await findRecord(id);
    } catch (e) {
      if (isDbFailure(e)) return jsonRes(res, 503, { ok: false, error: 'media unavailable' });
      throw e;
    }
    // 404 whether the file is unknown or belongs to another business —
    // the answer must not leak which one it is.
    const businessId = rec && rec.businessId ? await businessIdForEmail(email) : null;
    if (!canAccess(rec, email, businessId)) {
      return jsonRes(res, 404, { ok: false, error: 'not found' });
    }
    const ext = (ALLOWED_MIME[rec.mime] || {}).ext || '';
    const filePath = path.join(mediaDir(), rec.id + ext);
    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch (e) {
      return jsonRes(res, 404, { ok: false, error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': rec.mime,
      'Content-Length': buf.length,
      'Content-Disposition': 'inline; filename="' + String(rec.name).replace(/"/g, '') + '"',
      'Cache-Control': 'private, max-age=3600',
    });
    return res.end(buf);
  }

  return async function mediaHandler(req, res, urlPath) {
    try {
      if (req.method === 'POST' && urlPath === '/api/media/upload') {
        await handleUpload(req, res);
        return true;
      }
      if (req.method === 'GET' && urlPath.startsWith('/api/media/')) {
        await handleDownload(req, res, urlPath);
        return true;
      }
      return false;
    } catch (err) {
      console.error('media route error', err);
      if (!res.headersSent) {
        if (isDbFailure(err)) {
          jsonRes(res, 503, { ok: false, error: 'media unavailable' });
        } else {
          jsonRes(res, 500, { ok: false, error: 'media failed' });
        }
      }
      return true;
    }
  };
}

module.exports = { registerMediaRoutes, isMediaRoute, handleMediaUnavailable };
