'use strict';
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m, x) => new HttpError(400, m, x);

function send(res, status, body, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  Object.keys(headers || {}).forEach(k => res.setHeader(k, headers[k]));
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const ct = String(req.headers['content-type'] || '');
  if (!/application\/json/i.test(ct)) throw new HttpError(415, 'Content-Type must be application/json');
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;   // Vercel pre-parsed
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    raw = await new Promise((resolve, reject) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 100000) { reject(new HttpError(413, 'Request body too large')); req.destroy(); } });
      req.on('end', () => resolve(b));
      req.on('error', reject);
    });
  }
  if (!raw) return {};
  try { const v = JSON.parse(raw); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
  catch (e) { throw new HttpError(400, 'Body must be a JSON object'); }
}

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

module.exports = { HttpError, bad, send, readBody, isDate, cap, parseCookies };
