'use strict';
// Midrar server: plain Node (no npm packages) + built-in SQLite.
// Run:  node server.js      Open: http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open, tx } = require('./lib/db');
const E = require('./lib/engine');
const { loadDemo, clearDemo } = require('./lib/demo');

const WASTE_TYPES = ['plate', 'prep', 'spoilage'];
const MEALS = ['breakfast', 'lunch', 'dinner', 'break', 'snack'];
const DEFAULT_ITEMS = [
  ['ساندويتش', 'Sandwich'], ['بطاطس', 'Fries'], ['فطيرة', 'Pastry'], ['سلطة', 'Salad'], ['فواكه', 'Fruit'],
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(code, msg) { super(msg || String(code)); this.code = code; this.msg = msg; }
}
const bad = (msg) => new HttpError(400, msg);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(pw, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const str = (v, max = 120) => {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
};
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const isEmail = (s) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s);

function createApp(db, opts = {}) {
  const publicDir = opts.publicDir || path.join(__dirname, 'public');
  const secure = opts.secureCookies ?? process.env.SECURE_COOKIES === '1';
  const unsafeEval = process.env.CSP_UNSAFE_EVAL === '1';
  const attempts = new Map(); // login/setup throttling: key -> [timestamps]

  const throttled = (key, max = 8, windowMs = 10 * 60e3) => {
    const now = Date.now();
    const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
    attempts.set(key, list);
    return list.length >= max;
  };
  const noteAttempt = (key) => { attempts.get(key)?.push(Date.now()) ?? attempts.set(key, [Date.now()]); };

  /* ------------------------------------------------------------ helpers */
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const q1 = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const today = () => E.dayOf(Date.now());

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function currentUser(req) {
    const sid = parseCookies(req).sid;
    if (!sid) return null;
    const row = q1(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`, sha(sid));
    if (!row || row.expires_at < Date.now()) return null;
    return row;
  }
  function startSession(res, req, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const days = 30;
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha(token), userId, Date.now() + days * 864e5);
    run('DELETE FROM sessions WHERE expires_at<?', Date.now());
    const isHttps = secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${isHttps ? '; Secure' : ''}`);
  }
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, branch_id: u.branch_id });

  // Which branch(es) a request may see. Staff are pinned to their own branch.
  function scope(user, qBranch) {
    if (user.role === 'staff') return user.branch_id;
    if (qBranch && qBranch !== 'all') {
      const id = Number(qBranch);
      if (!q1('SELECT id FROM branches WHERE id=? AND org_id=?', id, user.org_id)) throw bad('invalid_branch');
      return id;
    }
    return null;
  }
  function entriesFor(user, branch, from, to) {
    const base = 'SELECT id,branch_id,user_id,ts,day,kg,waste_type,meal,item_ids,source,ai_corrected FROM entries WHERE org_id=? AND day>=? AND day<=?';
    return branch ? q(base + ' AND branch_id=?', user.org_id, from, to, branch) : q(base, user.org_id, from, to);
  }
  function preparedFor(user, branch, from, to) {
    const base = 'SELECT branch_id,day,kg FROM prepared WHERE org_id=? AND day>=? AND day<=?';
    return branch ? q(base + ' AND branch_id=?', user.org_id, from, to, branch) : q(base, user.org_id, from, to);
  }
  const price = (user) => q1('SELECT price_per_kg FROM orgs WHERE id=?', user.org_id).price_per_kg;
  const aiStatus = () => {
    try {
      const m = path.join(publicDir, 'model');
      if (!fs.existsSync(path.join(m, 'model.json')) || !fs.existsSync(path.join(m, 'metadata.json'))) return { available: false, labels: [] };
      const meta = JSON.parse(fs.readFileSync(path.join(m, 'metadata.json'), 'utf8'));
      return { available: true, labels: Array.isArray(meta.labels) ? meta.labels.map(String) : [] };
    } catch { return { available: false, labels: [] }; }
  };

  /* ------------------------------------------------------------- routes */
  const routes = [];
  const route = (method, pattern, access, handler) => {
    routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), access, handler });
  };
  const id = (p, k = 'id') => { const n = Number(p[k]); if (!Number.isInteger(n) || n <= 0) throw bad('invalid_id'); return n; };

  route('GET', '/api/status', 'public', () => ({ needs_setup: q1('SELECT COUNT(*) AS n FROM users').n === 0 }));

  route('POST', '/api/setup', 'public', (c) => {
    if (q1('SELECT COUNT(*) AS n FROM users').n > 0) throw new HttpError(409, 'already_setup');
    const b = c.body;
    const org = str(b.org_name), branch = str(b.branch_name), name = str(b.name), email = str(b.email, 200).toLowerCase();
    const pw = typeof b.password === 'string' ? b.password : '';
    if (!org || !branch || !name) throw bad('missing_fields');
    if (!isEmail(email)) throw bad('invalid_email');
    if (pw.length < 8 || pw.length > 200) throw bad('weak_password');
    const user = tx(db, () => {
      const o = Number(run('INSERT INTO orgs(name,created_at) VALUES(?,?)', org, Date.now()).lastInsertRowid);
      const br = Number(run('INSERT INTO branches(org_id,name,city) VALUES(?,?,?)', o, branch, str(b.city, 80) || null).lastInsertRowid);
      const { salt, hash } = hashPassword(pw);
      const u = Number(run('INSERT INTO users(org_id,email,name,role,branch_id,pass_hash,salt,created_at) VALUES(?,?,?,?,?,?,?,?)', o, email, name, 'admin', br, hash, salt, Date.now()).lastInsertRowid);
      for (const [ar, en] of DEFAULT_ITEMS) run('INSERT INTO items(org_id,name_ar,name_en) VALUES(?,?,?)', o, ar, en);
      return q1('SELECT * FROM users WHERE id=?', u);
    });
    startSession(c.res, c.req, user.id);
    return { user: publicUser(user) };
  });

  route('POST', '/api/login', 'public', (c) => {
    const email = str(c.body.email, 200).toLowerCase();
    const pw = typeof c.body.password === 'string' ? c.body.password : '';
    const key = 'login:' + c.ip + ':' + email;
    if (throttled(key)) throw new HttpError(429, 'too_many_attempts');
    const u = email ? q1('SELECT * FROM users WHERE email=?', email) : null;
    // Do the hash work either way so response time does not reveal whether the email exists.
    const ok = u ? checkPassword(pw, u.salt, u.pass_hash) : (hashPassword(pw || 'x'), false);
    if (!ok) { noteAttempt(key); throw new HttpError(401, 'bad_credentials'); }
    attempts.delete(key);
    startSession(c.res, c.req, u.id);
    return { user: publicUser(u) };
  });

  route('POST', '/api/logout', 'user', (c) => {
    const sid = parseCookies(c.req).sid;
    if (sid) run('DELETE FROM sessions WHERE token_hash=?', sha(sid));
    c.res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  route('POST', '/api/password', 'user', (c) => {
    const cur = typeof c.body.current === 'string' ? c.body.current : '';
    const next = typeof c.body.next === 'string' ? c.body.next : '';
    if (!checkPassword(cur, c.user.salt, c.user.pass_hash)) throw new HttpError(401, 'bad_credentials');
    if (next.length < 8 || next.length > 200) throw bad('weak_password');
    const { salt, hash } = hashPassword(next);
    run('UPDATE users SET pass_hash=?, salt=? WHERE id=?', hash, salt, c.user.id);
    return { ok: true };
  });

  route('GET', '/api/meta', 'user', (c) => {
    const u = c.user;
    const org = q1('SELECT name, price_per_kg FROM orgs WHERE id=?', u.org_id);
    const branches = u.role === 'staff'
      ? q('SELECT id,name,city,is_demo FROM branches WHERE org_id=? AND id=?', u.org_id, u.branch_id)
      : q('SELECT id,name,city,is_demo FROM branches WHERE org_id=? ORDER BY id', u.org_id);
    return {
      user: publicUser(u), org,
      items: q('SELECT id,name_ar,name_en,ai_label,active FROM items WHERE org_id=? ORDER BY id', u.org_id),
      branches,
      charities: q('SELECT id,name,active,is_demo FROM charities WHERE org_id=? ORDER BY id', u.org_id),
      today: today(),
      has_demo: q1('SELECT COUNT(*) AS n FROM entries WHERE org_id=? AND is_demo=1', u.org_id).n > 0,
      entry_count: q1('SELECT COUNT(*) AS n FROM entries WHERE org_id=?', u.org_id).n,
      ai: aiStatus(),
    };
  });

  /* ---- settings (admin) */
  route('PUT', '/api/org', 'admin', (c) => {
    const p = num(c.body.price_per_kg), name = str(c.body.name);
    if (!Number.isFinite(p) || p < 0 || p > 100000) throw bad('invalid_price');
    if (!name) throw bad('missing_fields');
    run('UPDATE orgs SET name=?, price_per_kg=? WHERE id=?', name, p, c.user.org_id);
    return { ok: true };
  });

  route('POST', '/api/items', 'admin', (c) => {
    const ar = str(c.body.name_ar, 60), en = str(c.body.name_en, 60) || ar;
    if (!ar) throw bad('missing_fields');
    try {
      const r = run('INSERT INTO items(org_id,name_ar,name_en,ai_label) VALUES(?,?,?,?)', c.user.org_id, ar, en, str(c.body.ai_label, 60) || null);
      return { id: Number(r.lastInsertRowid) };
    } catch { throw new HttpError(409, 'duplicate'); }
  });
  route('PUT', '/api/items/:id', 'admin', (c) => {
    const i = id(c.params), it = q1('SELECT * FROM items WHERE id=? AND org_id=?', i, c.user.org_id);
    if (!it) throw new HttpError(404, 'not_found');
    const ar = str(c.body.name_ar, 60) || it.name_ar;
    const en = str(c.body.name_en, 60) || it.name_en;
    const label = c.body.ai_label === undefined ? it.ai_label : (str(c.body.ai_label, 60) || null);
    const active = c.body.active === undefined ? it.active : (c.body.active ? 1 : 0);
    try { run('UPDATE items SET name_ar=?, name_en=?, ai_label=?, active=? WHERE id=?', ar, en, label, active, i); }
    catch { throw new HttpError(409, 'duplicate'); }
    return { ok: true };
  });

  route('POST', '/api/branches', 'admin', (c) => {
    const name = str(c.body.name, 80);
    if (!name) throw bad('missing_fields');
    try {
      const r = run('INSERT INTO branches(org_id,name,city) VALUES(?,?,?)', c.user.org_id, name, str(c.body.city, 80) || null);
      return { id: Number(r.lastInsertRowid) };
    } catch { throw new HttpError(409, 'duplicate'); }
  });
  route('PUT', '/api/branches/:id', 'admin', (c) => {
    const i = id(c.params);
    const b = q1('SELECT * FROM branches WHERE id=? AND org_id=?', i, c.user.org_id);
    if (!b) throw new HttpError(404, 'not_found');
    try { run('UPDATE branches SET name=?, city=? WHERE id=?', str(c.body.name, 80) || b.name, c.body.city === undefined ? b.city : (str(c.body.city, 80) || null), i); }
    catch { throw new HttpError(409, 'duplicate'); }
    return { ok: true };
  });

  route('POST', '/api/charities', 'admin', (c) => {
    const name = str(c.body.name, 80);
    if (!name) throw bad('missing_fields');
    try { return { id: Number(run('INSERT INTO charities(org_id,name) VALUES(?,?)', c.user.org_id, name).lastInsertRowid) }; }
    catch { throw new HttpError(409, 'duplicate'); }
  });
  route('PUT', '/api/charities/:id', 'admin', (c) => {
    const i = id(c.params);
    if (!q1('SELECT id FROM charities WHERE id=? AND org_id=?', i, c.user.org_id)) throw new HttpError(404, 'not_found');
    run('UPDATE charities SET active=? WHERE id=?', c.body.active ? 1 : 0, i);
    return { ok: true };
  });

  route('GET', '/api/users', 'admin', (c) => ({
    users: q('SELECT id,name,email,role,branch_id FROM users WHERE org_id=? ORDER BY id', c.user.org_id),
  }));
  route('POST', '/api/users', 'admin', (c) => {
    const b = c.body, email = str(b.email, 200).toLowerCase(), name = str(b.name), pw = typeof b.password === 'string' ? b.password : '';
    const role = b.role === 'admin' ? 'admin' : 'staff';
    if (!name) throw bad('missing_fields');
    if (!isEmail(email)) throw bad('invalid_email');
    if (pw.length < 8 || pw.length > 200) throw bad('weak_password');
    let branch = null;
    if (role === 'staff') {
      branch = Number(b.branch_id);
      if (!q1('SELECT id FROM branches WHERE id=? AND org_id=?', branch, c.user.org_id)) throw bad('invalid_branch');
    }
    const { salt, hash } = hashPassword(pw);
    try {
      const r = run('INSERT INTO users(org_id,email,name,role,branch_id,pass_hash,salt,created_at) VALUES(?,?,?,?,?,?,?,?)', c.user.org_id, email, name, role, branch, hash, salt, Date.now());
      return { id: Number(r.lastInsertRowid) };
    } catch { throw new HttpError(409, 'duplicate'); }
  });
  route('DELETE', '/api/users/:id', 'admin', (c) => {
    const i = id(c.params);
    if (i === c.user.id) throw bad('cannot_delete_self');
    const u = q1('SELECT id FROM users WHERE id=? AND org_id=?', i, c.user.org_id);
    if (!u) throw new HttpError(404, 'not_found');
    if (q1('SELECT COUNT(*) AS n FROM entries WHERE user_id=?', i).n > 0) throw new HttpError(409, 'user_has_entries');
    run('DELETE FROM users WHERE id=?', i);
    return { ok: true };
  });

  /* ---- logging */
  route('POST', '/api/entries', 'user', (c) => {
    const b = c.body, u = c.user;
    const kg = Math.round(num(b.kg) * 1000) / 1000;
    if (!Number.isFinite(kg) || kg <= 0 || kg > 5000) throw bad('invalid_kg');
    if (!WASTE_TYPES.includes(b.waste_type)) throw bad('invalid_type');
    if (!MEALS.includes(b.meal)) throw bad('invalid_meal');
    const itemIds = Array.isArray(b.item_ids) ? [...new Set(b.item_ids.map(Number))] : [];
    if (!itemIds.length || itemIds.length > 8 || itemIds.some((n) => !Number.isInteger(n))) throw bad('invalid_items');
    for (const n of itemIds) if (!q1('SELECT id FROM items WHERE id=? AND org_id=? AND active=1', n, u.org_id)) throw bad('invalid_items');
    let branch = u.role === 'staff' ? u.branch_id : Number(b.branch_id);
    if (!branch || !q1('SELECT id FROM branches WHERE id=? AND org_id=?', branch, u.org_id)) throw bad('invalid_branch');
    const t = today();
    let day = t;
    if (b.day !== undefined && b.day !== null && b.day !== '') {
      if (!isDay(b.day) || b.day > t || b.day < E.dayAdd(t, -60)) throw bad('invalid_day');
      day = b.day;
    }
    const aiLabels = Array.isArray(b.ai_labels) ? JSON.stringify(b.ai_labels.slice(0, 5).map((x) => ({ label: str(String(x?.label ?? ''), 60), p: Math.round(Math.min(1, Math.max(0, Number(x?.p) || 0)) * 1000) / 1000 }))) : null;
    const r = run(`INSERT INTO entries(org_id,branch_id,user_id,ts,day,kg,waste_type,meal,item_ids,ai_labels,source,ai_corrected)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, u.org_id, branch, u.id, Date.now(), day, kg, b.waste_type, b.meal, JSON.stringify(itemIds), aiLabels, aiLabels ? 'ai' : 'manual', b.ai_corrected ? 1 : 0);
    return { id: Number(r.lastInsertRowid), day };
  });

  route('GET', '/api/entries', 'user', (c) => {
    const branch = scope(c.user, c.query.branch);
    const limit = Math.min(200, Math.max(1, Number(c.query.limit) || 20));
    const sql = `SELECT id,branch_id,user_id,ts,day,kg,waste_type,meal,item_ids,source,ai_corrected FROM entries WHERE org_id=?${branch ? ' AND branch_id=?' : ''} ORDER BY ts DESC LIMIT ?`;
    const rows = branch ? q(sql, c.user.org_id, branch, limit) : q(sql, c.user.org_id, limit);
    return { entries: rows.map((e) => ({ ...e, item_ids: JSON.parse(e.item_ids) })) };
  });

  route('DELETE', '/api/entries/:id', 'user', (c) => {
    const i = id(c.params);
    const e = q1('SELECT * FROM entries WHERE id=? AND org_id=?', i, c.user.org_id);
    if (!e) throw new HttpError(404, 'not_found');
    const own = e.user_id === c.user.id && Date.now() - e.ts < 24 * 3600e3;
    if (c.user.role !== 'admin' && !own) throw new HttpError(403, 'forbidden');
    run('DELETE FROM entries WHERE id=?', i);
    return { ok: true };
  });

  route('POST', '/api/prepared', 'user', (c) => {
    const kg = num(c.body.kg);
    if (!Number.isFinite(kg) || kg <= 0 || kg > 100000) throw bad('invalid_kg');
    const branch = c.user.role === 'staff' ? c.user.branch_id : Number(c.body.branch_id);
    if (!branch || !q1('SELECT id FROM branches WHERE id=? AND org_id=?', branch, c.user.org_id)) throw bad('invalid_branch');
    const t = today();
    const day = isDay(c.body.day) ? c.body.day : t;
    if (day > t || day < E.dayAdd(t, -60)) throw bad('invalid_day');
    run(`INSERT INTO prepared(org_id,branch_id,day,kg) VALUES(?,?,?,?)
      ON CONFLICT(branch_id,day) DO UPDATE SET kg=excluded.kg, is_demo=0`, c.user.org_id, branch, day, kg);
    return { ok: true };
  });

  /* ---- analytics */
  route('GET', '/api/dashboard', 'user', (c) => {
    const days = Number(c.query.days) === 30 ? 30 : 7;
    const branch = scope(c.user, c.query.branch);
    const t = today(), from = E.dayAdd(t, -(days - 1)), prevFrom = E.dayAdd(from, -days);
    return E.dashboard({
      entries: entriesFor(c.user, branch, from, t),
      prevEntries: entriesFor(c.user, branch, prevFrom, E.dayAdd(from, -1)),
      prepared: preparedFor(c.user, branch, from, t),
      price: price(c.user), from, to: t,
    });
  });

  route('GET', '/api/forecast', 'user', (c) => {
    const branch = scope(c.user, c.query.branch);
    const t = today();
    return E.forecast(entriesFor(c.user, branch, E.dayAdd(t, -27), t), t);
  });

  const trialsFor = (user, branch) => {
    const rows = q('SELECT * FROM trials WHERE org_id=? ORDER BY id DESC', user.org_id);
    return branch ? rows.filter((t) => !t.branch_id || t.branch_id === branch) : rows;
  };

  route('GET', '/api/recommendations', 'user', (c) => {
    const branch = scope(c.user, c.query.branch);
    const t = today();
    const entries = entriesFor(c.user, branch, E.dayAdd(t, -27), t);
    const trials = trialsFor(c.user, branch);
    const blocked = trials
      .filter((x) => x.status === 'active' || (x.status === 'ignored' && E.diff(x.started_day, t) < 14))
      .map((x) => x.item_id);
    const rec = E.recommendations(entries, t, price(c.user), blocked);
    const all = entriesFor(c.user, branch, E.dayAdd(t, -120), t);
    const p = price(c.user);
    const visible = trials.filter((x) => x.status !== 'ignored').map((x) => ({
      ...x, impact: E.trialImpact(x, all, t, p),
    }));
    return { recommendations: rec, trials: visible };
  });

  route('POST', '/api/trials', 'admin', (c) => {
    const itemId = Number(c.body.item_id);
    if (!q1('SELECT id FROM items WHERE id=? AND org_id=?', itemId, c.user.org_id)) throw bad('invalid_items');
    const target = num(c.body.target_pct);
    if (!Number.isFinite(target) || target <= 0 || target > 90) throw bad('invalid_target');
    let branch = null;
    if (c.body.branch_id && c.body.branch_id !== 'all') {
      branch = Number(c.body.branch_id);
      if (!q1('SELECT id FROM branches WHERE id=? AND org_id=?', branch, c.user.org_id)) throw bad('invalid_branch');
    }
    const t = today();
    const dup = q('SELECT id FROM trials WHERE org_id=? AND item_id=? AND status=\'active\' AND COALESCE(branch_id,0)=COALESCE(?,0)', c.user.org_id, itemId, branch);
    if (dup.length) throw new HttpError(409, 'duplicate');
    const entries = entriesFor(c.user, branch, E.dayAdd(t, -14), t);
    const status = c.body.ignore ? 'ignored' : 'active';
    const baseline = status === 'active' ? E.itemBaseline(entries, itemId, t) : 0;
    const r = run('INSERT INTO trials(org_id,branch_id,item_id,target_pct,status,started_day,baseline_kg_day) VALUES(?,?,?,?,?,?,?)',
      c.user.org_id, branch, itemId, target, status, t, baseline);
    return { id: Number(r.lastInsertRowid), baseline_kg_day: E.r2(baseline) };
  });

  route('POST', '/api/trials/:id/stop', 'admin', (c) => {
    const i = id(c.params);
    const r = run(`UPDATE trials SET status='stopped', ended_day=? WHERE id=? AND org_id=? AND status='active'`, today(), i, c.user.org_id);
    if (!r.changes) throw new HttpError(404, 'not_found');
    return { ok: true };
  });

  route('GET', '/api/impact', 'user', (c) => {
    const branch = scope(c.user, c.query.branch);
    const len = Number(c.query.days) === 30 ? 30 : 7;
    const t = today();
    const entries = entriesFor(c.user, branch, E.dayAdd(t, -(len * 2 - 1)), t);
    return E.compare(entries, t, len, price(c.user));
  });

  route('GET', '/api/leaderboard', 'admin', (c) => {
    const t = today();
    const branches = q('SELECT id,name FROM branches WHERE org_id=?', c.user.org_id);
    const entries = entriesFor(c.user, null, E.dayAdd(t, -13), t);
    return { rows: E.leaderboard(branches, entries, trialsFor(c.user, null), t) };
  });

  /* ---- redistribution */
  route('GET', '/api/offers', 'user', (c) => {
    const branch = scope(c.user, c.query.branch);
    const sql = `SELECT id,branch_id,item_id,charity_id,kg,status,created_ts FROM offers WHERE org_id=?${branch ? ' AND branch_id=?' : ''} ORDER BY id DESC LIMIT 20`;
    return { offers: branch ? q(sql, c.user.org_id, branch) : q(sql, c.user.org_id) };
  });
  route('POST', '/api/offers', 'user', (c) => {
    const kg = num(c.body.kg);
    if (!Number.isFinite(kg) || kg <= 0 || kg > 5000) throw bad('invalid_kg');
    if (!q1('SELECT id FROM items WHERE id=? AND org_id=? AND active=1', Number(c.body.item_id), c.user.org_id)) throw bad('invalid_items');
    if (!q1('SELECT id FROM charities WHERE id=? AND org_id=? AND active=1', Number(c.body.charity_id), c.user.org_id)) throw bad('invalid_charity');
    const branch = c.user.role === 'staff' ? c.user.branch_id : Number(c.body.branch_id);
    if (!branch || !q1('SELECT id FROM branches WHERE id=? AND org_id=?', branch, c.user.org_id)) throw bad('invalid_branch');
    const r = run('INSERT INTO offers(org_id,branch_id,item_id,charity_id,kg,created_ts) VALUES(?,?,?,?,?,?)',
      c.user.org_id, branch, Number(c.body.item_id), Number(c.body.charity_id), kg, Date.now());
    return { id: Number(r.lastInsertRowid) };
  });
  route('PUT', '/api/offers/:id', 'user', (c) => {
    const i = id(c.params);
    const o = q1('SELECT * FROM offers WHERE id=? AND org_id=?', i, c.user.org_id);
    if (!o || (c.user.role === 'staff' && o.branch_id !== c.user.branch_id)) throw new HttpError(404, 'not_found');
    if (!['requested', 'collected', 'cancelled'].includes(c.body.status)) throw bad('invalid_status');
    run('UPDATE offers SET status=? WHERE id=?', c.body.status, i);
    return { ok: true };
  });

  /* ---- export + demo */
  route('GET', '/api/export.csv', 'admin', (c) => {
    const items = new Map(q('SELECT id,name_en,name_ar FROM items WHERE org_id=?', c.user.org_id).map((i) => [i.id, i.name_en || i.name_ar]));
    const branches = new Map(q('SELECT id,name FROM branches WHERE org_id=?', c.user.org_id).map((b) => [b.id, b.name]));
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [['id', 'date', 'branch', 'kg', 'waste_type', 'meal', 'items', 'source', 'ai_corrected'].join(',')];
    for (const e of q('SELECT * FROM entries WHERE org_id=? ORDER BY ts', c.user.org_id)) {
      const names = JSON.parse(e.item_ids).map((x) => items.get(x) || x).join('|');
      lines.push([e.id, e.day, branches.get(e.branch_id), e.kg, e.waste_type, e.meal, names, e.source, e.ai_corrected].map(cell).join(','));
    }
    return { raw: '﻿' + lines.join('\n') + '\n', type: 'text/csv; charset=utf-8', filename: 'midrar-entries.csv' };
  });

  route('POST', '/api/demo', 'admin', (c) => {
    if (q1('SELECT COUNT(*) AS n FROM entries WHERE org_id=? AND is_demo=0', c.user.org_id).n > 0) throw new HttpError(409, 'has_real_data');
    if (q1('SELECT COUNT(*) AS n FROM entries WHERE org_id=? AND is_demo=1', c.user.org_id).n > 0) throw new HttpError(409, 'duplicate');
    const itemIds = q('SELECT id FROM items WHERE org_id=? AND active=1 ORDER BY id', c.user.org_id).map((r) => r.id).slice(0, 5);
    const main = c.user.branch_id || q1('SELECT id FROM branches WHERE org_id=? ORDER BY id', c.user.org_id).id;
    const n = loadDemo(db, { orgId: c.user.org_id, userId: c.user.id, today: today(), itemIds, mainBranchId: main });
    return { entries: n };
  });
  route('DELETE', '/api/demo', 'admin', (c) => { clearDemo(db, c.user.org_id); return { ok: true }; });

  /* ------------------------------------------------------- HTTP plumbing */
  function send(res, code, body, headers = {}) {
    res.writeHead(code, headers);
    res.end(body);
  }
  function securityHeaders() {
    const csp = [
      "default-src 'self'",
      `script-src 'self' https://cdn.jsdelivr.net${unsafeEval ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data: blob:",
      "connect-src 'self' https://cdn.jsdelivr.net",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
    ].join('; ');
    return {
      'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(self), microphone=()',
    };
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (ch) => {
        size += ch.length;
        if (size > 1e6) { reject(new HttpError(413, 'too_large')); req.destroy(); return; }
        chunks.push(ch);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
        catch { reject(bad('invalid_json')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
    if (rel.includes('\0')) return send(res, 400, 'Bad request');
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size,
        'Cache-Control': rel.startsWith('/model/') ? 'no-cache' : 'no-cache',
        ...securityHeaders(),
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || '';
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
        return serveStatic(req, res, url.pathname);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'not_found');
      const mutating = req.method !== 'GET';
      if (mutating) {
        const origin = req.headers.origin;
        if (origin) {
          let host = '';
          try { host = new URL(origin).host; } catch { /* invalid origin */ }
          if (host !== req.headers.host) throw new HttpError(403, 'bad_origin');
        }
        if (['POST', 'PUT'].includes(req.method) && !(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'json_only');
      }
      const user = currentUser(req);
      if (r.access !== 'public' && !user) throw new HttpError(401, 'not_logged_in');
      if (r.access === 'admin' && user.role !== 'admin') throw new HttpError(403, 'forbidden');
      const params = r.re.exec(url.pathname).groups || {};
      const body = mutating ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams);
      const out = await r.handler({ req, res, params, query, body, user, ip });
      if (out && out.raw !== undefined) {
        return send(res, 200, out.raw, {
          'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"`,
          'Cache-Control': 'no-store', ...securityHeaders(),
        });
      }
      send(res, 200, JSON.stringify(out ?? { ok: true }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders() });
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) console.error(e);
      if (!res.headersSent) {
        send(res, code, JSON.stringify({ error: code === 500 ? 'server_error' : (e.msg || 'error') }), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      }
    }
  }

  return http.createServer(handler);
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '127.0.0.1';
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const db = open(path.join(dataDir, 'midrar.db'));
  createApp(db).listen(PORT, HOST, () => {
    console.log(`Midrar is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Data: ${path.join(dataDir, 'midrar.db')}`);
  });
}

module.exports = { createApp };
