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

const PORT = process.env.PORT || 3000;
const TRIAL_TO = process.env.TRIAL_TO || 'hellowrenqo@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// Sender shown on trial emails. Before the domain is verified in Resend,
// use the Resend default onboarding@resend.dev. After wrenqo.com is
// verified, set RESEND_FROM to e.g. 'Wrenqo <hello@wrenqo.com>'.
const RESEND_FROM = process.env.RESEND_FROM || 'Wrenqo <onboarding@resend.dev>';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Valid page paths (45). Any other GET path returns a real 404 instead of
// the homepage (soft-404 fix, 2026-11-10).
const PAGE_PATHS = new Set(['/', '/about-us', '/appliance-repair-software', '/blog', '/blog/flat-rate-pricing-guide', '/blog/get-paid-same-day-invoicing', '/blog/how-to-choose-field-service-software', '/blog/per-technician-pricing-cost', '/blog/recurring-service-routes', '/blog/working-offline-no-signal', '/cleaning-business-software', '/contact-us', '/electrical-contractor-software', '/faqs', '/field-service-software-by-trade', '/field-service-software-features', '/field-service-software-pricing', '/field-service-software-setup', '/flat-rate-price-book-software', '/garage-door-software', '/handyman-business-software', '/help', '/help/build-price-book', '/help/export-data-and-cancel', '/help/five-minute-setup', '/help/import-customers', '/help/send-first-invoice', '/help/start-free-trial', '/hvac-scheduling-app', '/invoicing-software-for-contractors', '/lawn-care-software', '/locksmith-software', '/offline-field-service-app', '/online-booking-software', '/pest-control-software', '/plumbing-scheduling-software', '/pool-service-software', '/privacy-policy', '/quickbooks-field-service-software', '/recurring-jobs-software', '/refund-policy', '/roofing-contractor-software', '/scheduling-dispatch-software', '/terms-of-service', '/work-order-app']);

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
    const record = {
      at: new Date().toISOString(),
      email,
      shopName: String(data.shopName || ''),
      trade: String(data.trade || ''),
      techs: String(data.techs || ''),
    };
    // Always log the request (backup) even if mail is not configured.
    fs.appendFile(
      path.join(__dirname, 'trial-requests.jsonl'),
      JSON.stringify(record) + '\n',
      () => {}
    );
    const teamText = [
      'New Wrenqo free-trial request',
      '',
      'Email: ' + record.email,
      'Shop name: ' + (record.shopName || '-'),
      'Trade: ' + (record.trade || '-'),
      'Technicians: ' + (record.techs || '-'),
      'Received: ' + record.at,
    ].join('\n');
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
      'Questions? Reply to this email or write to hellowrenqo@gmail.com.',
      '',
      'Thanks,',
      'The Wrenqo team',
    ].join('\n');
    // Try Resend first, then Gmail SMTP as fallback.
    let teamSent = await sendViaResend(TRIAL_TO, 'New free-trial request: ' + record.email, teamText);
    if (!teamSent) {
      teamSent = await sendMailSmtp(TRIAL_TO, 'New free-trial request: ' + record.email, teamText);
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

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && urlPath === '/api/trial') return handleTrial(req, res);
  if (req.method === 'POST' && urlPath === '/api/feedback') return handleFeedback(req, res);
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
