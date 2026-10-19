'use strict';
// Pure analytics: no database or HTTP in here, so it can be unit-tested.
// Every number the app shows is computed from logged entries by these functions.

const MS = 864e5;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (a) => a.reduce((s, x) => s + x, 0);

const tzHours = () => Number(process.env.TZ_OFFSET_HOURS ?? 3); // Asia/Riyadh = UTC+3, no DST

function dayOf(ts) { return new Date(ts + tzHours() * 36e5).toISOString().slice(0, 10); }
function dayAdd(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * MS).toISOString().slice(0, 10); }
function dow(d) { return new Date(d + 'T00:00:00Z').getUTCDay(); } // 0 = Sunday
function diff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / MS); }
function range(a, b) { const r = []; for (let d = a; d <= b; d = dayAdd(d, 1)) r.push(d); return r; }

function ids(e) {
  try { const v = JSON.parse(e.item_ids); return Array.isArray(v) ? v : []; } catch { return []; }
}

// One logged weight can cover several items; it is shared equally between them.
function kgByItem(entries) {
  const m = new Map();
  for (const e of entries) {
    const l = ids(e);
    if (!l.length) continue;
    for (const id of l) m.set(id, (m.get(id) || 0) + e.kg / l.length);
  }
  return m;
}

function groupKg(entries, key) {
  const m = new Map();
  for (const e of entries) m.set(e[key], (m.get(e[key]) || 0) + e.kg);
  return m;
}

function toRows(m, total, k) {
  return [...m]
    .map(([key, kg]) => ({ [k]: key, kg: r2(kg), pct: total > 0 ? r1((kg / total) * 100) : 0 }))
    .sort((a, b) => b.kg - a.kg);
}

function inRange(entries, from, to) { return entries.filter((e) => e.day >= from && e.day <= to); }

/* ---------------------------------------------------------------- dashboard */
function dashboard({ entries, prevEntries, prepared, price, from, to }) {
  const days = diff(from, to) + 1;
  const total = sum(entries.map((e) => e.kg));
  const prev = sum(prevEntries.map((e) => e.kg));
  const keys = new Set(prepared.map((p) => p.branch_id + '|' + p.day));
  const preparedKg = sum(prepared.map((p) => p.kg));
  const wasteOnPreparedDays = sum(entries.filter((e) => keys.has(e.branch_id + '|' + e.day)).map((e) => e.kg));

  const series = range(from, to).map((d) => ({ day: d, kg: 0 }));
  const idx = Object.fromEntries(series.map((s, i) => [s.day, i]));
  for (const e of entries) if (idx[e.day] !== undefined) series[idx[e.day]].kg += e.kg;
  series.forEach((s) => { s.kg = r2(s.kg); });

  return {
    days, from, to,
    total_kg: r2(total),
    cost_sar: r2(total * price),
    entries: entries.length,
    avg_per_day: r2(total / days),
    prev_kg: r2(prev),
    delta_pct: prev > 0 ? r1(((total - prev) / prev) * 100) : null,
    waste_share_pct: preparedKg > 0 && wasteOnPreparedDays > 0 ? r1((wasteOnPreparedDays / preparedKg) * 100) : null,
    by_item: toRows(kgByItem(entries), total, 'item_id'),
    by_type: toRows(groupKg(entries, 'waste_type'), total, 'key'),
    by_meal: toRows(groupKg(entries, 'meal'), total, 'key'),
    by_branch: toRows(groupKg(entries, 'branch_id'), total, 'branch_id'),
    series,
  };
}

/* ---------------------------------------------------------------- forecast */
// Honest, simple method: for each of the next 7 days, average the waste logged on the same
// weekday in the last 4 weeks, per item. It needs enough history, otherwise it says so.
function forecast(entries, today, { minDays = 10 } = {}) {
  const from = dayAdd(today, -27);
  const recent = inRange(entries, from, today);
  const have = new Set(recent.map((e) => e.day));
  if (have.size < minDays) return { ready: false, have_days: have.size, need_days: minDays };

  const first = [...have].sort()[0];
  const win = range(first, today);
  const perDay = {};
  for (const e of recent) {
    const l = ids(e);
    if (!l.length) continue;
    for (const id of l) {
      const d = (perDay[e.day] ||= {});
      d[id] = (d[id] || 0) + e.kg / l.length;
    }
  }
  const dayTotal = (d) => sum(Object.values(perDay[d] || {}));
  const mean = sum(win.map(dayTotal)) / win.length;

  const out = [];
  for (let i = 1; i <= 7; i++) {
    const d = dayAdd(today, i);
    const w = dow(d);
    const same = win.filter((x) => dow(x) === w);
    if (!same.length) { out.push({ day: d, dow: w, kg: null, level: 'unknown', reduce_pct: 0, top_item: null }); continue; }
    const items = {};
    for (const x of same) for (const [id, kg] of Object.entries(perDay[x] || {})) items[id] = (items[id] || 0) + kg / same.length;
    const kg = sum(Object.values(items));
    const ratio = mean > 0 ? kg / mean : 1;
    const level = kg === 0 ? 'none' : ratio >= 1.25 ? 'high' : ratio >= 1.05 ? 'medium' : 'low';
    const top = Object.entries(items).sort((a, b) => b[1] - a[1])[0];
    out.push({
      day: d, dow: w, kg: r1(kg), mean: r1(mean), ratio: r2(ratio), level,
      reduce_pct: level === 'high' || level === 'medium' ? clamp(Math.round((ratio - 1) * 60), 3, 25) : 0,
      top_item: top ? Number(top[0]) : null, top_kg: top ? r1(top[1]) : 0, samples: same.length,
    });
  }
  return { ready: true, method: 'weekday-average', window_days: win.length, days: out };
}

