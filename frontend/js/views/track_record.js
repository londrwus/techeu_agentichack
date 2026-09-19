// Track record (#/track): "How right is Orbit?" — held-out test scores, model leaderboard,
// backtests on real history, hits & misses, calibration and the Modal compute strip.
// Data: /api/leaderboard (eval/leaderboard.json), /api/eval (eval/summary.json), /api/eval/{item} (backtests).
import { topbar, wireScan } from './common.js';
import { api, esc, isNum, icon, itemIcon, onResize, countAll } from '../components/ui.js';
import { axisTooltip, itemTooltip, tipHtml, fmtMonth } from '../components/chartTheme.js';

const ACC = '#F97316', SLATE = '#CBD5E1', SLATE_D = '#94A3B8', HIST = '#334155', GOOD = '#16A34A', BAD = '#DC2626';
const ITEMS = [
  ['chocolate', 'Chocolate', 'World cocoa price'], ['olive_oil', 'Olive oil', 'World olive oil price'],
  ['orange_juice', 'Orange juice', 'World orange price'], ['latte', 'Latte', 'World arabica coffee price'],
  ['pint', 'Pint', 'World barley price'], ['bread', 'Bread', 'World wheat price'],
  ['gpu', 'GPU', 'High-end GPU street price, £'], ['laptop', 'Laptop', 'US computer price index'],
];
// Plain-English names for the model zoo (method id -> [name, family tag]).
const METHODS = {
  naive: ['Price stays the same', 'benchmark'],
  timesfm: ['Google TimesFM', 'AI foundation model'],
  orbit_v1: ['Orbit v1', 'first version'],
  stat_combo: ['Classic statistics blend', 'ETS · ARIMA · Theta'],
  quant_tsmom: ['Price momentum', 'quant trend'],
  exog_ridge: ['Weather + FX signals', 'outside data'],
  learner: ['Boosted-tree learner', 'machine learning'],
  bigmove_clf: ['Big-move detector', 'classifier'],
  orbit_v2: ['Orbit v2', 'final stack'],
};

