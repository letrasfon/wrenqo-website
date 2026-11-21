// Minimal static server for the Wrenqo marketing site on Railway.
// Serves index.html for every page, plus sitemap.xml and robots.txt.
// POST /api/trial accepts trial signup requests and emails them to the team
// via Resend (RESEND_API_KEY env var) first, with Gmail SMTP
// (SMTP_USER / SMTP_PASS env vars, app password) as fallback.
// It also sends a confirmation email to the person who signed up.
// Every request is also appended to trial-requests.jsonl as a backup.
// Resend sends over HTTPS, so it is not affected by the Railway network
// block that stops outbound SMTP to smtp.gmail.com.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TRIAL_TO = process.env.TRIAL_TO || 'support@wrenqo.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Paddle webhook secret (endpoint_secret_key from the Paddle notification
// destination). Set in Railway env vars once the destination is created.
// Without it, webhook signatures cannot be verified and events are refused.
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
// Polar webhook secret (from Polar Dashboard → Settings → Webhooks, shown
// when the endpoint is created). Set in Railway env vars. Polar signs with
// the Standard Webhooks scheme (HMAC-SHA256, base64 secret). Without the
// secret set, every Polar event is refused with 401.
const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET || '';
// Sender shown on trial emails. Before the domain is verified in Resend,
// use the Resend default onboarding@resend.dev. After wrenqo.com is
// verified, set RESEND_FROM to e.g. 'Wrenqo <hello@wrenqo.com>'.
const RESEND_FROM = process.env.RESEND_FROM || 'Wrenqo <onboarding@resend.dev>';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Valid page paths (49). Any other GET path returns a real 404 instead of
// the homepage (soft-404 fix, 2026-11-10).
const PAGE_PATHS = new Set(['/', '/about-us', '/appliance-repair-software', '/blog', '/blog/flat-rate-pricing-guide', '/blog/same-day-invoicing', '/blog/how-to-choose-field-service-software', '/blog/per-technician-pricing-cost', '/blog/recurring-service-routes', '/blog/working-offline-no-signal', '/cleaning-business-software', '/contact-us', '/delete-account', '/electrical-contractor-software', '/faqs', '/field-service-software-by-trade', '/field-service-software-features', '/field-service-software-pricing', '/field-service-software-setup', '/flat-rate-price-book-software', '/garage-door-software', '/handyman-business-software', '/help', '/help/build-price-book', '/help/cancel-subscription', '/help/delete-your-account', '/help/export-data-and-cancel', '/help/five-minute-setup', '/help/import-customers', '/help/send-first-invoice', '/help/sign-in-with-email-code', '/help/start-free-trial', '/hvac-scheduling-app', '/invoicing-software-for-contractors', '/lawn-care-software', '/locksmith-software', '/offline-field-service-app', '/online-booking-software', '/pest-control-software', '/plumbing-scheduling-software', '/pool-service-software', '/privacy-policy', '/quickbooks-field-service-software', '/recurring-jobs-software', '/refund-policy', '/roofing-contractor-software', '/scheduling-dispatch-software', '/terms-of-service', '/work-order-app']);

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
  });
  return transporter;
}

