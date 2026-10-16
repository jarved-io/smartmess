'use strict';
/* Mess-local time helpers (default timezone Asia/Kolkata, configurable via settings.timezone). */
function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {};
  f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}
function localNow(date, tz) {
  const p = parts(date, tz);
  const pad = n => String(n).padStart(2, '0');
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, minutes: p.h * 60 + p.mi };
}
function addDays(ymd, n) {
  const t = new Date(ymd + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function offsetMs(utcMs, tz) {
  const ms = Math.floor(utcMs / 1000) * 1000;
  const p = parts(new Date(ms), tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms;
}
function zonedToUtc(ymd, minutes, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  return new Date(t);
}
const toMinutes = hhmmss => { const [h, m] = String(hhmmss).split(':').map(Number); return h * 60 + m; };
module.exports = { localNow, addDays, zonedToUtc, toMinutes };
