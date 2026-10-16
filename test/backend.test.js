'use strict';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
delete process.env.ML_SERVICE_URL; delete process.env.ML_API_KEY; delete process.env.WARDEN_WEBHOOK_SECRET;
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { createPglite, setDb, getDb } = require('../lib/db');
const { migrate, seed, reset } = require('../lib/seed');
const { handle } = require('../lib/backend');
const { qrPayload } = require('../lib/auth');
const { zonedToUtc } = require('../lib/time');

const PW = 'test-password-1';
let db, server, base, clock = new Date();
const TODAY = () => new Date(clock.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);   // IST date
const at = (h, m) => { clock = zonedToUtc(TODAY(), h * 60 + m, 'Asia/Kolkata'); };

async function call(method, path, body, cookie) {
  const r = await fetch(base + path, { method, headers: Object.assign({ Cookie: cookie || '' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* */ }
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  return { status: r.status, body: json, cookie: sc.length ? sc[0].split(';')[0] : null, raw: sc };
}
async function login(id) { const r = await call('POST', '/api/auth/login', { student_id: id, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.cookie; }
const scan = (cookie, qr, extra) => call('POST', '/api/meals/scan', Object.assign({ qr }, extra), cookie);

test.before(async () => {
  if (process.env.TEST_DATABASE_URL) {                 // optional: run the same suite against a real Postgres via node-postgres
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; db = await getDb(); await migrate(db); await reset(db);
  } else { db = await createPglite(); setDb(db); await migrate(db); }
  at(12, 30);
  await seed(db, { studentsPerMess: 30, password: PW, demoIgnoreWindows: false, now: clock });
  server = http.createServer((req, res) => handle(req, res, clock));
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); await db.close(); });
test.beforeEach(async () => { at(12, 30); });

test('login: success sets an HttpOnly cookie, wrong password is 401, session works, logout clears it', async () => {
  const bad = await call('POST', '/api/auth/login', { student_id: 'NN25CSE290', password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/auth/login', { student_id: 'nn25cse290', password: PW });
  assert.equal(ok.status, 200); assert.equal(ok.body.user.ui_role, 'student'); assert.match(ok.raw[0], /HttpOnly/); assert.match(ok.raw[0], /SameSite=Lax/);
  assert.equal(JSON.stringify(ok.body).includes('password'), false);
  assert.equal((await call('GET', '/api/auth/me', null, ok.cookie)).body.user.mess, 'South Mess');
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  assert.equal((await call('GET', '/api/auth/me', null, ok.cookie.slice(0, -3) + 'abc')).status, 401);   // tampered
});

test('login is throttled after repeated failures', async () => {
  for (let i = 0; i < 8; i++) await call('POST', '/api/auth/login', { student_id: 'NN25CSE005', password: 'x' + i });
  const r = await call('POST', '/api/auth/login', { student_id: 'NN25CSE005', password: PW });
  assert.equal(r.status, 429);
});

test('POST needs application/json; unknown routes 404; wrong method 405', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/api/auth/login')).status, 405);
});

test('RBAC: anonymous 401, student 403 on manager data, manager ok, student-only scan', async () => {
  const stu = await login('NN25CSE290'), chief = await login('CHIEF'), admin = await login('ADMIN');
  assert.equal((await call('GET', '/api/dashboard/summary?mess=South%20Mess')).status, 401);
  assert.equal((await call('GET', '/api/dashboard/summary?mess=South%20Mess', null, stu)).status, 403);
  assert.equal((await call('GET', '/api/students?mess=south', null, stu)).status, 403);
  assert.equal((await call('GET', '/api/dashboard/summary?mess=South%20Mess', null, chief)).status, 200);
  assert.equal((await scan(chief, qrPayload('south'))).status, 403);
  assert.equal((await call('GET', '/api/settings', null, chief)).status, 403);
  assert.equal((await call('GET', '/api/settings', null, admin)).status, 200);
  assert.equal((await call('GET', '/api/meals/history', null, chief)).status, 403);
});

test('scan: success, duplicate, replay is idempotent, race gives exactly one success', async () => {
  await db.query(`DELETE FROM leave_requests WHERE user_id IN (SELECT id FROM users WHERE student_id IN ('NN25CSE290','NN25CSE010','NN25CSE011'))`);
  const c = await login('NN25CSE290'), q = qrPayload('south');
  const a = await scan(c, q, { event_id: 'ev-1' });
  assert.equal(a.body.valid, true); assert.equal(a.body.meal_type, 'Lunch'); assert.equal(a.body.student.name, 'Aarush'); assert.equal(a.body.mess.name, 'South Mess');
  const d = await scan(c, q, { event_id: 'ev-2' });
  assert.equal(d.body.valid, false); assert.equal(d.body.result, 'duplicate');
  const replay = await scan(c, q, { event_id: 'ev-1' });
  assert.equal(replay.body.valid, true); assert.equal(replay.body.replayed, true);
  assert.equal((await db.query(`SELECT count(*)::int n FROM meal_logs WHERE event_id='ev-1'`))[0].n, 1);
  const other = await login('NN25CSE010');
  assert.equal((await scan(other, q, { event_id: 'ev-1' })).status, 409);     // someone else's event id

  const c2 = await login('NN25CSE011');
  const [r1, r2] = await Promise.all([scan(c2, q, { event_id: 'race-1' }), scan(c2, q, { event_id: 'race-2' })]);
  assert.deepEqual([r1.body.result, r2.body.result].sort(), ['duplicate', 'success']);
  assert.equal((await db.query(`SELECT count(*)::int n FROM meal_logs l JOIN users u ON u.id=l.user_id WHERE u.student_id='NN25CSE011' AND l.meal_date=$1 AND l.result='success'`, [TODAY()]))[0].n, 1);
});

test('scan: invalid QR, tampered QR, wrong mess, outside window', async () => {
  const c = await login('NN25CSE012');
  assert.equal((await scan(c, 'hello')).body.result, 'invalid_qr');
  assert.equal((await scan(c, qrPayload('south').slice(0, -2) + 'xx')).body.result, 'invalid_qr');
  assert.equal((await scan(c, qrPayload('north'))).body.result, 'wrong_mess');
  at(15, 0);
  const o = await scan(c, qrPayload('south'));
  assert.equal(o.body.result, 'outside_window'); assert.equal(o.body.valid, false);
  assert.equal((await scan(c, qrPayload('south'), { meal_type: 'lunch' })).body.result, 'outside_window');   // client cannot pick the meal
});

test('scan: leave policy reject / flag / ignore', async () => {
  const sid = 'NN25CSE013', c = await login(sid);
  const u = (await db.query('SELECT id FROM users WHERE student_id=$1', [sid]))[0].id;
  await db.query(`DELETE FROM leave_requests WHERE user_id=$1`, [u]);
  await db.query(`INSERT INTO leave_requests (user_id,start_date,end_date,status) VALUES ($1,$2,$2,'approved')`, [u, TODAY()]);
  const admin = await login('ADMIN');
  const rej = await scan(c, qrPayload('south'));
  assert.equal(rej.body.result, 'on_leave');
  assert.equal((await call('PUT', '/api/settings', { key: 'leave_policy', value: 'flag' }, admin)).status, 200);
  const fl = await scan(c, qrPayload('south'));
  assert.equal(fl.body.valid, true); assert.match(fl.body.message, /flagged/);
  const exc = await call('GET', '/api/exceptions?mess=south', null, await login('CHIEF'));
  assert.ok(exc.body.exceptions.some(e => e.type === 'leave_flagged'));
  await call('PUT', '/api/settings', { key: 'leave_policy', value: 'reject' }, admin);
});

test('demo_ignore_windows allows a scan outside windows using the requested meal', async () => {
  const admin = await login('ADMIN'), c = await login('NN25CSE014');
  await call('PUT', '/api/settings', { key: 'demo_ignore_windows', value: 'true' }, admin);
  at(15, 0);
  const r = await scan(c, qrPayload('south'), { meal_type: 'dinner' });
  assert.equal(r.body.valid, true); assert.equal(r.body.meal_type, 'Dinner');
  await call('PUT', '/api/settings', { key: 'demo_ignore_windows', value: 'false' }, admin);
});

test('history + account for a student', async () => {
  const c = await login('NN25CSE290');
  const h = await call('GET', '/api/meals/history?limit=5', null, c);
  assert.equal(h.status, 200); assert.ok(h.body.history.length > 0 && h.body.history.length <= 5);
  const a = await call('GET', '/api/account', null, c);
  assert.equal(a.body.student_id, 'NN25CSE290'); assert.equal(a.body.balance, null);      // no ledger entries -> unknown, not 0
  assert.ok(a.body.meals_this_month >= 1);
});

test('dashboard summary: live served count follows scans; synthetic flag; null = unknown', async () => {
  const chief = await login('CHIEF');
  const s = await call('GET', '/api/dashboard/summary?mess=South%20Mess', null, chief);
  assert.equal(s.status, 200); assert.equal(s.body.synthetic, true); assert.equal(s.body.date, TODAY());
  const lunch = s.body.meals.find(m => m.mealType === 'Lunch');
  assert.ok(lunch.served >= 2);                                                         // scans made above
  assert.ok(Number.isInteger(lunch.expected));                                          // forecast created on first view
  assert.equal(lunch.prepared, null);
  const tomorrow = await call('GET', '/api/dashboard/summary?mess=south&date=' + new Date(Date.parse(TODAY()) + 864e5).toISOString().slice(0, 10), null, chief);
  assert.equal(tomorrow.body.meals[0].served, null);
  assert.equal((await call('GET', '/api/dashboard/summary?mess=Nowhere', null, chief)).status, 404);
  assert.equal((await call('GET', '/api/dashboard/summary?mess=south&date=bad', null, chief)).status, 400);
});

test('prepared / actual recording with validation, audit trail and waste', async () => {
  const chief = await login('CHIEF');
  assert.equal((await call('POST', '/api/mess-usage/prepared', { mess: 'south', meal_type: 'lunch', prepared_count: -5 }, chief)).status, 400);
  assert.equal((await call('POST', '/api/mess-usage/prepared', { mess: 'south', meal_type: 'brunch', prepared_count: 5 }, chief)).status, 400);
  const p = await call('POST', '/api/mess-usage/prepared', { mess: 'south', meal_type: 'lunch', prepared_count: 100 }, chief);
  assert.equal(p.body.prepared_count, 100);
  assert.equal((await call('POST', '/api/mess-usage/actual', { mess: 'south', meal_type: 'lunch' }, chief)).status, 409);   // still being served
  at(14, 30);
  const a = await call('POST', '/api/mess-usage/actual', { mess: 'south', meal_type: 'lunch' }, chief);
  assert.equal(a.status, 200); assert.ok(a.body.served_count >= 2); assert.equal(a.body.waste_count, Math.max(100 - a.body.served_count, 0));
  assert.equal((await call('POST', '/api/mess-usage/actual', { mess: 'south', meal_type: 'lunch', date: '2099-01-01', served_count: 5 }, chief)).status, 400);
  assert.ok((await db.query(`SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'mess_usage.%'`))[0].n >= 2);
  const sum = await call('GET', '/api/dashboard/summary?mess=south', null, chief);
  assert.equal(sum.body.meals.find(m => m.mealType === 'Lunch').prepared, 100);
});

test('exceptions are anonymised; reports list past days with forecast + actual', async () => {
  const chief = await login('CHIEF');
  const e = await call('GET', '/api/exceptions?mess=south&from=' + TODAY(), null, chief);
  assert.ok(e.body.exceptions.length > 0);
  e.body.exceptions.forEach(x => { assert.match(x.subjectRef, /^S-[0-9A-F]{4}$/); assert.equal('name' in x || 'student_id' in x, false); });
  const rep = await call('GET', '/api/reports/daily?mess=south&from=' + new Date(Date.parse(TODAY()) - 6 * 864e5).toISOString().slice(0, 10) + '&to=' + TODAY(), null, chief);
  assert.equal(rep.body.rows.length, 7 * 3);
  const past = rep.body.rows.find(r => r.date < TODAY());
  assert.ok(Number.isInteger(past.served) && Number.isInteger(past.predictedCount));
  assert.equal((await call('GET', '/api/reports/daily?mess=south&from=2020-01-01&to=2026-01-01', null, chief)).status, 400);
});

test('forecasts: baseline when ML is not configured; stored, cached, buffered; past date rejected', async () => {
  const chief = await login('CHIEF'), d = new Date(Date.parse(TODAY()) + 864e5).toISOString().slice(0, 10);
  const f = await call('GET', '/api/forecasts?mess=South%20Mess&date=' + d, null, chief);
  assert.equal(f.status, 200); assert.equal(f.body.forecasts.length, 3); assert.equal(f.body.synthetic, true);
  const lunch = f.body.forecasts.find(x => x.meal_type === 'lunch');
  assert.equal(lunch.model_version, 'baseline_ma7'); assert.equal(lunch.recommended_preparation, Math.round(lunch.predicted_meals * 1.02));
  assert.match(lunch.warnings[0], /not configured/);
  const again = await call('GET', '/api/forecasts?mess=South%20Mess&date=' + d, null, chief);
  assert.equal(again.body.forecasts.find(x => x.meal_type === 'lunch').generated_at, lunch.generated_at);   // cached, no new row
  assert.equal((await call('GET', '/api/forecasts?mess=south&date=2020-01-01', null, chief)).status, 400);
});

test('forecasts: real ML response is stored; ML failure falls back to the baseline with a warning', async () => {
  const seen = [];
  const ml = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b); seen.push({ key: req.headers['x-api-key'], j });
      if (j.meal_type === 'dinner') { res.statusCode = 422; return res.end(JSON.stringify({ detail: 'No history' })); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ predicted_meals: 41, recommended_preparation: 42, model_version: 'xgb_v7', method: 'xgboost', warnings: ['model was trained on SYNTHETIC data'], prediction_range: { low: 38, high: 45 } }));
    });
  });
  await new Promise(r => ml.listen(0, r));
  process.env.ML_SERVICE_URL = 'http://127.0.0.1:' + ml.address().port; process.env.ML_API_KEY = 'k123';
  try {
    await db.query(`DELETE FROM forecasts WHERE target_date = $1::date + 2`, [TODAY()]);
    const chief = await login('CHIEF'), d = new Date(Date.parse(TODAY()) + 2 * 864e5).toISOString().slice(0, 10);
    const f = await call('GET', '/api/forecasts?mess=south&date=' + d, null, chief);
    const lunch = f.body.forecasts.find(x => x.meal_type === 'lunch'), dinner = f.body.forecasts.find(x => x.meal_type === 'dinner');
    assert.equal(lunch.model_version, 'xgb_v7'); assert.deepEqual(lunch.prediction_range, { low: 38, high: 45 });
    assert.equal(seen[0].key, 'k123'); assert.equal(seen[0].j.mess_id, 'south'); assert.equal(seen[0].j.active_students, 30 + 1); assert.ok(Number.isInteger(seen[0].j.approved_leave));
    assert.equal(dinner.model_version, 'baseline_ma7'); assert.match(dinner.warnings[0], /ML forecast unavailable/);
    assert.equal((await db.query(`SELECT count(*)::int n FROM forecasts WHERE target_date=$1 AND mess_id='south'`, [d]))[0].n, 3);
  } finally { delete process.env.ML_SERVICE_URL; delete process.env.ML_API_KEY; ml.close(); }
});

