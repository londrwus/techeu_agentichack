// 01 Overview: five KPI cards, Tomorrow's Basket waffle and the satellite watch map.
// Ported from vanilla js/views/overview.js.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Topbar } from '@/components/orbit/chrome.jsx';
import { Icon, ModuleIcon, ItemIcon, moduleIconSvg } from '@/lib/icons.jsx';
import { api, allModules, useAsync } from '@/lib/api.js';
import { MODULE_META, ITEM_META, REGION_META } from '@/lib/meta.js';
import { agoText, esc, isNum, pct } from '@/lib/format.js';
import { countUp, hideTip, onResize, showTip } from '@/lib/dom.jsx';
import { initChart } from '@/lib/echarts.js';
import { watchMap } from '@/lib/motion.js';
import { axisTooltip, fmtMoney, fmtMonth, fmtPct, tipHtml } from '@/lib/chartTheme.js';

const BASKET = ['chocolate', 'olive_oil', 'orange_juice', 'latte', 'pint', 'wine', 'bread', 'gpu'];
const MOD_ORDER = ['groceries', 'latte', 'beer_wine', 'gpu', 'rent'];
const BASEMAP = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const shortName = n => String(n || '').replace(/\s*\(.*?\)/, '');
const moduleOfItem = id => ({ chocolate: 'groceries', olive_oil: 'groceries', orange_juice: 'groceries', bread: 'groceries', latte: 'latte', pint: 'beer_wine', wine: 'beer_wine', gpu: 'gpu', laptop: 'gpu' }[id] || 'groceries');

export default function Overview() {
  const { data } = useAsync(async () => {
    const [summary, mods, rent] = await Promise.all([
      api('/api/summary', { fresh: true }), allModules(), api('/api/modules/rent'),
    ]);
    const items = Object.fromEntries([...mods, rent].filter(Boolean).flatMap(m => m.items || []).map(i => [i.item_id, i]));
    return { summary, mods, items };
  }, []);
  const [share, setShare] = useState('Share');
  useEffect(() => () => hideTip(), []);

  const onShare = async () => {
    try { await navigator.clipboard.writeText(location.href); setShare('Copied'); } catch { /* ignore */ }
  };

  return (
    <>
      <Topbar
        title="Overview"
        pill={<Badge variant="live">{agoText(data?.summary?.generated_at)}</Badge>}
        tagline="Satellite intelligence for commodities. Fully agentic."
        right={<Button variant="orbit" size="orbit" onClick={onShare}><Icon name="share-2" />{share}</Button>}
      />
      <section className="ov-kpis">
        {data
          ? MOD_ORDER.map(id => <KpiCard key={id} id={id} summary={data.summary} items={data.items} />)
          : MOD_ORDER.map((id, i) => <div className="kc skeleton" key={i} />)}
      </section>
      <section className="ov-bottom">
        <Basket items={data?.items} />
        <SatelliteWatch mods={data?.mods} />
      </section>
    </>
  );
}

/* ---------- KPI cards: icon + name, one big number, sparkline, one delta line ---------- */
function KpiCard({ id, summary, items }) {
  const m = (summary?.modules || []).find(x => x.module_id === id) || {};
  const meta = MODULE_META[id];
  const it = items[m.top_item_id] || {};
  const ch = isNum(m.change_6m_pct) ? m.change_6m_pct : it.change_6m_pct;
  const p = isNum(m.prob_up_6m) ? m.prob_up_6m : it.prob_up_6m;
  const trend = !isNum(p) ? 'minus' : p >= 0.5 ? 'trending-up' : 'trending-down';
  const big = useRef(null);

  useEffect(() => {
    if (!isNum(ch)) return;
    countUp(big.current, Math.abs(ch), { digits: 1, prefix: ch > 0 ? '+' : ch < 0 ? '−' : '', suffix: '%' });
  }, [ch]);

  return (
    <Link className="kc" to={`/${id}`} style={{ '--mc': meta.color }}>
      <div className="kc-head"><span className="kc-name"><ModuleIcon id={id} size={15} />{meta.name}</span></div>
      <div className="kc-big num"><span className="cu" ref={big}>–</span><small>in 6 mo</small></div>
      <div className="kc-sub" title={m.top_item || it.name || ''}>{shortName(m.top_item || it.name) || 'Forecast pending'}</div>
      <Sparkline item={items[m.top_item_id]} color={meta.color} />
      <div className="kc-foot">
        <span className={`kc-trend ${p >= 0.5 ? 'up' : 'down'}`}><Icon name={trend} size={14} /></span>
        <span className="kc-prob" title="Probability the price is higher in 6 months">
          {isNum(p) ? <>{Math.round(p * 100)}%<span className="kc-lu"> likely up</span></> : 'Pending'}
        </span>
        <span className="kc-press" title="Price pressure index: 0 = easing, 100 = strong upward pressure">
          Pressure <b>{isNum(m.pressure) ? Math.round(m.pressure) : '–'}</b>
        </span>
      </div>
    </Link>
  );
}

