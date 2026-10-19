'use strict';
// Optional demo data for presentations. Every row is flagged is_demo=1 so it can be removed in one click.
// The numbers are generated, not measured: the UI labels demo mode clearly.
const E = require('./engine');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEEKDAY_FACTOR = { 0: 1.4, 1: 1.0, 2: 0.9, 3: 1.15, 4: 1.05, 5: 0, 6: 0 }; // Sun-Thu school-style week
const ITEM_WEIGHTS = [0.36, 0.22, 0.15, 0.15, 0.12]; // matches default item order
const MEALS = ['break', 'lunch', 'breakfast'];

function pick(r, weights) {
  let x = r() * weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
  return weights.length - 1;
}

function loadDemo(db, { orgId, userId, today, itemIds, mainBranchId }) {
  return db.tx(async (t) => {
    const r = rng(20261013);
    const branches = [{ id: mainBranchId, f: 1 }];
    for (const [name, city, f] of [['فرع جدة (تجريبي)', 'جدة', 0.8], ['فرع الدمام (تجريبي)', 'الدمام', 0.6]]) {
      let b = await t.q1('SELECT id FROM branches WHERE org_id=? AND name=?', [orgId, name]);
      if (!b) {
        const res = await t.run('INSERT INTO branches(org_id,name,city,is_demo) VALUES(?,?,?,1)', [orgId, name, city]);
        b = { id: Number(res.lastInsertRowid) };
      }
      branches.push({ id: b.id, f });
    }
    for (const name of ['جمعية تجريبية ١', 'جمعية تجريبية ٢']) {
      if (!(await t.q1('SELECT id FROM charities WHERE org_id=? AND name=?', [orgId, name]))) {
        await t.run('INSERT INTO charities(org_id,name,is_demo) VALUES(?,?,1)', [orgId, name]);
      }
    }
    const insE = `INSERT INTO entries(org_id,branch_id,user_id,ts,day,kg,waste_type,meal,item_ids,source,is_demo)
      VALUES(?,?,?,?,?,?,?,?,?, 'manual',1)`;
    let n = 0;
    for (let back = 27; back >= 1; back--) {
      const day = E.dayAdd(today, -back);
      const f = WEEKDAY_FACTOR[E.dow(day)];
      if (!f) continue;
      for (const b of branches) {
        const count = 2 + Math.floor(r() * 3);
        let dayKg = 0;
        for (let i = 0; i < count; i++) {
          const item = itemIds[pick(r, ITEM_WEIGHTS.slice(0, itemIds.length))];
          const kg = Math.round((0.8 + r() * 3.2) * f * b.f * 10) / 10 || 0.5;
          const type = ['plate', 'prep', 'spoilage'][pick(r, [0.45, 0.33, 0.22])];
          const ts = Date.parse(day + 'T09:00:00Z') + i * 3600e3;
          await t.run(insE, [orgId, b.id, userId, ts, day, Math.max(0.3, kg), type, MEALS[pick(r, [0.45, 0.4, 0.15])], JSON.stringify([item])]);
          dayKg += Math.max(0.3, kg); n++;
        }
        // keep a real figure if one already exists for this branch and day
        if (!(await t.q1('SELECT id FROM prepared WHERE branch_id=? AND day=?', [b.id, day]))) {
          await t.run('INSERT INTO prepared(org_id,branch_id,day,kg,is_demo) VALUES(?,?,?,?,1)', [orgId, b.id, day, Math.round((dayKg / (0.17 + r() * 0.08)) * 10) / 10]);
        }
      }
    }
    return n;
  });
}

function clearDemo(db, orgId) {
  return db.tx(async (t) => {
    await t.run('DELETE FROM offers WHERE org_id=? AND (is_demo=1 OR branch_id IN (SELECT id FROM branches WHERE org_id=? AND is_demo=1))', [orgId, orgId]);
    await t.run('DELETE FROM trials WHERE org_id=? AND branch_id IN (SELECT id FROM branches WHERE org_id=? AND is_demo=1)', [orgId, orgId]);
    await t.run('DELETE FROM entries WHERE org_id=? AND (is_demo=1 OR branch_id IN (SELECT id FROM branches WHERE org_id=? AND is_demo=1))', [orgId, orgId]);
    await t.run('DELETE FROM prepared WHERE org_id=? AND (is_demo=1 OR branch_id IN (SELECT id FROM branches WHERE org_id=? AND is_demo=1))', [orgId, orgId]);
    await t.run('DELETE FROM offers WHERE org_id=? AND charity_id IN (SELECT id FROM charities WHERE org_id=? AND is_demo=1)', [orgId, orgId]);
    await t.run('DELETE FROM charities WHERE org_id=? AND is_demo=1', [orgId]);
    await t.run('UPDATE users SET branch_id=NULL WHERE org_id=? AND branch_id IN (SELECT id FROM branches WHERE org_id=? AND is_demo=1)', [orgId, orgId]);
    await t.run('DELETE FROM branches WHERE org_id=? AND is_demo=1', [orgId]);
  });
}

module.exports = { loadDemo, clearDemo };
