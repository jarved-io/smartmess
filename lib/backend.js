/* HTTP entry for the real backend: routing, auth lookup, JSON in/out, uniform errors. */
'use strict';
const { getDb } = require('./db');
const { currentUser } = require('./auth');
const { HttpError, send, readBody, parseCookies } = require('./http');
const { ROUTES } = require('./routes');

async function handle(req, res, now = new Date()) {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
  const route = ROUTES[key];
  const extra = [];
  try {
    if (!route) {
      const known = Object.keys(ROUTES).some(k => k.split(' ')[1] === key.split(' ')[1]);
      throw new HttpError(known ? 405 : 404, known ? 'Method not allowed' : 'Not found');
    }
    const db = await getDb();
    if (!db) throw new HttpError(503, 'Database is not configured');
    const body = await readBody(req);
    const user = await currentUser(db, req, parseCookies(req));
    const c = { db, req, res, user, now, body: body || {}, q: Object.fromEntries(url.searchParams), setCookie: v => extra.push(v) };
    const out = await route(c);
    return send(res, 200, out, extra.length ? { 'Set-Cookie': extra } : undefined);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, Object.assign({ error: e.message }, e.extra || {}), extra.length ? { 'Set-Cookie': extra } : undefined);
    console.error('api error', key, e && e.stack || e);
    return send(res, 500, { error: 'Internal error' });
  }
}
module.exports = { handle };