function css() {
  if (document.getElementById('track-record-css')) return;
  document.head.insertAdjacentHTML('beforeend', '<link id="track-record-css" rel="stylesheet" href="/static/css/track_record.css">');
}
const addM = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const pc = (v, d = 0) => (isNum(v) ? `${Math.round(v * 100 * 10 ** d) / 10 ** d}%` : '–');
const sgn = (v, d = 0) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%` : '–');
const photo = (id, cls = '') => `<span class="tr-ph ${cls}"><img src="/static/assets/products/${id}.jpg" alt="" data-no-lightbox onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="tr-noimg" hidden>${itemIcon(id, { size: 18 })}</span></span>`;

export async function render(el) {
  css();
  const head = topbar({
    crumb: 'Agents  /  Track record', title: 'How right is Orbit?',
    iconSq: `<div class="icon-sq lg" style="background:#F9731622;color:${ACC}"><i data-lucide="target"></i></div>`,
    tagline: 'Checked against real prices it never saw',
  });
  el.innerHTML = head + `<div class="card skeleton" style="height:180px"></div><div class="card skeleton" style="height:420px"></div>`;
  wireScan(el);

  const [lb, ev] = await Promise.all([api('/api/leaderboard'), api('/api/eval')]);
  if (!lb && !ev) { el.innerHTML = head + `<div class="empty">Track record is being computed.</div>`; wireScan(el); return; }

  const rows = lb?.rows || [];
  const v2 = rows.find(r => r.method === 'orbit_v2')?.test?.h6 || ev?.test_overall?.orbit_v2?.h6 || ev?.orbit_v2?.test?.h6 || {};
  const imp = lb?.improvement_vs_v1 || ev?.orbit_v2?.improvement_vs_v1 || {};
  const n = v2.n;
  const tagline = isNum(n) ? `${n} forecasts on 2023–26 data the model never saw` : 'Forecasts on 2023–26 data the model never saw';

  el.innerHTML = topbar({
    crumb: 'Agents  /  Track record', title: 'How right is Orbit?',
    iconSq: `<div class="icon-sq lg" style="background:#F9731622;color:${ACC}"><i data-lucide="target"></i></div>`,
    tagline, right: `<span class="tr-badge"><i data-lucide="shield-check"></i>Tested 6 months ahead · 2023–26</span>`,
  }) + `
  <div class="tr-page">
    <section class="tr-stats">${statCards(v2, imp)}</section>
    <section class="tr-row2">
      <div class="card tr-lb">
        <div class="card-head">
          <div><div class="card-title">Which method won?</div><div class="card-sub">Every model we tried, scored on the unseen 2023–26 test, 6 months ahead</div></div>
          <div class="seg" data-lbm><button class="on" data-k="skill">Error cut</button><button data-k="dir_acc">Direction right</button></div>
        </div>
        <div class="tr-lb-note" data-lbnote></div>
        <div class="tr-lb-chart" data-lbchart></div>
      </div>
      <div class="card tr-cal">
        <div class="card-head"><div><div class="card-title" data-caltitle>Are its odds honest?</div><div class="card-sub">Chance of a price rise it gave vs how often prices really rose</div></div></div>
        <div class="tr-cal-chart" data-calchart></div>
        <div class="tr-legend"><span><i class="sw dot"></i>Orbit (bubble = number of forecasts)</span><span><i class="sw dash"></i>Perfectly honest</span></div>
      </div>
    </section>
    <section class="card tr-hist">
      <div class="card-head">
        <div><div class="card-title">See it on real history</div><div class="card-sub" data-histsub>What Orbit predicted 6 months earlier vs what actually happened</div></div>
        <div class="tr-legend top"><span><i class="sw line"></i>Actual price</span><span><i class="sw dash acc"></i>Orbit said, 6 mo earlier</span><span><i class="sw band"></i>Orbit's 80% range</span><span><i class="sw dot red"></i>Landed outside</span></div>
      </div>
      <div class="tr-chips" data-chips>${ITEMS.map(([id, name], i) => `<button class="tr-chip${i ? '' : ' on'}" data-item="${id}">${photo(id, 'sm')}${esc(name)}</button>`).join('')}</div>
      <div class="tr-hist-body">
        <div class="tr-hist-chart" data-histchart></div>
        <div class="tr-hist-side" data-histside></div>
      </div>
    </section>
    <section class="tr-hm-wrap">
      <div class="tr-sec-head"><h2>Hits &amp; misses</h2><span>Did Orbit warn before a big (&gt;15%) price jump? Green = it raised the alarm early, even when it under-called the size. Red = it missed.</span></div>
      <div class="tr-hm">${hitsMisses(ev?.highlights || [])}</div>
    </section>
    ${footer(ev, lb)}
  </div>`;
  wireScan(el);
  countAll(el);

  const charts = [];
  const mk = node => { if (!window.echarts || !node) return null; const c = echarts.init(node, null, { renderer: 'canvas' }); charts.push(c); return c; };
  const offs = [];

  // Leaderboard
  const lbChart = mk(el.querySelector('[data-lbchart]'));
  const lbNote = el.querySelector('[data-lbnote]');
  const drawLb = k => {
    lbChart?.setOption(leaderboardOption(rows, lb?.final, k), true);
    lbNote.innerHTML = k === 'skill'
      ? `How much smaller each method's price errors are than just assuming <b>"the price stays the same"</b>. Right of the line = better.`
      : `How often each method called the <b>direction</b> of the next 6 months right (up or down). A coin flip gets 50%.`;
  };
  if (rows.length) drawLb('skill'); else el.querySelector('.tr-lb').innerHTML += `<div class="empty">Leaderboard not built yet.</div>`;
  el.querySelectorAll('[data-lbm] button').forEach(b => b.addEventListener('click', () => {
    el.querySelectorAll('[data-lbm] button').forEach(x => x.classList.toggle('on', x === b)); drawLb(b.dataset.k);
  }));

  // Calibration
  const rel = (ev?.reliability_test_h6 || []).filter(r => isNum(r?.predicted) && isNum(r?.observed) && !(r.n < 5)); // tiny buckets are noise
  if (rel.length) {
    mk(el.querySelector('[data-calchart]'))?.setOption(calibrationOption(rel));
    const near = rel.filter(r => r.n >= 10).reduce((a, b) => (Math.abs(b.predicted - 0.6) < Math.abs(a.predicted - 0.6) ? b : a), rel[0]);
    el.querySelector('[data-caltitle]').textContent = `When Orbit says ${Math.round(near.predicted * 100)}%, it happens ${Math.round(near.observed * 100)}%`;
  } else el.querySelector('.tr-cal').innerHTML += `<div class="empty">Calibration not built yet.</div>`;

  // History backtests
  const histChart = mk(el.querySelector('[data-histchart]'));
  let reqSeq = 0;
  const showItem = async id => {
    const my = ++reqSeq;
    el.querySelectorAll('[data-chips] .tr-chip').forEach(b => b.classList.toggle('on', b.dataset.item === id));
    const d = await api(`/api/eval/${id}`);
    if (my !== reqSeq || !el.isConnected) return;
    const meta = ITEMS.find(x => x[0] === id);
    const bt = backtests(d);
    const side = el.querySelector('[data-histside]');
    if (!d || !bt.points.length) { histChart?.clear(); side.innerHTML = `<div class="empty">No backtests for this item yet.</div>`; return; }
    el.querySelector('[data-histsub]').textContent = `${meta?.[2] || d.name} · what Orbit predicted 6 months earlier vs what actually happened`;
    histChart?.setOption(historyOption(d, bt), true);
    side.innerHTML = histSide(d, bt, id);
  };
  el.querySelectorAll('[data-chips] .tr-chip').forEach(b => b.addEventListener('click', () => showItem(b.dataset.item)));
  showItem('orange_juice');

  offs.push(onResize(el, () => charts.forEach(c => c.resize())));
  return () => { offs.forEach(f => f()); charts.forEach(c => c.dispose()); };
}

