'use strict';
// Storage adapter. Same async API for two engines:
//   - SQLite (built into Node, zero install)   -> open(file)
//   - Microsoft SQL Server (npm package mssql) -> openMssql(config)
// API:  db.q(sql, params) -> rows[]     db.q1(sql, params) -> row | undefined
//       db.run(sql, params) -> { lastInsertRowid, changes }
//       db.tx(async (t) => { ...t.q / t.q1 / t.run... })   (commit on return, rollback on throw)
// SQL is written once, in the subset both engines accept, with ? placeholders and "LIMIT ?" at the end.
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ SQLite */
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  price_per_kg REAL NOT NULL DEFAULT 15 CHECK(price_per_kg>=0 AND price_per_kg<=100000),
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS branches(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL, city TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE(org_id,name));
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','staff')),
  branch_id INTEGER REFERENCES branches(id),
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL, ai_label TEXT,
  active INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,name_ar));
CREATE TABLE IF NOT EXISTS entries(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id), user_id INTEGER NOT NULL REFERENCES users(id),
  ts INTEGER NOT NULL, day TEXT NOT NULL,
  kg REAL NOT NULL CHECK(kg>0 AND kg<=5000),
  waste_type TEXT NOT NULL CHECK(waste_type IN ('plate','prep','spoilage')),
  meal TEXT NOT NULL CHECK(meal IN ('breakfast','lunch','dinner','break','snack')),
  item_ids TEXT NOT NULL, ai_labels TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','ai')),
  ai_corrected INTEGER NOT NULL DEFAULT 0, is_demo INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS entries_org_day ON entries(org_id,day);
CREATE INDEX IF NOT EXISTS entries_branch_day ON entries(branch_id,day);
CREATE TABLE IF NOT EXISTS prepared(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id), day TEXT NOT NULL,
  kg REAL NOT NULL CHECK(kg>0 AND kg<=100000), is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE(branch_id,day));
CREATE TABLE IF NOT EXISTS trials(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  branch_id INTEGER REFERENCES branches(id), item_id INTEGER NOT NULL REFERENCES items(id),
  target_pct REAL NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','stopped','ignored')),
  started_day TEXT NOT NULL, ended_day TEXT, baseline_kg_day REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS charities(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE(org_id,name));
CREATE TABLE IF NOT EXISTS offers(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id), item_id INTEGER NOT NULL REFERENCES items(id),
  charity_id INTEGER NOT NULL REFERENCES charities(id), kg REAL NOT NULL CHECK(kg>0 AND kg<=5000),
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','collected','cancelled')),
  created_ts INTEGER NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0);