test('evaluations: predicted vs actual from stored forecasts; errors persisted', async () => {
  const chief = await login('CHIEF');
  const e = await call('GET', '/api/forecasts/evaluations?mess=south&meal=lunch', null, chief);
  assert.equal(e.status, 200); assert.ok(e.body.records.length >= 5);
  const r = e.body.records[0];
  assert.ok(Number.isInteger(r.predictedCount) && Number.isInteger(r.actualCount)); assert.equal(r.mealType, 'Lunch');
  const row = (await db.query(`SELECT absolute_error, squared_error FROM forecast_evaluations fe JOIN forecasts f ON f.id=fe.forecast_id WHERE f.target_date=$1 AND f.meal_type='lunch' AND f.mess_id='south'`, [r.targetDate]))[0];
  assert.equal(row.absolute_error, Math.abs(r.predictedCount - r.actualCount)); assert.equal(row.squared_error, (r.predictedCount - r.actualCount) ** 2);
});

test('Warden adapter: webhook disabled without a secret; with a secret it syncs leave used by the scan rules', async () => {
  const body = { items: [{ external_id: 'W-1', student_id: 'NN25CSE015', start_date: TODAY(), end_date: TODAY(), status: 'approved', approved_by: 'Warden' }] };
  assert.equal((await call('POST', '/api/warden/webhook', body)).status, 404);
  process.env.WARDEN_WEBHOOK_SECRET = 'whsec-1234567890';
  try {
    const post = (secret, b) => fetch(base + '/api/warden/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-warden-secret': secret }, body: JSON.stringify(b) });
    assert.equal((await post('wrong-secret-000', body)).status, 401);
    await db.query(`DELETE FROM leave_requests WHERE user_id IN (SELECT id FROM users WHERE student_id='NN25CSE015')`);
    const ok = await post('whsec-1234567890', body);
    assert.equal(ok.status, 200); assert.equal((await ok.json()).synced, 1);
    await post('whsec-1234567890', body);                                                  // idempotent
    assert.equal((await db.query(`SELECT count(*)::int n FROM leave_requests WHERE external_id='W-1'`))[0].n, 1);
    const c = await login('NN25CSE015');
    assert.equal((await call('GET', '/api/warden/leave-status', null, c)).body.status, 'on_leave');
    assert.equal((await call('GET', '/api/warden/leave-status?student_id=NN25CSE016', null, c)).status, 403);
    assert.equal((await scan(c, qrPayload('south'))).body.result, 'on_leave');
    assert.equal((await post('whsec-1234567890', { items: [{ external_id: 'W-2', student_id: 'NOBODY', start_date: TODAY(), end_date: TODAY(), status: 'approved' }] })).status, 400);
  } finally { delete process.env.WARDEN_WEBHOOK_SECRET; }
});