// Send one email through the Resend HTTP API. Resolves true on success.
async function sendViaResend(to, subject, text) {
  if (!RESEND_API_KEY) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('resend send failed', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('resend send error', err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Callback-style wrapper so the SMTP fallback can reuse the same shape.
function sendMailSmtp(to, subject, text) {
  return new Promise((resolve) => {
    const tx = getTransporter();
    if (!tx) return resolve(false);
    tx.sendMail({ from: process.env.SMTP_USER, to, subject, text }, (err) => {
      if (err) {
        console.error('trial mail failed', err);
        return resolve(false);
      }
      resolve(true);
    });
  });
}

function handleTrial(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });
  req.on('end', async () => {
    let data = {};
    try {
      data = JSON.parse(body || '{}');
    } catch (e) {
      /* ignore malformed JSON */
    }
    const email = String(data.email || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'valid email required' }));
    }
    // Trial-abuse rule: log the signup IP + device fingerprint, and flag a
    // repeat trial (same IP or same device as an earlier request). The flag
    // only goes to the team email — the customer-facing reply stays the
    // same; a human decides whether it is a different business.
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || (req.socket && req.socket.remoteAddress) || '';
    const deviceFingerprint = String(data.deviceFingerprint || '').trim();
    let repeatTrial = false;
    try {
      const logPath = path.join(__dirname, 'trial-requests.jsonl');
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          let prev = null;
          try { prev = JSON.parse(line); } catch (e) { /* skip bad line */ }
          if (!prev) continue;
          if ((ip && prev.ip === ip) || (deviceFingerprint && prev.deviceFingerprint === deviceFingerprint)) {
            repeatTrial = true;
            break;
          }
        }
      }
    } catch (e) {
      /* log unreadable — treat as first trial */
    }
    const record = {
      at: new Date().toISOString(),
      email,
      shopName: String(data.shopName || ''),
      trade: String(data.trade || ''),
      techs: String(data.techs || ''),
      ip,
      deviceFingerprint,
      repeatTrial,
    };
    // Always log the request (backup) even if mail is not configured.
    fs.appendFile(
      path.join(__dirname, 'trial-requests.jsonl'),
      JSON.stringify(record) + '\n',
      () => {}
    );
    const teamLines = [
      'New Wrenqo free-trial request',
      '',
      'Email: ' + record.email,
      'Shop name: ' + (record.shopName || '-'),
      'Trade: ' + (record.trade || '-'),
      'Technicians: ' + (record.techs || '-'),
      'IP: ' + (record.ip || '-'),
      'Device fingerprint: ' + (record.deviceFingerprint || '-'),
      'Received: ' + record.at,
    ];
    if (repeatTrial) {
      teamLines.push('', 'NOTE: same IP or device as an earlier request — per the trial rule, a repeat signup gets NO new trial (must pay). Reply only if this is a different business.');
    }
    const teamText = teamLines.join('\n');
    const teamSubject = (repeatTrial ? 'REPEAT TRIAL? ' : '') + 'New free-trial request: ' + record.email;
    const confirmText = [
      'Hi,',
      '',
      'Thanks for requesting a free 14-day trial of Wrenqo.',
      '',
      'We received your request and will email you within 24 hours',
      'with your trial access.',
      '',
      'What is Wrenqo? Field-service software for small home-service',
      'shops - scheduling, dispatch, invoicing and payments in one',
      'app, $39/month flat.',
      '',
      'Questions? Reply to this email or write to support@wrenqo.com.',
      '',
      'Thanks,',
      'The Wrenqo team',
    ].join('\n');
    // Try Resend first, then Gmail SMTP as fallback.
    let teamSent = await sendViaResend(TRIAL_TO, teamSubject, teamText);
    if (!teamSent) {
      teamSent = await sendMailSmtp(TRIAL_TO, teamSubject, teamText);
    }
    if (!teamSent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mailed: false }));
    }
    // Best-effort confirmation email to the customer.
    let confirmSent = await sendViaResend(
      record.email,
      'Your Wrenqo trial request is received',
      confirmText
    );
    if (!confirmSent) {
      confirmSent = await sendMailSmtp(
        record.email,
        'Your Wrenqo trial request is received',
        confirmText
      );
    }
    if (!confirmSent) console.error('trial confirm mail failed');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mailed: true }));
  });
}

// POST /api/feedback: feedback / problem reports from the site's feedback
// form. Emails the team via Resend first, Gmail SMTP as fallback, and logs
// every report to feedback.jsonl as a backup.
function handleFeedback(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });
  req.on('end', async () => {
    let data = {};
    try {
      data = JSON.parse(body || '{}');
    } catch (e) {
      /* ignore malformed JSON */
    }
    const email = String(data.email || '').trim();
    const message = String(data.message || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'valid email and message required' }));
    }
    const record = {
      at: new Date().toISOString(),
      name: String(data.name || ''),
      email,
      page: String(data.page || ''),
      message,
    };
    fs.appendFile(
      path.join(__dirname, 'feedback.jsonl'),
      JSON.stringify(record) + '\n',
      () => {}
    );
    const text = [
      'New Wrenqo feedback / problem report',
      '',
      'Name: ' + (record.name || '-'),
      'Email: ' + record.email,
      'Page: ' + (record.page || '-'),
      'Received: ' + record.at,
      '',
      record.message,
    ].join('\n');
    let sent = await sendViaResend(TRIAL_TO, 'Wrenqo feedback from ' + record.email, text);
    if (!sent) {
      sent = await sendMailSmtp(TRIAL_TO, 'Wrenqo feedback from ' + record.email, text);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mailed: sent }));
  });
}

