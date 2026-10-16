/* Database access. Production: node-postgres against DATABASE_URL (Supabase/Neon pooler URL).
 * Tests/local: setDb() with an in-process PGlite (real Postgres in WASM). All queries use $1 placeholders.
 * Interface: query(text, params) -> rows[]; tx(fn(tx)) -> result (BEGIN/COMMIT/ROLLBACK); exec(sql). */
'use strict';
let current = null;

function configured() { return !!(current || process.env.DATABASE_URL); }

async function getDb() {
  if (current) return current;
  if (!process.env.DATABASE_URL) return null;
  const { Pool, types } = require('pg');
  types.setTypeParser(1082, v => v);          // DATE -> 'YYYY-MM-DD' string (no timezone surprises)
  types.setTypeParser(1700, v => Number(v));  // NUMERIC -> number
  const url = process.env.DATABASE_URL;
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX || 3), idleTimeoutMillis: 10000,
    ssl: local || process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false } });
  current = {
    kind: 'pg',
    query: async (text, params) => (await pool.query(text, params)).rows,
    exec: async sql => { await pool.query(sql); },
    tx: async fn => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn({ query: async (t, p) => (await c.query(t, p)).rows });
        await c.query('COMMIT');
        return r;
      } catch (e) { try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ } throw e; }
      finally { c.release(); }
    },
    close: () => pool.end()
  };
  return current;
}

async function createPglite(dir) {
  const name = '@electric-sql/pglite';           // dev/local only; kept out of the production bundle
  const { PGlite } = require(name);
  if (dir) require('node:fs').mkdirSync(require('node:path').dirname(dir), { recursive: true });
  const pg = new PGlite(dir, { parsers: { 1082: v => v, 1700: v => Number(v) } });
  await pg.waitReady;
  return {
    kind: 'pglite',
    query: async (t, p) => (await pg.query(t, p)).rows,
    exec: async sql => { await pg.exec(sql); },
    tx: async fn => pg.transaction(async t => fn({ query: async (q, p) => (await t.query(q, p)).rows })),
    close: () => pg.close()
  };
}

function setDb(db) { current = db; }

module.exports = { getDb, setDb, createPglite, configured };
