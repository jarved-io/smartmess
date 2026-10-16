'use strict';
// Static guards for the project rules: no invented metrics, no secrets, no silent fake fallbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..', 'public');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const webFiles = fs.readdirSync(path.join(root, 'web')).filter(f => f.endsWith('.js'));

test('browser code has no randomness, no sample arrays, no storage of credentials', () => {
  for (const f of webFiles) {
    const s = read('web/' + f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // code only, comments ignored
    assert.ok(!/Math\.random/.test(s), f + ' uses Math.random');
    if (f === 'live.js') {
      // live.js is the login/scan client: it shows the word "password" in UI text and deliberately REMOVES personal data
      // from localStorage. It must never write to storage/cookies or contain secrets or connection strings.
      assert.ok(!/sessionStorage|document\.cookie|localStorage\.(setItem|getItem)/.test(s), f + ' writes browser storage');
      assert.ok(!/(secret|api[_-]?key|DATABASE_URL|postgres(ql)?:\/\/)/i.test(s), f + ' mentions a secret');
    } else {
      assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(s), f + ' touches browser storage');
      assert.ok(!/(password|secret|api[_-]?key|DATABASE_URL|postgres:\/\/)/i.test(s), f + ' mentions a secret');
    }
    assert.ok(!/\[\s*600\s*,\s*640/.test(s), f + ' contains the old hardcoded trend array');
  }
});

test('manager dashboard does not import the synthetic mock', () => {
  for (const f of webFiles) assert.ok(!/mock-api|require\(['"]\.\.\/mock/.test(read('web/' + f)), f);
});

test('old simulated forecast/trend functions are gone from index.html', () => {
  const html = read('index.html');
  assert.ok(!/function pred\(/.test(html));
  assert.ok(!/function trend\(/.test(html));
  assert.ok(!/Recommended preparation: \$\{Math\.ceil/.test(html)); // invented 4% buffer
});

test('student portal code in index.html is still present', () => {
  const html = read('index.html');
  for (const needle of ['function sim(', 'function doLogin(', 'function sendFb(', 'scan(){return', 'hist(){return', 'prof(){return']) assert.ok(html.includes(needle), needle);
});

test('every API response normalizer keeps missing values null (no "|| 0" defaults)', () => {
  assert.ok(!/\|\|\s*0\b/.test(read('web/api.js')));
  assert.ok(!/\|\|\s*0\b/.test(read('web/calc.js')));
});
