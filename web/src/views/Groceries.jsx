// Groceries — Shop (MODULES.md 06b): Amazon-style product grid, Keepa-style detail, weekly basket.
// Renders only real /api/modules/groceries data; hides widgets without data.
// Ported from vanilla js/views/groceries.js.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Topbar, IconSquare, BacktestBadge } from '@/components/orbit/chrome.jsx';
import { Photo, SatImg } from '@/components/orbit/bits.jsx';
import { ForecastChart } from '@/components/orbit/charts.jsx';
import { Icon, ModuleIcon } from '@/lib/icons.jsx';
import { loadModule, useAsync } from '@/lib/api.js';
import { ACCENT } from '@/lib/meta.js';
import { arrowIconName, isNum, retailSeries, shortRegion } from '@/lib/format.js';
import { countUp } from '@/lib/dom.jsx';
import { fmtMonth, fmtPct, tipHtml } from '@/lib/chartTheme.js';

const ACC = ACCENT.groceries;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mon = m => MON[+m.split('-')[1] - 1];
const monY = m => `${mon(m)} ${m.slice(0, 4)}`;
const gbp = v => (isNum(v) ? '£' + v.toFixed(2) : '–');
const DEFAULT_QTY = { chocolate: 2, olive_oil: 1, orange_juice: 2, bread: 1 };
const QTY_KEY = 'orbit.groceries.qty';
const REC = {
  stock: { label: 'Stock up now', cls: 'stock' },
  wait: { label: 'Wait', cls: 'wait' },
  hold: { label: 'Hold', cls: 'hold' },
};

function loadQty() {
  try { return { ...DEFAULT_QTY, ...JSON.parse(localStorage.getItem(QTY_KEY) || '{}') }; } catch { return { ...DEFAULT_QTY }; }
}
function saveQty(q) { try { localStorage.setItem(QTY_KEY, JSON.stringify(q)); } catch { /* ignore */ } }

