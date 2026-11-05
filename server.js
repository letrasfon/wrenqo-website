// Minimal static server for the Wrenqo marketing site on Railway.
// Serves index.html for every page, plus sitemap.xml and robots.txt.
// No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
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
