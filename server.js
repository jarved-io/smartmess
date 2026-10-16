// Local dev server, no dependencies:  node server.js  ->  http://localhost:3000
// Serves public/ and runs the same /api handler that Vercel runs (api/[...path].js).
require('dotenv').config();
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
// LOCAL_DB=pglite -> run the REAL backend against an in-process Postgres (no install, data kept in .data/)
async function localDb() {
  const { createPglite, setDb } = require('./lib/db'), { migrate, seed } = require('./lib/seed');
  const db = await createPglite(process.env.LOCAL_DB_DIR || '.data/pgdata'); setDb(db); await migrate(db);
  if (!(await db.query('SELECT 1 FROM users LIMIT 1'))[0]) {
    const password = process.env.SEED_PASSWORD || 'demo1234';
    console.log('Seeded SYNTHETIC demo data. Logins: CHIEF / ADMIN / NN25CSE290, password:', password, await seed(db, { password }));
  }
}
const ready = process.env.LOCAL_DB === 'pglite' ? localDb() : Promise.resolve();
const apiHandler = (req, res) => ready.then(() => require('./api/[...path].js')(req, res));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    return Promise.resolve(apiHandler(req, res)).catch(() => { res.writeHead(500); res.end('{"error":"internal error"}'); });
  }
  const file = path.join(PUBLIC, url === '/' ? 'index.html' : path.normalize(url));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Smart Mess running at http://localhost:${PORT}`));
ready.catch(e => { console.error(e); process.exit(1); });
