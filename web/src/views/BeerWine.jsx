// Beer & Wine screen (MODULES.md §08): crop-health heatmap (region × year, summer NDVI vs region mean)
// + Pint | Wine forecast card, signal row below. Ported from frontend/js/views/beer_wine.js.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ModuleHeader } from '@/components/orbit/chrome.jsx';
import { SatImg } from '@/components/orbit/bits.jsx';
import { ForecastChart, SignalRow } from '@/components/orbit/charts.jsx';
import { loadModule, useAsync } from '@/lib/api.js';
import { ACCENT, ITEM_META } from '@/lib/meta.js';
import { fmtGBP, isNum, pct, shortRegion } from '@/lib/format.js';
import { CountUp } from '@/lib/dom.jsx';

const ID = 'beer_wine';
const SUMMER = ['06', '07', '08'];
const PLACE = { pint: 'London pub', wine: 'UK shop' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monLong = m => `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}`;

// Diverging, calm buckets from the spec (stressed amber → healthy green).
const SCALE = [
  [v => v <= -12, '#EA580C', '#fff'],
  [v => v <= -6, '#FB923C', '#7C2D12'],
  [v => v <= -2, '#FED7AA', '#9A3412'],
  [v => v < 2, '#F1F5F9', '#475569'],
  [v => v < 5, '#BBF7D0', '#166534'],
  [() => true, '#4ADE80', '#14532D'],
];
const bucket = v => SCALE.find(([t]) => t(v));
const kindOf = r => (/hop/i.test(r.name || r.region_id) ? 'Hops' : /vine|grape|wine/i.test(r.name || r.region_id) ? 'Wine grapes' : 'Crop');

/** rows: [{region, cells:{year:{pct, ndvi, month}}}], years: [..] */
function heatData(regions) {
  const rows = [];
  let yMin = Infinity, yMax = -Infinity;
  for (const r of regions) {
    const byYear = {};
    for (const s of r.series || []) {
      if (!s?.month || !isNum(s.ndvi) || !SUMMER.includes(s.month.slice(5))) continue;
      if (isNum(s.cloud_pct) && s.cloud_pct > 60) continue;
      const y = +s.month.slice(0, 4);
      (byYear[y] ||= []).push(s);
    }
    const years = Object.keys(byYear).map(Number);
    if (!years.length) continue;
    const mean = {};
    years.forEach(y => { const a = byYear[y]; mean[y] = a.reduce((t, s) => t + s.ndvi, 0) / a.length; });
    const base = years.reduce((t, y) => t + mean[y], 0) / years.length;
    if (!(base > 0)) continue;
    const cells = {};
    years.forEach(y => {
      const jul = byYear[y].find(s => s.month.endsWith('-07')) || byYear[y].at(-1);
      cells[y] = { pct: (mean[y] / base - 1) * 100, ndvi: mean[y], month: jul.month, base };
    });
    yMin = Math.min(yMin, ...years); yMax = Math.max(yMax, ...years);
    rows.push({ region: r, cells });
  }
  // Wine grapes first, then hops (matches the design's reading order).
  rows.sort((a, b) => kindOf(b.region).localeCompare(kindOf(a.region)));
  const years = [];
  for (let y = Math.max(yMin, yMax - 7); y <= yMax; y++) years.push(y);
  return { rows, years };
}

export default function BeerWine() {
  const { data, loading } = useAsync(() => loadModule(ID), []);
  const items = useMemo(() => (data?.items || []).filter(it => it?.history?.length && it?.forecast?.length), [data]);
  const hd = useMemo(() => heatData(data?.regions || []), [data]);
  const [itemId, setItemId] = useState(null);

  if (loading) {
    return (<>
      <ModuleHeader moduleId={ID} />
      <div className="bw-hero"><div className="card skeleton" /><div className="card skeleton" /></div>
      <div className="card skeleton" style={{ height: 232 }} />
    </>);
  }
  if (!data) return <><ModuleHeader moduleId={ID} /><div className="empty">No data for this module yet.</div></>;

  const accent = ACCENT[ID];
  const showHeat = hd.rows.length && hd.years.length;
  const item = items.find(i => i.item_id === itemId) || items[0];

  return (
    <>
      <ModuleHeader moduleId={ID} data={data} />
      <div className="bw-hero" style={!showHeat || !items.length ? { gridTemplateColumns: '1fr' } : undefined}>
        {showHeat ? <HeatCard hd={hd} accent={accent} activeItem={item?.item_id} /> : null}
        {items.length ? <FcCard items={items} item={item} onPick={setItemId} accent={accent} /> : null}
      </div>
      <SignalRow data={data} accent={accent} priceItem={items[0]} />
    </>
  );
}

/* ---------- crop-health heatmap ---------- */
function HeatCard({ hd, accent, activeItem }) {
  const nowY = hd.years.at(-1);
  const [hover, setHover] = useState(null); // {ri, y, x, py}
  const tip = useRef(null);
  const [ready, setReady] = useState(false);
  const [stagger, setStagger] = useState(true); // column-by-column fade-in, then hover stays instant

  useEffect(() => {
    const t = setTimeout(() => setReady(true), 30);
    const t2 = setTimeout(() => setStagger(false), 120 + 60 * hd.years.length + 400);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [hd.years.length]);

  useLayoutEffect(() => {
    if (!hover || !tip.current) return;
    const el = tip.current;
    el.style.left = Math.min(hover.x + 16, window.innerWidth - el.offsetWidth - 12) + 'px';
    el.style.top = Math.min(hover.py + 16, window.innerHeight - el.offsetHeight - 12) + 'px';
  }, [hover]);

  const cell = hover ? hd.rows[hover.ri].cells[hover.y] : null;
  const region = hover ? hd.rows[hover.ri].region : null;

  return (
    <section className="bw-card bw-heat">
      <div className="bw-head">
        <div>
          <div className="bw-title">Crop health by region</div>
          <div className="bw-sub">
            Sentinel-2 NDVI, Jun–Aug mean vs the {hd.years[0]}–{String(hd.years.at(-1)).slice(2)} summer average, % · click a cell for the satellite image
          </div>
        </div>
        <div className="bw-scale">Stressed<span />{SCALE.map((s, i) => <i key={i} style={{ background: s[1] }} />)}<span />Healthy</div>
      </div>
      <div
        className="bw-grid"
        style={{
          gridTemplateColumns: `130px repeat(${hd.years.length}, minmax(0,1fr))`,
          gridTemplateRows: `auto repeat(${hd.rows.length}, minmax(44px,1fr))`,
        }}
        onMouseLeave={() => setHover(null)}
      >
        <div />
        {hd.years.map(y => <div className={`bw-yr${y === nowY ? ' now' : ''}`} key={y}>{y}</div>)}
        {hd.rows.map((row, ri) => {
          const r = row.region;
          const on = r.item === activeItem;
          return (
            <Row key={r.region_id} row={row} ri={ri} years={hd.years} nowY={nowY} accent={accent} on={on}
                 ready={ready} stagger={stagger} onHover={setHover} />
          );
        })}
      </div>
      {cell ? (
        <div className="tooltip" ref={tip}>
          <div className="bw-tip">
            <SatImg regionId={region.region_id} month={cell.month} />
            <div>
              <b>{shortRegion(region)} · {hover.y}</b>
              <div className="muted">Summer NDVI {cell.ndvi.toFixed(2)} · avg {cell.base.toFixed(2)}</div>
              <div className="v">{pct(cell.pct, 1)}</div>
              <div className="muted">Tile: {monLong(cell.month)} · click to zoom</div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Row({ row, ri, years, nowY, accent, on, ready, stagger, onHover }) {
  const r = row.region;
  return (
    <>
      <div className={`bw-row${on ? ' on' : ''}`} data-item={r.item || ''} style={{ '--c': accent, opacity: r.item && !on ? 0.55 : 1 }}>
        <b>{shortRegion(r)}</b><small><i />{kindOf(r)}</small>
      </div>
      {years.map((y, ci) => {
        const c = row.cells[y];
        const now = y === nowY ? ' now' : '';
        if (!c) return <div className={`bw-cell na${now}${ready ? ' in' : ''}`} key={y} style={{ transitionDelay: stagger ? `${120 + 60 * ci}ms` : undefined }}>·</div>;
        const v = Math.round(c.pct), [, bg, fg] = bucket(v);
        return (
          <div
            key={y}
            className={`bw-cell${now}${ready ? ' in' : ''}`}
            data-sat-region={r.region_id}
            data-sat-month={c.month}
            style={{ background: bg, color: fg, transitionDelay: stagger ? `${120 + 60 * ci}ms` : undefined }}
            onMouseMove={e => onHover({ ri, y, x: e.clientX, py: e.clientY })}
            onClick={() => onHover(null)}
          >
            {v > 0 ? '+' : v < 0 ? '−' : ''}{Math.abs(v)}
          </div>
        );
      })}
    </>
  );
}

/* ---------- Pint | Wine forecast card ---------- */
function FcCard({ items, item, onPick, accent }) {
  const h = item.history, f = item.forecast.slice(0, 6);
  const now = h.at(-1).price, end = f.at(-1).p50;
  const short = ITEM_META[item.item_id]?.short || item.name;
  const chg6 = now > 0 ? (end / now - 1) * 100 : null;
  const f6 = f.at(-1);
  const stats = [
    isNum(item.prob_up_6m) && (
      <div key="p"><div className="v">{Math.round(item.prob_up_6m * 100)}%</div><div className="l">chance it rises in 6 mo</div></div>
    ),
    isNum(chg6) && (
      <div key="c"><div className="v" style={{ color: chg6 > 0 ? 'var(--up)' : 'var(--down)' }}>{pct(chg6, 1)}</div><div className="l">in 6 mo (by {monLong(f6.month)})</div></div>
    ),
    isNum(f6?.p10) && isNum(f6?.p90) && (
      <div key="r"><div className="v">{fmtGBP(f6.p10)} – {fmtGBP(f6.p90)}</div><div className="l">likely range in 6 mo</div></div>
    ),
  ].filter(Boolean);

  return (
    <section className="bw-card bw-fc">
      {items.length > 1 ? (
        <ToggleGroup type="single" className="seg" value={item.item_id} onValueChange={v => v && onPick(v)}>
          {items.map(it => (
            <ToggleGroupItem key={it.item_id} value={it.item_id} className={it.item_id === item.item_id ? 'on' : undefined}>
              {ITEM_META[it.item_id]?.short || it.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      <div className="lbl">{item.name}{PLACE[item.item_id] ? ', ' + PLACE[item.item_id] : ''}</div>
      <div className="hero-price">
        <CountUp as="b" className="bw-big" to={end} digits={2} prefix="£" dur={700} placeholder="–" />
        <span className="bw-from">from {fmtGBP(now)} today</span>
      </div>
      <ForecastChart
        className="fc-host"
        history={h}
        forecast={f}
        accent={accent}
        unit={item.unit || '£'}
        calloutTitle={short}
        months={12}
      />
      <div className="stat-strip" hidden={!stats.length}>{stats}</div>
    </section>
  );
}