/* ----------------------------------------------------------- recommendations */
const TYPE_ADVICE = { plate: 'portion', prep: 'prep', spoilage: 'stock' };

function recommendations(entries, today, price, excludeItemIds = []) {
  const from = dayAdd(today, -27);
  const recent = inRange(entries, from, today);
  const have = new Set(recent.map((e) => e.day));
  const total = sum(recent.map((e) => e.kg));
  if (have.size < 5 || total <= 0) return { ready: false, have_days: have.size, need_days: 5 };

  const first = [...have].sort()[0];
  const weeks = Math.max(1, diff(first, today) + 1) / 7;
  const perItem = kgByItem(recent);
  const typeByItem = new Map();
  for (const e of recent) {
    const l = ids(e);
    for (const id of l) {
      const t = typeByItem.get(id) || { plate: 0, prep: 0, spoilage: 0 };
      t[e.waste_type] += e.kg / l.length;
      typeByItem.set(id, t);
    }
  }
  const list = [...perItem]
    .filter(([id]) => !excludeItemIds.includes(id))
    .map(([id, kg]) => {
      const share = (kg / total) * 100;
      const t = typeByItem.get(id);
      const dom = Object.entries(t).sort((a, b) => b[1] - a[1])[0][0];
      const target = share >= 30 ? 10 : share >= 20 ? 8 : 5;
      const weekly = kg / weeks;
      return {
        item_id: id, share_pct: r1(share), kg_28d: r2(kg), weekly_kg: r2(weekly),
        main_type: dom, advice: TYPE_ADVICE[dom], target_pct: target,
        est_weekly_saving_sar: r2(weekly * (target / 100) * price),
      };
    })
    .filter((r) => r.share_pct >= 10)
    .sort((a, b) => b.share_pct - a.share_pct)
    .slice(0, 3);
  return { ready: true, window_days: diff(first, today) + 1, items: list };
}

// Baseline for a new trial: this item's average daily waste over the 14 complete days before today.
function itemBaseline(entries, itemId, today) {
  const from = dayAdd(today, -14);
  const to = dayAdd(today, -1);
  const rows = inRange(entries, from, to);
  const have = [...new Set(rows.map((e) => e.day))].sort();
  if (!have.length) return 0;
  const start = have[0] > from ? have[0] : from;
  const days = diff(start, to) + 1;
  return (kgByItem(rows).get(itemId) || 0) / days;
}

function trialImpact(trial, entries, today, price) {
  const end = trial.status === 'active' ? today : (trial.ended_day || today);
  const days = Math.max(1, diff(trial.started_day, end) + 1);
  const rows = inRange(entries, trial.started_day, end).filter((e) => !trial.branch_id || e.branch_id === trial.branch_id);
  const current = (kgByItem(rows).get(trial.item_id) || 0) / days;
  const base = trial.baseline_kg_day;
  const enough = days >= 3 && base > 0;
  return {
    days, baseline_kg_day: r2(base), current_kg_day: r2(current),
    measuring: !enough,
    reduction_pct: enough ? r1(((base - current) / base) * 100) : null,
    saving_sar: enough ? r2((base - current) * days * price) : null,
  };
}

/* ----------------------------------------------------------------- compare */
function compare(entries, today, len, price) {
  const curFrom = dayAdd(today, -(len - 1));
  const prevFrom = dayAdd(curFrom, -len);
  const prevTo = dayAdd(curFrom, -1);
  const cur = sum(inRange(entries, curFrom, today).map((e) => e.kg));
  const prevRows = inRange(entries, prevFrom, prevTo);
  const prev = sum(prevRows.map((e) => e.kg));
  const hasPrev = prevRows.length > 0;
  return {
    len, cur_kg: r2(cur), prev_kg: r2(prev), has_prev: hasPrev,
    delta_kg: hasPrev ? r2(cur - prev) : null,
    delta_pct: hasPrev && prev > 0 ? r1(((cur - prev) / prev) * 100) : null,
    saving_sar: hasPrev ? r2((prev - cur) * price) : null, // negative = waste went up
  };
}

/* ------------------------------------------------------------- leaderboard */
// Transparent formula, shown in the UI: 2 points per logged entry (last 7 days),
// 5 points per % of week-over-week reduction, 50 points per active trial.
function leaderboard(branches, entries, trials, today) {
  return branches.map((b) => {
    const mine = entries.filter((e) => e.branch_id === b.id);
    const c = compare(mine, today, 7, 0);
    const n = inRange(mine, dayAdd(today, -6), today).length;
    const red = c.delta_pct !== null && c.delta_pct < 0 ? Math.round(-c.delta_pct) : 0;
    const act = trials.filter((t) => t.status === 'active' && (!t.branch_id || t.branch_id === b.id)).length;
    return { branch_id: b.id, name: b.name, entries_7d: n, reduction_pct: red, active_trials: act, points: n * 2 + red * 5 + act * 50 };
  }).sort((a, b) => b.points - a.points);
}

module.exports = {
  dayOf, dayAdd, dow, diff, range, r1, r2, sum, clamp,
  kgByItem, dashboard, forecast, recommendations, itemBaseline, trialImpact, compare, leaderboard, inRange,
};
