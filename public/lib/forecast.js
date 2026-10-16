/* Forecasts: ML service when available, 7-day-average baseline otherwise. Every forecast is stored (PRD: forecasts table)
 * so predicted-vs-actual can be evaluated later. Nothing is invented: if no history exists the meal is reported unavailable. */
'use strict';
const { getSettings, isSynthetic } = require('./settings');
const { HttpError, cap } = require('./http');

const CACHE_MINUTES = Number(process.env.FORECAST_CACHE_MINUTES || 180);
const roundBuf = (p, b) => Math.round(Math.round(p * (1 + b) * 1e6) / 1e6);

async function callMl(payload) {
  const url = process.env.ML_SERVICE_URL;
  if (!url) return { ok: false, reason: 'ML service is not configured (ML_SERVICE_URL)' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(process.env.ML_TIMEOUT_MS || 25000));
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.ML_API_KEY) headers['X-API-Key'] = process.env.ML_API_KEY;
    const res = await fetch(url.replace(/\/+$/, '') + '/predict', { method: 'POST', headers, body: JSON.stringify(payload), signal: ctl.signal });
    let body = null; try { body = JSON.parse(await res.text()); } catch (e) { /* not JSON */ }
    if (res.ok && body && Number.isFinite(body.predicted_meals)) return { ok: true, body };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'ML service rejected the credentials' };
    return { ok: false, reason: String((body && body.detail) || 'ML service error ' + res.status).slice(0, 200) };
  } catch (e) { return { ok: false, reason: 'ML service unreachable' }; }
  finally { clearTimeout(timer); }
}

async function baseline(db, messId, meal, date) {
  const r = await db.query(
    `SELECT served_count FROM mess_usage WHERE mess_id=$1 AND meal_type=$2 AND date < $3 AND served_count IS NOT NULL ORDER BY date DESC LIMIT 7`,
    [messId, meal, date]);
  if (!r.length) return null;
  return r.reduce((s, x) => s + x.served_count, 0) / r.length;
}

function shape(f) {
  return {
    mess_id: f.mess_id, date: f.target_date, meal_type: f.meal_type, predicted_meals: f.predicted_count,
    recommended_preparation: f.recommended_count,
    prediction_range: f.range_low !== null && f.range_high !== null ? { low: f.range_low, high: f.range_high } : undefined,
    model_version: f.model_version, method: f.method, warnings: f.warnings || [], generated_at: new Date(f.created_at).toISOString()
  };
}

async function getForecasts(db, mess, date, today, { mealFilter } = {}) {
  if (date < today) throw new HttpError(400, 'Forecasts can only be requested for today or later');
  const settings = await getSettings(db, mess.id);
  const buffer = Number(settings.safety_buffer);
  const meals = (await db.query('SELECT meal_type FROM meal_windows WHERE mess_id=$1 ORDER BY start_time', [mess.id]))
    .map(r => r.meal_type).filter(m => !mealFilter || m === mealFilter);
  const active = (await db.query(`SELECT count(*)::int AS n FROM users WHERE role='student' AND status='active' AND mess_id=$1`, [mess.id]))[0].n;
  const leave = (await db.query(
    `SELECT count(DISTINCT lr.user_id)::int AS n FROM leave_requests lr JOIN users u ON u.id=lr.user_id
     WHERE u.mess_id=$1 AND u.role='student' AND lr.status='approved' AND $2::date BETWEEN lr.start_date AND lr.end_date`, [mess.id, date]))[0].n;

  const forecasts = [], unavailable = [];
  for (const meal of meals) {
    const cached = (await db.query(
      `SELECT * FROM forecasts WHERE mess_id=$1 AND target_date=$2 AND meal_type=$3 AND created_at > now() - ($4 || ' minutes')::interval
       ORDER BY created_at DESC LIMIT 1`, [mess.id, date, meal, String(CACHE_MINUTES)]))[0];
    if (cached) { forecasts.push(shape(cached)); continue; }

    const ml = await callMl({ mess_id: mess.id, date, meal_type: meal, active_students: active, approved_leave: leave });
    let row;
    if (ml.ok) {
      const b = ml.body, rg = b.prediction_range;
      row = { predicted: b.predicted_meals, rec: Number.isFinite(b.recommended_preparation) ? b.recommended_preparation : roundBuf(b.predicted_meals, buffer),
        low: rg ? rg.low : null, high: rg ? rg.high : null, version: String(b.model_version || 'ml'), method: b.method || 'xgboost',
        warnings: Array.isArray(b.warnings) ? b.warnings.slice(0, 5) : [] };
    } else {
      const avg = await baseline(db, mess.id, meal, date);
      if (avg === null) { unavailable.push({ meal_type: meal, reason: 'No history yet. ' + ml.reason }); continue; }
      const p = Math.round(avg);
      row = { predicted: p, rec: roundBuf(p, buffer), low: null, high: null, version: 'baseline_ma7', method: 'moving_average_7',
        warnings: ['ML forecast unavailable (' + ml.reason + '); showing the 7-day average'] };
    }
    const ins = await db.query(
      `INSERT INTO forecasts (mess_id,target_date,meal_type,predicted_count,recommended_count,range_low,range_high,model_version,method,warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
      [mess.id, date, meal, row.predicted, row.rec, row.low, row.high, row.version, row.method, JSON.stringify(row.warnings)]);
    forecasts.push(shape(ins[0]));
  }
  const out = { forecasts, unavailable };
  if (isSynthetic(settings)) out.synthetic = true;
  return out;
}

/** Predicted vs actual. Uses the latest stored forecast per mess/date/meal and persists the error (forecast_evaluations). */
async function getEvaluations(db, messId, from, to, meal) {
  const rows = await db.query(
    `SELECT DISTINCT ON (f.target_date, f.meal_type) f.id, f.target_date, f.meal_type, f.predicted_count, f.model_version, u.served_count
     FROM forecasts f JOIN mess_usage u ON u.mess_id=f.mess_id AND u.date=f.target_date AND u.meal_type=f.meal_type
     WHERE f.mess_id=$1 AND u.served_count IS NOT NULL AND f.target_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR f.meal_type=$4)
     ORDER BY f.target_date, f.meal_type, f.created_at DESC`, [messId, from, to, meal || null]);
  for (const r of rows) {
    const e = r.predicted_count - r.served_count;
    await db.query(
      `INSERT INTO forecast_evaluations (forecast_id, actual_count, absolute_error, squared_error) VALUES ($1,$2,$3,$4)
       ON CONFLICT (forecast_id) DO UPDATE SET actual_count=EXCLUDED.actual_count, absolute_error=EXCLUDED.absolute_error,
       squared_error=EXCLUDED.squared_error, evaluated_at=now()`, [r.id, r.served_count, Math.abs(e), e * e]);
  }
  return rows.map(r => ({ targetDate: r.target_date, mealType: cap(r.meal_type), predictedCount: r.predicted_count, actualCount: r.served_count, modelVersion: r.model_version }));
}

module.exports = { getForecasts, getEvaluations, roundBuf };
