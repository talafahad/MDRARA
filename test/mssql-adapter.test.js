'use strict';
// The SQL Server adapter is checked here against a stand-in for the "mssql" package, so these tests need no server.
// They prove the translation and bookkeeping logic. A real server still has to be tried once (see README).
const test = require('node:test');
const assert = require('node:assert/strict');
const { openMssql, toTsql, mssqlConfigFromEnv, MSSQL_SCHEMA } = require('../lib/db');

function fakeSql() {
  const log = { batches: [], queries: [], events: [] };
  class Req {
    constructor() { this.p = {}; }
    input(n, v) { this.p[n] = v; }
    async batch(t) { log.batches.push(t); return {}; }
    async query(t) {
      log.queries.push({ text: t, params: { ...this.p } });
      if (/SCOPE_IDENTITY/.test(t)) return { recordsets: [Object.assign([{ id: 7 }], { columns: { id: { type: BigInt } } })], rowsAffected: [1, 1] };
      if (/FROM sessions/.test(t)) return { recordset: Object.assign([{ expires_at: '1760000000000', n: 3 }], { columns: { expires_at: { type: BigInt }, n: { type: Int } } }), recordsets: [], rowsAffected: [1] };
      if (/boom/.test(t)) throw new Error('boom');
      return { recordset: Object.assign([], { columns: {} }), recordsets: [], rowsAffected: [2] };
    }
  }
  function BigInt() {} function Int() {}
  class Pool { constructor(c) { log.config = c; } async connect() { return this; } request() { return new Req(); } async close() { log.events.push('close'); } }
  class Transaction {
    constructor() {} async begin() { log.events.push('begin'); } async commit() { log.events.push('commit'); } async rollback() { log.events.push('rollback'); }
    request() { return new Req(); }
  }
  return { log, sql: { ConnectionPool: Pool, Transaction, BigInt, Int } };
}

test('placeholders and LIMIT are translated for T-SQL', () => {
  assert.equal(toTsql('SELECT * FROM t WHERE a=? AND b=? ORDER BY id DESC LIMIT ?'),
    'SELECT * FROM t WHERE a=@p1 AND b=@p2 ORDER BY id DESC OFFSET 0 ROWS FETCH NEXT @p3 ROWS ONLY');
  assert.equal(toTsql('SELECT id FROM offers WHERE org_id=? ORDER BY id DESC LIMIT 20'),
    'SELECT id FROM offers WHERE org_id=@p1 ORDER BY id DESC OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY');
});

test('schema is created once per statement, ids come back, BIGINT becomes a number, NaN becomes NULL', async () => {
  const { sql, log } = fakeSql();
  const db = await openMssql({ server: 'x' }, sql);
  assert.equal(log.batches.length, MSSQL_SCHEMA.length);
  const r = await db.run('INSERT INTO orgs(name,created_at) VALUES(?,?)', ['A', Date.now()]);
  assert.equal(r.lastInsertRowid, 7);
  assert.match(log.queries.at(-1).text, /SCOPE_IDENTITY/);
  const row = await db.q1('SELECT expires_at, COUNT(*) AS n FROM sessions WHERE token_hash=?', ['abc']);
  assert.equal(row.expires_at, 1760000000000);
  assert.equal(typeof row.expires_at, 'number');
  await db.q('SELECT 1 WHERE id=?', [NaN]);
  assert.equal(log.queries.at(-1).params.p1, null);
  const u = await db.run('UPDATE users SET name=? WHERE id=?', ['x', 1]);
  assert.equal(u.changes, 2);
});

test('transactions commit on success and roll back on error', async () => {
  const { sql, log } = fakeSql();
  const db = await openMssql({}, sql);
  await db.tx(async (t) => { await t.run('UPDATE a SET b=?', [1]); });
  assert.deepEqual(log.events, ['begin', 'commit']);
  await assert.rejects(db.tx(async (t) => { await t.q('SELECT boom'); }), /boom/);
  assert.deepEqual(log.events, ['begin', 'commit', 'begin', 'rollback']);
});

test('settings are read from environment variables', () => {
  const c = mssqlConfigFromEnv({ MSSQL_SERVER: 'PC\\SQLEXPRESS', MSSQL_DATABASE: 'midrar', MSSQL_USER: 'sa', MSSQL_PASSWORD: 'p', MSSQL_TRUST_CERT: '1', MSSQL_PORT: '1433' });
  assert.equal(c.server, 'PC'); assert.equal(c.options.instanceName, 'SQLEXPRESS'); assert.equal(c.port, 1433); assert.equal(c.options.trustServerCertificate, true); assert.equal(c.options.encrypt, false);
  assert.equal(mssqlConfigFromEnv({ MSSQL_CONNECTION: 'Server=x;Database=y' }), 'Server=x;Database=y');
});

test('no application query keeps SQLite-only syntax after translation', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8') + require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'demo.js'), 'utf8');
  for (const m of src.matchAll(/LIMIT\s+(\?|\d+)/g)) assert.doesNotMatch(toTsql('SELECT 1 ORDER BY id ' + m[0]), /LIMIT/);
  assert.doesNotMatch(src, /INSERT OR IGNORE|ON CONFLICT|AUTOINCREMENT|datetime\(|strftime\(|ifnull\(/i);
});