function Sparkline({ item, color }) {
  const box = useRef(null);
  useEffect(() => {
    const el = box.current;
    if (!item?.history?.length) { el.classList.add('empty'); return undefined; }
    const hist = item.history.slice(-24);
    const fc = (item.forecast || []).slice(0, 6);
    const months = [...hist.map(h => h.month), ...fc.map(f => f.month)];
    const nH = hist.length, last = hist[nH - 1].price;
    const hData = [...hist.map(h => h.price), ...fc.map(() => null)];
    const fData = [...hist.map((_, i) => (i === nH - 1 ? last : null)), ...fc.map(f => f.p50)];
    const vals = [...hist.map(h => h.price), ...fc.map(f => f.p50)];
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.15 || hi * 0.02;
    const c = initChart(el, null, { renderer: 'svg' });
    c.setOption({
      animationDuration: 600,
      grid: { left: 2, right: 2, top: 4, bottom: 4 },
      xAxis: { type: 'category', data: months, show: false, boundaryGap: false },
      yAxis: { type: 'value', show: false, min: lo - pad, max: hi + pad },
      tooltip: {
        ...axisTooltip(ps => {
          const i = ps[0]?.dataIndex ?? 0;
          const isF = i >= nH;
          const f = isF ? fc[i - nH] : null;
          const v = isF ? f.p50 : hist[i].price;
          return tipHtml({
            title: fmtMonth(months[i]), tag: isF ? 'Forecast' : i === nH - 1 ? 'Today' : '',
            rows: [
              { color: isF ? color : '#A8A29E', dashed: isF, label: isF ? 'Expected' : 'Price', value: fmtMoney(v) },
              isF && isNum(f.p10) && isNum(f.p90) ? { label: 'Likely range', value: `${fmtMoney(f.p10)} – ${fmtMoney(f.p90)}` } : null,
              i !== nH - 1 ? { label: 'vs today', value: fmtPct((v / last - 1) * 100) } : null,
            ],
            note: shortName(item.name),
          });
        }),
        confine: false,
        appendToBody: true,
        // Show the card below the sparkline so the line stays visible.
        position: (pt, _p, _d, _r, size) => {
          const bb = el.getBoundingClientRect();
          return [Math.max(-bb.left + 8, Math.min(pt[0] - size.contentSize[0] / 2, window.innerWidth - bb.left - size.contentSize[0] - 8)), bb.height + 12];
        },
      },
      series: [
        { type: 'line', data: hData, symbol: 'none', smooth: 0.3, lineStyle: { width: 1.5, color: '#A8A29E' }, emphasis: { disabled: true }, areaStyle: { color: 'rgba(168,162,158,.08)' } },
        { type: 'line', data: fData, symbol: 'none', smooth: 0.3, lineStyle: { width: 2, color, type: [4, 3] }, emphasis: { disabled: true } },
      ],
    });
    const stop = onResize(el, () => c.resize());
    return () => { stop(); c.dispose(); };
  }, [item, color]);
  return <div className="kc-spark" ref={box} />;
}