`;

// NaN / Infinity cannot be stored by either engine: treat them as NULL (same as SQLite does).
const clean = (params) => (params || []).map((p) => (typeof p === 'number' && !Number.isFinite(p) ? null : p));

function open(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
  raw.exec(SQLITE_SCHEMA);
  const ops = {
    async q(sql, params) { return raw.prepare(sql).all(...clean(params)); },
    async q1(sql, params) { return raw.prepare(sql).get(...clean(params)); },
    async run(sql, params) { return raw.prepare(sql).run(...clean(params)); },
  };
  // A SQLite transaction body only awaits calls that are already resolved, so no other request
  // can run in the middle of it (Node only switches requests between event-loop turns).
  async function tx(fn) {
    raw.exec('BEGIN');
    try { const r = await fn(ops); raw.exec('COMMIT'); return r; }
    catch (e) { raw.exec('ROLLBACK'); throw e; }
  }
  return { kind: 'sqlite', raw, ...ops, tx, close: async () => raw.close() };
}

/* -------------------------------------------------------------- SQL Server */
// One statement per entry (SQL Server needs separate batches). Idempotent: safe to run on every start.
const T = (name, body) => `IF OBJECT_ID(N'dbo.${name}', N'U') IS NULL CREATE TABLE dbo.${name}(${body})`;
const IX = (name, table, cols) => `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'${name}' AND object_id=OBJECT_ID(N'dbo.${table}')) CREATE INDEX ${name} ON dbo.${table}(${cols})`;
const MSSQL_SCHEMA = [
  T('orgs', `id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(200) NOT NULL,
    price_per_kg FLOAT NOT NULL DEFAULT 15 CHECK(price_per_kg>=0 AND price_per_kg<=100000),
    created_at BIGINT NOT NULL`),
  T('branches', `id INT IDENTITY(1,1) PRIMARY KEY, org_id INT NOT NULL REFERENCES dbo.orgs(id),
    name NVARCHAR(200) NOT NULL, city NVARCHAR(200) NULL, is_demo INT NOT NULL DEFAULT 0,
    CONSTRAINT uq_branches UNIQUE(org_id,name)`),
  T('users', `id INT IDENTITY(1,1) PRIMARY KEY, org_id INT NOT NULL REFERENCES dbo.orgs(id),
    email NVARCHAR(255) NOT NULL UNIQUE, name NVARCHAR(200) NOT NULL,
    role NVARCHAR(10) NOT NULL CHECK(role IN ('admin','staff')),
    branch_id INT NULL REFERENCES dbo.branches(id),
    pass_hash NVARCHAR(200) NOT NULL, salt NVARCHAR(100) NOT NULL, created_at BIGINT NOT NULL`),
  T('sessions', `token_hash NVARCHAR(64) PRIMARY KEY, user_id INT NOT NULL REFERENCES dbo.users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL`),
  T('items', `id INT IDENTITY(1,1) PRIMARY KEY, org_id INT NOT NULL REFERENCES dbo.orgs(id),
    name_ar NVARCHAR(200) NOT NULL, name_en NVARCHAR(200) NOT NULL, ai_label NVARCHAR(200) NULL,
    active INT NOT NULL DEFAULT 1, CONSTRAINT uq_items UNIQUE(org_id,name_ar)`),
  T('entries', `id INT IDENTITY(1,1) PRIMARY KEY, org_id INT NOT NULL REFERENCES dbo.orgs(id),
    branch_id INT NOT NULL REFERENCES dbo.branches(id), user_id INT NOT NULL REFERENCES dbo.users(id),
    ts BIGINT NOT NULL, day NVARCHAR(10) NOT NULL,
    kg FLOAT NOT NULL CHECK(kg>0 AND kg<=5000),
    waste_type NVARCHAR(20) NOT NULL CHECK(waste_type IN ('plate','prep','spoilage')),
    meal NVARCHAR(20) NOT NULL CHECK(meal IN ('breakfast','lunch','dinner','break','snack')),
    item_ids NVARCHAR(MAX) NOT NULL, ai_labels NVARCHAR(MAX) NULL,
    source NVARCHAR(10) NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','ai')),
    ai_corrected INT NOT NULL DEFAULT 0, is_demo INT NOT NULL DEFAULT 0`),
  IX('entries_org_day', 'entries', 'org_id,day'),
  IX('entries_branch_day', 'entries', 'branch_id,day'),
  T('prepared', `id INT IDENTITY(1,1) PRIMARY KEY, org_id INT NOT NULL REFERENCES dbo.orgs(id),
    branch_id INT NOT NULL REFERENCES dbo.branches(id), day NVARCHAR(10) NOT NULL,
    kg FLOAT NOT NULL CHECK(kg>0 AND kg<=100000), is_demo INT NOT NULL DEFAULT 0,
    CONSTRAINT uq_prepared UNIQUE(branch_id,day)`),
  T('trials', `id INT IDENTITY(1,1) PRIMARY KEY, org_id INT NOT NULL REFERENCES dbo.orgs(id),
    branch_id INT NULL REFERENCES dbo.branches(id), item_id INT NOT NULL REFERENCES dbo.items(id),
    target_pct FLOAT NOT NULL, status NVARCHAR(10) NOT NULL CHECK(status IN ('active','stopped','ignored')),
    started_day NVARCHAR(10) NOT NULL, ended_day NVARCHAR(10) NULL, baseline_kg_day FLOAT NOT NULL DEFAULT 0`),
  T('charities', `id INT IDENTITY(1,1) PRIMARY KEY, org_id INT NOT NULL REFERENCES dbo.orgs(id),
    name NVARCHAR(200) NOT NULL, active INT NOT NULL DEFAULT 1, is_demo INT NOT NULL DEFAULT 0,
    CONSTRAINT uq_charities UNIQUE(org_id,name)`),
  T('offers', `id INT IDENTITY(1,1) PRIMARY KEY, org_id INT NOT NULL REFERENCES dbo.orgs(id),
    branch_id INT NOT NULL REFERENCES dbo.branches(id), item_id INT NOT NULL REFERENCES dbo.items(id),
    charity_id INT NOT NULL REFERENCES dbo.charities(id), kg FLOAT NOT NULL CHECK(kg>0 AND kg<=5000),
    status NVARCHAR(12) NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','collected','cancelled')),
    created_ts BIGINT NOT NULL, is_demo INT NOT NULL DEFAULT 0`),
];

// ? -> @p1.., and "LIMIT ?" or "LIMIT 20" (always last) -> OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY
function toTsql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '@p' + (++i)).replace(/\bLIMIT\s+(@p\d+|\d+)\s*$/i, 'OFFSET 0 ROWS FETCH NEXT $1 ROWS ONLY');
}

// SQL Server settings come from environment variables (see README) or a ready connection string.
function mssqlConfigFromEnv(env = process.env) {
  if (env.MSSQL_CONNECTION) return env.MSSQL_CONNECTION;
  // "PC-NAME\\SQLEXPRESS" means server PC-NAME, named instance SQLEXPRESS
  const [host, inst] = String(env.MSSQL_SERVER || 'localhost').split('\\');
  const cfg = {
    server: host, database: env.MSSQL_DATABASE || 'midrar',
    user: env.MSSQL_USER, password: env.MSSQL_PASSWORD,
    options: {
      encrypt: env.MSSQL_ENCRYPT === '1', trustServerCertificate: env.MSSQL_TRUST_CERT === '1',
      ...(env.MSSQL_INSTANCE || inst ? { instanceName: env.MSSQL_INSTANCE || inst } : {}),
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
  if (env.MSSQL_PORT) cfg.port = Number(env.MSSQL_PORT);
  return cfg;
}

async function openMssql(config, sqlLib) {
  const sql = sqlLib || require('mssql');
  const pool = await new sql.ConnectionPool(config).connect();
  const isBig = (col) => col && (col.type === sql.BigInt || (col.type && col.type.name === 'BigInt'));

  const exec = async (target, text, params, wantId) => {
    const req = target.request();
    clean(params).forEach((v, i) => req.input('p' + (i + 1), v));
    let t = toTsql(text);
    if (wantId) t += '; SELECT CAST(SCOPE_IDENTITY() AS INT) AS id';
    const r = await req.query(t);
    const rs = wantId ? r.recordsets[r.recordsets.length - 1] : r.recordset;
    // tedious returns BIGINT as text: turn it back into a number (epoch milliseconds fit exactly)
    const cols = (rs && rs.columns) || {};
    const big = Object.keys(cols).filter((k) => isBig(cols[k]));
    const rows = (rs || []).map((row) => { for (const k of big) if (row[k] != null) row[k] = Number(row[k]); return row; });
    return { rows, changes: Array.isArray(r.rowsAffected) ? r.rowsAffected[0] || 0 : 0 };
  };
  const bind = (target) => ({
    async q(text, params) { return (await exec(target, text, params, false)).rows; },
    async q1(text, params) { return (await exec(target, text, params, false)).rows[0]; },
    async run(text, params) {
      const insert = /^\s*INSERT\b/i.test(text);
      const r = await exec(target, text, params, insert);
      return { lastInsertRowid: insert ? (r.rows[0] && r.rows[0].id) || 0 : 0, changes: r.changes };
    },
  });

  for (const stmt of MSSQL_SCHEMA) await pool.request().batch(stmt);

  async function tx(fn) {
    const t = new sql.Transaction(pool);
    await t.begin();
    try { const r = await fn(bind(t)); await t.commit(); return r; }
    catch (e) { try { await t.rollback(); } catch { /* already rolled back */ } throw e; }
  }
  return { kind: 'mssql', ...bind(pool), tx, close: () => pool.close() };
}

// Picks the engine from the environment: DB_TYPE=mssql  (default: SQLite file in DATA_DIR)
async function openFromEnv(dataDir, env = process.env) {
  if ((env.DB_TYPE || '').toLowerCase() === 'mssql') return openMssql(mssqlConfigFromEnv(env));
  return open(path.join(dataDir, 'midrar.db'));
}

module.exports = { open, openMssql, openFromEnv, toTsql, mssqlConfigFromEnv, MSSQL_SCHEMA, SQLITE_SCHEMA };