/** "Chocolate bar (100g)" → {name:"Chocolate bar", size:"100 g"} */
function splitName(n) {
  const m = String(n || '').match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (!m) return { name: n, size: '' };
  return { name: m[1], size: m[2].replace(/(\d)([a-zA-Z])/, '$1 $2') };
}
function recOf(it) {
  if (!isNum(it.chg)) return null;
  if (isNum(it.prob) && it.prob >= 0.6 && it.chg >= 2) return 'stock';
  if (it.chg <= -2) return 'wait';
  return isNum(it.prob) ? 'hold' : null;
}
const pillCls = v => (v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat');

/** Best recent satellite month for a region: latest with a thumb and cloud ≤ 60 %, else latest thumb. */
function bestMonth(r) {
  const s = (r?.series || []).filter(p => p?.thumb && p.month);
  const clear = s.filter(p => !isNum(p.cloud_pct) || p.cloud_pct <= 60);
  return (clear.at(-1) || s.at(-1))?.month || null;
}
function regionLabel(r) {
  const parts = String(r.name || '').split(',');
  const country = parts.length > 1 ? parts.at(-1).trim() : '';
  return shortRegion(r) + (country ? `, ${country}` : '');
}
/** Sparkline points: last 12 months of shelf price + 6 forecast months (p50, with p10/p90). */
function sparkPts(it) {
  return [
    ...it.hist.slice(-12).filter(p => isNum(p.price)).map(p => ({ month: p.month, v: p.price })),
    ...it.fc.slice(0, 6).filter(p => isNum(p.p50)).map(p => ({ month: p.month, v: p.p50, lo: p.p10, hi: p.p90, fc: true })),
  ];
}
const SW = 160, SH = 30;
const sx = (i, n) => i / (n - 1) * (SW - 4) + 2;
const pUp = h => { const p = h?.supply_effect?.probs || {}; return (p.strongly_up || 0) + (p.up || 0); };
const pDown = h => { const p = h?.supply_effect?.probs || {}; return (p.strongly_down || 0) + (p.down || 0); };

/** Normalise items with everything the widgets need. */
function buildItems(data) {
  const regions = data.regions || [];
  const judg = data.signals?.region_judgments || [];
  const heads = data.signals?.headlines || [];
  return (data.items || []).map(raw => {
    const { history: hist, forecast: fc } = retailSeries(raw);
    const now = isNum(raw.retail_now) ? raw.retail_now : hist.at(-1)?.price;
    const p6 = isNum(raw.retail_6m) ? raw.retail_6m : fc[5]?.p50 ?? fc.at(-1)?.p50;
    const chg = isNum(raw.change_6m_pct) ? raw.change_6m_pct : (isNum(now) && isNum(p6) ? (p6 / now - 1) * 100 : null);
    const region = regions.find(r => (r.item || r.item_id) === raw.item_id && bestMonth(r)) || regions.find(r => (r.item || r.item_id) === raw.item_id);
    const j = region && judg.find(x => x.region_id === region.region_id);
    const seen = new Set();
    const hl = heads.filter(h => h.item_id === raw.item_id && h.title && !seen.has(h.title) && seen.add(h.title))
      .sort((a, b) => Math.max(pUp(b), pDown(b)) - Math.max(pUp(a), pDown(a)) || pUp(b) - pUp(a)).slice(0, 3);
    const it = {
      id: raw.item_id, raw, ...splitName(raw.name), hist, fc, now, p6, chg, prob: raw.prob_up_6m,
      region, month: region ? bestMonth(region) : null, judg: j, hl,
      nHl: heads.filter(h => h.item_id === raw.item_id).length,
    };
    it.rec = recOf(it);
    it.spark = sparkPts(it);
    return it;
  });
}

const Arrow = ({ v, size = 12 }) => <Icon name={arrowIconName(v)} size={size} strokeWidth={2.25} />;
const GsPill = ({ v }) => (isNum(v) ? <span className={`gs-pill ${pillCls(v)}`}><Arrow v={v} />{Math.abs(v).toFixed(1)}%</span> : null);

export default function Groceries() {
  const { data, loading } = useAsync(() => loadModule('groceries'), []);
  const items = useMemo(() => (data?.items?.length ? buildItems(data) : []), [data]);

  const head = <Topbar
    crumb="Modules  /  Groceries  /  Shop"
    title="Groceries"
    iconSquare={<IconSquare color={ACC} large style={{ background: `${ACC}1A` }}><ModuleIcon id="groceries" size={22} /></IconSquare>}
    right={data ? <BacktestBadge data={data} /> : null}
  />;

  if (loading) return <>{head}<div className="card skeleton" style={{ height: 600 }} /></>;
  if (!items.length) return <>{head}<div className="empty">No groceries data yet.</div></>;
  return <>{head}<Shop items={items} data={data} /></>;
}

function Shop({ items, data }) {
  const [qty, setQty] = useState(loadQty);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('rise');
  const [sel, setSel] = useState(() => [...items].sort((a, b) => (b.chg ?? -99) - (a.chg ?? -99))[0]?.id);
  const [range, setRange] = useState(12);
  const [detailOpen, setDetailOpen] = useState(true);
  const [fade, setFade] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [tip, setTip] = useState(null); // {html, x, y}
  const tipEl = useRef(null);

  useEffect(() => { saveQty(qty); }, [qty]);

  useLayoutEffect(() => {
    if (!tip || !tipEl.current) return;
    const el = tipEl.current;
    const w = el.offsetWidth, h = el.offsetHeight;
    let l = tip.x + 14, t = tip.y - h - 12;
    if (l + w > window.innerWidth - 8) l = tip.x - w - 14;
    if (t < 8) t = tip.y + 16;
    el.style.left = l + 'px'; el.style.top = t + 'px';
  }, [tip]);

  const cnt = {
    all: items.length,
    rising: items.filter(i => i.chg > 0).length,
    falling: items.filter(i => i.chg < 0).length,
    staples: items.length,
  };
  const keyF = { rise: i => -(i.chg ?? -99), drop: i => i.chg ?? 99, prob: i => -(i.prob ?? 0), price: i => i.now ?? 0 }[sort];
  const show = { all: () => true, staples: () => true, rising: i => i.chg > 0, falling: i => i.chg < 0 }[filter];
  const ordered = [...items].sort((a, b) => keyF(a) - keyF(b));
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const selItem = byId[sel];

  const pick = id => {
    if (!detailOpen) { setSel(id); setDetailOpen(true); return; }
    setFade(true);
    setTimeout(() => { setSel(id); setFade(false); }, 150);
  };

  return (
    <div className="gs">
      <div className="gs-shop">
        <div className="gs-filter">
          <div className="gs-chips">
            {[['all', 'All'], ['rising', 'Rising'], ['falling', 'Falling'], ['staples', 'Staples']].map(([k, l]) => (
              <button key={k} className={`gs-chip${k === filter ? ' on' : ''}`} disabled={!cnt[k]} onClick={() => setFilter(k)}>
                {l}<span>{cnt[k]}</span>
              </button>
            ))}
          </div>
          <label className="gs-sort">
            Sort by
            <select value={sort} onChange={e => setSort(e.target.value)}>
              <option value="rise">Biggest 6-mo rise</option>
              <option value="drop">Biggest 6-mo drop</option>
              <option value="prob">Most likely to rise</option>
              <option value="price">Price: low to high</option>
            </select>
            <Icon name="chevron-down" />
          </label>
        </div>
        <div className="gs-grid" onMouseLeave={() => setTip(null)}>
          {ordered.map(it => (
            <ProductCard
              key={it.id}
              it={it}
              index={items.indexOf(it)}
              hidden={!show(it)}
              selected={it.id === sel && detailOpen}
              onPick={() => pick(it.id)}
              onTip={setTip}
            />
          ))}
        </div>
        <section
          className={`card gs-detail${fade ? ' fade' : ''}${hovering ? ' hovering' : ''}`}
          hidden={!detailOpen || !selItem}
          onMouseOver={e => { if (e.target.closest('.gs-chartwrap')) setHovering(true); }}
          onMouseOut={e => { if (!e.relatedTarget?.closest?.('.gs-chartwrap')) setHovering(false); }}
        >
          {selItem ? (
            <Detail it={selItem} data={data} range={range} onRange={setRange} onClose={() => setDetailOpen(false)} />
          ) : null}
        </section>
      </div>
      <Cart items={items} qty={qty} setQty={setQty} onTip={setTip} />
      {/* portal: animated (transformed) ancestors would re-anchor the fixed tooltip */}
      {tip ? createPortal(<div className="gs-tip" ref={tipEl} dangerouslySetInnerHTML={{ __html: tip.html }} />, document.body) : null}
    </div>
  );
}

/* ---------- product card ---------- */
function ProductCard({ it, index, hidden, selected, onPick, onTip }) {
  const rec = it.rec && REC[it.rec];
  const wrap = useRef(null);
  const line = useRef(null);
  const dot = useRef(null);
  const [hov, setHov] = useState(false);

  const onMove = e => {
    const pts = it.spark || [];
    if (!pts.length || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width;
    let i = 0; pts.forEach((p, j) => { if (Math.abs(p.x - fx) < Math.abs(pts[i].x - fx)) i = j; });
    const p = pts[i];
    setHov(true);
    line.current.hidden = dot.current.hidden = false;
    line.current.style.left = dot.current.style.left = (p.x * 100) + '%';
    dot.current.style.top = (p.y * 100) + '%';
    const vs = isNum(it.now) ? (p.v / it.now - 1) * 100 : null;
    const isNow = !p.fc && i === pts.findIndex(q => q.fc) - 1;
    onTip({
      x: e.clientX, y: e.clientY,
      html: tipHtml({
        title: fmtMonth(p.month), tag: p.fc ? 'Forecast' : isNow ? 'Today' : '',
        rows: [
          { color: p.fc ? ACC : '#334155', dashed: p.fc, label: p.fc ? 'Expected price' : 'Shelf price', value: gbp(p.v) },
          p.fc && isNum(p.lo) && isNum(p.hi) ? { label: 'Likely range', value: `${gbp(p.lo)} – ${gbp(p.hi)}` } : null,
          !isNow && isNum(vs) ? { label: 'vs today', value: fmtPct(vs) } : null,
        ],
      }),
    });
  };
  const leave = () => {
    setHov(false);
    onTip(null);
    if (line.current) line.current.hidden = dot.current.hidden = true;
  };

  return (
    <button
      className={`gs-card${selected ? ' sel' : ''}`}
      hidden={hidden}
      style={{ animationDelay: `${index * 40}ms` }}
      onClick={e => { if (e.target.closest('[data-sat-region]')) return; onPick(); }}
    >
      <div className="gs-photo"><Photo id={it.id} wrapClass="gs-pic" fallbackClass="gs-noimg" /></div>
      {rec ? <span className={`gs-badge ${rec.cls}`}><i />{rec.label}</span> : null}
      <div className="gs-info">
        {it.region ? (
          <div className="gs-origin">
            <SatImg regionId={it.region.region_id} month={it.month} alt={it.region.name} />
            {regionLabel(it.region)}
          </div>
        ) : null}
        <div className="gs-name">{it.name}{it.size ? <small>{it.size}</small> : null}</div>
        <div className="gs-price">{gbp(it.now)}</div>
        {isNum(it.p6) ? <div className="gs-then"><span>in 6 months {gbp(it.p6)}</span><GsPill v={it.chg} /></div> : null}
        <Spark it={it} wrapRef={wrap} lineRef={line} dotRef={dot} hov={hov} onMove={onMove} onLeave={leave} />
      </div>
    </button>
  );
}

function Spark({ it, wrapRef, lineRef, dotRef, hov, onMove, onLeave }) {
  const pts = it.spark;
  if (pts.length < 3) return null;
  const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v)), sp = hi - lo || 1;
  const xy = pts.map((p, i) => [sx(i, pts.length), SH - 4 - (p.v - lo) / sp * (SH - 8)]);
  pts.forEach((p, i) => { p.x = xy[i][0] / SW; p.y = xy[i][1] / SH; });
  const k = pts.findIndex(p => p.fc), nH = k < 0 ? pts.length : k;
  const path = a => a.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const col = isNum(it.chg) && it.chg < 0 ? 'var(--down)' : ACC;
  const hPath = path(xy.slice(0, nH)), fPath = k > 0 ? path(xy.slice(nH - 1)) : '';

  return (
    <div className={`gs-sparkw${hov ? ' hov' : ''}`} ref={wrapRef} onMouseMove={onMove} onMouseLeave={onLeave}>
      <svg className="gs-spark" viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none">
        <path d={hPath} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {fPath ? <path className="fc" d={fPath} fill="none" stroke={col} strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {k > 0 ? <i className="gs-snow" style={{ left: `${(xy[nH - 1][0] / SW * 100).toFixed(2)}%` }} /> : null}
      <i className="gs-sline" ref={lineRef} hidden />
      <i className="gs-sdot" ref={dotRef} hidden style={{ '--c': col }} />
    </div>
  );
}

/* ---------- detail ---------- */
function Detail({ it, data, range, onRange, onClose }) {
  const ev = useRef(null);
  const call = useRef(null);
  const hShown = it.hist.slice(-range), last = it.fc.slice(0, 6).at(-1)?.month;
  const f6 = it.fc.slice(0, 6), hv = it.hist.slice(-range);

  const bounds = useMemo(() => {
    const vals = [...hv.map(p => p.price), ...f6.flatMap(p => [p.p10, p.p50, p.p90])].filter(isNum);
    if (!vals.length) return null;
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || hi * 0.05 || 1;
    const raw = (span * 1.3) / 5, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw);
    return { step, yMin: Math.max(0, Math.floor((lo - span * 0.08) / step) * step), yMax: Math.ceil((hi + span * 0.2) / step) * step };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it.id, range]);

  // Drop headlines that would overflow the evidence column.
  useEffect(() => {
    const el = ev.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      while (el.scrollHeight > el.clientHeight + 1 && el.querySelectorAll('.gs-hl').length > 1) [...el.querySelectorAll('.gs-hl')].pop().remove();
    });
    return () => cancelAnimationFrame(id);
  }, [it.id, range]);

  // Restart the callout reveal whenever the item or range changes.
  useEffect(() => {
    const el = call.current;
    if (!el) return;
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  }, [it.id, range]);

  const f = f6.at(-1);
  const d = f && isNum(it.now) ? (f.p50 / it.now - 1) * 100 : null;
  const hasEv = !!(it.region || it.hl.length);

  return (
    <>
      <div className="gs-dhead">
        <Photo id={it.id} wrapClass="gs-pic gs-dthumb" fallbackClass="gs-noimg" />
        <div>
          <div className="gs-dtitle">{it.name}{it.size ? ` · ${it.size}` : ''}</div>
          <div className="gs-dsub">
            Price history &amp; {(it.raw.model || 'TimesFM').split('+')[0].trim()} forecast
            {hShown[0] && last ? ` · ${monY(hShown[0].month)} – ${monY(last)}` : ''}
          </div>
        </div>
        <div className="gs-seg">
          {[12, 36, 60].map(m => (
            <button key={m} className={m === range ? 'on' : ''} onClick={() => onRange(m)}>{m / 12}Y</button>
          ))}
        </div>
        <button className="gs-x" title="Close" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      <div className={`gs-dbody${hasEv ? '' : ' solo'}`}>
        {hv.length || f6.length ? (
          <div className="gs-chartwrap">
            <ForecastChart
              className="fc gs-chart"
              history={it.hist}
              forecast={f6}
              accent={ACC}
              unit="£"
              band
              months={range}
              showCallout={false}
              yMin={bounds?.yMin}
              yMax={bounds?.yMax}
              afterUpdate={api => api.chart?.setOption({ series: [{ step: 'end' }], yAxis: { interval: bounds?.step } })}
            />
            <div className="gs-call" ref={call} hidden={!f || !isNum(it.now)}>
              {f && isNum(it.now) ? (<>
                <div className="t">{it.name} · {monY(f.month)}</div>
                <div className="v"><b>{gbp(f.p50)}</b><span className={`delta ${pillCls(d)}`}><Arrow v={d} size={13} />{Math.abs(d).toFixed(1)}%</span></div>
                {isNum(f.p10) && isNum(f.p90) ? (
                  <div className="l3">likely {gbp(f.p10)} – {gbp(f.p90)}{isNum(it.prob) ? ` · ${Math.round(it.prob * 100)}% chance it rises` : ''}</div>
                ) : null}
              </>) : null}
            </div>
          </div>
        ) : null}
        {hasEv ? <Evidence it={it} data={data} evRef={ev} /> : null}
      </div>
    </>
  );
}

