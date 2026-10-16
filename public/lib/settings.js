'use strict';
/* Configurable business rules live in the `settings` table (global or per mess). Defaults here are fallbacks only. */
const DEFAULTS = {
  timezone: 'Asia/Kolkata',
  leave_policy: 'reject',          // reject | flag | ignore   (open decision #3: confirm with the college)
  cross_mess_policy: 'reject',     // reject | allow           (student scans at a mess other than their own)
  safety_buffer: '0.02',           // preparation buffer applied on top of the forecast
  demo_ignore_windows: 'false',    // true = allow scans outside meal windows (DEMO ONLY)
  data_source: 'real'              // 'synthetic_demo' makes every manager payload carry synthetic:true
};
const VALID = {
  timezone: v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch (e) { return false; } },
  leave_policy: v => ['reject', 'flag', 'ignore'].includes(v),
  cross_mess_policy: v => ['reject', 'allow'].includes(v),
  safety_buffer: v => Number.isFinite(+v) && +v >= 0 && +v <= 0.5,
  demo_ignore_windows: v => ['true', 'false'].includes(v),
  data_source: v => ['real', 'synthetic_demo'].includes(v)
};

async function getSettings(db, messId) {
  const rows = await db.query('SELECT mess_id, key, value FROM settings WHERE mess_id IS NULL OR mess_id = $1', [messId || null]);
  const out = Object.assign({}, DEFAULTS);
  rows.filter(r => r.mess_id === null).forEach(r => { out[r.key] = r.value; });
  rows.filter(r => r.mess_id !== null).forEach(r => { out[r.key] = r.value; });
  return out;
}
const isSynthetic = s => s.data_source === 'synthetic_demo';

module.exports = { DEFAULTS, VALID, getSettings, isSynthetic };
