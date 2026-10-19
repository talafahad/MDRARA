'use strict';
// Copies everything from the SQLite file (data/midrar.db) into SQL Server, keeping the same ids.
// Usage (after npm install, with the same MSSQL_* variables the server uses):
//   node scripts/migrate-sqlite-to-mssql.js            -> copies; refuses if SQL Server already has users
//   node scripts/migrate-sqlite-to-mssql.js --dry-run  -> only counts rows
const path = require('path');
const { open, openMssql, mssqlConfigFromEnv } = require('../lib/db');

// parents before children
const TABLES = [
  ['orgs', true], ['branches', true], ['users', true], ['sessions', false], ['items', true],
  ['entries', true], ['prepared', true], ['trials', true], ['charities', true], ['offers', true],
];

(async () => {
  const dry = process.argv.includes('--dry-run');
  const file = process.env.SQLITE_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'midrar.db');
  const src = open(file);
  const counts = {};
  for (const [t] of TABLES) counts[t] = (await src.q1(`SELECT COUNT(*) AS n FROM ${t}`, [])).n;
  console.log('SQLite rows:', counts);
  if (dry) return;

  const dst = await openMssql(mssqlConfigFromEnv());
  if ((await dst.q1('SELECT COUNT(*) AS n FROM users', [])).n > 0) {
    throw new Error('SQL Server already has users. Use an empty database for the migration.');
  }
  await dst.tx(async (t) => {
    for (const [table, identity] of TABLES) {
      const rows = await src.q(`SELECT * FROM ${table}`, []);
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const sql = `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`;
      // IDENTITY_INSERT is per session/transaction: wrap each table's rows in one batch-level toggle
      if (identity) await t.run(`SET IDENTITY_INSERT dbo.${table} ON`, []);
      for (const r of rows) await t.run(sql, cols.map((c) => r[c]));
      if (identity) await t.run(`SET IDENTITY_INSERT dbo.${table} OFF`, []);
      console.log(`  ${table}: ${rows.length} rows copied`);
    }
  });
  for (const [t] of TABLES) {
    const n = (await dst.q1(`SELECT COUNT(*) AS n FROM ${t}`, [])).n;
    if (n !== counts[t]) throw new Error(`Row count mismatch in ${t}: SQLite ${counts[t]} / SQL Server ${n}`);
  }
  console.log('Done: all row counts match. Start the server with DB_TYPE=mssql.');
  await dst.close();
})().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
