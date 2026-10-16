'use strict';
/* Drives the real index.html + web/live.js in jsdom against the real backend (PGlite): login -> scan -> history -> manager pages. */
process.env.SESSION_SECRET = 'ui-test-secret-ui-test-secret-ui-test';
delete process.env.ML_SERVICE_URL;
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const { createPglite, setDb } = require('../lib/db');
const { migrate, seed } = require('../lib/seed');
const api = require('../api/[...path].js');

const PUB = path.join(__dirname, '..', 'public'), TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let db, server, base, dom, jar = '';

const wait = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } if (Date.now() - t > ms) throw new Error('timeout waiting for: ' + fn); await new Promise(r => setTimeout(r, 40)); } };
const $ = id => dom.window.document.getElementById(id);
const text = () => dom.window.document.body.textContent.replace(/\s+/g, ' ');

test.before(async () => {
  db = await createPglite(); setDb(db); await migrate(db);
  await seed(db, { studentsPerMess: 30, password: 'ui-pass-1234', demoIgnoreWindows: true });
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) return api(req, res);
    const f = path.join(PUB, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', TYPES[path.extname(f)] || 'text/plain'); res.end(d); });
  });
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o = {}) => fetch(new URL(u, base), Object.assign({}, o, { headers: Object.assign({}, o.headers, { Cookie: jar }) })).then(r => {
        (r.headers.getSetCookie() || []).forEach(c => { const kv = c.split(';')[0]; jar = /=$/.test(kv) ? '' : kv; });
        return r;
      });
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
      w.scrollTo = () => {};
    }
  });
  await wait(() => dom.window.SmartMessLive && $('uid') && $('lerr'));
  await new Promise(r => setTimeout(r, 300));
});
test.after(() => { dom.window.close(); server.close(); return db.close(); });

async function signIn(role, id, pw) {
  dom.window.setRole(role); $('uid').value = id; $('pw').value = pw; dom.window.doLogin();
  await wait(() => $('app').style.display === 'block' || $('lerr').textContent);
  assert.equal($('app').style.display, 'block', 'login error: ' + $('lerr').textContent);
}

test('login shows readable text even when a proxy answers with an object-shaped error (never [object Object])', async () => {
  const real = dom.window.fetch;
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ error: { code: 'BAD_GATEWAY', message: 'upstream down' } }) });
  dom.window.setRole('student'); $('uid').value = 'NN25CSE290'; $('pw').value = 'whatever1'; dom.window.doLogin();
  await wait(() => $('lerr').textContent);
  assert.equal($('lerr').textContent, 'upstream down');
  dom.window.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) });
  $('lerr').textContent = ''; dom.window.doLogin();
  await wait(() => $('lerr').textContent);
  assert.match($('lerr').textContent, /HTTP 500/); assert.doesNotMatch($('lerr').textContent, /object/i);
  dom.window.fetch = real; $('lerr').textContent = '';
});

test('login screen explains the demo database and rejects a wrong password with the server message', async () => {
  assert.match(text(), /Demo database: all data is SYNTHETIC/);
  dom.window.setRole('student'); $('uid').value = 'NN25CSE290'; $('pw').value = 'wrong-pass'; dom.window.doLogin();
  await wait(() => $('lerr').textContent);
  assert.equal($('lerr').textContent, 'Wrong ID or password');
  assert.notEqual($('app').style.display, 'block');
});

test('student: sign in, scan the counter QR (server verifies), see it in history; second scan is rejected', async () => {
  await signIn('student', 'NN25CSE290', 'ui-pass-1234');
  assert.match($('who').textContent, /Aarush/);
  assert.equal(Object.keys(dom.window.localStorage).includes('sm_db') && dom.window.localStorage.getItem('sm_db') !== null, false, 'personal data must not be stored in the browser');
  dom.window.go('scan'); await wait(() => $('lgo'));
  const { qrPayload } = require('../lib/auth');
  $('lmeal').value = 'dinner'; $('lq').value = qrPayload('south'); $('lgo').click();
  await wait(() => /Meal verified/.test($('sr').textContent));
  assert.match($('sr').textContent, /Aarush.*Dinner.*South Mess/);
  $('lgo').click();
  await wait(() => /Already scanned/.test($('sr').textContent));
  $('lq').value = 'not-a-real-code'; $('lgo').click();
  await wait(() => /Invalid QR/.test($('sr').textContent));
  dom.window.go('hist'); await wait(() => /Dinner/.test($('pg').textContent) && /Verified/.test($('pg').textContent));
  const rows = [...dom.window.document.querySelectorAll('#pg tbody tr')].map(r => r.textContent);
  assert.ok(rows.some(r => /Dinner/.test(r) && /Verified/.test(r)) && rows.some(r => /Rejected/.test(r)));
});

test('a student cannot reach manager data even by calling the API directly', async () => {
  const r = await dom.window.fetch('/api/dashboard/summary?mess=South%20Mess'); assert.equal(r.status, 403);
});

test('mess chief: sign in, dashboard shows live served count, prepared form saves, counter QR is shown', async () => {
  dom.window.logout && await dom.window.fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  jar = '';
  dom.window.document.getElementById('app').style.display = 'none'; dom.window.document.getElementById('login').style.display = 'block';
  await signIn('chief', 'CHIEF', 'ui-pass-1234');
  assert.match($('who').textContent, /Mess Chief/);
  const navTxt = $('nav').textContent; assert.match(navTxt, /Prepared & Actuals/); assert.match(navTxt, /Counter QR/);
  dom.window.go('dash'); await wait(() => /SYNTHETIC/i.test($('pg').textContent) && /Dinner/.test($('pg').textContent), 8000);
  dom.window.go('prep'); await wait(() => $('psave'));
  $('pm').value = 'dinner'; $('pc').value = '28'; $('psave').click();
  await wait(() => /Saved: 28 prepared/.test($('pmsg').textContent));
  dom.window.go('att'); await wait(() => /Aarush/.test($('pg').textContent));
});
