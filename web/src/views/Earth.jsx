// 00 Earth: full-bleed Sentinel-2 basemap with the regions that set tomorrow's prices.
// The shell adds body.full-bleed (same sidebar as every page; this view fills the content area).
// Ported from vanilla js/views/earth.js: React owns the panels and the region card, MapLibre keeps
// the markers (they are map-projected DOM nodes, so they stay outside the React tree).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Icon } from '@/lib/icons.jsx';
import { api, useAsync } from '@/lib/api.js';
import { MODULE_IDS, commodityOf } from '@/lib/meta.js';
import { fmtGBP, isNum, riskOf } from '@/lib/format.js';
import { countUp } from '@/lib/dom.jsx';
import { watchMap } from '@/lib/motion.js';

const EOX = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg';
const HOME = { center: [15, 20], zoom: 1.6 };
const LONDON = { lat: 51.507, lon: -0.128 };
const TECH = new Set(['water', 'fab', 'datacenter', 'built', 'port']);
const KIND = { water: 'Fab water reservoir', fab: 'Chip fab', datacenter: 'AI data centre', built: 'Chip fab park', port: 'Chip export port' };
// Chip order + labels (design): item_id → [label, lucide icon]
const CHIPS = [
  ['chocolate', 'Chocolate', 'candy'], ['olive_oil', 'Olive oil', 'droplet'], ['orange_juice', 'Orange juice', 'citrus'],
  ['bread', 'Bread', 'wheat'], ['latte', 'Coffee', 'coffee'], ['pint', 'Beer', 'beer'], ['wine', 'Wine', 'wine'],
  ['gpu', 'GPU', 'cpu'], ['laptop', 'Laptop', 'laptop'], ['rent_1bed', 'Rent', 'building-2'],
];
const MOD_ROUTE = { groceries: 'groceries', latte: 'latte', beer_wine: 'beer_wine', gpu: 'gpu', rent: 'rent' };

