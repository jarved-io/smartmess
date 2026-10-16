/*
 * Vercel serverless entry for every /api/* route.
 *
 *  DATABASE_URL set  -> REAL backend (lib/backend.js): Postgres/Supabase, sessions, role checks, scan validation,
 *                       forecasts stored in the database (XGBoost via ML_SERVICE_URL, 7-day-average fallback).
 *  DATABASE_URL unset-> SYNTHETIC demo backend (mock/mock-api.js) so the site still works without a database.
 *                       Every payload carries "synthetic": true. (Force it with FORCE_DEMO_BACKEND=1.)
 */
'use strict';
const { createMock } = require('../mock/mock-api.js');
const { createProxy } = require('../adapters/ml-proxy.js');
const backend = require('../lib/backend.js');
const { configured, getDb } = require('../lib/db.js');

const OFFSET_MIN = Number(process.env.DEMO_TZ_OFFSET_MINUTES || 330);
function wallClock() {
  const u = new Date(Date.now() + OFFSET_MIN * 60000);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
}
const mock = createMock({ now: wallClock, realNow: () => new Date(), allowedOrigin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000' });
let messIds;
try { messIds = process.env.MESS_ID_MAP ? JSON.parse(process.env.MESS_ID_MAP) : undefined; } catch (e) { messIds = undefined; }
const ml = process.env.ML_SERVICE_URL
  ? createProxy({ mlUrl: process.env.ML_SERVICE_URL, apiKey: process.env.ML_API_KEY, messIds, timeoutMs: Number(process.env.ML_TIMEOUT_MS || 25000) })
  : null;

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
const useReal = () => process.env.FORCE_DEMO_BACKEND !== '1' && configured();

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    let database = 'not_configured';
    if (useReal()) {
      try { await (await getDb()).query('SELECT 1'); database = 'connected'; } catch (e) { database = 'error'; }
    }
    let dataSource = 'synthetic-demo-backend', schema, seeded;
    if (database === 'connected') {
      const db = await getDb();
      try { seeded = (await db.query('SELECT 1 FROM users LIMIT 1')).length > 0; schema = 'ready'; } catch (e) { schema = 'missing'; }
      if (schema === 'ready') {
        try { const r = await db.query(`SELECT value FROM settings WHERE mess_id IS NULL AND key='data_source'`); dataSource = r[0] ? r[0].value : 'real'; } catch (e) { dataSource = 'unknown'; }
      } else dataSource = 'unknown';
    }
    return json(res, database === 'error' ? 503 : 200, { status: database === 'error' ? 'degraded' : 'ok', database, schema, seeded, dataSource,
      forecasts: database === 'connected' ? (process.env.ML_SERVICE_URL ? 'ml-service (baseline fallback)' : 'baseline') : (ml ? 'ml-service' : 'synthetic-demo') });
  }
  if (useReal()) return backend.handle(req, res);
  if (ml && req.method === 'GET' && url.pathname === '/api/forecasts') {
    const r = await ml.forecasts(Object.fromEntries(url.searchParams));
    return json(res, r.code, r.body);
  }
  return mock.handler(req, res);
};
