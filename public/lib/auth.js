/* Authentication: scrypt password hashes + HMAC-signed, HttpOnly session cookie. Roles re-read from the DB on every request. */
'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const COOKIE = 'sm_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
let devSecret = null;

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) throw new Error('SESSION_SECRET is required in production');
  return devSecret || (devSecret = crypto.randomBytes(32).toString('hex'));   // dev: sessions reset on restart
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expect = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expect.length);
  return crypto.timingSafeEqual(got, expect);
}

const b64 = b => Buffer.from(b).toString('base64url');
const sign = data => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

function makeToken(userId, now = Date.now()) {
  const payload = b64(JSON.stringify({ u: userId, e: now + SESSION_HOURS * 3600e3 }));
  return `${payload}.${sign(payload)}`;
}
function readToken(token, now = Date.now()) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = sign(payload);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(payload, 'base64url').toString()); return p.e > now ? p.u : null; } catch (e) { return null; }
}

function sessionCookie(req, token, clear) {
  const secure = String(req.headers['x-forwarded-proto'] || '').startsWith('https') || process.env.NODE_ENV === 'production';
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : null,
    `Max-Age=${clear ? 0 : SESSION_HOURS * 3600}`].filter(Boolean).join('; ');
  return `${COOKIE}=${clear ? '' : token}; ${attrs}`;
}

async function currentUser(db, req, cookies) {
  const uid = readToken(cookies[COOKIE]);
  if (!uid) return null;
  const rows = await db.query('SELECT id, role, student_id, name, email, photo_url, mess_id, status FROM users WHERE id = $1', [uid]);
  return rows[0] && rows[0].status === 'active' ? rows[0] : null;
}

function requireUser(user) { if (!user) throw new HttpError(401, 'Not signed in'); return user; }
function requireRole(user, roles) {
  requireUser(user);
  if (!roles.includes(user.role)) throw new HttpError(403, 'Your account may not do this');
  return user;
}
function canAccessMess(user, messId) {
  return user.role === 'admin' || (user.role === 'mess_manager' && (!user.mess_id || user.mess_id === messId));
}

// QR codes: SMARTMESS:v1:<mess_id>:<signature>. Static per mess; rotate by changing QR_SECRET.
function qrSecret() { return process.env.QR_SECRET || secret(); }
function qrPayload(messId) {
  return `SMARTMESS:v1:${messId}:${crypto.createHmac('sha256', qrSecret()).update('qr:v1:' + messId).digest('base64url').slice(0, 22)}`;
}
function parseQr(text) {
  const m = /^SMARTMESS:v1:([a-z0-9_-]{1,40}):([A-Za-z0-9_-]{22})$/.exec(String(text || '').trim());
  if (!m) return null;
  const want = qrPayload(m[1]);
  const a = Buffer.from(String(text).trim()), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}

// Anonymous but stable reference for exception lists (no names/emails in manager exception feeds)
const subjectRef = userId => 'S-' + crypto.createHmac('sha256', secret()).update(String(userId)).digest('hex').slice(0, 4).toUpperCase();

module.exports = { COOKIE, hashPassword, verifyPassword, makeToken, readToken, sessionCookie, currentUser,
  requireUser, requireRole, canAccessMess, qrPayload, parseQr, subjectRef };