function Evidence({ it, data, evRef }) {
  const r = it.region;
  const ndvi = r?.anomaly?.ndvi_vs_5yr_pct;
  const p = it.judg?.harvest_risk?.probs;
  const risk = p ? (p.high || 0) + (p.severe || 0) : null;
  return (
    <div className="gs-ev" ref={evRef}>
      {r ? (
        <div className="gs-farm">
          <SatImg regionId={r.region_id} month={it.month} alt={r.name} />
          <div style={{ minWidth: 0 }}>
            <div className="gs-eyebrow">Sentinel-2 · {it.month ? monY(it.month) : ''}</div>
            <div className="gs-farm-name">{regionLabel(r)}</div>
            <div className="gs-stats">
              {isNum(ndvi) ? (
                <div><b style={{ color: ndvi < 0 ? '#EA580C' : 'var(--down)' }}>{ndvi > 0 ? '+' : ndvi < 0 ? '−' : ''}{Math.abs(ndvi).toFixed(0)}%</b><span>Crop health</span></div>
              ) : null}
              {isNum(risk) ? <div><b>{Math.round(risk * 100)}%</b><span>Harvest risk</span></div> : null}
            </div>
          </div>
        </div>
      ) : null}
      {it.hl.length ? (<>
        <div className="gs-why">
          <b>Why it moves</b>
          <span>Jev · {(it.nHl || data.signals?.n_judgments || 0).toLocaleString('en-GB')} headlines judged</span>
        </div>
        {it.hl.map((h, i) => {
          const up = pUp(h), dn = pDown(h), isUp = up >= dn;
          const dt = h.date ? `${mon(h.date.slice(0, 7))} ${h.date.slice(0, 4)}` : '';
          return (
            <a className="gs-hl" key={i} href={h.url || '#'} target="_blank" rel="noopener noreferrer">
              <div style={{ minWidth: 0 }}>
                <div className="t">{h.title}</div>
                <div className="s">{h.source || ''}{dt ? ` · ${dt}` : ''}</div>
              </div>
              <div className="p">
                <b className={isUp ? 'up' : 'down'}><Arrow v={isUp ? 1 : -1} />{Math.min(99, Math.round((isUp ? up : dn) * 100))}%</b>
                <span>chance price {isUp ? 'rises' : 'falls'}</span>
              </div>
            </a>
          );
        })}
      </>) : null}
    </div>
  );
}

