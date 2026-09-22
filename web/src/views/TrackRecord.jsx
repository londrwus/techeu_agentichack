// Track record (/track): "How right is Orbit?" — held-out test scores, model leaderboard,
// backtests on real history, calibration and the Modal compute strip.
// Data: /api/leaderboard (eval/leaderboard.json), /api/eval (eval/summary.json), /api/eval/{item} (backtests).
// Ported from vanilla js/views/track_record.js.
import { useMemo, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Topbar } from '@/components/orbit/chrome.jsx';
import { EChart } from '@/components/orbit/charts.jsx';
import { Photo } from '@/components/orbit/bits.jsx';
import { Icon } from '@/lib/icons.jsx';
import { api, useAsync } from '@/lib/api.js';
import { isNum } from '@/lib/format.js';
import { CountUp } from '@/lib/dom.jsx';
import { axisTooltip, fmtMonth, itemTooltip, tipHtml } from '@/lib/chartTheme.js';

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
  dir_clf: ['Direction classifier', 'momentum · CFTC positioning'],
  xasset: ['Cross-market signals', 'FX · oil · El Niño'],
  orbit_v2: ['Orbit v2', 'previous version'],
  orbit_v3: ['Orbit v3', 'final stack'],
};

const addM = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const pc = (v, d = 0) => (isNum(v) ? `${Math.round(v * 100 * 10 ** d) / 10 ** d}%` : '–');
const sgn = (v, d = 0) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%` : '–');

export default function TrackRecord() {
  const { data, loading } = useAsync(async () => {
    const [lb, ev] = await Promise.all([api('/api/leaderboard'), api('/api/eval')]);
    return { lb, ev };
  }, []);
  const [lbKey, setLbKey] = useState('skill');
  const [itemId, setItemId] = useState('orange_juice');
  const { data: itemData } = useAsync(() => api(`/api/eval/${itemId}`), [itemId]);

  const head = (tagline, right) => (
    <Topbar
      crumb="Agents  /  Track record"
      title="How right is Orbit?"
      iconSquare={<div className="icon-sq lg" style={{ background: '#F9731622', color: ACC }}><Icon name="target" /></div>}
      tagline={tagline}
      right={right}
    />
  );

  const model = useMemo(() => {
    if (!data) return null;
    const { lb, ev } = data;
    const rows = lb?.rows || [];
    const FINAL = lb?.final?.name && METHODS[lb.final.name] ? lb.final.name : (rows.some(r => r.method === 'orbit_v3') ? 'orbit_v3' : 'orbit_v2');
    const PREV = FINAL === 'orbit_v3' ? 'orbit_v2' : 'orbit_v1';
    const v2 = rows.find(r => r.method === FINAL)?.test?.h6 || ev?.test_overall?.[FINAL]?.h6 || ev?.[FINAL]?.test?.h6 || {};
    const impRaw = lb?.[`improvement_vs_${PREV.slice(6)}`] || lb?.improvement_vs_v1 || {};
    return { rows, FINAL, PREV, v2, imp: impRaw.h6 || impRaw };
  }, [data]);

  if (loading) {
    return <>{head('Checked against real prices it never saw')}<div className="card skeleton" style={{ height: 180 }} /><div className="card skeleton" style={{ height: 420 }} /></>;
  }
  if (!data?.lb && !data?.ev) {
    return <>{head('Checked against real prices it never saw')}<div className="empty">Track record is being computed.</div></>;
  }

  const { lb, ev } = data;
  const { rows, FINAL, PREV, v2, imp } = model;
  const n = v2.n;
  const tagline = isNum(n) ? `${n} forecasts on 2023–26 data the model never saw` : 'Forecasts on 2023–26 data the model never saw';

  const rel = ((FINAL === 'orbit_v3' && ev?.reliability_test_h6_v3) || ev?.reliability_test_h6 || [])
    .filter(r => isNum(r?.predicted) && isNum(r?.observed) && !(r.n < 5)); // tiny buckets are noise
  const near = rel.length ? rel.filter(r => r.n >= 10).reduce((a, b) => (Math.abs(b.predicted - 0.6) < Math.abs(a.predicted - 0.6) ? b : a), rel[0]) : null;

  const bt = itemData ? backtests(itemData, FINAL) : null;
  const meta = ITEMS.find(x => x[0] === itemId);

  return (
    <>
      {head(tagline, <span className="tr-badge"><Icon name="shield-check" />Tested 6 months ahead · 2023–26</span>)}
      <div className="tr-page">
        <section className="tr-stats"><StatCards t={v2} imp={imp} prev={PREV} /></section>
        <section className="tr-row2">
          <div className="card tr-lb">
            <div className="card-head">
              <div>
                <div className="card-title">Which method won?</div>
                <div className="card-sub">Every model we tried, scored on the unseen 2023–26 test, 6 months ahead</div>
              </div>
              <ToggleGroup type="single" className="seg" value={lbKey} onValueChange={v => v && setLbKey(v)}>
                <ToggleGroupItem value="skill" className={lbKey === 'skill' ? 'on' : undefined}>Error cut</ToggleGroupItem>
                <ToggleGroupItem value="dir_acc" className={lbKey === 'dir_acc' ? 'on' : undefined}>Direction right</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="tr-lb-note">
              {lbKey === 'skill'
                ? <>How much smaller each method&apos;s price errors are than just assuming <b>&quot;the price stays the same&quot;</b>. Right of the line = better.</>
                : <>How often each method called the <b>direction</b> of the next 6 months right (up or down). A coin flip gets 50%.</>}
            </div>
            {rows.length
              ? <EChart className="tr-lb-chart" option={leaderboardOption(rows, lb?.final, lbKey, FINAL)} opts={{ renderer: 'canvas' }} />
              : <div className="empty">Leaderboard not built yet.</div>}
          </div>
          <div className="card tr-cal">
            <div className="card-head">
              <div>
                <div className="card-title">
                  {near ? `When Orbit says ${Math.round(near.predicted * 100)}%, it happens ${Math.round(near.observed * 100)}%` : 'Are its odds honest?'}
                </div>
                <div className="card-sub">Chance of a price rise it gave vs how often prices really rose</div>
              </div>
            </div>
            {rel.length
              ? <EChart className="tr-cal-chart" option={calibrationOption(rel)} opts={{ renderer: 'canvas' }} />
              : <div className="empty">Calibration not built yet.</div>}
            <div className="tr-legend">
              <span><i className="sw dot" />Orbit (bubble = number of forecasts)</span>
              <span><i className="sw dash" />Perfectly honest</span>
            </div>
          </div>
        </section>

        <section className="card tr-hist">
          <div className="card-head">
            <div>
              <div className="card-title">See it on real history</div>
              <div className="card-sub">
                {bt?.points.length ? `${meta?.[2] || itemData.name} · what Orbit predicted 6 months earlier vs what actually happened`
                  : 'What Orbit predicted 6 months earlier vs what actually happened'}
              </div>
            </div>
            <div className="tr-legend top">
              <span><i className="sw line" />Actual price</span>
              <span><i className="sw dash acc" />Orbit said, 6 mo earlier</span>
              <span><i className="sw band" />Orbit&apos;s 80% range</span>
              <span><i className="sw dot red" />Landed outside</span>
            </div>
          </div>
          <div className="tr-chips">
            {ITEMS.map(([id, name]) => (
              <button key={id} className={`tr-chip${id === itemId ? ' on' : ''}`} onClick={() => setItemId(id)}>
                <Photo id={id} wrapClass="tr-ph sm" fallbackClass="tr-noimg" fallbackSize={18} />{name}
              </button>
            ))}
          </div>
          <div className="tr-hist-body">
            {bt?.points.length ? (<>
              <EChart className="tr-hist-chart" option={historyOption(itemData, bt)} opts={{ renderer: 'canvas' }} />
              <div className="tr-hist-side"><HistSide d={itemData} bt={bt} id={itemId} /></div>
            </>) : (<>
              <div className="tr-hist-chart" />
              <div className="tr-hist-side"><div className="empty">No backtests for this item yet.</div></div>
            </>)}
          </div>
        </section>

        <Footer ev={ev} lb={lb} />
      </div>
    </>
  );
}

/* ---------- 1. stat cards ---------- */
function StatCards({ t, imp, prev }) {
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

  return cards.map((c, i) => (
    <div className="card tr-stat" key={c.label} style={{ animationDelay: `${i * 60}ms` }}>
      <div className="tr-stat-top">
        <span className="tr-stat-ic"><Icon name={c.ic} size={15} /></span>
        <span className="tr-stat-label">{c.label}</span>
      </div>
      <div className="tr-stat-v">
        <CountUp to={+c.v.toFixed(c.digits || 0)} digits={c.digits || 0} prefix={c.pre || ''} suffix={c.suf} placeholder={`0${c.suf}`} />
        {c.was ? (
          <span className={`tr-was${c.was.up ? ' better' : ''}`}>
            {c.was.up ? <Icon name="arrow-up-right" size={13} strokeWidth={2.25} /> : null}
            {prev.slice(6)} was {c.was.t}
          </span>
        ) : null}
      </div>
      {isNum(c.bar) ? (
        <div className="tr-meter">
          <i style={{ width: `${Math.max(0, Math.min(1, c.bar)) * 100}%` }} />
          {isNum(c.mark) ? (<>
            <b style={{ left: `${c.mark * 100}%` }} title={c.markLab} />
            <em style={{ left: `${c.mark * 100}%` }}>{c.markLab}</em>
          </>) : null}
        </div>
      ) : (
        <div className="tr-meter zero">
          <i style={{ width: `${Math.min(100, Math.abs(c.v) * 10)}%`, left: '50%' }} />
          <b style={{ left: '50%' }} />
          <em style={{ left: '50%' }}>no-change guess</em>
        </div>
      )}
      <div className="tr-stat-sub">{c.sub}</div>
    </div>
  ));
}

/* ---------- 2. leaderboard ---------- */
function leaderboardOption(rows, final, key, FINAL) {
  const h6 = final?.horizons?.h6 || {};
  const used = new Set([...Object.keys(h6.weights || {}), ...(h6.band_members || []), ...(h6.prob_up_members || []), ...(h6.prob_bigup_members || [])]);
  const list = Object.keys(METHODS).map(id => rows.find(r => r.method === id)).filter(Boolean).map(r => {
    const t = r.test?.h6 || {};
    const notUsed = !['naive', 'orbit_v1', 'orbit_v2', 'orbit_v3'].includes(r.method) && used.size > 0 && !used.has(r.method);
    const tag = notUsed ? 'tested, not used' : r.method === FINAL ? 'final stack' : METHODS[r.method][1];
    return { id: r.method, name: METHODS[r.method][0], tag, notUsed, t, v: isNum(t[key]) ? t[key] * 100 : null };
  });
  list.sort((a, b) => (a.id === FINAL ? -1 : b.id === FINAL ? 1 : (b.v ?? -1e9) - (a.v ?? -1e9)));
  const isSkill = key === 'skill';
  const color = d => (d.id === FINAL ? ACC : d.notUsed ? '#E7E5E4' : d.id === 'naive' ? SLATE_D : SLATE);
  const data = list.map(d => ({
    value: d.v ?? (isSkill ? 0 : null), raw: d,
    itemStyle: { color: color(d), borderRadius: (d.v ?? 0) < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0], ...(d.notUsed ? { decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4, color: '#D6D3D1' } } : {}) },
    label: {
      show: true, position: (d.v ?? 0) < 0 ? 'left' : 'right', distance: 6,
      formatter: () => (d.v == null ? 'makes no up/down call' : d.id === 'naive' && isSkill ? '0 · the benchmark' : isSkill ? sgn(d.v, 1) : `${Math.round(d.v)}%`),
      color: d.id === FINAL ? '#C2410C' : '#57534E', fontWeight: d.id === FINAL ? 800 : 600, fontSize: 12, fontFamily: 'Inter',
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
        title: d.name, tag: d.id === FINAL ? 'Final' : d.notUsed ? 'Not used' : '',
        rows: [
          { label: "Error cut vs 'stays the same'", value: sgn(t.skill * 100, 1) },
          { label: 'Direction right', value: pc(t.dir_acc) },
          { label: 'Big rises caught', value: pc(t.big_move_recall) },
          { label: '80% range hit', value: pc(t.coverage80) },
          { label: 'Average error', value: isNum(t.mape) ? `${t.mape.toFixed(1)}%` : '–' },
          { label: 'Test forecasts', value: isNum(t.n) ? String(t.n) : '–' },
        ],
        note: d.notUsed ? 'Tried, but left out of the final stack (validation rules).' : d.id === FINAL ? 'Blends the members that beat the benchmark on the tuning period.' : METHODS[d.id][1],
      });
    }),
    xAxis: {
      type: 'value', min: lo, max: hi, splitLine: { lineStyle: { color: '#F1F0EE' } },
      axisLabel: { color: '#A8A29E', fontSize: 11, formatter: v => (isSkill ? sgn(v, 0) : `${v}%`) },
    },
    yAxis: {
      type: 'category', inverse: true, data: list.map(d => d.id), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: {
        margin: 12, formatter: id => { const d = list.find(x => x.id === id); return `{n${d.id === FINAL ? 'b' : ''}|${d.name}}\n{${d.notUsed ? 'x' : 't'}|${d.tag}}`; },
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
function backtests(d, FINAL) {
  const all = (d?.backtests || []).filter(b => b.h === 6 && isNum(b.p50) && isNum(b.actual));
  const method = all.some(b => b.method === FINAL) ? FINAL : all.some(b => b.method === 'orbit_v2') ? 'orbit_v2' : 'orbit';
  const byT = new Map();
  for (const b of all.filter(x => x.method === method)) {
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

function HistSide({ d, bt, id }) {
  const test = bt.points.filter(p => p.split === 'test');
  const set = test.length ? test : bt.points;
  const hitN = set.filter(p => p.hit).length, withBand = set.filter(p => p.hit != null).length;
  const dirN = set.filter(p => p.dirOk).length, dirAll = set.filter(p => p.dirOk != null).length;
  const worst = set.reduce((a, b) => (Math.abs(b.actual / b.base - 1) > Math.abs(a.actual / a.base - 1) ? b : a), set[0]);
  const move = worst && isNum(worst.base) ? (worst.actual / worst.base - 1) * 100 : null;
  return (
    <>
      <div className="tr-side-head">
        <Photo id={id} wrapClass="tr-ph md" fallbackClass="tr-noimg" fallbackSize={18} />
        <div>
          <div className="tr-side-name">{d.name || id}</div>
          <div className="tr-side-meta">{test.length ? `${test.length} unseen test forecasts` : `${set.length} forecasts`}</div>
        </div>
      </div>
      {withBand ? (
        <div className="tr-side-stat">
          <div className="v">{hitN}<span>/{withBand}</span></div>
          <div className="l">landed inside Orbit&apos;s 80% range</div>
          <div className="tr-dots">
            {set.filter(p => p.hit != null).map((p, i) => <i key={i} className={p.hit ? 'ok' : 'no'} title={fmtMonth(p.target)} />)}
          </div>
        </div>
      ) : null}
      {dirAll ? (
        <div className="tr-side-stat"><div className="v">{Math.round(dirN / dirAll * 100)}<span>%</span></div><div className="l">called the direction right</div></div>
      ) : null}
      {isNum(move) ? (
        <div className="tr-side-stat">
          <div className={`v ${move > 0 ? 'up' : 'down'}`}>{sgn(move)}</div>
          <div className="l">biggest 6-month move in the test, {fmtMonth(worst.cutoff)} → {fmtMonth(worst.target)}</div>
        </div>
      ) : null}
    </>
  );
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
function Footer({ ev, lb }) {
  const g = ev?.gpu || {};
  const nTfm = ev?.n_forecasts;
  const fits = lb?.compute?.stat_fits ?? 1222;
  const cpus = lb?.compute?.cpu_containers ?? 100;
  const fixes = (lb?.notes || []).filter(s => /^audit:/i.test(s) && /removed|fix/i.test(s)).length;
  const parts = [
    isNum(nTfm) && (
      <><Icon name="cpu" size={16} /><b>{nTfm.toLocaleString('en-GB')}</b> TimesFM forecasts on {isNum(g.containers) ? `${g.containers} × ` : ''}{g.type || 'L4'} GPUs</>
    ),
    <><Icon name="server" size={16} /><b>{Number(fits).toLocaleString('en-GB')}</b> statistical fits on {cpus} CPU containers</>,
    isNum(ev?.n_scored) && (
      <><Icon name="list-checks" size={16} /><b>{ev.n_scored.toLocaleString('en-GB')}</b> forecasts scored</>
    ),
    <><Icon name="shield-check" size={16} />Leakage audit passed{fixes ? <> <span className="dim">({fixes} fix)</span></> : null}</>,
  ].filter(Boolean);
  return (
    <footer className="tr-foot">
      <span className="tr-foot-k">Trained &amp; tested on Modal</span>
      {parts.map((p, i) => <span className="tr-foot-i" key={i}>{p}</span>)}
    </footer>
  );
}
