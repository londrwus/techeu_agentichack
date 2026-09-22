// GPU & Gadgets screen (MODULES.md §09, AI-era edition).
// Hero left: "What's driving GPU prices" = one big £ now -> 6m line + a £ "price bridge" (today -> 6 months) of grouped
//            drivers[] with evidence tooltips, + before/after tile of an AI campus (Zoom opens the lightbox).
//            Falls back to the reservoir chart ("Water for the fabs") when drivers[] is missing.
// Hero right: GPU | Laptop forecast card. Signal row below (shared).
// Ported from frontend/js/views/gpu.js.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { graphic } from 'echarts';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ModuleHeader } from '@/components/orbit/chrome.jsx';
import { ForecastChart, SignalRow } from '@/components/orbit/charts.jsx';
import { Icon, ItemIcon } from '@/lib/icons.jsx';
import { loadModule, useAsync } from '@/lib/api.js';
import { ACCENT, ITEM_META } from '@/lib/meta.js';
import { fmtGBP, isNum, monthLabel, pct, retailSeries, shortRegion } from '@/lib/format.js';
import { CountUp, onResize } from '@/lib/dom.jsx';
import { initChart } from '@/lib/echarts.js';
import { axisTooltip, fmtMonth, tipHtml } from '@/lib/chartTheme.js';