/* ---------- Basket waffle ---------- */
function Basket({ items }) {
  const total = useRef(null);
  const rows = useMemo(() => (items
    ? BASKET.map(id => ({ id, ...ITEM_META[id], it: items[id], v: items[id]?.change_6m_pct, name: items[id]?.name })).filter(r => isNum(r.v))
    : []), [items]);
  const avg = rows.length ? rows.reduce((a, r) => a + r.v, 0) / rows.length : null;

  useEffect(() => {
    if (!isNum(avg)) return;
    countUp(total.current, Math.abs(avg), { digits: 1, prefix: avg >= 0 ? '+' : '−', suffix: '%' });
    total.current.style.color = avg < 0 ? 'var(--down)' : '';
  }, [avg]);

  const tipFor = r => {
    const h = r.it?.history || [], f6 = (r.it?.forecast || [])[5];
    const now = h[h.length - 1];
    return tipHtml({
      title: shortName(r.name || r.short), tag: '6-month outlook',
      rows: [
        now ? { color: '#A8A29E', label: `Today (${fmtMonth(now.month)})`, value: fmtMoney(now.price) } : null,
        f6 ? { color: 'var(--accent)', dashed: true, label: `Expected ${fmtMonth(f6.month)}`, value: fmtMoney(f6.p50) } : null,
        f6 && isNum(f6.p10) ? { label: 'Likely range', value: `${fmtMoney(f6.p10)} – ${fmtMoney(f6.p90)}` } : null,
        { label: 'Change', value: fmtPct(r.v) },
        isNum(r.it?.prob_up_6m) ? { label: 'Chance of rising', value: Math.round(r.it.prob_up_6m * 100) + '%' } : null,
      ],
      note: 'Click to open the forecast',
    });
  };

  return (
    <div className="card" id="basket">
      <div className="card-head">
        <div>
          <div className="card-title">Tomorrow&apos;s Basket</div>
          <div className="card-sub">Expected price change in 6 months</div>
        </div>
        <div className="basket-total">
          <div className="v num" ref={total}>–</div>
          <div className="l">basket vs today</div>
        </div>
      </div>
      <div className="waffle-cols">
        {!items ? <div className="empty">Loading forecasts…</div>
          : !rows.length ? <div className="empty">Forecasts are still being computed on Modal.</div>
            : rows.map((r, ci) => {
              const n = Math.max(0, Math.min(10, Math.round(r.v / 0.5)));
              const hot = r.v >= 3;
              const fill = hot ? 'var(--accent)' : 'var(--accent-light)';
              return (
                <div
                  className="wcol"
                  key={r.id}
                  onMouseMove={e => showTip(tipFor(r), e.clientX, e.clientY)}
                  onMouseLeave={hideTip}
                  onClick={() => { hideTip(); location.hash = `#/${moduleOfItem(r.id)}`; }}
                >
                  <div className={`val ${hot ? 'hot' : r.v < 0 ? 'neg' : ''}`}>{pct(r.v, Math.abs(r.v) < 1 ? 1 : 0)}</div>
                  <div className="wstack">
                    {Array.from({ length: 10 }, (_, k) => (
                      <i key={k} style={{ background: k < n ? fill : undefined, animationDelay: `${ci * 60 + k * 35}ms` }} />
                    ))}
                  </div>
                  <div className="emo"><ItemIcon id={r.id} size={18} /></div>
                  <div className="nm">{r.short}</div>
                </div>
              );
            })}
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--accent)' }} />Rising fast (≥3%)</span>
        <span><i style={{ background: 'var(--accent-light)' }} />Rising</span>
        <span><i style={{ background: 'var(--muted)' }} />1 square = +0.5%</span>
      </div>
    </div>
  );
}

/* ---------- Satellite watch map ---------- */
const sigOf = r => r.signal || REGION_META[r.region_id]?.[1];