// POST /api/paddle/webhook: Paddle webhook endpoint (Stage 3).
// Verifies the Paddle-Signature header (HMAC-SHA256 over ts + ':' + raw
// body, keyed by PADDLE_WEBHOOK_SECRET) before trusting any event.
// On a completed payment or an active subscription, marks the customer
// email as Pro in pro-customers.jsonl and emails the team, so the app can
// unlock that email via Email + OTP / Magic Link. Without the secret set,
// every event is refused with 401 — the endpoint is inert until the
// notification destination is created in Paddle and the secret is set.
function verifyPaddleSignature(rawBody, signatureHeader) {
  if (!PADDLE_WEBHOOK_SECRET || !signatureHeader) return false;
  const parts = {};
  for (const piece of String(signatureHeader).split(';')) {
    const idx = piece.indexOf('=');
    if (idx > 0) parts[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
  }
  if (!parts.ts || !parts.h1) return false;
  const expected = crypto
    .createHmac('sha256', PADDLE_WEBHOOK_SECRET)
    .update(parts.ts + ':' + rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parts.h1, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function handlePaddleWebhook(req, res) {
  let rawBody = '';
  req.on('data', (chunk) => {
    rawBody += chunk;
    if (rawBody.length > 100000) req.destroy();
  });
  req.on('end', async () => {
    if (!verifyPaddleSignature(rawBody, req.headers['paddle-signature'])) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid signature' }));
    }
    let event = null;
    try {
      event = JSON.parse(rawBody);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
    }
    const eventType = String(event.event_type || '');
    const data = event.data || {};
    const customerEmail =
      String((data.customer && data.customer.email) || '') ||
      String((data.billing_details && data.billing_details.email) || '');
    const record = {
      at: new Date().toISOString(),
      event_type: eventType,
      event_id: String(event.event_id || ''),
      customer_email: customerEmail,
      subscription_id: String(data.subscription_id || (data.subscription && data.subscription.id) || ''),
      transaction_id: String(data.id || ''),
      status: String(data.status || ''),
    };
    fs.appendFile(
      path.join(__dirname, 'paddle-webhooks.jsonl'),
      JSON.stringify(record) + '\n',
      () => {}
    );
    // Paid events unlock the customer: transaction completed, or a
    // subscription created/activated. Anything else is logged only.
    const paidEvent =
      eventType === 'transaction.completed' ||
      eventType === 'subscription.created' ||
      eventType === 'subscription.activated';
    if (paidEvent && customerEmail) {
      fs.appendFile(
        path.join(__dirname, 'pro-customers.jsonl'),
        JSON.stringify({
          at: record.at,
          email: customerEmail,
          subscription_id: record.subscription_id,
          transaction_id: record.transaction_id,
          event_type: eventType,
        }) + '\n',
        () => {}
      );
      const text = [
        'Wrenqo payment received — customer unlocked (Pro)',
        '',
        'Email: ' + customerEmail,
        'Event: ' + eventType,
        'Subscription: ' + (record.subscription_id || '-'),
        'Transaction: ' + (record.transaction_id || '-'),
        'Received: ' + record.at,
      ].join('\n');
      let sent = await sendViaResend(TRIAL_TO, 'Wrenqo payment: ' + customerEmail, text);
      if (!sent) {
        sent = await sendMailSmtp(TRIAL_TO, 'Wrenqo payment: ' + customerEmail, text);
      }
      if (!sent) console.error('paddle webhook team mail failed');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

// POST /api/polar/webhook: Polar webhook endpoint.
// Polar signs events with the Standard Webhooks scheme: HMAC-SHA256 keyed
// by the base64-decoded endpoint secret over
// "<webhook-id>.<webhook-timestamp>.<raw body>", delivered base64-encoded
// in the webhook-signature header as "v1,<signature>". The timestamp is
// never used to reject a delivery (Polar retries old events and header
// formats vary) — the HMAC signature itself is the authenticity check.
// On order.paid or
// subscription.active, marks the customer email as Pro in
// pro-customers.jsonl and emails the team (same unlock list the app reads
// via Email + OTP / Magic Link). Cancellations/revocations are logged and
// emailed so access can be removed. Without POLAR_WEBHOOK_SECRET set,
// every event is refused with 401 — the endpoint is inert until the
// endpoint is created in Polar and the secret is set in Railway.
// Polar shows the endpoint secret in a few possible shapes (plain base64,
// or prefixed, e.g. "whsec_..." / "polar_whs_..."). Build every plausible
// HMAC key from the configured secret and accept a signature matching any
// of them — each check is still a full HMAC verification, so trying the
// encodings does not weaken security.
function polarSecretKeys() {
  if (!POLAR_WEBHOOK_SECRET) return [];
  const s = POLAR_WEBHOOK_SECRET.trim();
  const keys = [];
  const push = (buf) => {
    if (buf && buf.length > 0 && !keys.some((k) => k.equals(buf))) keys.push(buf);
  };
  push(Buffer.from(s, 'utf8'));
  try { push(Buffer.from(s, 'base64')); } catch (e) { /* ignore */ }
  try { push(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')); } catch (e) { /* ignore */ }
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) push(Buffer.from(s, 'hex'));
  for (const prefix of ['whsec_', 'polar_whs_']) {
    if (s.startsWith(prefix)) {
      const rest = s.slice(prefix.length);
      push(Buffer.from(rest, 'utf8'));
      try { push(Buffer.from(rest, 'base64')); } catch (e) { /* ignore */ }
      try { push(Buffer.from(rest.replace(/-/g, '+').replace(/_/g, '/'), 'base64')); } catch (e) { /* ignore */ }
      if (/^[0-9a-fA-F]+$/.test(rest) && rest.length % 2 === 0) push(Buffer.from(rest, 'hex'));
    }
  }
  return keys;
}

function verifyPolarSignature(rawBody, headers) {
  const keys = polarSecretKeys();
  if (!keys.length) return false;
  const msgId = String(headers['webhook-id'] || '');
  const timestamp = String(headers['webhook-timestamp'] || '');
  const signatureHeader = String(headers['webhook-signature'] || '');
  if (!msgId || !timestamp || !signatureHeader) return false;
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  // No timestamp-window rejection: Polar retries can carry old
  // timestamps; the HMAC check below is the real gate.
  // Header may carry several space-separated "v1,<sig>" entries.
  const candidates = [];
  for (const entry of signatureHeader.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0) continue;
    if (entry.slice(0, comma) !== 'v1') continue;
    candidates.push(Buffer.from(entry.slice(comma + 1), 'utf8'));
  }
  if (!candidates.length) return false;
  for (const key of keys) {
    const expected = Buffer.from(
      crypto
        .createHmac('sha256', key)
        .update(msgId + '.' + timestamp + '.' + rawBody)
        .digest('base64'),
      'utf8'
    );
    for (const candidate of candidates) {
      if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
        return true;
      }
    }
  }
  return false;
}

function handlePolarWebhook(req, res) {
  let rawBody = '';
  req.on('data', (chunk) => {
    rawBody += chunk;
    if (rawBody.length > 100000) req.destroy();
  });
  req.on('end', async () => {
    if (!verifyPolarSignature(rawBody, req.headers)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid signature' }));
    }
    let event = null;
    try {
      event = JSON.parse(rawBody);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
    }
    const eventType = String(event.type || '');
    const data = event.data || {};
    const customerEmail =
      String((data.customer && data.customer.email) || '') ||
      String(data.customer_email || '');
    const record = {
      at: new Date().toISOString(),
      event_type: eventType,
      customer_email: customerEmail,
      subscription_id: String(data.subscription_id || data.id || ''),
      order_id: String(data.id || ''),
      status: String(data.status || ''),
    };
    fs.appendFile(
      path.join(__dirname, 'polar-webhooks.jsonl'),
      JSON.stringify(record) + '\n',
      () => {}
    );
    // Paid events unlock the customer. Anything else is logged only,
    // except cancellations/revocations, which also email the team so
    // access can be removed by hand.
    const paidEvent = eventType === 'order.paid' || eventType === 'subscription.active';
    const endedEvent =
      eventType === 'subscription.revoked' ||
      eventType === 'subscription.canceled' ||
      eventType === 'order.refunded';
    if (paidEvent && customerEmail) {
      fs.appendFile(
        path.join(__dirname, 'pro-customers.jsonl'),
        JSON.stringify({
          at: record.at,
          email: customerEmail,
          source: 'polar',
          subscription_id: record.subscription_id,
          order_id: record.order_id,
          event_type: eventType,
        }) + '\n',
        () => {}
      );
      const text = [
        'Wrenqo payment received via Polar — customer unlocked (Pro)',
        '',
        'Email: ' + customerEmail,
        'Event: ' + eventType,
        'Reference: ' + (record.subscription_id || record.order_id || '-'),
        'Received: ' + record.at,
      ].join('\n');
      let sent = await sendViaResend(TRIAL_TO, 'Wrenqo payment (Polar): ' + customerEmail, text);
      if (!sent) {
        sent = await sendMailSmtp(TRIAL_TO, 'Wrenqo payment (Polar): ' + customerEmail, text);
      }
      if (!sent) console.error('polar webhook team mail failed');
    } else if (endedEvent && customerEmail) {
      // Record the removal too: plan checks read the LATEST record per
      // email, so this grant/revoke history stays correct on its own.
      fs.appendFile(
        path.join(__dirname, 'pro-customers.jsonl'),
        JSON.stringify({
          at: record.at,
          email: customerEmail,
          source: 'polar',
          event_type: eventType,
          removed: true,
        }) + '\n',
        () => {}
      );
      const text = [
        'Wrenqo Pro access ended via Polar — remove Pro access',
        '',
        'Email: ' + customerEmail,
        'Event: ' + eventType,
        'Received: ' + record.at,
      ].join('\n');
      let sent = await sendViaResend(TRIAL_TO, 'Wrenqo subscription ended (Polar): ' + customerEmail, text);
      if (!sent) {
        sent = await sendMailSmtp(TRIAL_TO, 'Wrenqo subscription ended (Polar): ' + customerEmail, text);
      }
      if (!sent) console.error('polar webhook end mail failed');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

// ---------------------------------------------------------------------------
// App sign-in (email one-time code) + plan status
//
// The app never sells anything (Google Play reader-app model): plans are
// bought on the website via Polar, and the app unlocks for the email that
// has an active plan. Flow: the app asks for a code (request-otp), we
// email a 6-digit code, the app sends it back (verify-otp) and receives a
// signed 30-day token. GET /api/auth/status with that token returns the
// plan for the token's email:
//   pro   — the latest pro-customers.jsonl record for the email is a
//           grant (written by the Polar webhook), or the Polar API (when
//           POLAR_API_TOKEN is set) shows an active/trialing subscription.
//   trial — earliest trial-requests.jsonl record for the email + 14 days.
// The signing key is AUTH_SECRET when set, else the Polar webhook secret
// (already configured). With neither set, the endpoints answer 503.
// Codes live in memory only (10-minute life, 5 attempts, 60-second resend
// cooldown) — fine on this single-container deployment.
// ---------------------------------------------------------------------------

const otpStore = new Map();
const otpLastSentAt = new Map();
const polarPlanCache = new Map();

function authKey() {
  return String(process.env.AUTH_SECRET || process.env.POLAR_WEBHOOK_SECRET || '');
}

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJsonlRecords(fileName) {
  try {
    const p = path.join(__dirname, fileName);
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

function issueAuthToken(email) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', authKey()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyAuthToken(token) {
  const key = authKey();
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

async function polarApiPlan(email) {
  const token = String(process.env.POLAR_API_TOKEN || '');
  if (!token) return null;
  const cached = polarPlanCache.get(email);
  if (cached && Date.now() - cached.at < 60000) return cached.plan;
  let plan = null;
  try {
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    const custRes = await fetch(
      'https://api.polar.sh/v1/customers/?email=' + encodeURIComponent(email),
      { headers }
    );
    if (custRes.ok) {
      const custData = await custRes.json();
      const items = custData.items || [];
      const customer = Array.isArray(items) ? items[0] : null;
      if (customer && customer.id) {
        const subRes = await fetch(
          'https://api.polar.sh/v1/subscriptions/?customer_id=' +
            encodeURIComponent(customer.id) + '&limit=10',
          { headers }
        );
        if (subRes.ok) {
          const subData = await subRes.json();
          const subs = subData.items || [];
          let status = null;
          for (const s of subs) {
            if (s.status === 'active' || s.status === 'trialing') { status = s.status; break; }
            if (!status) status = String(s.status || '');
          }
          if (status) {
            plan = {
              pro: status === 'active' || status === 'trialing',
              subscriptionStatus: status,
            };
          }
        }
      }
    }
  } catch (e) {
    plan = null;
  }
  polarPlanCache.set(email, { at: Date.now(), plan });
  return plan;
}

async function planForEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  let pro = false;
  let proSource = null;
  let subscriptionStatus = null;
  let latest = null;
  for (const r of readJsonlRecords('pro-customers.jsonl')) {
    if (String(r.email || '').trim().toLowerCase() === email) latest = r;
  }
  if (latest && !latest.removed) {
    pro = true;
    proSource = 'webhook';
    subscriptionStatus = 'active';
  }
  if (!pro) {
    const apiPlan = await polarApiPlan(email);
    if (apiPlan && apiPlan.pro) {
      pro = true;
      proSource = 'polar-api';
      subscriptionStatus = apiPlan.subscriptionStatus;
    } else if (apiPlan && apiPlan.subscriptionStatus) {
      subscriptionStatus = apiPlan.subscriptionStatus;
    }
  }
  let trialActive = false;
  let trialEndsAt = null;
  for (const r of readJsonlRecords('trial-requests.jsonl')) {
    if (String(r.email || '').trim().toLowerCase() !== email) continue;
    const start = new Date(r.at || '').getTime();
    if (isNaN(start)) continue;
    const end = start + 14 * 24 * 3600 * 1000;
    trialEndsAt = new Date(end).toISOString();
    trialActive = Date.now() < end;
    break; // earliest record governs — one trial per email
  }
  return { pro, proSource, subscriptionStatus, trialActive, trialEndsAt };
}

function handleAuthRequestOtp(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });
  req.on('end', async () => {
    if (!authKey()) return jsonRes(res, 503, { ok: false, error: 'auth not configured' });
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
    const email = String(data.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jsonRes(res, 400, { ok: false, error: 'valid email required' });
    }
    const lastSent = otpLastSentAt.get(email) || 0;
    if (Date.now() - lastSent < 60000) {
      return jsonRes(res, 429, { ok: false, error: 'wait a minute before asking for a new code' });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const hash = crypto.createHash('sha256').update(code + ':' + email).digest('hex');
    otpStore.set(email, {
      hash,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
      sentAt: Date.now(),
    });
    const text = [
      'Your Wrenqo sign-in code is: ' + code,
      '',
      'Enter this code in the Wrenqo app to sign in.',
      'The code is valid for 10 minutes.',
      '',
      'If you did not ask for this code, you can ignore this email.',
      '',
      'The Wrenqo team',
    ].join('\n');
    let sent = await sendViaResend(email, 'Your Wrenqo sign-in code', text);
    if (!sent) sent = await sendMailSmtp(email, 'Your Wrenqo sign-in code', text);
    if (!sent) {
      otpStore.delete(email);
      return jsonRes(res, 502, { ok: false, error: 'could not send the code email' });
    }
    otpLastSentAt.set(email, Date.now());
    return jsonRes(res, 200, { ok: true });
  });
}

function handleAuthVerifyOtp(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });
  req.on('end', async () => {
    if (!authKey()) return jsonRes(res, 503, { ok: false, error: 'auth not configured' });
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
    const email = String(data.email || '').trim().toLowerCase();
    const code = String(data.code || '').trim();
    const entry = otpStore.get(email);
    if (!entry) return jsonRes(res, 401, { ok: false, error: 'invalid or expired code' });
    if (Date.now() > entry.expiresAt) {
      otpStore.delete(email);
      return jsonRes(res, 401, { ok: false, error: 'invalid or expired code' });
    }
    entry.attempts += 1;
    if (entry.attempts > 5) {
      otpStore.delete(email);
      return jsonRes(res, 401, { ok: false, error: 'too many attempts — ask for a new code' });
    }
    const hash = crypto.createHash('sha256').update(code + ':' + email).digest('hex');
    const a = Buffer.from(hash, 'utf8');
    const b = Buffer.from(entry.hash, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return jsonRes(res, 401, { ok: false, error: 'invalid or expired code' });
    }
    otpStore.delete(email);
    const token = issueAuthToken(email);
    const plan = await planForEmail(email);
    return jsonRes(res, 200, { ok: true, token, email, plan });
  });
}

function handleAuthStatus(req, res) {
  const header = String(req.headers['authorization'] || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const email = verifyAuthToken(token);
  if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
  planForEmail(email)
    .then((plan) => jsonRes(res, 200, { ok: true, email, plan }))
    .catch(() => jsonRes(res, 500, { ok: false, error: 'status check failed' }));
}

// POST /api/auth/delete-account (Bearer token) — Google Play requires an
// in-app account-deletion path. Records the removal (plan checks read
// the LATEST pro-customers.jsonl record per email, so Pro access ends),
// logs the deletion, clears any pending sign-in code for the email and
// emails the team. Deleting the account does NOT cancel a live Polar
// subscription (billing lives with Polar) — the team email says so, so
// it can be cancelled from the Polar dashboard by hand.
async function handleAuthDeleteAccount(req, res) {
  const header = String(req.headers['authorization'] || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const email = verifyAuthToken(token);
  if (!email) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
  const at = new Date().toISOString();
  fs.appendFile(
    path.join(__dirname, 'pro-customers.jsonl'),
    JSON.stringify({ at, email, removed: true, reason: 'account-deletion' }) + '\n',
    () => {}
  );
  fs.appendFile(
    path.join(__dirname, 'account-deletions.jsonl'),
    JSON.stringify({ at, email }) + '\n',
    () => {}
  );
  otpStore.delete(email);
  otpLastSentAt.delete(email);
  polarPlanCache.delete(email);
  const text = [
    'Wrenqo account deleted from the app',
    '',
    'Email: ' + email,
    'Deleted: ' + at,
    '',
    'Pro access for this email has been removed on the server and the',
    'deletion logged. If this email still has an ACTIVE Polar',
    'subscription, cancel it from the Polar dashboard — deleting the',
    'app account does not cancel billing.',
  ].join('\n');
  let sent = await sendViaResend(TRIAL_TO, 'Wrenqo account deleted: ' + email, text);
  if (!sent) sent = await sendMailSmtp(TRIAL_TO, 'Wrenqo account deleted: ' + email, text);
  if (!sent) console.error('account deletion team mail failed');
  return jsonRes(res, 200, { ok: true });
}

// ------------------------------------------------------------ cloud sync
// Postgres-backed team sync (module: ./sync.js; design notes live in
// the wrenqo-sync folder). Entirely optional and fail-safe: with no
// DATABASE_URL the server behaves exactly as before — the sync/team
// paths still answer, 401 for a bad token and 503 'sync unavailable'
// for a good one, so the app can honestly say sync is not set up yet.
// A database that is unreachable at request time degrades sync to 503
// the same way and never affects the site or the other API routes.

// The schema (the same statements as wrenqo-sync/schema.sql) is applied
// lazily: the first sync call runs it once per process through the
// schema-first pool wrapper below, so deploys need no manual SQL step.
// Every statement is IF NOT EXISTS, so re-running is harmless. A failed
// attempt is forgotten, so the next sync call retries.
const SYNC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS businesses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'technician')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, email)
);
CREATE INDEX IF NOT EXISTS members_email_idx ON members (email);
CREATE UNIQUE INDEX IF NOT EXISTS members_one_owner_per_email
  ON members (email) WHERE role = 'owner';
CREATE TABLE IF NOT EXISTS sync_records (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  entity      TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  data        JSONB,
  updated_at  TIMESTAMPTZ NOT NULL,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, entity, record_id)
);
CREATE INDEX IF NOT EXISTS sync_records_pull_idx
  ON sync_records (business_id, updated_at);
CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_by     TEXT
);
CREATE INDEX IF NOT EXISTS invite_codes_business_idx
  ON invite_codes (business_id, expires_at);
`;
let syncSchemaPromise = null;
function ensureSyncSchema(rawPool) {
  if (!syncSchemaPromise) {
    syncSchemaPromise = rawPool.query(SYNC_SCHEMA_SQL).catch((e) => {
      syncSchemaPromise = null; // let the next sync call retry
      throw e;
    });
  }
  return syncSchemaPromise;
}
// Wraps the real pool so the schema exists before the module's first
// query or connection. If the database is unreachable the ensure step
// throws, the sync module's error handling answers 503, and nothing
// else in this server is touched.
function schemaFirstPool(rawPool) {
  return {
    query: async (...args) => {
      await ensureSyncSchema(rawPool);
      return rawPool.query(...args);
    },
    connect: async () => {
      await ensureSyncSchema(rawPool);
      return rawPool.connect();
    },
  };
}

const SYNC_ROUTES = new Set([
  'POST /api/sync/push',
  'GET /api/sync/pull',
  'POST /api/team/invite',
  'POST /api/team/join',
]);

let syncHandler = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const { registerSyncRoutes } = require('./sync.js');
    const rawSyncPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
    });
    // An idle-client error must never crash the site process.
    rawSyncPool.on('error', (e) => console.error('sync pool idle error', e.message));
    // verifyAuthToken is this server's real verifier (defined above):
    // sync requests authenticate with the same OTP sign-in tokens.
    syncHandler = registerSyncRoutes({ pool: schemaFirstPool(rawSyncPool), verifyAuthToken });
    console.log('Wrenqo cloud sync enabled');
  } catch (e) {
    console.error('cloud sync disabled (init failed):', e.message);
    syncHandler = null;
  }
}

// Sync paths when sync is not configured: same auth discipline as the
// real routes (401 first), then an honest 503.
function handleSyncUnavailable(req, res) {
  const header = String(req.headers['authorization'] || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!verifyAuthToken(token)) return jsonRes(res, 401, { ok: false, error: 'invalid token' });
  return jsonRes(res, 503, { ok: false, error: 'sync unavailable' });
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  // Cloud sync dispatch comes FIRST: the PAGE_PATHS check below 404s
  // unknown GET paths and would swallow GET /api/sync/pull.
  if (SYNC_ROUTES.has(req.method + ' ' + urlPath)) {
    if (!syncHandler) return handleSyncUnavailable(req, res);
    try {
      if (await syncHandler(req, res, urlPath)) return;
    } catch (e) {
      console.error('sync dispatch error', e);
      if (!res.headersSent) return jsonRes(res, 503, { ok: false, error: 'sync unavailable' });
      return;
    }
  }
  if (req.method === 'POST' && urlPath === '/api/trial') return handleTrial(req, res);
  if (req.method === 'POST' && urlPath === '/api/feedback') return handleFeedback(req, res);
  if (req.method === 'POST' && urlPath === '/api/paddle/webhook') return handlePaddleWebhook(req, res);
  if (req.method === 'POST' && urlPath === '/api/polar/webhook') return handlePolarWebhook(req, res);
  if (req.method === 'POST' && urlPath === '/api/auth/request-otp') return handleAuthRequestOtp(req, res);
  if (req.method === 'POST' && urlPath === '/api/auth/verify-otp') return handleAuthVerifyOtp(req, res);
  if (req.method === 'GET' && urlPath === '/api/auth/status') return handleAuthStatus(req, res);
  if (req.method === 'POST' && urlPath === '/api/auth/delete-account') return handleAuthDeleteAccount(req, res);
  // 301: blog slug renamed 2026-11-19 (Paddle-appeal wording cleanup).
  if (req.method === 'GET' && urlPath === '/blog/get-paid-same-day-invoicing') {
    res.writeHead(301, { Location: '/blog/same-day-invoicing' });
    return res.end();
  }
  if (req.method === 'GET' && urlPath !== '/sitemap.xml' && urlPath !== '/robots.txt' && !PAGE_PATHS.has(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><head><title>Page not found — Wrenqo</title><meta name="robots" content="noindex, follow"></head><body><h1>Page not found</h1><p>Sorry, this page does not exist. <a href="/">Go to the Wrenqo home page</a>.</p></body></html>');
  }
  let file = path.join(__dirname, 'index.html');
  if (urlPath === '/sitemap.xml' || urlPath === '/robots.txt') {
    file = path.join(__dirname, urlPath);
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('Wrenqo site running on port ' + PORT));