/* ---------- 1. stat cards ---------- */
function statCards(t, imp) {
  const was = (k, f) => (Array.isArray(imp[k]) && isNum(imp[k][0]) ? { t: f(imp[k][0]), up: imp[k][2] === true } : null);
  const cards = [
    isNum(t.dir_acc) && {
      ic: 'compass', v: t.dir_acc * 100, suf: '%', label: 'Direction right', sub: 'Called up vs down correctly',
      was: was('dir_acc', v => `${Math.round(v * 100)}%`), bar: t.dir_acc, mark: 0.5, markLab: 'coin flip',
    },
    isNum(t.big_move_recall) && {
      ic: 'trending-up', v: t.big_move_recall * 100, suf: '%', label: 'Big price rises caught',
      sub: isNum(t.n_big_moves) ? `${Math.round(t.big_move_recall * t.n_big_moves)} of ${t.n_big_moves} jumps above 15% flagged` : 'Rises above 15% it flagged',
      was: was('big_move_recall', v => `${Math.round(v * 100)}%`), bar: t.big_move_recall,
    },
    isNum(t.skill) && {
      ic: 'scale', v: t.skill * 100, suf: '%', pre: t.skill > 0 ? '+' : '', digits: 1, label: "Beats 'price stays the same'",
      sub: 'Smaller price errors than no-change guess', was: was('skill', v => sgn(v * 100, 1)), bar: null,
    },
    isNum(t.coverage80) && {
      ic: 'crosshair', v: t.coverage80 * 100, suf: '%', label: '80% range hit', sub: 'Real price landed inside its range (aim: 80%)',
      was: was('coverage80', v => `${Math.round(v * 100)}%`), bar: t.coverage80, mark: 0.8, markLab: 'aim',
    },
  ].filter(Boolean);
  return cards.map((c, i) => `<div class="card tr-stat" style="animation-delay:${i * 60}ms">
    <div class="tr-stat-top"><span class="tr-stat-ic">${icon(c.ic, { size: 18 })}</span><span class="tr-stat-label">${esc(c.label)}</span></div>
    <div class="tr-stat-v"><span data-count="${c.v.toFixed(c.digits || 0)}" data-digits="${c.digits || 0}" data-prefix="${c.pre || ''}" data-suffix="${c.suf}">0${c.suf}</span>${c.was ? `<span class="tr-was${c.was.up ? ' better' : ''}">${c.was.up ? icon('arrow-up-right', { size: 13, stroke: 2.25 }) : ''}v1 was ${esc(c.was.t)}</span>` : ''}</div>
    ${isNum(c.bar) ? `<div class="tr-meter"><i style="width:${Math.max(0, Math.min(1, c.bar)) * 100}%"></i>${isNum(c.mark) ? `<b style="left:${c.mark * 100}%" title="${esc(c.markLab)}"></b><em style="left:${c.mark * 100}%">${esc(c.markLab)}</em>` : ''}</div>` : `<div class="tr-meter zero"><i style="width:${Math.min(100, Math.abs(c.v) * 10)}%;left:50%"></i><b style="left:50%"></b><em style="left:50%">no-change guess</em></div>`}
    <div class="tr-stat-sub">${esc(c.sub)}</div>
  </div>`).join('');
}