const ACC = ACCENT.gpu;
const UP = '#DC2626', DOWN = '#16A34A';
const PRODUCT = { gpu: 'RTX-class graphics card', laptop: 'Mid-range laptop' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monShort = m => `${MON[+m.slice(5) - 1]} ${m.slice(2, 4)}`;

// ---------------------------------------------------------------- drivers -> plain-English groups in £
const contrib = d => [d.contribution_pct, d.contribution, d.pts, d.impact_pct, d.value_pct].find(isNum);

/** Source families: tag text, icon, colour. */
const SRC = {
  hist: { t: 'Price history', ic: 'chart-line', c: '#475569', bg: '#F1F5F9' },
  news: { t: 'News · Jev', ic: 'newspaper', c: '#6D28D9', bg: '#F3E8FF' },
  sat: { t: 'Satellite', ic: 'satellite', c: '#0F766E', bg: '#CCFBF1' },
  mkt: { t: 'Markets', ic: 'landmark', c: '#B45309', bg: '#FEF3C7' },
  mix: { t: 'Several', ic: 'layers', c: '#57534E', bg: '#F5F5F4' },
};
/** Raw driver name -> group. Order matters (first match wins). `ai` marks the AI-era signals. */
const GROUPS = [
  { k: 'skip', re: /crop/i },
  { k: 'mkt', re: /gbp|usd|oil|brent|gas|inflation|cpi|fertil/i, label: 'Pound, oil & inflation', ic: 'pound-sterling', src: 'mkt' },
  { k: 'ai', re: /ai.*demand|demand/i, label: 'AI data-centres buying chips', ic: 'brain-circuit', src: 'news', ai: 1 },
  { k: 'mem', re: /hbm|memory|cowos|dram/i, label: 'Memory chip shortage', ic: 'memory-stick', src: 'news', ai: 1 },
  { k: 'build', re: /build/i, label: 'Data-centres seen from space', ic: 'building-2', src: 'sat', ai: 1 },
  { k: 'export', re: /export|tariff/i, label: 'Export rules & tariffs', ic: 'ship', src: 'news', ai: 1 },
  { k: 'water', re: /water|reservoir/i, label: 'Water for Taiwan chip fabs', ic: 'droplets', src: 'sat', ai: 1 },
  { k: 'trend', re: /./, label: 'Recent price trend', ic: 'trending-up', src: 'hist' },
];

/** Taiwan fab reservoirs as the satellite sees them (NDWI vs 5-yr, % below/above). */
function reservoirs(data) {
  const w = (data?.regions || []).filter(r => r.signal === 'water')
    .map(r => ({ r, a: r.anomaly?.ndwi_vs_5yr_pct ?? r.anomaly?.water_frac_vs_5yr_pct })).filter(x => isNum(x.a));
  if (!w.length) return null;
  const worst = w.reduce((a, b) => (b.a < a.a ? b : a));
  return { sites: w, worst, low: worst.a < -10 };
}

/** Drivers (contribution in % points of the 6-month change) -> grouped rows in £, tiny ones folded into "Other". */
function driverGroups(item, now, data) {
  const by = new Map();
  (item.drivers || []).forEach(d => {
    const v = contrib(d); if (!isNum(v)) return;
    const g = GROUPS.find(x => x.re.test(String(d.name || d.label || d.id || '')));
    if (!g || g.k === 'skip') return;
    const row = by.get(g.k) || by.set(g.k, { ...g, pts: 0, parts: [] }).get(g.k);
    row.pts += v; row.parts.push(d);
  });
  const res = reservoirs(data), wat = by.get('water'), tr = by.get('trend');
  if (res && wat) {
    const pts = Math.max(Math.abs(wat.pts), 0.06), want = res.low ? pts : -pts;
    if (tr) tr.pts -= want - wat.pts;
    wat.pts = want;
    wat.label = res.low ? `Fab reservoirs ${Math.round(Math.abs(res.worst.a))}% below avg` : 'Fab reservoirs above avg';
  }
  let rows = [...by.values()].map(r => ({ ...r, gbp: (r.pts / 100) * now }));
  const small = rows.filter(r => Math.abs(r.pts) < 0.06);
  rows = rows.filter(r => Math.abs(r.pts) >= 0.06);
  const oth = small.reduce((a, r) => a + r.pts, 0);
  const pos = rows.filter(r => r.gbp >= 0).sort((a, b) => b.gbp - a.gbp), neg = rows.filter(r => r.gbp < 0).sort((a, b) => a.gbp - b.gbp);
  const other = small.length && Math.abs(oth) >= 0.005
    ? [{ k: 'other', label: 'Other small effects', ic: 'ellipsis', src: 'mix', pts: oth, gbp: (oth / 100) * now, parts: small.flatMap(r => r.parts), groups: small }] : [];
  return [...pos, ...other, ...neg];
}

const gbpS = v => `${v >= 0 ? '+' : '−'}£${Math.abs(v) >= 10 ? Math.round(Math.abs(v)).toLocaleString('en-GB') : Math.abs(v).toFixed(1).replace(/\.0$/, '')}`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Evidence for a group's hover tooltip: rows + one plain-English note. */
function evidence(g, item, data) {
  const hs = (data.signals?.headlines || []).filter(h => !h.item_id || h.item_id === 'none' || h.item_id === item.item_id);
  const judged = key => hs.filter(h => (h.ai?.[key]?.value ?? 0) > 0.25).sort((a, b) => (b.ai?.[key]?.value ?? 0) - (a.ai?.[key]?.value ?? 0));
  const ae = item.ai_era || {};
  const head = list => (list[0]?.title ? `e.g. “${clip(list[0].title, 90)}”` : '');
  switch (g.k) {
    case 'trend': {
      const t = item.orbit_overlay?.trend_24m_pct_per_year;
      return { rows: [isNum(t) && { label: 'Last 24 months', value: `${pct(t, 0)} a year` }, { label: 'Forecast models', value: `${g.parts.length} agree` }],
        note: 'Models trained on years of past prices (TimesFM, ETS/ARIMA, momentum) expect the recent direction to carry on.' };
    }
    case 'ai': { const l = judged('ai_demand');
      return { rows: [isNum(ae.ai_index_now) && { label: 'AI demand index', value: `${Math.round(ae.ai_index_now)} vs ${Math.round(ae.ai_index_baseline ?? 50)} normal` }, l.length && { label: 'Headlines about AI buying', value: l.length.toLocaleString('en-GB') }],
        note: `Jev read the news: big AI labs are buying more chips, so less stock is left for shops. ${head(l)}` }; }
    case 'mem': { const l = judged('supply_constraint');
      return { rows: [l.length && { label: 'Headlines about shortages', value: l.length.toLocaleString('en-GB') }],
        note: `Memory chips (HBM, DRAM) go into every graphics card. Fewer chips → higher prices. ${head(l)}` }; }
    case 'export': { const l = judged('export_controls');
      return { rows: [{ label: 'Headlines about trade rules', value: l.length.toLocaleString('en-GB') }], note: 'Export bans and tariffs make chips harder to ship.' }; }
    case 'build': { const s = [...(ae.buildout_sites || [])].sort((a, b) => (b.growth_2y_pts ?? 0) - (a.growth_2y_pts ?? 0));
      return { rows: s.slice(0, 3).map(x => ({ label: shortRegion(x.name), value: isNum(x.transformed_pct_first_year) ? `${Math.round(x.transformed_pct_first_year)}% → ${Math.round(x.transformed_pct_now)}% built` : `${Math.round(x.transformed_pct_now)}% built` })),
        note: 'Sentinel-2 shows fields turning into AI data-centres. Every new campus needs tens of thousands of GPUs.' }; }
    case 'water': { const res = reservoirs(data);
      return { rows: (res?.sites || []).sort((a, b) => a.a - b.a).map(x => ({ label: shortRegion(x.r.name).replace(/\s*II$/, ''), value: `${pct(x.a, 0)} vs 5-yr avg` })),
        note: res?.low ? 'Chip fabs use huge amounts of water. Sentinel-2 sees Taiwan reservoirs well below normal, so drought cuts at the fabs are a risk → nudges prices up.'
          : 'Chip fabs use huge amounts of water. Reservoirs are at or above normal, so no drought risk → nudges prices slightly lower.' }; }
    case 'mkt': return { rows: g.parts.map(d => ({ label: String(d.name).replace(/\s*\(.*?\)/g, '').replace('EU gas / fertiliser proxy', 'Gas prices'), value: pct(contrib(d), 2) + ' pts' })), note: 'GPUs are priced in dollars: a weaker pound or pricier energy makes them dearer in UK shops.' };
    case 'other': return { rows: (g.groups || []).map(x => ({ label: x.label, value: gbpS(x.gbp) })), note: 'Drivers too small to matter on their own.' };
    default: return { rows: [], note: '' };
  }
}

// ---------------------------------------------------------------- AI campus before/after tile
function buildSites(data, item) {
  const regions = data.regions || [];
  const ai = item?.ai_era?.buildout_sites || [];
  const sites = regions.filter(r => ['datacenter', 'fab', 'built'].includes(r.signal) && r.series?.length);
  const growth = r => ai.find(s => s.region_id === r.region_id)?.growth_since_start_pts ?? r.anomaly?.built_frac_vs_5yr_pct ?? -99;
  const order = { datacenter: 0, fab: 1, built: 2 };
  return sites.sort((a, b) => (order[a.signal] - order[b.signal]) || growth(b) - growth(a)).slice(0, 4).map(r => {
    const clear = r.series.filter(s => s.thumb && (s.cloud_pct ?? 0) <= 5);
    const pool = clear.length >= 2 ? clear : r.series.filter(s => s.thumb);
    const site = ai.find(s => s.region_id === r.region_id);
    return { r, before: pool[0], after: pool[pool.length - 1], growth: site?.growth_since_start_pts ?? site?.growth_2y_pts ?? r.anomaly?.built_frac_vs_5yr_pct };
  }).filter(s => s.after);
}

export default function Gpu() {
  const { data, loading } = useAsync(() => loadModule('gpu'), []);
  const items = useMemo(() => (data?.items || []).filter(i => i?.history?.length || i?.forecast?.length), [data]);
  const [itemId, setItemId] = useState(null);

  if (loading) return <><ModuleHeader moduleId="gpu" /><div className="card skeleton" style={{ height: 500 }} /></>;
  if (!data) return <><ModuleHeader moduleId="gpu" /><div className="empty">No data for this module yet.</div></>;

  const cur = items.find(i => i.item_id === itemId) || items.find(i => i.item_id === 'gpu') || items[0];
  const hasDrivers = (cur?.drivers || []).some(d => isNum(contrib(d)));

  return (
    <>
      <ModuleHeader moduleId="gpu" data={data} />
      <section className="module-hero gpu-hero">
        <div className="card gpu-left gpu-in" key={cur?.item_id}>
          {hasDrivers ? <DriversHero data={data} item={cur} /> : <ReservoirHero data={data} />}
        </div>
        <div className="card gpu-fc gpu-in d1">
          {cur ? <FcCard data={data} item={cur} items={items} onPick={setItemId} /> : null}
        </div>
      </section>
      <SignalRow className="gpu-sig gpu-in d2" data={data} accent={ACC}
                 priceItem={items.find(i => i.item_id === 'gpu') || items[0]} earthMetric="ndwi" />
    </>
  );
}

/* ---------------- hero A: "price bridge" from today to 6 months out, in £ ---------------- */
function DriversHero({ data, item }) {
  const short = ITEM_META[item.item_id]?.short || item.name;
  const noun = short === 'GPU' ? 'GPU' : short.toLowerCase();
  const { history, forecast } = retailSeries(item);
  const now = item.retail_now ?? history.at(-1)?.price;
  const f6 = forecast[Math.min(5, forecast.length - 1)];
  // Cumulative £ from today (0) to the forecast, so each driver bar floats where it lands.
  const groups = useMemo(() => {
    const list = driverGroups(item, now, data);
    const starts = list.map((_, i) => list.slice(0, i).reduce((a, g) => a + g.gbp, 0));
    return list.map((g, i) => ({ ...g, a: starts[i], b: starts[i] + g.gbp }));
  }, [item, now, data]);
  const later = [item.retail_6m, f6?.p50].find(isNum) ?? now * (1 + (isNum(item.change_6m_pct) ? item.change_6m_pct : groups.reduce((a, g) => a + g.pts, 0)) / 100);
  const totalGbp = later - now, totalPct = (totalGbp / now) * 100;
  const when = f6?.month ? fmtMonth(f6.month) : 'six months';
  const sites = useMemo(() => buildSites(data, item), [data, item]);

  const dir = Math.abs(totalPct) < 1 ? 'flat' : totalPct > 0 ? 'up' : 'down';
  const cap = [`by ${when}`, isNum(item.prob_up_6m) && `${Math.round(item.prob_up_6m * 100)}% chance it rises`].filter(Boolean).join(' · ');

  const rows = groups;
  const lo = Math.min(0, ...rows.flatMap(r => [r.a, r.b]), totalGbp), hi = Math.max(0, ...rows.flatMap(r => [r.a, r.b]), totalGbp);
  const X = v => ((v - lo) / ((hi - lo) || 1)) * 100;
  const topI = rows.reduce((bi, r, i) => (r.gbp > (rows[bi]?.gbp ?? 0) ? i : bi), -1);

  const bridge = useRef(null);
  const tip = useRef(null);
  const [tipState, setTipState] = useState(null); // {html, x, y}
  const [glow, setGlow] = useState(false);
  const [site, setSite] = useState(0);

  useEffect(() => { const id = requestAnimationFrame(() => bridge.current?.classList.add('on')); return () => cancelAnimationFrame(id); }, []);

  useLayoutEffect(() => {
    if (!tipState || !tip.current) return;
    const el = tip.current, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.min(window.innerWidth - w - 8, tipState.x + 16) + 'px';
    el.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, tipState.y - h / 2)) + 'px';
  }, [tipState]);

  const rowTip = (r, e) => {
    const html = r
      ? tipHtml({
        title: r.label, tag: SRC[r.src].t,
        rows: [{ color: r.gbp < 0 ? DOWN : UP, label: 'Effect on price', value: `${gbpS(r.gbp)} (${pct(r.pts, 2)} pts)` }, ...evidence(r, item, data).rows.filter(Boolean)],
        note: evidence(r, item, data).note,
      })
      : tipHtml({
        title: `${short} forecast · ${when}`, tag: 'Total',
        rows: [{ label: 'Today', value: fmtGBP(now) }, { color: ACC, label: 'Expected', value: fmtGBP(later) },
          isNum(f6?.p10) && { label: 'Likely range', value: `${fmtGBP(f6.p10)} – ${fmtGBP(f6.p90)}` },
          isNum(item.prob_up_6m) && { label: 'Chance it rises', value: `${Math.round(item.prob_up_6m * 100)}%` }],
        note: 'The sum of all the drivers above.',
      });
    setTipState({ html, x: e.clientX, y: e.clientY });
    if (r?.k === 'build') setGlow(true);
  };
  const leave = () => { setTipState(null); setGlow(false); };

  const s = sites[site];

  return (
    <>
      <div className="card-head"><div className="card-title">What&apos;s driving {noun} prices</div></div>
      <div className="gd-verdict">
        <div className="gd-big">
          <span className="gd-now">{fmtGBP(now)}</span>
          <Icon name="arrow-right" size={22} strokeWidth={2.2} />
          <b>{fmtGBP(later)}</b>
          <span className={`gd-chg ${dir}`}>{pct(totalPct, 1)}</span>
        </div>
        <div className="gd-cap">{cap}</div>
      </div>
      <div className="gpu-body" style={!sites.length ? { gridTemplateColumns: '1fr' } : undefined}>
        <div className="gd-bridge" ref={bridge}>
          {rows.map((r, i) => (
            <div className="gd-row" key={r.k}
                 onMouseEnter={e => rowTip(r, e)}
                 onMouseMove={e => setTipState(t => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
                 onMouseLeave={leave}>
              <div className="gd-lab"><span className="gd-ic"><Icon name={r.ic} size={16} /></span><div><div className="gd-n" title={r.label}>{r.label}</div></div></div>
              <div className="gd-track">
                <i className="gd-zero" style={{ left: `${X(0)}%` }} />
                <i className="gd-end" style={{ left: `${X(totalGbp)}%` }} />
                <div className={`gd-bar ${r.gbp < 0 ? 'down' : i === topI ? 'up top' : 'up'}`}
                     style={{ left: `${X(Math.min(r.a, r.b))}%`, '--w': `${Math.max(0.6, X(Math.max(r.a, r.b)) - X(Math.min(r.a, r.b)))}%`, '--d': `${150 + i * 80}ms` }} />
              </div>
              <div className={`gd-v ${r.gbp < 0 ? 'down' : 'up'}`}>{gbpS(r.gbp)}</div>
            </div>
          ))}
          <div className="gd-row total"
               onMouseEnter={e => rowTip(null, e)}
               onMouseMove={e => setTipState(t => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
               onMouseLeave={leave}>
            <div className="gd-lab"><span className="gd-ic"><Icon name="equal" size={16} /></span><div><div className="gd-n">Forecast change</div></div></div>
            <div className="gd-track">
              <i className="gd-zero" style={{ left: `${X(0)}%` }} />
              <div className="gd-bar total" style={{ left: `${X(Math.min(0, totalGbp))}%`, '--w': `${Math.max(0.6, Math.abs(X(totalGbp) - X(0)))}%`, '--d': `${150 + rows.length * 80}ms` }} />
            </div>
            <div className="gd-v">{gbpS(totalGbp)}<small>{pct(totalPct, 1)}</small></div>
          </div>
        </div>
        <div className="gpu-tiles">
          {sites.length ? (<>
            <div className="gd-sat-h"><Icon name="satellite" size={13} strokeWidth={2} />Seen from space</div>
            <div className={`cmp-host${glow ? ' glow' : ''}`}>
              <CompareSite s={s} key={s?.r?.region_id} />
              <button className="gd-zoom" data-sat-region={s?.r?.region_id} data-sat-month={s?.after?.month}
                      title="Open full-size satellite view" onPointerDown={e => e.stopPropagation()}>
                <Icon name="maximize-2" size={13} strokeWidth={2} />Zoom
              </button>
            </div>
          </>) : null}
          {sites.length > 1 ? (
            <div className="gpu-dots">
              {sites.map((x, i) => (
                <button key={x.r.region_id} className={i === site ? 'on' : ''} title={shortRegion(x.r.name)} onClick={() => setSite(i)} />
              ))}
            </div>
          ) : null}
          <div className="build-pill">
            {isNum(s?.growth) ? (
              <span className="gpu-chip ind">
                <Icon name="building-2" size={13} />Built-up land {s.growth >= 0 ? '+' : ''}{s.growth.toFixed(0)} pts since {s.before?.month?.slice(0, 4) || ''}
              </span>
            ) : null}
          </div>
          <div className="gpu-cap">Sentinel-2 · drag to compare</div>
        </div>
      </div>
      {tipState ? <div className="gd-tip" ref={tip} dangerouslySetInnerHTML={{ __html: tipState.html }} /> : null}
    </>
  );
}

/** Before/after satellite slider for one AI campus. */
function CompareSite({ s }) {
  const box = useRef(null);
  const before = useRef(null);
  const handle = useRef(null);
  const drag = useRef(false);

  const setP = p => {
    if (!before.current) return;
    before.current.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
    handle.current.style.left = p + '%';
  };
  const set = x => { const r = box.current.getBoundingClientRect(); setP(Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100))); };

  // Gentle intro sweep so the before/after reads at a glance.
  useEffect(() => {
    if (!before.current) return undefined;
    let t = 0, raf = 0, timer = 0;
    const intro = () => {
      if (drag.current || !box.current?.isConnected) return;
      t += 0.02; setP(50 + 24 * Math.sin(t * Math.PI));
      if (t < 2) raf = requestAnimationFrame(intro);
    };
    timer = setTimeout(() => { raf = requestAnimationFrame(intro); }, 700);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [s]);

  if (!s) return null;
  const [head, loc] = String(s.r.name).split(',');
  const name = `${head.replace(/\s*\(.*?\)|\s+(AI\s+)?campus|\s+fabs?/gi, '').trim()}${loc ? ' · ' + loc.trim().replace(/\s+[A-Z]{2}$/, '') : ''}`;
  const hasBefore = s.before && s.before !== s.after;
  const hide = e => { e.currentTarget.style.visibility = 'hidden'; };

  return (
    <div className="compare gpu-cmp" ref={box} data-no-lightbox=""
         onPointerDown={e => { drag.current = true; box.current.setPointerCapture(e.pointerId); set(e.clientX); }}
         onPointerMove={e => drag.current && set(e.clientX)}
         onPointerUp={() => { drag.current = false; }}>
      <img src={`/${s.after.thumb}`} alt={`${name} ${s.after.month}`} onError={hide} />
      {hasBefore ? (<>
        <img className="before" ref={before} src={`/${s.before.thumb}`} alt={`${name} ${s.before.month}`}
             style={{ clipPath: 'inset(0 50% 0 0)' }} onError={hide} />
        <div className="handle" ref={handle} style={{ left: '50%' }}><div className="knob"><Icon name="chevrons-left-right" /></div></div>
        <span className="tag" style={{ left: 10 }}>{monShort(s.before.month)}</span>
      </>) : null}
      <span className="tag" style={{ right: 10 }}>{monShort(s.after.month)}</span>
      <span className="site">{name}</span>
    </div>
  );
}

/* ---------------- hero B (fallback): reservoir chart ---------------- */
function ReservoirHero({ data }) {
  const plot = useRef(null);
  const chartBox = useRef(null);
  const call = useRef(null);

  const model = useMemo(() => {
    const res = (data.regions || []).filter(r => r.signal === 'water' && r.series?.length);
    if (!res.length) return null;
    const anom = r => r.anomaly?.water_frac_vs_5yr_pct ?? r.anomaly?.ndwi_vs_5yr_pct ?? 0;
    res.sort((a, b) => anom(a) - anom(b));
    const [main, other] = res;
    const hasFrac = main.series.some(s => isNum(s.water_frac));
    const level = r => {
      const ok = r.series.filter(s => (s.cloud_pct ?? 0) <= 20);
      const mx = Math.max(...ok.map(s => s.water_frac).filter(isNum), 1e-6);
      return s => ((s.cloud_pct ?? 0) > 20 ? null : hasFrac && isNum(s.water_frac) ? Math.min(100, (s.water_frac / mx) * 100) : isNum(s.ndwi) ? Math.max(0, Math.min(100, (s.ndwi + 0.7) * 100)) : null);
    };
    const lvM = level(main), months = main.series.slice(-24).map(s => s.month);
    const byM = (r, f) => { const m = new Map(r.series.map(s => [s.month, f(s)])); return months.map(k => (isNum(m.get(k)) ? +m.get(k).toFixed(1) : null)); };
    const smooth = a => a.map((v, i) => { const w = a.slice(Math.max(0, i - 1), i + 2).filter(isNum).sort((x, y) => x - y); return isNum(v) && w.length ? w[w.length >> 1] : v; });
    const mainD = smooth(byM(main, lvM)), otherD = other ? smooth(byM(other, level(other))) : [];
    const allM = main.series.map(s => [s.month, lvM(s)]).filter(([, v]) => isNum(v));
    const avg5 = months.map(m => { const vs = allM.filter(([k]) => k.slice(5) === m.slice(5) && k < m && k >= `${+m.slice(0, 4) - 5}`).map(x => x[1]); return vs.length ? +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1) : null; });
    const lastI = mainD.map((v, i) => [v, i]).filter(([v]) => isNum(v)).pop()?.[1] ?? months.length - 1;
    const minI = mainD.reduce((bi, v, i) => (isNum(v) && (!isNum(mainD[bi]) || v < mainD[bi]) ? i : bi), 0);
    return {
      main, other, months, mainD, otherD, avg5, lastI, minI, lvM,
      now: mainD[lastI], base: avg5[lastI], name: shortRegion(main.name).replace(/\s*II$/, ''), a: anom(main),
      tile: main.series.filter(s => s.thumb && (s.cloud_pct ?? 0) <= 10).pop() || main.series.filter(s => s.thumb).pop(),
    };
  }, [data]);

  useEffect(() => {
    if (!model) return undefined;
    const { months, mainD, otherD, avg5, other, name, lastI, minI, main, lvM } = model;
    const chart = initChart(chartBox.current);
    const endData = mainD.map((v, i) => (i === lastI ? v : null));
    chart.setOption({
      tooltip: axisTooltip(ps => { const i = ps[0]?.dataIndex ?? 0; return tipHtml({ title: fmtMonth(months[i]), rows: [
        isNum(mainD[i]) && { color: ACC, label: name, value: `${Math.round(mainD[i])}% full` },
        other && isNum(otherD[i]) && { color: '#94A3B8', label: shortRegion(other.name).replace(/\s*II$/, ''), value: `${Math.round(otherD[i])}% full` },
        isNum(avg5[i]) && { color: '#A8A29E', dashed: true, label: '5-yr average', value: `${Math.round(avg5[i])}%` }] }); }),
      grid: { left: 40, right: 8, top: 10, bottom: 26 },
      xAxis: { type: 'category', data: months, boundaryGap: false, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#A8A29E', fontSize: 11, interval: i => i === 0 || i === months.length - 1 || i === 12, formatter: monShort } },
      yAxis: { type: 'value', min: 0, max: 100, interval: 25, axisLabel: { color: '#A8A29E', fontSize: 11, formatter: '{value}%' }, splitLine: { lineStyle: { color: '#F1F0EE' } } },
      series: [
        { type: 'line', data: avg5, symbol: 'none', connectNulls: true, lineStyle: { type: [5, 4], color: '#A8A29E', width: 1.5 }, z: 1 },
        ...(other ? [{ type: 'line', data: otherD, symbol: 'none', connectNulls: true, lineStyle: { color: '#94A3B8', width: 2 }, z: 2 }] : []),
        { type: 'line', data: mainD, symbol: 'none', connectNulls: true, lineStyle: { color: ACC, width: 2.5 }, z: 3, animationDuration: 900,
          areaStyle: { color: new graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(99,102,241,.16)' }, { offset: 1, color: 'rgba(99,102,241,0)' }]) } },
        { type: 'scatter', data: endData, symbolSize: 9, itemStyle: { color: ACC, borderColor: '#fff', borderWidth: 2 }, z: 5 },
      ],
    });
    const place = () => {
      const v = mainD[minI]; if (!isNum(v) || !call.current) return;
      const earlier = main.series.filter(s => s.month < months[minI]).map(lvM).filter(isNum);
      const sinceY = earlier.length && Math.min(...earlier) > v ? main.series[0].month.slice(0, 4) : null;
      call.current.innerHTML = `<div class="t">${name} · ${monthLabel(months[minI], true)}</div><div class="v"><b>${Math.round(v)}%</b>${sinceY ? `<span class="delta up">lowest since ${sinceY}</span>` : ''}</div>`;
      const [x, y] = chart.convertToPixel({ seriesIndex: other ? 2 : 1 }, [minI, v]);
      const W = plot.current.clientWidth, H = plot.current.clientHeight, w = call.current.offsetWidth || 170, h = call.current.offsetHeight || 60;
      call.current.style.left = Math.max(0, Math.min(W - w, x - w / 2)) + 'px';
      call.current.style.top = Math.max(0, Math.min(H - h, y + 16)) + 'px';
    };
    const tmr = setTimeout(() => { place(); call.current?.classList.add('on'); }, 1000);
    const off = onResize(plot.current, () => { chart.resize(); place(); });
    return () => { clearTimeout(tmr); off(); chart.dispose(); };
  }, [model]);

  if (!model) return <div className="empty">Reservoir data is still building.</div>;
  const { now, base, name, a, tile, other } = model;

  return (
    <>
      <div className="card-head">
        <div><div className="card-title">Water for the fabs</div><div className="card-sub">Reservoir level, % of capacity · 24 months</div></div>
        {isNum(now) ? (
          <div className="gpu-stat">
            <div className="row">
              <CountUp as="b" to={now} suffix="%" placeholder={`${Math.round(now)}%`} />
              {isNum(base) ? (
                <span className={`gpu-chip ${now < base ? 'up' : 'down'}`}>{now - base >= 0 ? '+' : '−'}{Math.abs(Math.round(now - base))} pts vs 5-yr</span>
              ) : null}
            </div>
            <div className="s">{name} today{isNum(base) ? ` · 5-yr avg ${Math.round(base)}%` : ''}</div>
          </div>
        ) : null}
      </div>
      <div className="gpu-body">
        <div className="gpu-plot" ref={plot}><div className="chart" ref={chartBox} /><div className="fc-callout" ref={call} /></div>
        <div className="gpu-tiles">
          {tile ? (
            <div className="tile-box">
              <img className="sat-img" src={`/${tile.thumb}`} alt={name} onError={e => { e.currentTarget.style.visibility = 'hidden'; }} />
              <span className="site">{name} · {monthLabel(tile.month, true)}</span>
            </div>
          ) : null}
          <div className="gpu-legend">
            <span><i style={{ borderColor: ACC }} />{name}</span>
            {other ? <span><i style={{ borderColor: '#94A3B8' }} />{shortRegion(other.name).replace(/\s*II$/, '')}</span> : null}
            <span><i className="dash" />5-yr average</span>
          </div>
          {isNum(a) ? <span className={`gpu-chip ${a < 0 ? 'up' : 'down'}`}><Icon name="droplets" />Water area {pct(a, 0)} vs 5-yr</span> : null}
        </div>
      </div>
    </>
  );
}

/** Product packshot for the forecast card: <img> with a lucide sibling fallback (matches .gpu-prod's CSS). */
function ProdImg({ id }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <div className="ph"><ItemIcon id={id} size={20} /></div>
    : <img src={`/static/assets/products/${id}.jpg`} alt="" onError={() => setFailed(true)} />;
}

/* ---------------- right: GPU | Laptop forecast card ---------------- */
function FcCard({ data, item, items, onPick }) {
  const short = ITEM_META[item.item_id]?.short || item.name;
  const { history, forecast } = retailSeries(item);
  const now = item.retail_now ?? history.at(-1)?.price;
  const f6 = forecast[Math.min(5, forecast.length - 1)]?.p50;
  const later = item.retail_6m ?? f6;
  const aiG = isNum(now) ? driverGroups(item, now, data).filter(g => g.ai) : [];
  const aiSum = aiG.reduce((a, g) => a + g.gbp, 0);
  const water = (data.regions || []).filter(r => r.signal === 'water').map(r => r.anomaly?.ndwi_vs_5yr_pct).filter(isNum);
  const stat2 = aiG.length ? { v: gbpS(aiSum), l: 'from AI signals', cls: aiSum >= 0 ? 'up' : 'down' }
    : water.length ? { v: pct(Math.min(...water), 0), l: 'reservoir vs 5-yr', cls: Math.min(...water) < 0 ? 'up' : 'down' } : null;

  // Headroom above the line so the callout can sit top-left of the end point without covering the curve.
  const vals = [...history.slice(-18).map(p => p.price), ...forecast.slice(0, 6).map(p => p.p50)].filter(isNum);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || hi * 0.05 || 1;
  const raw = span * 1.8 / 5, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw);

  return (
    <>
      {items.length > 1 ? (
        <ToggleGroup type="single" className="seg" style={{ alignSelf: 'flex-start' }} value={item.item_id} onValueChange={v => v && onPick(v)}>
          {items.map(i => (
            <ToggleGroupItem key={i.item_id} value={i.item_id} className={i === item ? 'on' : undefined}>
              {ITEM_META[i.item_id]?.short || i.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      <div className="gpu-prod">
        <ProdImg id={item.item_id} />
        <div><div className="n">{PRODUCT[item.item_id] || item.name}</div><div className="m">London retail · in 6 months</div></div>
      </div>
      <div className="hero-price">
        <CountUp as="b" to={later} prefix="£" placeholder={fmtGBP(later)} />
        {isNum(now) ? <span>from {fmtGBP(now)} today</span> : null}
      </div>
      <ForecastChart
        className="fc-host"
        history={history}
        forecast={forecast.slice(0, 6)}
        accent={ACC}
        unit={item.unit || '£'}
        calloutTitle={short}
        months={18}
        calloutIndex={5}
        yMin={Math.max(0, Math.floor((lo - span * 0.08) / step) * step)}
        yMax={Math.ceil((hi + span * 0.7) / step) * step}
      />
      <div className="stat-strip">
        {isNum(item.prob_up_6m) ? (
          <div><CountUp as="div" className="v" to={item.prob_up_6m * 100} suffix="%" placeholder={`${Math.round(item.prob_up_6m * 100)}%`} /><div className="l">chance it rises</div></div>
        ) : null}
        {stat2 ? <div><div className={`v ${stat2.cls}`}>{stat2.v}</div><div className="l">{stat2.l}</div></div> : null}
      </div>
    </>
  );
}
