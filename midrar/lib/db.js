'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
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

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
  db.exec(SCHEMA);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { open, tx };