/** Satellite metric for a region: {value, label, bad}. Crops: NDVI; water: NDWI; fabs/DCs: built-up growth. */
function metricOf(r) {
  const a = r.anomaly || {};
  if (r.signal === 'water') { const v = a.ndwi_vs_5yr_pct ?? a.water_frac_vs_5yr_pct; return { value: v, label: 'Reservoir water vs 5-yr', bad: isNum(v) && v < -10 }; }
  if (TECH.has(r.signal)) { const v = a.built_frac_vs_5yr_pct ?? a.ndbi_vs_5yr_pct; return { value: v, label: 'Built-up vs 5-yr', bad: isNum(v) && v > 10 }; }
  const v = a.ndvi_vs_5yr_pct; return { value: v, label: 'Crop health vs 5-yr', bad: isNum(v) && v < -5 };
}
/** How strongly this region is pushing prices up (for picking the "main" region of an item). */
function stressOf(r) {
  const m = metricOf(r); if (!isNum(m.value)) return -1e9;
  return r.signal === 'water' || !TECH.has(r.signal) ? -m.value : m.value;
}
const pctTxt = v => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.max(-99, Math.min(99, v))).toFixed(0) + '%' : '–');
const monthCaps = m => { if (!m) return ''; const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' }).toUpperCase(); };
const avgOf = (arr, k) => { const v = arr.map(x => x[k]).filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export default function Earth() {
  const { data } = useAsync(async () => {
    const [summary, rentMod, rentGeo, ...mods] = await Promise.all([
      api('/api/summary'), api('/api/modules/rent'), api('/api/rent'), ...MODULE_IDS.map(id => api(`/api/modules/${id}`)),
    ]);
    const modules = mods.filter(Boolean);
    const items = {};
    const regions = [];
    let latest = null;
    for (const m of modules) {
      const mid = m.module?.id;
      for (const it of m.items || []) items[it.item_id] = { ...it, module_id: mid };
      const judg = Object.fromEntries((m.signals?.region_judgments || []).map(j => [j.region_id, j]));
      for (const r of m.regions || []) {
        if (!isNum(r.lat) || !isNum(r.lon)) continue;
        const risk = riskOf(judg[r.region_id]);
        const lm = r.series?.at(-1)?.month; if (lm && (!latest || lm > latest)) latest = lm;
        regions.push({ ...r, module_id: mid, item_id: r.item || r.item_id, risk, metric: metricOf(r), tech: TECH.has(r.signal) });
      }
    }
    for (const it of rentMod?.items || []) items[it.item_id] = { ...it, module_id: 'rent' };
    const boroughs = (rentGeo?.features || []).map(f => f.properties || {});
    // London as a pseudo-region for Rent Radar
    const london = {
      region_id: 'london', name: 'London, UK', lat: LONDON.lat, lon: LONDON.lon, module_id: 'rent', item_id: 'rent_1bed', london: true,
      metric: { value: avgOf(boroughs, 'built_change_pct'), label: 'Built-up vs 2019', bad: false },
    };
    return { summary, modules, items, regions, london, boroughs, latest };
  }, []);

  const stage = useRef(null);
  const overlay = useRef(null);
  const cardEl = useRef(null);
  const leader = useRef(null);
  const mapBox = useRef(null);
  const mapRef = useRef(null);
  const allRef = useRef([]);
  const selRef = useRef(null);
  const driftRef = useRef({ on: true, raf: 0 });
  const [selected, setSelected] = useState(null);

  const stopDrift = useCallback(() => { driftRef.current.on = false; cancelAnimationFrame(driftRef.current.raf); }, []);

  const project = useCallback((lon, lat) => {
    const map = mapRef.current;
    if (map) {
      const c = map.getCenter().lng;
      const l = lon + 360 * Math.round((c - lon) / 360); // nearest world copy
      return map.project([l, lat]);
    }
    // fallback: plain web-mercator of HOME view
    const W = stage.current.clientWidth, H = stage.current.clientHeight, ws = 512 * 2 ** HOME.zoom;
    const mx = l => (l + 180) / 360 * ws, my = la => { const s = Math.sin(la * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws; };
    return { x: W / 2 + mx(lon) - mx(HOME.center[0]), y: H / 2 + my(lat) - my(HOME.center[1]) };
  }, []);

  const placeCard = useCallback(() => {
    const sel = selRef.current;
    if (!sel || !cardEl.current || cardEl.current.hidden) { if (leader.current) leader.current.hidden = true; return; }
    const p = project(sel.lon, sel.lat);
    const W = stage.current.clientWidth, H = stage.current.clientHeight;
    const cw = cardEl.current.offsetWidth, ch = cardEl.current.offsetHeight;
    const off = 44 + 34, rightSide = p.x + off + cw < W - 16;
    const x = rightSide ? p.x + off : p.x - off - cw;
    const y = Math.max(120, Math.min(H - 116 - ch, p.y - 96));
    cardEl.current.style.transform = `translate(${x}px, ${y}px)`;
    const offscreen = p.x < 0 || p.x > W || p.y < 0 || p.y > H;
    cardEl.current.classList.toggle('off', offscreen);
    leader.current.hidden = offscreen;
    const x1 = rightSide ? p.x + 34 : x + cw, x2 = rightSide ? x : p.x - 34;
    leader.current.style.transform = `translate(${x1}px, ${p.y}px)`;
    leader.current.style.width = Math.max(0, x2 - x1) + 'px';
  }, [project]);

  const place = useCallback(() => {
    for (const r of allRef.current) {
      const p = project(r.lon, r.lat);
      r.node.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    placeCard();
  }, [project, placeCard]);

  const select = useCallback((r, { fly = true } = {}) => {
    if (!r) return;
    selRef.current?.node?.classList.remove('sel');
    selRef.current = r;
    r.node?.classList.add('sel');
    setSelected(r);
    const el = cardEl.current;
    el.classList.remove('show');
    el.hidden = false;
    const reveal = () => {
      if (selRef.current !== r) return;
      placeCard();
      requestAnimationFrame(() => el.classList.add('show'));
    };
    const map = mapRef.current;
    if (fly && map) {
      leader.current.hidden = true;
      el.classList.add('flying');
      map.flyTo({ center: [r.lon, r.lat], zoom: r.london ? 6.5 : 5.5, duration: 2000, essential: true });
      map.once('moveend', () => { el.classList.remove('flying'); reveal(); });
    } else reveal();
  }, [placeCard]);

  // Markers + map. One effect, torn down with the view.
  useEffect(() => {
    if (!data) return undefined;
    const { regions, london } = data;
    const maxRisk = Math.max(0.01, ...regions.map(r => r.risk ?? 0));
    const all = [...regions, london];
    for (const r of all) {
      const size = r.london ? 14 : Math.round(22 + 22 * Math.min(1, (r.risk ?? 0.35) / maxRisk));
      const cls = r.london ? 'london' : r.tech ? 'tech' : 'farm';
      const node = document.createElement('button');
      node.className = `ea-mk ${cls}${r.metric.bad ? ' bad' : ''}`;
      node.style.setProperty('--s', size + 'px');
      node.innerHTML = `<i class="dot"></i><span class="lbl"></span>`;
      node.querySelector('.lbl').textContent = r.london ? 'London · Rent' : String(r.name).split(',')[0];
      node.addEventListener('click', e => { e.stopPropagation(); stopDrift(); select(r, { fly: false }); });
      overlay.current.appendChild(node);
      r.node = node;
    }
    allRef.current = all;

    let map = null;
    try {
      map = watchMap(new maplibregl.Map({
        container: mapBox.current, attributionControl: false, renderWorldCopies: true,
        style: {
          version: 8,
          sources: { s2: { type: 'raster', tiles: [EOX], tileSize: 256, maxzoom: 14 } },
          layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0A0F2C' } },
            { id: 's2', type: 'raster', source: 's2', paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 1200 }, 'raster-saturation': -0.05, 'raster-brightness-max': 0.92 } }],
        },
        center: HOME.center, zoom: 1.2, minZoom: 1, maxZoom: 12, dragRotate: false, pitchWithRotate: false,
      }));
      try { map.setProjection?.({ type: 'globe' }); } catch { /* mercator on MapLibre 4 */ }
      mapRef.current = map;
      map.on('move', place);
      map.on('load', () => {
        map.setPaintProperty('s2', 'raster-opacity', 1);
        map.easeTo({ zoom: HOME.zoom, duration: 3000, easing: t => 1 - Math.pow(1 - t, 3) });
        map.once('moveend', () => { if (driftRef.current.on) startDrift(); });
      });
      for (const ev of ['mousedown', 'wheel', 'touchstart', 'dragstart']) map.on(ev, stopDrift);
    } catch (e) { console.warn('[earth] map failed, static fallback', e); map = null; mapRef.current = null; }
    if (!map) stage.current.classList.add('static');

    // idle drift: gentle longitude sway until the user touches anything
    function startDrift() {
      const t0 = performance.now(), c0 = map.getCenter();
      const step = now => {
        if (!driftRef.current.on) return;
        const t = (now - t0) / 1000;
        map.jumpTo({ center: [c0.lng + 22 * Math.sin(t / 14), c0.lat + 3 * Math.sin(t / 21)] });
        driftRef.current.raf = requestAnimationFrame(step);
      };
      driftRef.current.raf = requestAnimationFrame(step);
    }

    const onWinResize = () => place();
    window.addEventListener('resize', onWinResize);
    place();
    // default selection: the most stressed farm region (else anything)
    const first = [...regions].filter(r => !r.tech).sort((a, b) => stressOf(b) - stressOf(a))[0] || regions[0];
    const t = setTimeout(() => select(first, { fly: false }), 900);

    return () => {
      clearTimeout(t);
      stopDrift();
      window.removeEventListener('resize', onWinResize);
      window.removeEventListener('resize', onWinResize);
      all.forEach(r => r.node?.remove());
      try { map?.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      selRef.current = null;
    };
  }, [data, place, select, stopDrift]);

  const mainRegion = useCallback(id => {
    if (!data) return null;
    if (id === 'rent_1bed') return data.london;
    const rs = data.regions.filter(r => r.item_id === id);
    return rs.sort((a, b) => stressOf(b) - stressOf(a))[0] || null;
  }, [data]);

  const stats = useMemo(() => {
    if (!data) return [];
    const tiles = data.summary?.stats?.tiles_processed;
    const heads = data.modules.reduce((s, m) => s + (m.signals?.n_headlines || 0), 0);
    const press = avgOf(data.summary?.modules || [], 'pressure');
    return [[tiles, 'tiles seen', ''], [heads || data.summary?.stats?.jev_judgments, heads ? 'headlines judged' : 'Jev judgments', ''], [press, 'avg pressure', 'hot']]
      .filter(s => isNum(s[0]) && s[0] > 0);
  }, [data]);

  const statRefs = useRef([]);
  useEffect(() => {
    stats.forEach(([v], i) => setTimeout(() => countUp(statRefs.current[i], Math.round(v), { dur: 1400 }), 300 + i * 120));
  }, [stats]);

  const nFarm = data ? data.regions.filter(r => !r.tech).length : 0;
  const nTech = data ? data.regions.length - nFarm : 0;

  return (
    <div className="earth-stage ea" ref={stage}>
      <div className="ea-map" ref={mapBox} />
      <div className="ea-shade" />
      <div className="ea-overlay" ref={overlay} />
      <div className="ea-leader" ref={leader} hidden />
      <div className="glass-panel earth-title ea-in">
        <div className="kicker"><i className="live" /><span className="ea-kicker">Live from Sentinel-2{data?.latest ? ` · ${monthCaps(data.latest)}` : ''}</span></div>
        <h1>Where tomorrow&apos;s prices grow</h1>
        <div className="sub">{data?.regions?.length ? `${nFarm} farm & ${nTech} chip regions · greener = more production` : 'Farm & fab regions · greener = more production'}</div>
      </div>
      <div className="glass-panel ea-stats ea-in" hidden={!stats.length}>
        {stats.map(([, l, c], i) => (
          <div className="ea-stat" key={l}>
            <b className={c} ref={el => { statRefs.current[i] = el; }}>0</b><span>{l}</span>
          </div>
        ))}
      </div>
      <a className="btn primary ea-scan ea-in" href="#/mission"><Icon name="radar" />Scan now</a>
      <div className="glass-panel ea-card" ref={cardEl} hidden>
        {selected ? <EarthCard r={selected} data={data} /> : null}
      </div>
      <div className="glass-panel ea-legend ea-in">
        <div className="ea-leg-t">Production</div>
        <div className="ea-ramp" />
        <div className="ea-leg-lh"><span>low</span><span>high</span></div>
        <div className="ea-leg-row"><i className="ring" />Health below 5-yr</div>
        <div className="ea-leg-row"><i className="tech" />Chips &amp; AI (water, fabs)</div>
      </div>
      <div className="glass-panel ea-chips ea-in">
        <div className="ea-chip-row">
          <button className="ea-home" title="Whole world" onClick={() => { stopDrift(); mapRef.current?.flyTo({ ...HOME, duration: 1800 }); }}>
            <Icon name="globe" />
          </button>
          {CHIPS.filter(([id]) => mainRegion(id)).map(([id, label, ic]) => (
            <button
              key={id}
              className={`ea-chip${selected?.item_id === id ? ' on' : ''}`}
              onClick={() => { stopDrift(); select(mainRegion(id)); }}
            >
              <ChipPhoto id={id} icon={ic} />{label}
            </button>
          ))}
        </div>
      </div>
      <div className="ea-attrib">Sentinel-2 cloudless by EOX — CC BY-NC-SA 4.0</div>
    </div>
  );
}

/** Product photo with a lucide fallback when the jpg is missing. */
function ChipPhoto({ id, icon }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="ea-ph">
      {failed ? <Icon name={icon} /> : <img src={`/products/${id}.jpg`} alt="" onError={() => setFailed(true)} />}
    </span>
  );
}

/** The floating region card that the map flies to. */
function EarthCard({ r, data }) {
  const it = data.items[r.item_id] || {};
  const m = r.metric;
  const pressure = data.summary?.modules?.find(x => x.module_id === r.module_id)?.pressure;
  const label = CHIPS.find(c => c[0] === r.item_id)?.[1] || it.name || '';
  const sub = r.london ? `1-bed flat · ${data.boroughs.length || 33} boroughs`
    : r.tech ? KIND[r.signal] || 'Chip supply'
      : `${commodityOf(r)} · feeds ${label.toLowerCase()}`;
  const month = r.series?.at(-1)?.month;
  const now = it.retail_now, fut = it.retail_6m;
  const nameShort = r.london ? 'London' : String(r.name).replace(/\s*\(.*?\)/, '');
  const [thumbOk, setThumbOk] = useState(true);

  return (
    <a className="ea-card-link" href={`#/${MOD_ROUTE[r.module_id] || 'overview'}`}>
      <div className="ea-c-head">
        <div>
          <div className="ea-c-name">{nameShort}</div>
          <div className="ea-c-sub">{sub}</div>
        </div>
        {!r.london && month && thumbOk ? (
          <img className="ea-thumb" src={`/tiles/${r.region_id}/${month}.png`} data-sat-region={r.region_id}
               data-sat-month={month} title="Open satellite image" alt="" onError={() => setThumbOk(false)} />
        ) : null}
      </div>
      {isNum(m.value) ? (<>
        <div className="ea-c-lab">{m.label}</div>
        <div className={`ea-c-big ${m.bad ? 'bad' : 'ok'}`}>{pctTxt(m.value)}</div>
      </>) : null}
      {isNum(pressure) ? (<>
        <div className="ea-c-lab">Price pressure</div>
        <div className="ea-c-press"><b>{Math.round(pressure)}</b><span>/100</span></div>
        <div className="ea-bar"><i style={{ width: `${Math.max(2, Math.min(100, pressure))}%` }} /></div>
      </>) : null}
      {isNum(now) && isNum(fut) ? (<>
        <div className="ea-c-lab">{label}, London · in 6 months</div>
        <div className="ea-c-price">
          <span className="was">{fmtGBP(now)}</span>
          <Icon name="arrow-right" />
          <b className={fut >= now ? 'up' : 'down'}>{fmtGBP(fut)}</b>
        </div>
      </>) : null}
    </a>
  );
}