/* ---------- 2. leaderboard ---------- */
function leaderboardOption(rows, final, key) {
  const h6 = final?.horizons?.h6 || {};
  const used = new Set([...Object.keys(h6.weights || {}), ...(h6.band_members || []), ...(h6.prob_up_members || []), ...(h6.prob_bigup_members || [])]);
  const list = Object.keys(METHODS).map(id => rows.find(r => r.method === id)).filter(Boolean).map(r => {
    const t = r.test?.h6 || {};
    const notUsed = !['naive', 'orbit_v2'].includes(r.method) && used.size > 0 && !used.has(r.method);
    return { id: r.method, name: METHODS[r.method][0], tag: notUsed ? 'tested, not used' : METHODS[r.method][1], notUsed, t, v: isNum(t[key]) ? t[key] * 100 : null };
  });
  list.sort((a, b) => (a.id === 'orbit_v2' ? -1 : b.id === 'orbit_v2' ? 1 : (b.v ?? -1e9) - (a.v ?? -1e9)));
  const isSkill = key === 'skill';
  const color = d => (d.id === 'orbit_v2' ? ACC : d.notUsed ? '#E7E5E4' : d.id === 'naive' ? SLATE_D : SLATE);
  const data = list.map(d => ({
    value: d.v ?? (isSkill ? 0 : null), raw: d,
    itemStyle: { color: color(d), borderRadius: (d.v ?? 0) < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0], ...(d.notUsed ? { decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4, color: '#D6D3D1' } } : {}) },
    label: {
      show: true, position: (d.v ?? 0) < 0 ? 'left' : 'right', distance: 6,
      formatter: () => (d.v == null ? 'makes no up/down call' : d.id === 'naive' && isSkill ? '0 · the benchmark' : isSkill ? sgn(d.v, 1) : `${Math.round(d.v)}%`),
      color: d.id === 'orbit_v2' ? '#C2410C' : '#57534E', fontWeight: d.id === 'orbit_v2' ? 800 : 600, fontSize: 12, fontFamily: 'Inter',
    },
  }));
  const vals = list.map(d => d.v).filter(isNum);
  const lo = isSkill ? Math.min(-4, Math.floor(Math.min(...vals) - 3.5)) : 0;
  const hi = isSkill ? Math.max(4, Math.ceil(Math.max(...vals) + 1.5)) : 80;
  return {
    animationDuration: 700,
    grid: { left: 208, right: 96, top: 24, bottom: 22 },
    tooltip: itemTooltip(p => {
      const d = p.data.raw, t = d.t;
      return tipHtml({
        title: d.name, tag: d.id === 'orbit_v2' ? 'Final' : d.notUsed ? 'Not used' : '',
        rows: [
          { label: "Error cut vs 'stays the same'", value: sgn(t.skill * 100, 1) },
          { label: 'Direction right', value: pc(t.dir_acc) },
          { label: 'Big rises caught', value: pc(t.big_move_recall) },
          { label: '80% range hit', value: pc(t.coverage80) },
          { label: 'Average error', value: isNum(t.mape) ? `${t.mape.toFixed(1)}%` : '–' },
          { label: 'Test forecasts', value: isNum(t.n) ? String(t.n) : '–' },
        ],
        note: d.notUsed ? 'Tried, but left out of the final stack (validation rules).' : d.id === 'orbit_v2' ? 'Blends the members that beat the benchmark on the tuning period.' : METHODS[d.id][1],
      });
    }),
    xAxis: {
      type: 'value', min: lo, max: hi, splitLine: { lineStyle: { color: '#F1F0EE' } },
      axisLabel: { color: '#A8A29E', fontSize: 11, formatter: v => (isSkill ? sgn(v, 0) : `${v}%`) },
    },
    yAxis: {
      type: 'category', inverse: true, data: list.map(d => d.id), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: {
        margin: 12, formatter: id => { const d = list.find(x => x.id === id); return `{n${d.id === 'orbit_v2' ? 'b' : ''}|${d.name}}\n{${d.notUsed ? 'x' : 't'}|${d.tag}}`; },
        rich: {
          n: { fontSize: 13, fontWeight: 600, color: '#1C1917', fontFamily: 'Inter', align: 'right', lineHeight: 17 },
          nb: { fontSize: 13, fontWeight: 800, color: '#C2410C', fontFamily: 'Inter', align: 'right', lineHeight: 17 },
          t: { fontSize: 11, color: '#A8A29E', fontFamily: 'Inter', align: 'right' },
          x: { fontSize: 11, color: '#B45309', fontFamily: 'Inter', align: 'right', fontStyle: 'italic' },
        },
      },
    },
    series: [{
      type: 'bar', data, barWidth: 14,
      markLine: {
        symbol: 'none', silent: true, animation: false,
        data: [{ xAxis: isSkill ? 0 : 50 }],
        lineStyle: { color: '#78716C', type: [4, 4], width: 1 },
        label: { formatter: isSkill ? 'no-change guess' : 'coin flip', position: 'start', color: '#78716C', fontSize: 10, fontWeight: 600 },
      },
    }],
  };
}

