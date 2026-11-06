// Minimal static server for the Wrenqo marketing site on Railway.
// Serves index.html for every page, plus sitemap.xml and robots.txt.
// POST /api/trial accepts trial signup requests and emails them to the team
// via Gmail SMTP (SMTP_USER / SMTP_PASS env vars, app password).
// Every request is also appended to trial-requests.jsonl as a backup.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TRIAL_TO = process.env.TRIAL_TO || 'hellowrenqo@gmail.com';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

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
  });
  return transporter;
}

function handleTrial(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });
  req.on('end', () => {
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
    const tx = getTransporter();
    if (!tx) {
      // Mail not configured yet - request is logged; form still shows success.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mailed: false }));
    }
    const text = [
      'New Wrenqo free-trial request',
      '',
      'Email: ' + record.email,
      'Shop name: ' + (record.shopName || '-'),
      'Trade: ' + (record.trade || '-'),
      'Technicians: ' + (record.techs || '-'),
      'Received: ' + record.at,
    ].join('\n');
    tx.sendMail(
      {
        from: process.env.SMTP_USER,
        to: TRIAL_TO,
        subject: 'New free-trial request: ' + record.email,
        text,
      },
      (err) => {
        if (err) {
          console.error('trial mail failed', err);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, mailed: false }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mailed: true }));
      }
    );
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && urlPath === '/api/trial') return handleTrial(req, res);
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