function anomalyOf(reg) {
  const sig = sigOf(reg);
  const a = reg.anomaly || {};
  if (sig === 'water' && isNum(a.ndwi_vs_5yr_pct)) return { v: a.ndwi_vs_5yr_pct, idx: 'NDWI' };
  if (isNum(a.ndvi_vs_5yr_pct)) return { v: a.ndvi_vs_5yr_pct, idx: 'NDVI' };
  return null;
}

function regionTip(r, a) {
  const tiles = (r.series || []).filter(s => s.thumb);
  const last = tiles.filter(s => (s.cloud_pct ?? 0) < 30).slice(-1)[0] || tiles.slice(-1)[0];
  const meta = MODULE_META[r.module] || {};
  return `<div class="ov-tip">
    ${last ? `<img src="/${esc(last.thumb)}" alt="">` : ''}
    <div class="ov-tip-b">
      <div class="ov-tip-m" style="color:${meta.color}">${moduleIconSvg(r.module, { size: 13 })}${esc(meta.name || '')}</div>
      <div class="ov-tip-n">${esc(r.name)}</div>
      ${a ? `<div class="ov-tip-v ${a.v < 0 ? 'red' : 'green'}">${a.idx} ${fmtPct(a.v, 0)} vs 5-yr avg</div>` : '<div class="muted">Anomaly pending</div>'}
      ${last ? `<div class="muted">Latest clear tile ${fmtMonth(last.month)} · ${Math.round(last.cloud_pct ?? 0)}% cloud</div>` : ''}
      <div class="muted">Click to open ${esc(meta.name || 'module')}</div>
    </div></div>`;
}

const FILTERS = { All: null, Crops: ['crop'], Water: ['water'], Built: ['built', 'port'] };