/* ---------- 3. history backtests ---------- */
function backtests(d) {
  const all = (d?.backtests || []).filter(b => b.h === 6 && isNum(b.p50) && isNum(b.actual));
  const method = all.some(b => b.method === 'orbit_v2') ? 'orbit_v2' : 'orbit';
  const byT = new Map();
  for (const b of all.filter(b => b.method === method)) {
    const tm = addM(b.cutoff, 6);
    const cur = byT.get(tm);
    if (!cur || (cur.split !== 'test' && b.split === 'test')) byT.set(tm, { ...b, target: tm });
  }
  const points = [...byT.values()].sort((a, b) => a.target.localeCompare(b.target));
  for (const p of points) {
    p.hit = isNum(p.p10) && isNum(p.p90) ? p.actual >= p.p10 && p.actual <= p.p90 : null;
    p.dirOk = isNum(p.base) ? Math.sign(p.p50 - p.base) === Math.sign(p.actual - p.base) : null;
  }
  return { method, points };
}

function historyOption(d, bt) {
  const money = /GBP/.test(d.unit || '');
  const fmtV = v => (!isNum(v) ? '–' : money ? '£' + Math.round(v).toLocaleString('en-GB') : v >= 100 || v === 0 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(2));
  const first = addM(bt.points[0].cutoff, -6);
  const hist = (d.history || []).filter(p => p.month >= first && isNum(p.price));
  const lastM = [hist.at(-1)?.month, bt.points.at(-1).target].sort().at(-1);
  const months = []; for (let m = first; m <= lastM; m = addM(m, 1)) months.push(m);
  const hMap = new Map(hist.map(p => [p.month, p.price]));
  const pMap = new Map(bt.points.map(p => [p.target, p]));
  const col = f => months.map(m => { const p = pMap.get(m); return p ? f(p) : null; });
  const sparse = bt.points.length < 30;
  const firstTest = bt.points.find(p => p.split === 'test')?.target;
  const tuneEnd = [...bt.points].reverse().find(p => p.split === 'train' || p.split === 'val')?.target;
  const areas = [];
  if (tuneEnd) areas.push([{ name: 'Tuning period', xAxis: months[0], itemStyle: { color: 'rgba(120,113,108,.06)' } }, { xAxis: tuneEnd }]);
  if (firstTest) areas.push([{ name: 'Unseen test', xAxis: firstTest, itemStyle: { color: 'rgba(249,115,22,.07)' } }, { xAxis: months.at(-1) }]);
  const every = Math.max(1, Math.round(months.length / 7));
  // Keep the price readable: a runaway 80% range may run off the top instead of flattening the chart.
  const top = Math.max(...hist.map(p => p.price), ...bt.points.map(p => Math.max(p.p50, p.actual)));
  const nice = x => { const k = 10 ** Math.floor(Math.log10(x)); return Math.ceil(x / k * 2) / 2 * k; };
  const yMax = v => (v.max > top * 1.25 ? nice(top * 1.15) : v.max);

  return {
    animationDuration: 800,
    grid: { left: 58, right: 18, top: 34, bottom: 28 },
    tooltip: axisTooltip(ps => {
      const m = months[ps[0]?.dataIndex];
      const p = pMap.get(m), act = hMap.get(m);
      if (!p) return tipHtml({ title: fmtMonth(m), rows: [{ color: HIST, label: 'Actual price', value: fmtV(act) }] });
      const ch = v => (isNum(p.base) && p.base ? sgn((v / p.base - 1) * 100) : '');
      return tipHtml({
        title: fmtMonth(m), tag: p.split === 'test' ? 'Unseen test' : p.split === 'gap' ? 'Buffer' : 'Tuning',
        rows: [
          { color: ACC, dashed: true, label: `Orbit said (in ${fmtMonth(p.cutoff)})`, value: `${fmtV(p.p50)} · ${ch(p.p50)}` },
          isNum(p.p10) && { color: 'rgba(249,115,22,.35)', label: '80% range', value: `${fmtV(p.p10)} – ${fmtV(p.p90)}` },
          { color: HIST, label: 'Actual', value: `${fmtV(p.actual)} · ${ch(p.actual)}` },
          p.hit != null && { label: 'Result', html: p.hit ? `<span style="color:${GOOD}">Inside range</span>` : `<span style="color:${BAD}">Outside range</span>` },
        ],
      });
    }),
    xAxis: {
      type: 'category', data: months, boundaryGap: false, axisLine: { lineStyle: { color: '#E7E5E4' } }, axisTick: { show: false },
      axisLabel: { color: '#A8A29E', fontSize: 11, interval: i => (months.length > 36 ? months[i].endsWith('-01') : i % every === 0), formatter: m => (months.length > 36 ? m.slice(0, 4) : fmtMonth(m)) },
    },
    yAxis: {
      type: 'value', scale: true, splitLine: { lineStyle: { color: '#F1F0EE' } }, max: yMax,
      axisLabel: { color: '#A8A29E', fontSize: 11, formatter: fmtV },
    },
    series: [
      { name: 'lo', type: 'line', data: col(p => p.p10), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, silent: true, connectNulls: sparse, tooltip: { show: false } },
      { name: 'band', type: 'line', data: col(p => (isNum(p.p10) && isNum(p.p90) ? p.p90 - p.p10 : null)), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(249,115,22,.16)' }, silent: true, connectNulls: sparse },
      {
        name: 'actual', type: 'line', data: months.map(m => hMap.get(m) ?? null), symbol: 'none', lineStyle: { color: HIST, width: 2.5 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(100,116,139,.14)' }, { offset: 1, color: 'rgba(100,116,139,0)' }] } },
        markArea: {
          silent: true, data: areas,
          label: { position: 'insideTop', distance: -22, color: '#57534E', fontSize: 11, fontWeight: 700, fontFamily: 'Inter' },
        },
      },
      { name: 'p50', type: 'line', data: col(p => p.p50), symbol: sparse ? 'circle' : 'none', symbolSize: 6, connectNulls: sparse, lineStyle: { color: ACC, width: 2, type: [6, 4] }, itemStyle: { color: ACC } },
      {
        name: 'miss', type: 'scatter', data: months.map(m => { const p = pMap.get(m); return p && p.hit === false ? p.actual : null; }),
        symbolSize: 7, itemStyle: { color: '#fff', borderColor: BAD, borderWidth: 2 }, z: 5,
      },
    ],
  };
}

function histSide(d, bt, id) {
  const test = bt.points.filter(p => p.split === 'test');
  const set = test.length ? test : bt.points;
  const hitN = set.filter(p => p.hit).length, withBand = set.filter(p => p.hit != null).length;
  const dirN = set.filter(p => p.dirOk).length, dirAll = set.filter(p => p.dirOk != null).length;
  const worst = set.reduce((a, b) => (Math.abs(b.actual / b.base - 1) > Math.abs(a.actual / a.base - 1) ? b : a), set[0]);
  const move = worst && isNum(worst.base) ? (worst.actual / worst.base - 1) * 100 : null;
  return `
    <div class="tr-side-head">${photo(id, 'md')}<div><div class="tr-side-name">${esc(d.name || id)}</div><div class="tr-side-meta">${test.length ? `${test.length} unseen test forecasts` : `${set.length} forecasts`}</div></div></div>
    ${withBand ? `<div class="tr-side-stat"><div class="v">${hitN}<span>/${withBand}</span></div><div class="l">landed inside Orbit's 80% range</div><div class="tr-dots">${set.filter(p => p.hit != null).map(p => `<i class="${p.hit ? 'ok' : 'no'}" title="${esc(fmtMonth(p.target))}"></i>`).join('')}</div></div>` : ''}
    ${dirAll ? `<div class="tr-side-stat"><div class="v">${Math.round(dirN / dirAll * 100)}<span>%</span></div><div class="l">called the direction right</div></div>` : ''}
    ${isNum(move) ? `<div class="tr-side-stat"><div class="v ${move > 0 ? 'up' : 'down'}">${sgn(move)}</div><div class="l">biggest 6-month move in the test, ${esc(fmtMonth(worst.cutoff))} → ${esc(fmtMonth(worst.target))}</div></div>` : ''}`;
}

/* ---------- 4. hits & misses ---------- */
function hitsMisses(list) {
  const hs = [...list.filter(h => h.kind === 'hit'), ...list.filter(h => h.kind !== 'hit')];
  if (!hs.length) return `<div class="empty">No highlights yet.</div>`;
  const name = id => ITEMS.find(x => x[0] === id)?.[1] || id;
  return hs.map((h, i) => {
    const hit = h.kind === 'hit';
    const said = h.predicted_change_pct, act = h.actual_change_pct;
    const max = Math.max(Math.abs(said || 0), Math.abs(act || 0), 1);
    const w = v => `${Math.max(2, Math.abs(v || 0) / max * 100)}%`;
    const warn = isNum(h.prob_bigup) ? `Warned: ${Math.round(h.prob_bigup * 100)}% chance of a >15% jump${hit ? ' (well above normal)' : ''}` : hit ? 'Called the rise' : 'No big-rise warning raised';
    return `<div class="tr-hmc ${hit ? 'hit' : 'miss'}" style="animation-delay:${i * 40}ms">
      <div class="tr-hmc-top">${photo(h.item_id, 'lg')}
        <div class="tr-hmc-id"><div class="tr-hmc-name">${esc(name(h.item_id))}</div><div class="tr-hmc-when">${esc(fmtMonth(h.cutoff))} → ${esc(fmtMonth(addM(h.cutoff, 6)))}</div></div>
        <span class="tr-hmc-badge">${icon(hit ? 'check' : 'x', { size: 14, stroke: 2.5 })}${hit ? 'Rise flagged' : 'Missed'}</span>
      </div>
      <div class="tr-hmc-bars">
        <div><span class="k">Expected</span><span class="bar"><i class="said" style="width:${w(said)}"></i></span><b>${sgn(said)}</b></div>
        <div><span class="k">Actual</span><span class="bar"><i class="act" style="width:${w(act)}"></i></span><b class="up">${sgn(act)}</b></div>
      </div>
      <div class="tr-hmc-foot">${esc(warn)}</div>
    </div>`;
  }).join('');
}

/* ---------- 5. calibration ---------- */
function calibrationOption(rel) {
  const lo = Math.max(0, Math.floor(Math.min(...rel.flatMap(r => [r.predicted, r.observed])) * 10 - 0.5) / 10);
  const hi = Math.min(1, Math.ceil(Math.max(...rel.flatMap(r => [r.predicted, r.observed])) * 10 + 0.5) / 10);
  return {
    animationDuration: 700,
    grid: { left: 44, right: 14, top: 12, bottom: 36 },
    tooltip: itemTooltip(p => {
      const r = p.data.raw; if (!r) return '';
      return tipHtml({
        title: `Orbit said ${Math.round(r.predicted * 100)}%`, rows: [
          { color: ACC, label: 'Prices actually rose', value: `${Math.round(r.observed * 100)}%` },
          { label: 'Forecasts in this group', value: String(r.n) },
        ], note: r.n < 10 ? 'Very few forecasts here, so this dot is noisy.' : `Bucket ${r.bin}`,
      });
    }),
    xAxis: { type: 'value', min: lo, max: hi, name: 'Orbit said', nameLocation: 'middle', nameGap: 22, nameTextStyle: { color: '#A8A29E', fontSize: 11 }, splitLine: { lineStyle: { color: '#F1F0EE' } }, axisLabel: { color: '#A8A29E', fontSize: 10, formatter: v => `${Math.round(v * 100)}%` } },
    yAxis: { type: 'value', min: lo, max: hi, name: 'It happened', nameLocation: 'middle', nameGap: 32, nameTextStyle: { color: '#A8A29E', fontSize: 11 }, splitLine: { lineStyle: { color: '#F1F0EE' } }, axisLabel: { color: '#A8A29E', fontSize: 10, formatter: v => `${Math.round(v * 100)}%` } },
    series: [
      { type: 'line', data: [[lo, lo], [hi, hi]], symbol: 'none', silent: true, lineStyle: { color: '#A8A29E', type: [5, 5], width: 1.5 }, tooltip: { show: false } },
      { type: 'line', data: rel.filter(r => r.n >= 10).map(r => [r.predicted, r.observed]), symbol: 'none', silent: true, lineStyle: { color: ACC, width: 1.5, opacity: 0.45 }, tooltip: { show: false } },
      {
        type: 'scatter', data: rel.map(r => ({ value: [r.predicted, r.observed], raw: r })),
        symbolSize: (_, p) => Math.max(9, Math.sqrt(p.data.raw.n) * 2.6),
        itemStyle: { color: ACC, borderColor: '#fff', borderWidth: 2, shadowBlur: 8, shadowColor: 'rgba(249,115,22,.35)' }, z: 3,
      },
    ],
  };
}

/* ---------- 6. Modal footer ---------- */
function footer(ev, lb) {
  const g = ev?.gpu || {};
  const nTfm = ev?.n_forecasts;
  const fits = lb?.compute?.stat_fits ?? 1222;
  const cpus = lb?.compute?.cpu_containers ?? 100;
  const fixes = (lb?.notes || []).filter(s => /^audit:/i.test(s) && /removed|fix/i.test(s)).length;
  const parts = [
    isNum(nTfm) && `${icon('cpu', { size: 16 })}<b>${nTfm.toLocaleString('en-GB')}</b> TimesFM forecasts on ${isNum(g.containers) ? `${g.containers} × ` : ''}${esc(g.type || 'L4')} GPUs`,
    `${icon('server', { size: 16 })}<b>${Number(fits).toLocaleString('en-GB')}</b> statistical fits on ${cpus} CPU containers`,
    isNum(ev?.n_scored) && `${icon('list-checks', { size: 16 })}<b>${ev.n_scored.toLocaleString('en-GB')}</b> forecasts scored`,
    `${icon('shield-check', { size: 16 })}Leakage audit passed${fixes ? ` <span class="dim">(${fixes} fix)</span>` : ''}`,
  ].filter(Boolean);
  return `<footer class="tr-foot"><span class="tr-foot-k">Trained &amp; tested on Modal</span>${parts.map(p => `<span class="tr-foot-i">${p}</span>`).join('')}</footer>`;
}
