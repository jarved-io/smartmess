/* All /api routes for the real (database-backed) backend. Auth + RBAC are enforced here, never in the browser. */
'use strict';
const crypto = require('node:crypto');
const A = require('./auth');
const { HttpError, bad, isDate, cap } = require('./http');
const { getSettings, isSynthetic, VALID } = require('./settings');
const { localNow, addDays } = require('./time');
const { processScan } = require('./scan');
const { getForecasts, getEvaluations } = require('./forecast');

const DUMMY_HASH = A.hashPassword(crypto.randomBytes(8).toString('hex'));   // equalises timing for unknown users
const UI_ROLE = { student: 'student', mess_manager: 'chief', admin: 'chief', warden: 'warden' };
const MEAL_RE = /^[a-z]{3,20}$/;

const userView = (u, messName) => ({ student_id: u.student_id, name: u.name, role: u.role, ui_role: UI_ROLE[u.role], mess_id: u.mess_id, mess: messName || null, photo_url: u.photo_url || null });

async function resolveMess(c) {
  const v = c.q.mess || (c.body && (c.body.mess || c.body.mess_id));
  let rows;
  if (v) rows = await c.db.query('SELECT id, name FROM messes WHERE active AND (lower(id)=lower($1) OR lower(name)=lower($1))', [String(v)]);
  else rows = await c.db.query('SELECT id, name FROM messes WHERE active AND ($1::text IS NULL OR id=$1) ORDER BY id LIMIT 1', [c.user.mess_id || null]);
  if (!rows[0]) throw new HttpError(404, 'Unknown mess');
  if (!A.canAccessMess(c.user, rows[0].id)) throw new HttpError(403, 'You do not manage this mess');
  return rows[0];
}
async function todayFor(c, mess) { const s = await getSettings(c.db, mess.id); return { today: localNow(c.now, s.timezone).date, settings: s }; }
const needManager = c => A.requireRole(c.user, ['mess_manager', 'admin']);
const audit = (c, action, type, id, before, after) => c.db.query(
  'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_json, after_json) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
  [c.user.id, action, type, String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
function range(c, defDays) {
  return { from: c.q.from, to: c.q.to, defDays };
}
function dateRange(c, today, defDays, maxDays) {
  const to = c.q.to || today, from = c.q.from || addDays(to, -(defDays - 1));
  if (!isDate(from) || !isDate(to)) throw bad('from/to must be YYYY-MM-DD');
  if (from > to) throw bad('from must not be after to');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > maxDays) throw bad(`range too large (max ${maxDays} days)`);
  return { from, to };
}

const R = {};

/* ---------------- auth ---------------- */
R['POST /api/auth/login'] = async c => {
  const id = String((c.body.student_id || c.body.id || '')).trim(), pw = String(c.body.password || '');
  if (!id || !pw || id.length > 40 || pw.length > 200) throw bad('ID and password are required');
  const fails = (await c.db.query(`SELECT count(*)::int AS n FROM auth_attempts WHERE lower(student_id)=lower($1) AND ok=false AND at > now() - interval '10 minutes'`, [id]))[0].n;
  if (fails >= 8) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  const u = (await c.db.query('SELECT u.*, m.name AS mess_name FROM users u LEFT JOIN messes m ON m.id=u.mess_id WHERE lower(u.student_id)=lower($1)', [id]))[0];
  const ok = A.verifyPassword(pw, u ? u.password_hash : DUMMY_HASH) && !!u && u.status === 'active';
  await c.db.query('INSERT INTO auth_attempts (student_id, ok) VALUES ($1,$2)', [id.slice(0, 40), ok]);
  if (!ok) throw new HttpError(401, 'Wrong ID or password');
  c.setCookie(A.sessionCookie(c.req, A.makeToken(u.id)));
  return { user: userView(u, u.mess_name) };
};
R['POST /api/auth/logout'] = async c => { c.setCookie(A.sessionCookie(c.req, '', true)); return { ok: true }; };
R['GET /api/auth/me'] = async c => {
  A.requireUser(c.user);
  const m = c.user.mess_id ? (await c.db.query('SELECT name FROM messes WHERE id=$1', [c.user.mess_id]))[0] : null;
  return { user: userView(c.user, m && m.name) };
};

/* ---------------- student ---------------- */
R['POST /api/meals/scan'] = async c => {
  A.requireRole(c.user, ['student']);
  if (typeof c.body.qr !== 'string' || c.body.qr.length > 200) throw bad('qr is required');
  return processScan(c.db, c.user, c.body, c.now);
};
R['GET /api/meals/history'] = async c => {
  A.requireRole(c.user, ['student']);
  const limit = Math.min(Math.max(parseInt(c.q.limit || '100', 10) || 100, 1), 500);
  const rows = await c.db.query(
    `SELECT l.id, l.mess_id, m.name AS mess, l.meal_type, l.scanned_at, l.result, l.reason FROM meal_logs l LEFT JOIN messes m ON m.id=l.mess_id
     WHERE l.user_id=$1 ORDER BY l.scanned_at DESC LIMIT $2`, [c.user.id, limit]);
  return { history: rows.map(r => ({ id: r.id, mess_id: r.mess_id, mess: r.mess, meal_type: r.meal_type, scanned_at: new Date(r.scanned_at).toISOString(), result: r.result, reason: r.reason })) };
};
R['GET /api/account'] = async c => {
  A.requireRole(c.user, ['student']);
  const mess = c.user.mess_id ? (await c.db.query('SELECT id, name FROM messes WHERE id=$1', [c.user.mess_id]))[0] : null;
  const s = await getSettings(c.db, c.user.mess_id), today = localNow(c.now, s.timezone).date;
  const ledger = (await c.db.query('SELECT count(*)::int AS n, COALESCE(sum(amount),0) AS bal FROM ledger_entries WHERE user_id=$1', [c.user.id]))[0];
  const meals = (await c.db.query(`SELECT count(*)::int AS n FROM meal_logs WHERE user_id=$1 AND result='success' AND meal_date >= date_trunc('month', $2::date)::date`, [c.user.id, today]))[0].n;
  const leave = await c.db.query(`SELECT start_date, end_date, status FROM leave_requests WHERE user_id=$1 AND end_date >= $2 ORDER BY start_date LIMIT 10`, [c.user.id, today]);
  return { student_id: c.user.student_id, name: c.user.name, mess, balance: ledger.n ? Number(ledger.bal) : null,
    meals_this_month: meals, leave: leave.map(l => ({ start: l.start_date, end: l.end_date, status: l.status })) };
};
R['GET /api/meal-windows'] = async c => {
  A.requireUser(c.user);
  const mess = c.user.role === 'student' ? { id: c.user.mess_id } : await resolveMess(c);
  const rows = await c.db.query('SELECT meal_type, start_time::text AS s, end_time::text AS e FROM meal_windows WHERE mess_id=$1 ORDER BY start_time', [mess.id]);
  return { windows: rows.map(r => ({ meal_type: r.meal_type, meal: cap(r.meal_type), start: r.s.slice(0, 5), end: r.e.slice(0, 5) })) };
};

/* ---------------- manager: dashboard ---------------- */
R['GET /api/dashboard/summary'] = async c => {
  needManager(c);
  const mess = await resolveMess(c);
  const { today, settings } = await todayFor(c, mess);
  const date = c.q.date || today;
  if (!isDate(date)) throw bad('date must be YYYY-MM-DD');
  const q = () => c.db.query(
    `SELECT w.meal_type, f.predicted_count, u.prepared_count, u.served_count, l.cnt
     FROM meal_windows w
     LEFT JOIN LATERAL (SELECT predicted_count FROM forecasts WHERE mess_id=w.mess_id AND target_date=$2 AND meal_type=w.meal_type ORDER BY created_at DESC LIMIT 1) f ON true
     LEFT JOIN mess_usage u ON u.mess_id=w.mess_id AND u.date=$2 AND u.meal_type=w.meal_type
     LEFT JOIN LATERAL (SELECT count(*)::int AS cnt FROM meal_logs WHERE mess_id=w.mess_id AND meal_date=$2 AND meal_type=w.meal_type AND result='success') l ON true
     WHERE w.mess_id=$1 ORDER BY w.start_time`, [mess.id, date]);
  let rows = await q();
  if (date >= today && rows.some(r => r.predicted_count === null)) {      // expected = the stored forecast; create it on first view
    try { await getForecasts(c.db, mess, date, today); rows = await q(); } catch (e) { /* expected stays null (unknown) */ }
  }
  const exc = (await c.db.query(`SELECT count(*)::int AS n FROM meal_logs WHERE mess_id=$1 AND meal_date=$2 AND result<>'success'`, [mess.id, date]))[0].n;
  const out = { mess: mess.name, date, generatedAt: c.now.toISOString(), exceptionCount: exc,
    meals: rows.map(r => ({ mealType: cap(r.meal_type), expected: r.predicted_count,
      served: date > today ? null : date === today ? r.cnt : (r.served_count !== null ? r.served_count : (r.cnt > 0 ? r.cnt : null)),
      prepared: r.prepared_count })) };
  if (isSynthetic(settings)) out.synthetic = true;
  return out;
};

R['GET /api/forecasts'] = async c => {
  needManager(c);
  const mess = await resolveMess(c);
  const { today } = await todayFor(c, mess);
  const date = c.q.date;
  if (!isDate(date)) throw bad('date must be YYYY-MM-DD');
  const meal = c.q.meal ? String(c.q.meal).toLowerCase() : null;
  if (meal && !MEAL_RE.test(meal)) throw bad('invalid meal');
  return getForecasts(c.db, mess, date, today, { mealFilter: meal });
};
R['GET /api/forecasts/evaluations'] = async c => {
  needManager(c);
  const mess = await resolveMess(c);
  const { today, settings } = await todayFor(c, mess);
  const { from, to } = dateRange(c, today, 30, 400);
  const meal = c.q.meal ? String(c.q.meal).toLowerCase() : null;
  const out = { records: await getEvaluations(c.db, mess.id, from, to, meal) };
  if (isSynthetic(settings)) out.synthetic = true;
  return out;
};

const EXC = {
  duplicate: ['duplicate_scan', 'Second scan attempt for the same meal'], on_leave: ['leave_rejection', 'Scan rejected: approved leave on record'],
  outside_window: ['outside_window', 'Scan outside the meal window'], wrong_mess: ['wrong_mess', 'Student scanned at a different mess'],
  invalid_qr: ['invalid_scan', 'Invalid QR code'], inactive: ['inactive_account', 'Inactive account tried to scan']
};
R['GET /api/exceptions'] = async c => {
  needManager(c);
  const mess = await resolveMess(c);
  const { today, settings } = await todayFor(c, mess);
  const { from, to } = dateRange(c, today, 7, 93);
  const rows = await c.db.query(
    `SELECT id, scanned_at, meal_type, result, reason, user_id FROM meal_logs
     WHERE mess_id=$1 AND meal_date BETWEEN $2 AND $3 AND (result<>'success' OR reason='on_leave_flagged') ORDER BY scanned_at DESC LIMIT 500`, [mess.id, from, to]);
  const out = { exceptions: rows.map(r => {
    const flagged = r.result === 'success';
    const t = flagged ? ['leave_flagged', 'Meal served while approved leave on record (flagged)'] : (EXC[r.result] || [r.result, r.result]);
    return { id: 'e' + r.id, timestamp: new Date(r.scanned_at).toISOString(), type: t[0], description: t[1] + (r.meal_type ? ' (' + cap(r.meal_type) + ')' : ''),
      subjectRef: A.subjectRef(r.user_id), status: flagged ? 'flagged' : 'rejected' };
  }) };
  if (isSynthetic(settings)) out.synthetic = true;
  return out;
};

R['GET /api/reports/daily'] = async c => {
  needManager(c);
  const mess = await resolveMess(c);
  const { today, settings } = await todayFor(c, mess);
  const { from, to } = dateRange(c, today, 7, 93);
  const end = to < today ? to : today;
  const rows = end < from ? [] : await c.db.query(
    `SELECT d.date::text AS date, w.meal_type, f.predicted_count, u.prepared_count, u.served_count, l.cnt
     FROM generate_series($2::date, $3::date, interval '1 day') AS d(date)
     CROSS JOIN meal_windows w
     LEFT JOIN LATERAL (SELECT predicted_count FROM forecasts WHERE mess_id=w.mess_id AND target_date=d.date::date AND meal_type=w.meal_type ORDER BY created_at DESC LIMIT 1) f ON true
     LEFT JOIN mess_usage u ON u.mess_id=w.mess_id AND u.date=d.date::date AND u.meal_type=w.meal_type
     LEFT JOIN LATERAL (SELECT count(*)::int AS cnt FROM meal_logs WHERE mess_id=w.mess_id AND meal_date=d.date::date AND meal_type=w.meal_type AND result='success') l ON true
     WHERE w.mess_id=$1 ORDER BY d.date, w.start_time`, [mess.id, from, end]);
  const out = { rows: rows.map(r => ({ date: String(r.date).slice(0, 10), mealType: cap(r.meal_type), expected: r.predicted_count, predictedCount: r.predicted_count,
    served: r.served_count !== null ? r.served_count : (r.cnt > 0 || String(r.date).slice(0, 10) === today ? r.cnt : null), prepared: r.prepared_count })) };
  if (isSynthetic(settings)) out.synthetic = true;
  return out;
};

/* ---------------- manager: usage, QR, rosters ---------------- */
async function mealOf(c, mess, v) {
  const meal = String(v || '').toLowerCase();
  const w = (await c.db.query('SELECT meal_type, start_time::text AS s, end_time::text AS e FROM meal_windows WHERE mess_id=$1 AND meal_type=$2', [mess.id, meal]))[0];
  if (!w) throw bad('Unknown meal_type for this mess');
  return w;
}
const count = (v, name) => { if (!Number.isInteger(v) || v < 0 || v > 100000) throw bad(`${name} must be a whole number between 0 and 100000`); return v; };

R['POST /api/mess-usage/prepared'] = async c => {
  needManager(c);
  const mess = await resolveMess(c), { today } = await todayFor(c, mess);
  const date = c.body.date || today;
  if (!isDate(date) || date > addDays(today, 1)) throw bad('date must be YYYY-MM-DD and not after tomorrow');
  const w = await mealOf(c, mess, c.body.meal_type), n = count(c.body.prepared_count, 'prepared_count');
  const before = (await c.db.query('SELECT prepared_count FROM mess_usage WHERE mess_id=$1 AND date=$2 AND meal_type=$3', [mess.id, date, w.meal_type]))[0];
  const row = (await c.db.query(
    `INSERT INTO mess_usage (mess_id,date,meal_type,prepared_count) VALUES ($1,$2,$3,$4)
     ON CONFLICT (mess_id,date,meal_type) DO UPDATE SET prepared_count=EXCLUDED.prepared_count, updated_at=now()
     RETURNING mess_id, date, meal_type, prepared_count, served_count, waste_count`, [mess.id, date, w.meal_type, n]))[0];
  await audit(c, 'mess_usage.prepared', 'mess_usage', `${mess.id}/${date}/${w.meal_type}`, before, { prepared_count: n });
  return row;
};
R['POST /api/mess-usage/actual'] = async c => {
  needManager(c);
  const mess = await resolveMess(c), { today, settings } = await todayFor(c, mess);
  const date = c.body.date || today;
  if (!isDate(date) || date > today) throw bad('date must be YYYY-MM-DD and not in the future');
  const w = await mealOf(c, mess, c.body.meal_type);
  let served = c.body.served_count;
  if (served === undefined || served === null) {              // close the meal: aggregate verified scans
    const nowMin = localNow(c.now, settings.timezone).minutes, [h, m] = w.e.split(':').map(Number);
    if (date === today && nowMin <= h * 60 + m) throw new HttpError(409, 'This meal is still being served; close it after the window ends or pass served_count');
    served = (await c.db.query(`SELECT count(*)::int AS n FROM meal_logs WHERE mess_id=$1 AND meal_date=$2 AND meal_type=$3 AND result='success'`, [mess.id, date, w.meal_type]))[0].n;
  } else count(served, 'served_count');
  const before = (await c.db.query('SELECT served_count, prepared_count FROM mess_usage WHERE mess_id=$1 AND date=$2 AND meal_type=$3', [mess.id, date, w.meal_type]))[0];
  const row = (await c.db.query(
    `INSERT INTO mess_usage (mess_id,date,meal_type,served_count) VALUES ($1,$2,$3,$4)
     ON CONFLICT (mess_id,date,meal_type) DO UPDATE SET served_count=EXCLUDED.served_count,
       waste_count = CASE WHEN mess_usage.prepared_count IS NULL THEN NULL ELSE GREATEST(mess_usage.prepared_count - EXCLUDED.served_count, 0) END, updated_at=now()
     RETURNING mess_id, date, meal_type, prepared_count, served_count, waste_count`, [mess.id, date, w.meal_type, served]))[0];
  await audit(c, 'mess_usage.actual', 'mess_usage', `${mess.id}/${date}/${w.meal_type}`, before, { served_count: served });
  return row;
};
R['GET /api/mess-usage'] = async c => {
  needManager(c);
  const mess = await resolveMess(c), { today } = await todayFor(c, mess), { from, to } = dateRange(c, today, 14, 93);
  const rows = await c.db.query('SELECT date, meal_type, prepared_count, served_count, waste_count FROM mess_usage WHERE mess_id=$1 AND date BETWEEN $2 AND $3 ORDER BY date DESC, meal_type', [mess.id, from, to]);
  return { rows };
};
R['GET /api/mess/qr'] = async c => {
  needManager(c);
  const mess = await resolveMess(c);
  return { mess_id: mess.id, mess: mess.name, payload: A.qrPayload(mess.id) };
};
R['GET /api/meals/attendance'] = async c => {
  needManager(c);
  const mess = await resolveMess(c), { today } = await todayFor(c, mess);
  const days = Math.min(Math.max(parseInt(c.q.days || '7', 10) || 7, 1), 31);
  const rows = await c.db.query(
    `SELECT l.scanned_at, l.meal_type, l.result, u.student_id, u.name FROM meal_logs l JOIN users u ON u.id=l.user_id
     WHERE l.mess_id=$1 AND l.meal_date BETWEEN $2 AND $3 ORDER BY l.scanned_at DESC LIMIT 1500`, [mess.id, addDays(today, -(days - 1)), today]);
  return { mess: mess.name, attendance: rows.map(r => ({ student_id: r.student_id, name: r.name, meal_type: r.meal_type, result: r.result, scanned_at: new Date(r.scanned_at).toISOString() })) };
};
R['GET /api/students'] = async c => {
  needManager(c);
  const mess = await resolveMess(c);
  const rows = await c.db.query(`SELECT student_id, name, status FROM users WHERE role='student' AND mess_id=$1 ORDER BY student_id LIMIT 3000`, [mess.id]);
  return { mess: mess.name, students: rows };
};

/* ---------------- Warden adapter (the Warden app stays the approval system) ---------------- */
R['GET /api/warden/leave-status'] = async c => {
  A.requireUser(c.user);
  const sid = String(c.q.student_id || (c.user.role === 'student' ? c.user.student_id : '')).trim();
  if (!sid) throw bad('student_id is required');
  if (c.user.role === 'student' && sid.toLowerCase() !== c.user.student_id.toLowerCase()) throw new HttpError(403, 'You can only view your own leave');
  if (!['student', 'warden', 'admin'].includes(c.user.role)) throw new HttpError(403, 'Not allowed');
  const s = await getSettings(c.db, null);
  const date = c.q.date || localNow(c.now, s.timezone).date;
  if (!isDate(date)) throw bad('date must be YYYY-MM-DD');
  const r = (await c.db.query(
    `SELECT lr.start_date, lr.end_date, lr.status FROM leave_requests lr JOIN users u ON u.id=lr.user_id
     WHERE lower(u.student_id)=lower($1) AND $2::date BETWEEN lr.start_date AND lr.end_date ORDER BY (lr.status='approved') DESC, lr.id DESC LIMIT 1`, [sid, date]))[0];
  return { student_id: sid, date, status: r && r.status === 'approved' ? 'on_leave' : 'none', request: r ? { start: r.start_date, end: r.end_date, status: r.status } : null };
};
R['POST /api/warden/webhook'] = async c => {            // the Warden app pushes leave decisions here
  const key = process.env.WARDEN_WEBHOOK_SECRET;
  if (!key) throw new HttpError(404, 'Not found');
  const given = String(c.req.headers['x-warden-secret'] || '');
  if (given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) throw new HttpError(401, 'Bad secret');
  const items = Array.isArray(c.body.items) ? c.body.items : [c.body];
  if (items.length > 500) throw bad('too many items');
  let n = 0;
  for (const it of items) {
    if (!it.external_id || !it.student_id || !isDate(it.start_date) || !isDate(it.end_date) || it.end_date < it.start_date || !['pending', 'approved', 'rejected'].includes(it.status)) throw bad('invalid leave item');
    const u = (await c.db.query(`SELECT id FROM users WHERE lower(student_id)=lower($1) AND role='student'`, [String(it.student_id)]))[0];
    if (!u) throw bad('unknown student_id ' + String(it.student_id).slice(0, 40));
    await c.db.query(
      `INSERT INTO leave_requests (external_id,user_id,start_date,end_date,status,approved_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (external_id) DO UPDATE SET start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, status=EXCLUDED.status, approved_by=EXCLUDED.approved_by`,
      [String(it.external_id).slice(0, 80), u.id, it.start_date, it.end_date, it.status, it.approved_by ? String(it.approved_by).slice(0, 80) : null]);
    n++;
  }
  return { synced: n };
};

/* ---------------- admin ---------------- */
R['GET /api/settings'] = async c => {
  A.requireRole(c.user, ['admin']);
  return { settings: await getSettings(c.db, null), allowed: Object.keys(VALID) };
};
R['PUT /api/settings'] = async c => {
  A.requireRole(c.user, ['admin']);
  const key = String(c.body.key || ''), value = String(c.body.value === undefined ? '' : c.body.value);
  if (!VALID[key] || !VALID[key](value)) throw bad('Unknown setting or invalid value');
  const before = (await c.db.query('SELECT value FROM settings WHERE mess_id IS NULL AND key=$1', [key]))[0];
  await c.db.query(
    `INSERT INTO settings (mess_id,key,value,updated_by) VALUES (NULL,$1,$2,$3)
     ON CONFLICT (COALESCE(mess_id,''), key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [key, value, c.user.id]);
  await audit(c, 'settings.update', 'settings', key, before, { value });
  return { key, value };
};

module.exports = { ROUTES: R };
