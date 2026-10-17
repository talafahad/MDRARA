'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { open } = require('../lib/db');
const { createApp } = require('../server');
const E = require('../lib/engine');

let server, base;
const jar = {};
function client(name) {
  jar[name] = jar[name] || '';
  return async (method, url, body, extra = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: jar[name], ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) jar[name] = sc.split(';')[0].replace(/=$/, '=');
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}
const admin = client('admin'), staff = client('staff'), anon = client('anon');

test.before(async () => {
  const db = open(':memory:');
  server = createApp(db, { publicDir: path.join(__dirname, '..', 'public') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

test('needs setup, then setup creates admin session', async () => {
  assert.equal((await anon('GET', '/api/status')).data.needs_setup, true);
  assert.equal((await admin('POST', '/api/setup', { org_name: 'X', branch_name: 'Main', name: 'A', email: 'bad', password: '12345678' })).status, 400);
  assert.equal((await admin('POST', '/api/setup', { org_name: 'X', branch_name: 'Main', name: 'A', email: 'a@x.sa', password: 'short' })).data.error, 'weak_password');
  const r = await admin('POST', '/api/setup', { org_name: 'Test Org', branch_name: 'Main', city: 'Riyadh', name: 'Admin', email: 'a@x.sa', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal((await anon('GET', '/api/status')).data.needs_setup, false);
  assert.equal((await admin('POST', '/api/setup', { org_name: 'Y', branch_name: 'Z', name: 'B', email: 'b@x.sa', password: 'password123' })).status, 409);
  const meta = (await admin('GET', '/api/meta')).data;
  assert.equal(meta.items.length, 5);
  assert.equal(meta.branches.length, 1);
  assert.equal(meta.ai.available, false);
});

test('auth: no session, wrong password, throttling', async () => {
  assert.equal((await anon('GET', '/api/meta')).status, 401);
  assert.equal((await anon('POST', '/api/login', { email: 'a@x.sa', password: 'wrong' })).status, 401);
  assert.equal((await anon('POST', '/api/login', { email: 'nobody@x.sa', password: 'wrong' })).status, 401);
  let last;
  for (let i = 0; i < 10; i++) last = await anon('POST', '/api/login', { email: 'a@x.sa', password: 'wrong' });
  assert.equal(last.status, 429);
  assert.equal((await client('ok')('POST', '/api/login', { email: 'nobody@x.sa', password: 'x' })).status, 401);
});

test('security: origin check, json only, path traversal, headers', async () => {
  assert.equal((await admin('POST', '/api/prepared', { kg: 5 }, { Origin: 'https://evil.example' })).status, 403);
  const r = await fetch(base + '/api/prepared', { method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: jar.admin }, body: '{}' });
  assert.equal(r.status, 415);
  const t = await fetch(base + '/..%2f..%2fserver.js');
  assert.ok([403, 404].includes(t.status));
  const t2 = await fetch(base + '/%2e%2e/server.js');
  assert.ok([403, 404].includes(t2.status));
  const idx = await fetch(base + '/');
  assert.match(idx.headers.get('content-security-policy') || '', /default-src 'self'/);
});

test('entries: validation, staff scoping', async () => {
  const meta = (await admin('GET', '/api/meta')).data;
  const [i1, i2] = meta.items;
  const b = meta.branches[0].id;
  const good = { kg: 2.5, waste_type: 'plate', meal: 'lunch', item_ids: [i1.id], branch_id: b };
  assert.equal((await admin('POST', '/api/entries', { ...good, kg: 0 })).data.error, 'invalid_kg');
  assert.equal((await admin('POST', '/api/entries', { ...good, kg: -1 })).data.error, 'invalid_kg');
  assert.equal((await admin('POST', '/api/entries', { ...good, kg: 'abc' })).data.error, 'invalid_kg');
  assert.equal((await admin('POST', '/api/entries', { ...good, waste_type: 'x' })).data.error, 'invalid_type');
  assert.equal((await admin('POST', '/api/entries', { ...good, item_ids: [] })).data.error, 'invalid_items');
  assert.equal((await admin('POST', '/api/entries', { ...good, item_ids: [9999] })).data.error, 'invalid_items');
  assert.equal((await admin('POST', '/api/entries', { ...good, branch_id: 9999 })).data.error, 'invalid_branch');
  assert.equal((await admin('POST', '/api/entries', { ...good, day: '2999-01-01' })).data.error, 'invalid_day');
  assert.equal((await admin('POST', '/api/entries', good)).status, 200);
  assert.equal((await admin('POST', '/api/entries', { ...good, item_ids: [i1.id, i2.id], ai_labels: [{ label: 'sandwich', p: 0.9 }], ai_corrected: true })).status, 200);

  // second branch + staff user pinned to it
  const nb = (await admin('POST', '/api/branches', { name: 'Jeddah' })).data.id;
  assert.equal((await admin('POST', '/api/users', { name: 'S', email: 's@x.sa', password: 'password123', role: 'staff', branch_id: nb })).status, 200);
  assert.equal((await staff('POST', '/api/login', { email: 's@x.sa', password: 'password123' })).status, 200);
  const e = await staff('POST', '/api/entries', { ...good, branch_id: b }); // tries to log for main branch
  assert.equal(e.status, 200);
  const list = (await staff('GET', '/api/entries?branch=' + b)).data.entries;
  assert.ok(list.every((x) => x.branch_id === nb), 'staff only sees own branch');
  assert.equal((await staff('PUT', '/api/org', { name: 'x', price_per_kg: 1 })).status, 403);
  assert.equal((await staff('GET', '/api/users')).status, 403);
  assert.equal((await staff('GET', '/api/export.csv')).status, 403);
  assert.equal((await staff('POST', '/api/demo', {})).status, 403);
  const dash = (await staff('GET', '/api/dashboard?days=7&branch=' + b)).data;
  assert.equal(dash.total_kg, 2.5);
  const adminDash = (await admin('GET', '/api/dashboard?days=7')).data;
  assert.ok(adminDash.total_kg > 2.5);
});

test('org price drives cost; prepared drives waste share', async () => {
  assert.equal((await admin('PUT', '/api/org', { name: 'Test Org', price_per_kg: -5 })).data.error, 'invalid_price');
  assert.equal((await admin('PUT', '/api/org', { name: 'Test Org', price_per_kg: 20 })).status, 200);
  const before = (await admin('GET', '/api/dashboard?days=7')).data;
  assert.equal(before.cost_sar, Math.round(before.total_kg * 20 * 100) / 100);
  assert.equal(before.waste_share_pct, null);
  const b = (await admin('GET', '/api/meta')).data.branches[0].id;
  assert.equal((await admin('POST', '/api/prepared', { branch_id: b, kg: 100 })).status, 200);
  const after = (await admin('GET', '/api/dashboard?days=7')).data;
  assert.ok(after.waste_share_pct > 0 && after.waste_share_pct < 100);
});

test('forecast and recommendations are honest without data, work with demo data', async () => {
  const f0 = (await admin('GET', '/api/forecast')).data;
  assert.equal(f0.ready, false);
  assert.equal((await admin('POST', '/api/demo', {})).status, 409, 'demo refused when real data exists');
  // fresh org for demo path
  const fresh = client('fresh');
  const db2 = open(':memory:');
  const s2 = createApp(db2, { publicDir: path.join(__dirname, '..', 'public') });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const old = base; base = 'http://127.0.0.1:' + s2.address().port;
  try {
    assert.equal((await fresh('POST', '/api/setup', { org_name: 'D', branch_name: 'Main', name: 'A', email: 'd@x.sa', password: 'password123' })).status, 200);
    assert.equal((await fresh('GET', '/api/recommendations')).data.recommendations.ready, false);
    assert.equal((await fresh('POST', '/api/demo', {})).status, 200);
    assert.equal((await fresh('POST', '/api/demo', {})).status, 409);
    const meta = (await fresh('GET', '/api/meta')).data;
    assert.equal(meta.branches.length, 3);
    assert.equal(meta.has_demo, true);
    const f = (await fresh('GET', '/api/forecast')).data;
    assert.equal(f.ready, true);
    assert.equal(f.days.length, 7);
    assert.ok(f.days.some((d) => d.level === 'high' || d.level === 'medium'), 'a Sunday-heavy pattern must show up');
    const rec = (await fresh('GET', '/api/recommendations')).data;
    assert.equal(rec.recommendations.ready, true);
    assert.ok(rec.recommendations.items.length >= 1);
    const top = rec.recommendations.items[0];
    assert.ok(top.share_pct >= 10 && top.est_weekly_saving_sar > 0);
    // start a trial, then ignoring/duplicate rules
    const t = await fresh('POST', '/api/trials', { item_id: top.item_id, target_pct: top.target_pct });
    assert.equal(t.status, 200);
    assert.ok(t.data.baseline_kg_day > 0);
    assert.equal((await fresh('POST', '/api/trials', { item_id: top.item_id, target_pct: 10 })).status, 409);
    const rec2 = (await fresh('GET', '/api/recommendations')).data;
    assert.ok(!rec2.recommendations.items.some((r) => r.item_id === top.item_id), 'active trial item is not recommended again');
    assert.equal(rec2.trials[0].impact.measuring, true, 'a trial that just started is still measuring');
    const lb = (await fresh('GET', '/api/leaderboard')).data.rows;
    assert.equal(lb.length, 3);
    assert.ok(lb[0].points >= lb[2].points);
    assert.equal((await fresh('POST', `/api/trials/${t.data.id}/stop`, {})).status, 200);
    // clear demo removes demo branches and rows
    assert.equal((await fresh('DELETE', '/api/demo')).status, 200);
    const m2 = (await fresh('GET', '/api/meta')).data;
    assert.equal(m2.branches.length, 1);
    assert.equal(m2.entry_count, 0);
  } finally { base = old; s2.close(); }
});

test('offers, csv export, delete rules', async () => {
  const meta = (await admin('GET', '/api/meta')).data;
  const ch = (await admin('POST', '/api/charities', { name: 'Test Charity' })).data.id;
  const o = await admin('POST', '/api/offers', { item_id: meta.items[0].id, kg: 4, charity_id: ch, branch_id: meta.branches[0].id });
  assert.equal(o.status, 200);
  assert.equal((await admin('PUT', '/api/offers/' + o.data.id, { status: 'collected' })).status, 200);
  assert.equal((await admin('PUT', '/api/offers/' + o.data.id, { status: 'weird' })).status, 400);
  assert.equal((await admin('POST', '/api/offers', { item_id: meta.items[0].id, kg: 4, charity_id: 9999, branch_id: meta.branches[0].id })).data.error, 'invalid_charity');
  // formula-looking item names must be neutralised in CSV
  await admin('POST', '/api/items', { name_ar: '=cmd', name_en: '=HYPERLINK("x")' });
  const items = (await admin('GET', '/api/meta')).data.items;
  const evil = items.find((i) => i.name_ar === '=cmd');
  await admin('POST', '/api/entries', { kg: 1, waste_type: 'prep', meal: 'snack', item_ids: [evil.id], branch_id: meta.branches[0].id });
  const csv = (await admin('GET', '/api/export.csv')).data;
  assert.match(csv, /date,branch,kg/);
  assert.ok(!/,=HYPERLINK/.test(csv) && /'=HYPERLINK/.test(csv));
  const list = (await admin('GET', '/api/entries?limit=5')).data.entries;
  assert.equal((await admin('DELETE', '/api/entries/' + list[0].id)).status, 200);
  assert.equal((await admin('DELETE', '/api/entries/999999')).status, 404);
});

test('engine: weekday forecast and trial impact maths', () => {
  const today = '2026-10-15'; // Thursday
  const entries = [];
  for (let back = 27; back >= 0; back--) {
    const d = E.dayAdd(today, -back);
    const kg = E.dow(d) === 0 ? 10 : 2; // Sundays heavy
    entries.push({ id: back, branch_id: 1, day: d, kg, waste_type: 'plate', meal: 'lunch', item_ids: '[1]' });
  }
  const f = E.forecast(entries, today);
  const sunday = f.days.find((d) => d.dow === 0);
  assert.equal(sunday.level, 'high');
  assert.equal(sunday.kg, 10);
  assert.equal(f.days.find((d) => d.dow === 1).level, 'low');
  // trial: baseline 4/day, then 2/day for 4 days at price 10 -> saving (4-2)*4*10 = 80
  const trial = { item_id: 1, branch_id: null, status: 'active', started_day: E.dayAdd(today, -3), baseline_kg_day: 4 };
  const rows = entries.map((e) => ({ ...e, kg: 2 }));
  const imp = E.trialImpact(trial, rows, today, 10);
  assert.equal(imp.days, 4);
  assert.equal(imp.reduction_pct, 50);
  assert.equal(imp.saving_sar, 80);
  const c = E.compare(entries, today, 7, 10);
  assert.equal(c.has_prev, true);
  assert.ok(Math.abs(c.cur_kg + (-c.delta_kg) - c.prev_kg) < 0.01);
});