function SatelliteWatch({ mods }) {
  const mapBox = useRef(null);
  const pinsRef = useRef([]);
  const calloutRef = useRef(null);
  const worstRef = useRef(null);
  const fitRef = useRef(null);
  const [filter, setFilter] = useState('All');

  const regions = useMemo(() => (mods || [])
    .flatMap(m => (m.regions || []).map(r => ({ ...r, module: r.module || m.module?.id })))
    .filter(r => isNum(r.lat) && isNum(r.lon) && MODULE_META[r.module]), [mods]);

  const stats = useMemo(() => {
    const an = regions.map(anomalyOf).filter(Boolean);
    const nd = regions.map(r => r.anomaly?.ndvi_vs_5yr_pct).filter(isNum);
    return {
      n: regions.length,
      stress: an.length ? an.filter(a => a.v < -10).length : null,
      avg: nd.length ? nd.reduce((a, b) => a + b, 0) / nd.length : null,
    };
  }, [regions]);

  const nRef = useRef(null), dRef = useRef(null);
  useEffect(() => {
    if (!regions.length) return;
    countUp(nRef.current, stats.n);
    if (isNum(stats.stress)) countUp(dRef.current, stats.stress);
  }, [regions.length, stats]);

  // Map + DOM markers (MapLibre owns the positioning, so the pins are plain elements).
  useEffect(() => {
    if (!regions.length) return undefined;
    const map = mapBox.current;
    const pins = regions.map(r => {
      const a = anomalyOf(r);
      const p = document.createElement('div');
      p.className = 'ov-pin' + (a && a.v < -10 ? ' pulse' : '');
      p.style.setProperty('--c', MODULE_META[r.module].color);
      const tipH = regionTip(r, a);
      p.addEventListener('mousemove', e => showTip(tipH, e.clientX, e.clientY, map.getBoundingClientRect()));
      p.addEventListener('mouseleave', hideTip);
      p.addEventListener('click', e => { e.stopPropagation(); hideTip(); location.hash = `#/${r.module}`; });
      return { r, p, a };
    });
    pinsRef.current = pins;
    const worst = pins.filter(x => x.a).sort((x, y) => x.a.v - y.a.v)[0];
    worstRef.current = worst;
    let callout = null;
    if (worst && worst.a.v < 0) {
      callout = document.createElement('div');
      callout.className = 'ov-callout';
      callout.innerHTML = `<span style="color:${MODULE_META[worst.r.module].color}">${moduleIconSvg(worst.r.module, { size: 13 })}</span><b>${esc(shortName(worst.r.name).split(',')[0])}</b><span class="red">${worst.a.idx} ${fmtPct(worst.a.v, 0)}</span>`;
    }
    calloutRef.current = callout;

    const b = regions.reduce((acc, r) => [Math.min(acc[0], r.lon), Math.min(acc[1], r.lat), Math.max(acc[2], r.lon), Math.max(acc[3], r.lat)], [180, 90, -180, -90]);
    const bounds = [[b[0] - 4, b[1] - 4], [b[2] + 4, b[3] + 4]];
    let touched = false;
    const gl = watchMap(new maplibregl.Map({
      container: map, bounds, fitBoundsOptions: { padding: 24 }, minZoom: 0, maxZoom: 11,
      renderWorldCopies: false, dragRotate: false, pitchWithRotate: false, attributionControl: false,
      style: {
        version: 8,
        sources: { base: { type: 'raster', tiles: [BASEMAP], tileSize: 256, maxzoom: 16, attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors' } },
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#EEF2F6' } }, { id: 'base', type: 'raster', source: 'base' }],
      },
    }));
    const fit = (duration = 0) => gl.fitBounds(bounds, { padding: 24, duration });
    fitRef.current = () => { touched = false; fit(800); };
    gl.touchZoomRotate.disableRotation();
    gl.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    gl.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    pins.forEach(({ r, p }) => new maplibregl.Marker({ element: p }).setLngLat([r.lon, r.lat]).addTo(gl));
    const east = worst && worst.r.lon > (b[0] + b[2]) / 2;
    if (callout) new maplibregl.Marker({ element: callout, anchor: east ? 'right' : 'left', offset: [east ? -16 : 16, 0] }).setLngLat([worst.r.lon, worst.r.lat]).addTo(gl);
    gl.on('movestart', e => { hideTip(); if (e.originalEvent) touched = true; });
    gl.on('load', () => fit());
    const stop = onResize(map, () => { gl.resize(); if (!touched) fit(); });
    return () => { stop(); gl.remove(); };
  }, [regions]);

  // Segment filter dims the pins that fall outside the selected signal type.
  useEffect(() => {
    const want = FILTERS[filter];
    pinsRef.current.forEach(({ r, p }) => p.classList.toggle('dim', !!want && !want.includes(sigOf(r))));
    const worst = worstRef.current;
    if (calloutRef.current && worst) calloutRef.current.hidden = !!want && !want.includes(sigOf(worst.r));
  }, [filter]);

  return (
    <div className="card" id="watch">
      <div className="card-head">
        <div>
          <div className="card-title">Satellite watch</div>
          <div className="card-sub">{regions.length ? `${regions.length} regions · Sentinel-2` : 'Sentinel-2'}</div>
        </div>
        <ToggleGroup type="single" className="seg" value={filter} onValueChange={v => v && setFilter(v)}>
          {Object.keys(FILTERS).map(s => (
            <ToggleGroupItem key={s} value={s} className={s === filter ? 'on' : undefined}>{s}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="ov-map" ref={mapBox}>
        <button className="ov-fit" title="Show all regions" onClick={() => fitRef.current?.()}>
          <Icon name="maximize-2" size={14} />All regions
        </button>
      </div>
      <div className="stat-row">
        <div className="stat"><div className="v" ref={nRef}>–</div><div className="l">regions watched</div></div>
        <div className="stat"><div className="v red" ref={dRef}>–</div><div className="l">in drought stress</div></div>
        <div className="stat"><div className={isNum(stats.avg) && stats.avg >= 0 ? 'v green' : 'v red'}>{pct(stats.avg)}</div><div className="l">avg NDVI vs 5-yr</div></div>
      </div>
      <div className="legend">
        {MOD_ORDER.map(m => (
          <span key={m}>
            <i className="round" style={{ background: MODULE_META[m].color }} />
            {MODULE_META[m].name.replace(' Index', '').replace(' & Gadgets', '').replace(' Radar', '')}
          </span>
        ))}
      </div>
    </div>
  );
}