/* ---------- weekly basket ---------- */
function Cart({ items, qty, setQty, onTip }) {
  const t0Ref = useRef(null), t6Ref = useRef(null);
  const first = useRef(true);
  const [hovBar, setHovBar] = useState(null);

  // Months: today (last history) + next 6 forecast months, only if every item has them.
  const months = useMemo(() => {
    const base = items[0];
    const ms = [base.hist.at(-1)?.month, ...base.fc.slice(0, 6).map(p => p.month)].filter(Boolean);
    return items.every(i => i.hist.length && i.fc.length >= 6) ? ms : [];
  }, [items]);
  const priceAt = (it, k) => (k === 0 ? it.now : it.fc[k - 1]?.p50);

  const n = items.reduce((s, i) => s + (qty[i.id] || 0), 0);
  const t0 = items.reduce((s, it) => s + (qty[it.id] || 0) * (it.now || 0), 0);
  const t6 = items.reduce((s, it) => s + (qty[it.id] || 0) * (it.p6 ?? it.now ?? 0), 0);
  const barTot = months.length && n ? months.map((_, k) => items.reduce((s, it) => s + (qty[it.id] || 0) * (priceAt(it, k) || 0), 0)) : [];

  useEffect(() => {
    const dur = first.current ? 900 : 400;
    countUp(t0Ref.current, t0, { digits: 2, prefix: '£', dur });
    countUp(t6Ref.current, t6, { digits: 2, prefix: '£', dur });
    first.current = false;
  }, [t0, t6]);

  const [barsIn, setBarsIn] = useState(false);
  useEffect(() => { const t = setTimeout(() => setBarsIn(true), 40); return () => clearTimeout(t); }, []);

  const stock = items.filter(i => i.rec === 'stock' && qty[i.id] > 0);
  const wait = items.filter(i => i.rec === 'wait' && qty[i.id] > 0);
  const save = stock.reduce((s, i) => s + qty[i.id] * ((i.p6 ?? i.now) - i.now), 0);
  const names = l => l.map(i => i.name.split(' ')[0].toLowerCase()).join(' + ');

  const step = (id, d) => setQty(q => ({ ...q, [id]: Math.max(0, Math.min(20, (q[id] || 0) + d)) }));

  const lo = barTot.length ? Math.min(...barTot) : 0, hi = barTot.length ? Math.max(...barTot) : 1;
  const span = hi - lo || hi * 0.02 || 1, floor = lo - span * 1.2, peak = barTot.indexOf(hi);

  return (
    <aside className="card gs-cart">
      <div className="gs-chead">
        <div><h2>Your weekly basket</h2><div className="sub">{n} item{n === 1 ? '' : 's'} · prices in 6 months</div></div>
        <div className="gs-cicon"><Icon name="shopping-basket" size={18} /></div>
      </div>
      <div className="gs-rows">
        {items.map(it => {
          const q = qty[it.id] || 0;
          const a = q * (it.now || 0), b = q * (it.p6 ?? it.now ?? 0);
          const c = pillCls(b - a > 0.004 ? 1 : b - a < -0.004 ? -1 : 0);
          return (
            <div className="gs-row" key={it.id}>
              <Photo id={it.id} wrapClass="gs-pic" fallbackClass="gs-noimg" />
              <div style={{ minWidth: 0 }}>
                <div className="nm">{it.name}</div>
                <div className="gs-step">
                  <button aria-label="Less" onClick={() => step(it.id, -1)}><Icon name="minus" size={12} strokeWidth={2.25} /></button>
                  <span className="q">{q}</span>
                  <button aria-label="More" onClick={() => step(it.id, 1)}><Icon name="plus" size={12} strokeWidth={2.25} /></button>
                </div>
              </div>
              <div className="amt"><b className="now">{gbp(a)}</b><span className={`then ${c}`}>{isNum(it.p6) ? `→ ${gbp(b)}` : ''}</span></div>
            </div>
          );
        })}
      </div>
      <div className="gs-bars-wrap" hidden={!months.length || !n}>
        <div className="gs-bars-head"><b>Basket cost by month</b><span>£ · TimesFM p50</span></div>
        <div className="gs-bars" onMouseLeave={() => { setHovBar(null); onTip(null); }}>
          {barTot.map((v, k) => {
            const hPct = 18 + 82 * (v - floor) / (hi - floor || 1);
            return (
              <div
                className={`gs-bar${hovBar === k ? ' hov' : ''}`}
                key={k}
                onMouseMove={e => {
                  setHovBar(k);
                  const lines = items.filter(it => (qty[it.id] || 0) > 0).map(it => ({ label: `${qty[it.id]} × ${it.name}`, value: gbp(qty[it.id] * (priceAt(it, k) || 0)) }));
                  onTip({
                    x: e.clientX, y: e.clientY,
                    html: tipHtml({
                      title: fmtMonth(months[k]), tag: k === 0 ? 'Today' : 'Forecast',
                      rows: [{ color: k === 0 ? '#334155' : ACC, label: 'Basket total', value: gbp(v) }, ...lines,
                        k > 0 && isNum(barTot[0]) ? { label: 'vs today', value: `${v - barTot[0] >= 0 ? '+' : '−'}${gbp(Math.abs(v - barTot[0]))}` } : null],
                      note: k > 0 ? 'TimesFM median (p50) forecast' : '',
                    }),
                  });
                }}
              >
                <span className={`v${k === 0 || k === peak ? ' hi' : ''}`}>{v.toFixed(2)}</span>
                <i className={k === 0 ? 'now' : k === peak ? 'peak' : ''}
                   style={{ height: barsIn ? `${hPct}%` : 0, transitionDelay: `${k * 40}ms` }} />
                <span className="m">{mon(months[k])}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="gs-tot">
        <div>Total today<b className="t0" ref={t0Ref}>£0.00</b></div>
        <div>Same basket in 6 months<b className="t6" ref={t6Ref}>£0.00</b></div>
      </div>
      <div className="gs-save" hidden={!stock.length}>
        {stock.length ? (<>
          <div className="r"><span>Stock up on {stock.length} item{stock.length > 1 ? 's' : ''} now</span><b>Save {gbp(save)}</b></div>
          <div className="l">Buy {names(stock)} today{wait.length ? `, wait on ${names(wait)}` : ''}</div>
        </>) : null}
      </div>
      <button className="gs-buy" hidden={!stock.length}
              onClick={() => toast.custom(() => <div className="toast"><Icon name="circle-check" /> Added to plan</div>, { duration: 2500 })}>
        <Icon name="package-plus" size={18} />
        <span>Stock up on {stock.length} item{stock.length > 1 ? 's' : ''}</span>
      </button>
    </aside>
  );
}

