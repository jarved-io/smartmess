/* Schema migration + SYNTHETIC demo data. Replace with real data when available.
 * Seeded data sets settings.data_source = 'synthetic_demo' so every manager payload carries "synthetic": true.
 * To go live: delete that setting row (or PUT /api/settings data_source=real), remove demo users/logs, import real data. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');
const { localNow, addDays, zonedToUtc } = require('./time');

const MESSES = [['south', 'South Mess', 'South hostel block'], ['north', 'North Mess', 'North hostel block']];
const WINDOWS = [['breakfast', '07:30', '08:45'], ['lunch', '12:00', '13:45'], ['dinner', '19:30', '20:45']];
const RATE = { breakfast: 0.68, lunch: 0.86, dinner: 0.9 };
const TABLES = ['audit_logs', 'auth_attempts', 'forecast_evaluations', 'forecasts', 'mess_usage', 'add_on_orders', 'leave_requests', 'ledger_entries', 'meal_logs', 'settings', 'meal_windows', 'users', 'messes'];

async function migrate(db) { await db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')); }
async function reset(db) { await db.exec('TRUNCATE ' + TABLES.join(', ') + ' RESTART IDENTITY CASCADE'); }

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pad = (n, w) => String(n).padStart(w, '0');
function timeIn(w, rnd) { const [sh, sm] = w[1].split(':').map(Number), [eh, em] = w[2].split(':').map(Number); const a = sh * 60 + sm; return a + Math.floor(rnd() * (eh * 60 + em - a)); }

async function chunked(db, sql, cols, chunk = 3000) {
  const n = cols[0].length;
  for (let i = 0; i < n; i += chunk) await db.query(sql, cols.map(c => c.slice(i, i + chunk)));
}

async function seed(db, opts = {}) {
  const o = Object.assign({ studentsPerMess: 200, historyDays: 120, logDays: 14, password: 'change-me-now', demoIgnoreWindows: true, now: new Date(), seed: 42 }, opts);
  const r = rng(o.seed), gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const tz = 'Asia/Kolkata', today = localNow(o.now, tz).date, hash = hashPassword(o.password);

  await db.query('INSERT INTO messes (id,name,location) SELECT * FROM unnest($1::text[],$2::text[],$3::text[])', [0, 1, 2].map(i => MESSES.map(m => m[i])));
  for (const m of MESSES) await db.query('INSERT INTO meal_windows (mess_id,meal_type,start_time,end_time) SELECT $1, * FROM unnest($2::text[],$3::time[],$4::time[])',
    [m[0], WINDOWS.map(w => w[0]), WINDOWS.map(w => w[1]), WINDOWS.map(w => w[2])]);
  const gs = { timezone: tz, leave_policy: 'reject', cross_mess_policy: 'reject', safety_buffer: '0.02', data_source: 'synthetic_demo', demo_ignore_windows: String(!!o.demoIgnoreWindows) };
  await db.query('INSERT INTO settings (mess_id,key,value) SELECT NULL, * FROM unnest($1::text[],$2::text[])', [Object.keys(gs), Object.values(gs)]);

  // users
  const U = { role: ['admin', 'mess_manager'], sid: ['ADMIN', 'CHIEF'], name: ['Demo Admin', 'Demo Mess Chief'], mess: [null, null] };
  let n = 0;                                                     // NN25CSE001.. (290 is reserved for the named demo student)
  MESSES.forEach(m => {
    for (let i = 1; i <= o.studentsPerMess; i++) { n++; if (n === 290) n++; U.role.push('student'); U.sid.push('NN25CSE' + pad(n, 3)); U.name.push('Demo Student ' + pad(n, 3)); U.mess.push(m[0]); }
  });
  U.role.push('student'); U.sid.push('NN25CSE290'); U.name.push('Aarush'); U.mess.push('south');
  const ins = [];
  for (let i = 0; i < U.sid.length; i += 3000) {
    const s = (a) => a.slice(i, i + 3000);
    ins.push(...await db.query(`INSERT INTO users (role,student_id,name,mess_id,password_hash) SELECT role,sid,name,mess,$5 FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) AS t(role,sid,name,mess) RETURNING id, student_id, role, mess_id`,
      [s(U.role), s(U.sid), s(U.name), s(U.mess), hash]));
  }
  const students = ins.filter(u => u.role === 'student');

  // approved leave (as if synced from the Warden app)
  const leaves = [], onLeave = new Map();
  students.forEach((u, k) => {
    const cnt = r() < 0.25 ? (r() < 0.3 ? 2 : 1) : 0;
    for (let j = 0; j < cnt; j++) {
      const start = addDays(today, Math.floor(r() * (o.historyDays + 12)) - o.historyDays), end = addDays(start, 1 + Math.floor(r() * 5));
      leaves.push([`seed-${k}-${j}`, u.id, start, end]);
      if (!onLeave.has(u.id)) onLeave.set(u.id, []);
      onLeave.get(u.id).push([start, end]);
    }
  });
  await chunked(db, `INSERT INTO leave_requests (external_id,user_id,start_date,end_date,status,approved_by) SELECT a,b,c::date,d::date,'approved','Warden (seed)' FROM unnest($1::text[],$2::uuid[],$3::text[],$4::text[]) AS t(a,b,c,d)`,
    [0, 1, 2, 3].map(i => leaves.map(l => l[i])));
  const away = (uid, d) => (onLeave.get(uid) || []).some(([s, e]) => d >= s && d <= e);

  // history: aggregate served counts for every past day; verified scans for the last logDays days
  const usage = { mess: [], date: [], meal: [], prepared: [], served: [] }, logs = { ev: [], uid: [], mess: [], meal: [], date: [], at: [], res: [], reason: [] };
  const fc = { mess: [], date: [], meal: [], pred: [], rec: [], at: [] };
  const series = {};
  for (const m of MESSES) {
    const mine = students.filter(s => s.mess_id === m[0]);
    for (let back = o.historyDays; back >= 1; back--) {
      const date = addDays(today, -back), dow = new Date(date + 'T00:00:00Z').getUTCDay(), present = mine.filter(s => !away(s.id, date));
      for (const w of WINDOWS) {
        const meal = w[0], wk = (dow === 0 || dow === 6) && meal === 'breakfast' ? 0.82 : (dow === 0 && meal === 'dinner' ? 1.03 : 1);
        const served = Math.max(0, Math.min(present.length, Math.round(present.length * RATE[meal] * wk * (1 + 0.025 * gauss()))));
        const key = m[0] + '|' + meal, hist = (series[key] = series[key] || []);
        const withLogs = back <= o.logDays;
        usage.mess.push(m[0]); usage.date.push(date); usage.meal.push(meal); usage.served.push(served);
        usage.prepared.push(withLogs ? Math.round(served * (1.02 + 0.04 * r())) : null);
        if (withLogs && hist.length >= 3) {
          const p = Math.round(hist.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, hist.length));
          fc.mess.push(m[0]); fc.date.push(date); fc.meal.push(meal); fc.pred.push(p); fc.rec.push(Math.round(p * 1.02));
          fc.at.push(zonedToUtc(addDays(date, -1), 18 * 60, tz).toISOString());
        }
        hist.push(served);
        if (withLogs) {
          const pool = present.slice();
          for (let i = 0; i < served; i++) {                       // partial Fisher-Yates: pick `served` distinct students
            const j = i + Math.floor(r() * (pool.length - i)); [pool[i], pool[j]] = [pool[j], pool[i]];
            const s = pool[i], mins = timeIn(w, r);
            logs.ev.push(`seed-${m[0]}-${date}-${meal}-${s.student_id}`); logs.uid.push(s.id); logs.mess.push(m[0]); logs.meal.push(meal); logs.date.push(date);
            logs.at.push(zonedToUtc(date, mins, tz).toISOString()); logs.res.push('success'); logs.reason.push(null);
          }
          for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {          // a few rejected scans for the exceptions panel
            const kind = ['duplicate', 'outside_window', 'on_leave'][Math.floor(r() * 3)];
            const s = kind === 'on_leave' ? mine.find(x => away(x.id, date) && r() < 0.2) || mine.find(x => away(x.id, date)) : pool[Math.floor(r() * Math.max(1, served))];
            if (!s) continue;
            logs.ev.push(`seed-x-${m[0]}-${date}-${meal}-${k}`); logs.uid.push(s.id); logs.mess.push(m[0]); logs.meal.push(kind === 'outside_window' ? null : meal); logs.date.push(date);
            logs.at.push(zonedToUtc(date, kind === 'outside_window' ? 15 * 60 + Math.floor(r() * 60) : timeIn(w, r), tz).toISOString());
            logs.res.push(kind); logs.reason.push(kind === 'duplicate' ? 'already_served' : kind === 'on_leave' ? 'approved_leave' : 'no_window_open');
          }
        }
      }
    }
  }
  await chunked(db, `INSERT INTO mess_usage (mess_id,date,meal_type,prepared_count,served_count,waste_count)
    SELECT a,b::date,c,d,e,CASE WHEN d IS NULL THEN NULL ELSE GREATEST(d-e,0) END FROM unnest($1::text[],$2::text[],$3::text[],$4::int[],$5::int[]) AS t(a,b,c,d,e)`,
    [usage.mess, usage.date, usage.meal, usage.prepared, usage.served]);
  await chunked(db, `INSERT INTO meal_logs (event_id,user_id,mess_id,meal_type,meal_date,scanned_at,result,reason,source)
    SELECT a,b,c,d,e::date,f::timestamptz,g,h,'seed' FROM unnest($1::text[],$2::uuid[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[]) AS t(a,b,c,d,e,f,g,h)`,
    [logs.ev, logs.uid, logs.mess, logs.meal, logs.date, logs.at, logs.res, logs.reason], 4000);
  await chunked(db, `INSERT INTO forecasts (mess_id,target_date,meal_type,predicted_count,recommended_count,model_version,method,warnings,created_at)
    SELECT a,b::date,c,d,e,'baseline_ma7','moving_average_7','["Backfilled by seed: 7-day average of the previous days"]'::jsonb,f::timestamptz FROM unnest($1::text[],$2::text[],$3::text[],$4::int[],$5::int[],$6::text[]) AS t(a,b,c,d,e,f)`,
    [fc.mess, fc.date, fc.meal, fc.pred, fc.rec, fc.at]);
  return { users: U.sid.length, students: students.length, usage_rows: usage.mess.length, log_rows: logs.ev.length, forecast_rows: fc.mess.length, today };
}

module.exports = { migrate, reset, seed };
