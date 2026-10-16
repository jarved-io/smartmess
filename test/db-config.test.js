'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getDatabaseUrl } = require('../lib/db');

test('database URL aliases are selected in documented priority order', () => {
  const keys = ['DATABASE_URL', 'POSTGRES_URL', 'PRISMA_DATABASE_URL'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    keys.forEach(key => { delete process.env[key]; });
    assert.equal(getDatabaseUrl(), null);

    process.env.PRISMA_DATABASE_URL = 'postgresql://prisma';
    assert.equal(getDatabaseUrl(), 'postgresql://prisma');

    process.env.POSTGRES_URL = 'postgresql://postgres';
    assert.equal(getDatabaseUrl(), 'postgresql://postgres');

    process.env.DATABASE_URL = 'postgresql://database';
    assert.equal(getDatabaseUrl(), 'postgresql://database');
  } finally {
    keys.forEach(key => {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    });
  }
});