test('QR endpoint for the counter + roster endpoints (manager only)', async () => {
  const chief = await login('CHIEF');
  const q = await call('GET', '/api/mess/qr?mess=south', null, chief);
  assert.equal(q.body.payload, qrPayload('south'));
  assert.equal((await call('GET', '/api/students?mess=south', null, chief)).body.students.length, 31);
  const att = await call('GET', '/api/meals/attendance?mess=south&days=2', null, chief);
  assert.ok(att.body.attendance.length > 0 && 'name' in att.body.attendance[0]);
  assert.equal((await call('GET', '/api/mess/qr?mess=south', null, await login('NN25CSE290'))).status, 403);
});

test('settings: admin can change a business rule; invalid values rejected', async () => {
  const admin = await login('ADMIN');
  assert.equal((await call('PUT', '/api/settings', { key: 'safety_buffer', value: '0.9' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/settings', { key: 'bogus', value: '1' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/settings', { key: 'safety_buffer', value: '0.05' }, admin)).status, 200);
  await call('PUT', '/api/settings', { key: 'safety_buffer', value: '0.02' }, admin);
});

test('an unmigrated database gives a clear 503 instead of a vague error', async () => {
  const { createPglite: mk } = require('../lib/db');
  const empty = await mk(); const prev = db; setDb(empty);
  try {
    const r = await call('POST', '/api/auth/login', { student_id: 'NN25CSE290', password: PW });
    assert.equal(r.status, 503); assert.match(r.body.error, /db:migrate/); assert.equal(typeof r.body.error, 'string');
  } finally { setDb(prev); await empty.close(); }
});
