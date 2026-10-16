/* Meal-scan validation engine. Deterministic, machine-readable reasons; every attempt is logged.
 * Order (PRD): authenticated -> registered/active -> QR valid -> meal window -> correct mess -> no duplicate -> leave policy.
 * Balance never blocks a scan (billing rules are an open decision; we do not invent blocking rules). */
'use strict';
const crypto = require('node:crypto');
const { parseQr } = require('./auth');
const { getSettings } = require('./settings');
const { localNow, toMinutes } = require('./time');
const { HttpError, cap } = require('./http');

const MESSAGES = {
  success: 'Meal verified.',
  duplicate: 'Already scanned for this meal.',
  outside_window: 'Outside the meal window.',
  on_leave: 'Approved leave on record for today.',
  invalid_qr: 'Invalid QR code. Scan the code shown at the mess counter.',
  wrong_mess: 'This QR belongs to a different mess.',
  inactive: 'Account is not active.'
};

async function insertLog(db, row) {
  const r = await db.query(
    `INSERT INTO meal_logs (event_id, user_id, mess_id, meal_type, meal_date, scanned_at, result, reason, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [row.event_id, row.user_id, row.mess_id, row.meal_type, row.meal_date, row.scanned_at, row.result, row.reason || null, row.source || 'online']);
  return r[0].id;
}

function outcome(user, mess, result, meal, scannedAt, reason, eventId, flagged) {
  return {
    valid: result === 'success', result, reason: reason || null, message: MESSAGES[result] + (flagged ? ' (flagged: leave on record)' : ''),
    event_id: eventId, student: { student_id: user.student_id, name: user.name, photo_url: user.photo_url || null },
    mess: mess ? { id: mess.id, name: mess.name } : null, meal_type: meal ? cap(meal) : null, scanned_at: scannedAt.toISOString()
  };
}

async function processScan(db, user, input, now = new Date()) {
  if (user.role !== 'student') throw new HttpError(403, 'Only students scan meal QR codes');
  const eventId = String(input.event_id || '').trim() || 'srv-' + crypto.randomUUID();
  if (eventId.length > 80) throw new HttpError(400, 'event_id too long');

  // Idempotency: a retried event returns the original outcome and never creates a second meal.
  const prev = await db.query(
    `SELECT l.*, m.name AS mess_name FROM meal_logs l LEFT JOIN messes m ON m.id = l.mess_id WHERE l.event_id = $1`, [eventId]);
  if (prev[0]) {
    if (prev[0].user_id !== user.id) throw new HttpError(409, 'event_id already used');
    const p = prev[0];
    return Object.assign(outcome(user, p.mess_id ? { id: p.mess_id, name: p.mess_name } : null, p.result, p.meal_type, new Date(p.scanned_at), p.reason, eventId), { replayed: true });
  }

  const messId = parseQr(input.qr);
  const baseSettings = await getSettings(db, messId || user.mess_id);
  const tz = baseSettings.timezone;
  const local = localNow(now, tz);
  const log = (result, mess, meal, reason, flagged) => db.query('SELECT 1').then(() => insertLog(db, {
    event_id: eventId, user_id: user.id, mess_id: mess ? mess.id : null, meal_type: meal, meal_date: local.date,
    scanned_at: now, result, reason, source: input.source === 'offline' ? 'offline' : 'online'
  })).then(() => outcome(user, mess, result, meal, now, reason, eventId, flagged));

  if (user.status !== 'active') return log('inactive', null, null, 'account_inactive');
  if (!messId) return log('invalid_qr', null, null, 'bad_or_unsigned_qr');
  const mess = (await db.query('SELECT id, name FROM messes WHERE id = $1 AND active', [messId]))[0];
  if (!mess) return log('invalid_qr', null, null, 'unknown_or_inactive_mess');

  // meal window (server decides the meal; the client cannot choose it)
  const windows = await db.query('SELECT meal_type, start_time::text AS s, end_time::text AS e FROM meal_windows WHERE mess_id = $1', [mess.id]);
  let meal = (windows.find(w => local.minutes >= toMinutes(w.s) && local.minutes <= toMinutes(w.e)) || {}).meal_type;
  if (!meal) {
    const hint = String(input.meal_type || '').toLowerCase();
    if (baseSettings.demo_ignore_windows === 'true' && windows.some(w => w.meal_type === hint)) meal = hint;   // DEMO ONLY
    else return log('outside_window', mess, null, 'no_window_open');
  }

  const homeMess = user.mess_id;
  if (homeMess && homeMess !== mess.id && baseSettings.cross_mess_policy === 'reject') return log('wrong_mess', mess, meal, 'home_mess_' + homeMess);

  const dup = await db.query(`SELECT 1 FROM meal_logs WHERE user_id = $1 AND meal_date = $2 AND meal_type = $3 AND result = 'success'`, [user.id, local.date, meal]);
  if (dup[0]) return log('duplicate', mess, meal, 'already_served');

  const leave = await db.query(
    `SELECT 1 FROM leave_requests WHERE user_id = $1 AND status = 'approved' AND $2::date BETWEEN start_date AND end_date LIMIT 1`, [user.id, local.date]);
  const onLeave = !!leave[0];
  if (onLeave && baseSettings.leave_policy === 'reject') return log('on_leave', mess, meal, 'approved_leave');

  try {
    return await log('success', mess, meal, onLeave && baseSettings.leave_policy === 'flag' ? 'on_leave_flagged' : null, onLeave && baseSettings.leave_policy === 'flag');
  } catch (e) {
    if (e && e.code === '23505') {          // concurrent double scan lost the race on the partial unique index
      if (/event_id/.test(String(e.message))) throw new HttpError(409, 'event_id already used');
      return log('duplicate', mess, meal, 'already_served');
    }
    throw e;
  }
}

module.exports = { processScan, MESSAGES };
