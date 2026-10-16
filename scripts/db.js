#!/usr/bin/env node
require('dotenv').config();
/* Usage:  DATABASE_URL=... node scripts/db.js migrate | seed [--students 200] | reset-seed
 *  migrate     create/upgrade tables (idempotent)
 *  seed        load SYNTHETIC demo data into an EMPTY database; prints the demo login password once
 *  reset-seed  wipe everything, then seed (demo databases only!) */
'use strict';
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const path = require('node:path');
const envFile = dotenv.config({ path: path.join(__dirname, '..', '.env') });
if (envFile.error && envFile.error.code !== 'ENOENT') {
  console.error('Could not load the project .env file.');
  process.exit(1);
}
const { getDb } = require('../lib/db');
const { migrate, reset, seed } = require('../lib/seed');

(async () => {
  const cmd = process.argv[2], db = await getDb();
  if (!db) { console.error('Set DATABASE_URL, POSTGRES_URL, or PRISMA_DATABASE_URL.'); process.exit(1); }
  await migrate(db);
  if (cmd === 'migrate') { console.log('Schema is up to date.'); }
  else if (cmd === 'seed' || cmd === 'reset-seed') {
    if (cmd === 'reset-seed') await reset(db);
    else if ((await db.query('SELECT count(*)::int AS n FROM users'))[0].n > 0) { console.error('Database already has users. Use reset-seed to wipe and reseed (demo databases only).'); process.exit(1); }
    const i = process.argv.indexOf('--students');
    const password = process.env.SEED_PASSWORD || crypto.randomBytes(6).toString('base64url');
    const res = await seed(db, { password, studentsPerMess: i > 0 ? Number(process.argv[i + 1]) : 200 });
    console.log('Seeded SYNTHETIC demo data:', JSON.stringify(res));
    console.log('\nDemo logins (same password for all):', password);
    console.log('  Mess Chief : CHIEF        Admin: ADMIN\n  Student    : NN25CSE290 (Aarush, South Mess), or NN25CSE001.. (any generated ID)');
  } else { console.error('Usage: node scripts/db.js migrate | seed | reset-seed'); process.exit(1); }
  if (db.close) await db.close();
})().catch(e => { console.error(e); process.exit(1); });
