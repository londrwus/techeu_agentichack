// Rent Radar: London rents x new building seen from orbit.
// MapLibre (CARTO streets) with borough polygons at city zoom and H3 neighbourhood hexagons (~0.7 km2) from zoom 11.
// 2D / 3D toggle, metric toggle (recolours map + legend + ranking), hover tooltip, click for details, search.
import { api, MODULE_META, esc, isNum, money, pct, fmt, tint, countUp, plainAI } from '../lib.js';
import { topbar, wireScan } from './common.js';
import { icon } from '../components/icons.js';

const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const FALLBACK_STYLE = {
  version: 8, glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
  sources: { r: { type: 'raster', tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap © CARTO' } },
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0B0F14' } }, { id: 'r', type: 'raster', source: 'r' }],
};
const FONT = ['Montserrat Medium', 'Open Sans Bold', 'Noto Sans Regular'];
const LONDON = [[-0.51, 51.286], [0.334, 51.692]];
const HOME = { pitch: 45, bearing: -12 };
const PAD = { top: 64, bottom: 24, left: 24, right: 64 };
const HEX_Z = 11; // neighbourhood hexagons from this zoom

const SEQ = ['#FDE68A', '#FB923C', '#EA580C', '#991B1B'];
const DIV = ['#0F766E', '#5EEAD4', '#57534E', '#FDBA74', '#EA580C'];
const METRICS = {
  pressure: { label: 'Pressure', key: 'pressure', ramp: SEQ, f: v => `${fmt(v)}/100`, lf: v => fmt(v), desc: 'Expected rent growth, ranked across London (0 = calmest, 100 = hottest)' },
  rent_now: { label: 'Rent now', key: 'rent_now', ramp: SEQ, f: v => money(v), lf: v => money(v), desc: 'Typical 1-bed rent per month today' },
  change_pct: { label: '12-month change', key: 'change_pct', ramp: SEQ, f: v => pct(v, 1), lf: v => pct(v, 1), desc: 'Forecast rent change over the next 12 months' },
  built: { label: 'Built change', key: 'built_change_pct', ramp: DIV, div: true, f: v => pct(v, 1), lf: v => pct(v, 0), desc: 'New building seen by Sentinel-2 since 2019, vs the London average',
    hf: v => pts(v), hlf: v => pts(v, 0), hdesc: 'Change in built-up share of land since 2019 (Sentinel-2), vs the London average' },
};

function css() {
  if (document.getElementById('rent-css')) return;
  document.head.insertAdjacentHTML('beforeend', '<link id="rent-css" rel="stylesheet" href="/static/css/rent.css">');
}
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
function rampColor(stops, t) {
  t = Math.max(0, Math.min(1, isNum(t) ? t : 0));
  const n = stops.length - 1, i = Math.min(n - 1, Math.floor(t * n)), k = t * n - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]);
  return '#' + a.map((v, j) => Math.round(v + (b[j] - v) * k).toString(16).padStart(2, '0')).join('');
}
const quant = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
function bboxOf(geom) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = c => (typeof c[0] === 'number' ? (x0 = Math.min(x0, c[0]), x1 = Math.max(x1, c[0]), y0 = Math.min(y0, c[1]), y1 = Math.max(y1, c[1])) : c.forEach(walk));
  try { walk(geom.coordinates); } catch { return null; }
  return [[x0, y0], [x1, y1]];
}
const pts = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)} pts` : '–');
const short = n => String(n || '').replace(' and ', ' & ').replace(' upon Thames', '');
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export async function render(page) {
  css();
  const meta = MODULE_META.rent;
  page.innerHTML = topbar({
    crumb: 'Modules  /  Rent Radar', title: 'Rent Radar',
    iconSq: `<div class="icon-sq lg" style="background:${tint(meta.color)}">${icon('building-2', { size: 22 })}</div>`,
    subtitle: 'London · new building seen from orbit × rents',
    right: `<div class="seg dark" id="metric" role="tablist">${Object.entries(METRICS).map(([k, m]) => `<button class="${k === 'pressure' ? 'on' : ''}" data-m="${k}">${m.label}</button>`).join('')}</div>`,
  }) + `
  <section class="rent-row rr">
    <div class="map3d" id="map3d">
      <div class="mapc" id="mapc"></div>
      <div class="rr-tl">
        <div class="rr-search glass-s"><span class="rr-si">${icon('search', { size: 15 })}</span><input id="rr-q" placeholder="Search a borough or area…" autocomplete="off" spellcheck="false"><div class="rr-res" id="rr-res" hidden></div></div>
        <div class="rr-toggles">
          <div class="rr-seg glass-s" id="dim"><button data-d="2d">2D</button><button class="on" data-d="3d">3D</button></div>
          <div class="rr-seg glass-s" id="lvl"><button class="on" data-l="b">Boroughs</button><button data-l="h">Neighbourhoods</button></div>
        </div>
      </div>
      <div class="rr-zoom glass-s">
        <button data-z="1" title="Zoom in">${icon('plus', { size: 16 })}</button>
        <button data-z="-1" title="Zoom out">${icon('minus', { size: 16 })}</button>
        <button data-z="0" title="Reset view">${icon('maximize', { size: 15 })}</button>
      </div>
      <div class="rr-legend glass-s" id="legend"></div>
      <div class="rr-tip" id="rr-tip" hidden></div>
      <div class="rr-hint glass-s" id="rr-hint">${icon('mouse-pointer-click', { size: 14 })}<span>Hover an area · click for details · scroll to zoom to street level</span></div>
    </div>
    <div class="side rr-side">
      <div class="card rr-detail" id="detail"><div class="skeleton" style="height:150px"></div></div>
      <div class="card rr-rank">
        <div class="rr-rank-h"><div><div class="card-title" id="rank-t">Ranking</div><div class="rr-rank-s" id="rank-s"></div></div>
          <button class="rr-sort" id="sort" title="Flip order">${icon('arrow-down-wide-narrow', { size: 15 })}<span>Highest</span></button></div>
        <div class="rr-list" id="rank"></div>
      </div>
      <div class="card ink-card rr-ins"><div class="lbl">${icon('sparkles', { size: 15 })}Gemini sees</div><p id="rent-ins">Reading London from orbit…</p></div>
    </div>
  </section>`;
  wireScan(page);
  const $ = s => page.querySelector(s);

  const [geo, hexGeo, mod] = await Promise.all([api('/api/rent'), api('/api/rent/hex').catch(() => null), api('/api/modules/rent').catch(() => null)]);
  const card0 = mod?.insights?.cards?.[0];
  $('#rent-ins').textContent = plainAI(card0?.text) || mod?.insights?.headline || 'East London is adding rooftops fastest, yet rents still lead the city. New supply is not keeping up.';
  const boros = (geo?.features || []).filter(f => f?.geometry && f.properties?.name);
  const hexes = (hexGeo?.features || []).filter(f => f?.geometry && f.properties?.id);
  if (!boros.length) {
    $('#mapc').innerHTML = `<div class="empty" style="height:100%;background:transparent;color:rgba(255,255,255,.6)">Borough data is being built on Modal…</div>`;
    $('#detail').innerHTML = `<div class="empty">Pending</div>`; $('#rank').innerHTML = '';
    return;
  }
  const hexMeta = hexGeo?.meta || {};
  boros.forEach(f => { f.properties._bb = bboxOf(f.geometry); f.properties._kind = 'b'; });
  hexes.forEach(f => (f.properties._kind = 'h'));

  // Neighbourhoods = named groups of hexagons (for labels, ranking, search).
  const hoods = new Map();
  for (const f of hexes) {
    const p = f.properties, k = p.name;
    if (!hoods.has(k)) hoods.set(k, { key: k, name: p.name, cells: [] });
    hoods.get(k).cells.push(p);
  }
  const hoodList = [...hoods.values()].map(h => {
    const c = h.cells, avgK = key => mean(c.map(p => p[key]).filter(isNum));
    const xs = c.map(p => p.centroid[0]), ys = c.map(p => p.centroid[1]);
    const bc = {}; c.forEach(p => (bc[p.borough] = (bc[p.borough] || 0) + 1));
    return {
      _kind: 'n', key: h.key, name: h.name, borough: Object.entries(bc).sort((a, b) => b[1] - a[1])[0][0], n: c.length,
      rent_now: Math.round(avgK('rent_now') / 5) * 5, rent_12m: Math.round(avgK('rent_12m') / 5) * 5,
      change_pct: avgK('change_pct'), built_change_pct: avgK('built_change_pct'), pressure: avgK('pressure'),
      built_share_2019: avgK('built_share_2019'), built_share_latest: avgK('built_share_latest'),
      centroid: [mean(xs), mean(ys)], _bb: [[Math.min(...xs) - 0.006, Math.min(...ys) - 0.004], [Math.max(...xs) + 0.006, Math.max(...ys) + 0.004]],
    };
  });

  // London reference values
  const Lmed = {}; for (const m of Object.values(METRICS)) Lmed[m.key] = quant(boros.map(f => f.properties[m.key]).filter(isNum), 0.5);
  const avgRent = mean(boros.map(f => f.properties.rent_now).filter(isNum)), avgNext = mean(boros.map(f => f.properties.rent_12m).filter(isNum));

  let metric = 'pressure', level = 'b', dim = '3d', desc = true, sel = null, hover = null;
  const M = () => METRICS[metric];
  const domainOf = feats => {
    const v = feats.map(p => p[M().key]).filter(isNum);
    if (!v.length) return [0, 1];
    let lo = quant(v, 0.03), hi = quant(v, 0.97);
    if (M().div) { const a = Math.max(Math.abs(lo), Math.abs(hi), 1); lo = -a; hi = a; }
    if (metric === 'pressure') { lo = 0; hi = 100; }
    return [lo, hi === lo ? lo + 1 : hi];
  };
  let domB = [0, 1], domH = [0, 1];
  const colorFor = (p, dom) => (isNum(p[M().key]) ? rampColor(M().ramp, (p[M().key] - dom[0]) / (dom[1] - dom[0])) : '#44403C');
  const recolor = () => {
    domB = domainOf(boros.map(f => f.properties));
    domH = domainOf(hexes.map(f => f.properties));
    boros.forEach(f => { const p = f.properties; p._c = colorFor(p, domB); p._h = 250 + Math.max(0, p.built_change_pct ?? 0) * 170; });
    hexes.forEach(f => { const p = f.properties; p._c = colorFor(p, domH); p._h = 40 + Math.max(0, p.built_change_pct ?? 0) * 26; });
  };
  recolor();

  // ---------- side: detail card ----------
  const statRow = (label, v, ref, f, max, hint) => {
    const w = isNum(v) && max ? Math.min(100, Math.abs(v) / max * 100) : 0, rw = isNum(ref) && max ? Math.min(100, Math.abs(ref) / max * 100) : 0;
    return `<div class="rr-stat"><div class="rr-stat-l"><span>${esc(label)}</span><b>${isNum(v) ? f(v) : '–'}</b></div>
      <div class="rr-stat-bar"><i style="width:${w}%" class="${isNum(v) && v < 0 ? 'neg' : ''}"></i>${isNum(ref) ? `<em style="left:${rw}%" title="London median ${f(ref)}"></em>` : ''}</div>
      ${hint ? `<div class="rr-stat-h">${hint}</div>` : ''}</div>`;
  };
  function renderDetail() {
    const d = $('#detail');
    if (!sel) {
      d.innerHTML = `<div class="rr-d-top"><div><div class="rr-d-k">Greater London</div><div class="rr-d-n">Average 1-bed rent</div></div></div>
        <div class="avg-line"><span class="a">${money(avgRent)}</span>${icon('arrow-right', { size: 18, cls: 'rr-arrow' })}<span class="b" id="avg-b">${money(avgNext)}</span></div>
        <div class="rr-d-chg">${pct((avgNext / avgRent - 1) * 100, 1)} in 12 months</div>
        <div class="rr-d-tip">${icon('info', { size: 14 })}<span>Click any area on the map or in the ranking for its details. Zoom in past the borough level to see ${hexes.length ? fmt(hexes.length) + ' neighbourhood hexagons' : 'neighbourhoods'}.</span></div>`;
      countUp($('#avg-b'), avgNext, { prefix: '£', dur: 900 });
      return;
    }
    const p = sel.p, kind = p._kind;
    const sub = kind === 'b' ? 'London borough' : kind === 'h' ? `One hexagon (~0.7 km²) · ${esc(short(p.borough))}` : `Neighbourhood average · ${esc(short(p.borough))}`;
    const area = kind === 'h' ? hoodList.find(h => h.key === p.name) : null;
    const areaLine = area && area.n > 1 ? `<div class="rr-d-area">${icon('hexagon', { size: 13 })}<span>Whole ${esc(area.name)} area avg (${area.n} hexagons, as ranked): <b>${money(area.rent_now)}</b> · <b>${pct(area.change_pct, 1)}</b> · pressure <b>${fmt(area.pressure)}/100</b></span></div>` : '';
    const bs = isNum(p.built_share_2019) && isNum(p.built_share_latest) ? `Built-up share of land ${Math.round(p.built_share_2019)}% → ${Math.round(p.built_share_latest)}% (Sentinel-2, 2019 → ${hexMeta.latest?.year || 'now'})` : (p.why ? esc(p.why) : '');
    d.innerHTML = `<div class="rr-d-top"><div><div class="rr-d-k">${sub}</div><div class="rr-d-n">${esc(p.name)}</div></div>
        <button class="rr-x" id="rr-x" title="Back to London">${icon('x', { size: 16 })}</button></div>
      <div class="avg-line"><span class="a">${money(p.rent_now)}</span>${icon('arrow-right', { size: 18, cls: 'rr-arrow' })}<span class="b">${money(p.rent_12m)}</span></div>
      <div class="rr-d-chg">${pct(p.change_pct, 1)} in 12 months <span>· London ${pct(Lmed.change_pct, 1)}</span></div>
      ${areaLine}
      <div class="rr-stats">
        ${statRow('Rent pressure', p.pressure, Lmed.pressure, v => `${fmt(v)}/100`, 100)}
        ${kind === 'b' ? statRow('New building since 2019', p.built_change_pct, Lmed.built_change_pct, v => pct(v, 1), 30, bs)
          : statRow('Built-up share since 2019', p.built_change_pct, 0, v => `${pts(v)} vs London`, 20, bs)}
      </div>
      <div class="rr-legend-mini"><em></em>London median</div>`;
    $('#rr-x').addEventListener('click', () => select(null));
  }

  // ---------- side: ranking ----------
  const rows = () => (level === 'b' ? boros.map(f => f.properties) : hoodList);
  function renderRank() {
    const m = M(), F = level === 'b' ? m.f : (m.hf || m.f), list = rows().filter(p => isNum(p[m.key])).sort((a, b) => (desc ? b[m.key] - a[m.key] : a[m.key] - b[m.key]));
    const vals = list.map(p => p[m.key]), maxAbs = Math.max(...vals.map(Math.abs), 1e-6), lo = Math.min(0, ...vals);
    const dom = level === 'b' ? domB : domH;
    $('#rank-t').textContent = `${desc ? 'Top' : 'Bottom'} ${level === 'b' ? 'boroughs' : 'neighbourhoods'}`;
    $('#rank-s').textContent = `By ${m.label.toLowerCase()} · ${list.length} ${level === 'b' ? 'boroughs' : 'areas'} · click a row to fly there`;
    $('#sort').querySelector('span').textContent = desc ? 'Highest' : 'Lowest';
    const selKey = sel ? (sel.p.key || sel.p.name) : null;
    $('#rank').innerHTML = list.map((p, i) => {
      const v = p[m.key], w = m.div ? Math.abs(v) / maxAbs * 50 : (lo < 0 ? (v - lo) / (maxAbs - lo) : v / maxAbs) * 100;
      const bar = m.div ? `<i class="dv" style="${v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%;background:${colorFor(p, dom)}"></i><b class="mid"></b>` : `<i style="width:${Math.max(2, w)}%;background:${colorFor(p, dom)}"></i>`;
      const key = p.key || p.name;
      return `<button class="rr-row${key === selKey ? ' on' : ''}" data-k="${esc(key)}">
        <span class="rr-rk">${i + 1}</span>
        <span class="rr-nm"><b>${esc(p.name)}</b>${p._kind === 'n' ? `<small>${key === selKey && sel.p._kind === 'h' ? `area avg · ${p.n} hex` : `${esc(short(p.borough))}${p.n > 1 ? ` · ${p.n} hexagons` : ''}`}</small>` : ''}</span>
        <span class="rr-v">${F(v)}</span>
        <span class="rr-bar">${bar}</span></button>`;
    }).join('');
    $('#rank').querySelectorAll('.rr-row').forEach(r => r.addEventListener('click', () => {
      const p = list.find(x => (x.key || x.name) === r.dataset.k);
      if (p) { select(p); flyTo(p); }
    }));
    $('#rank .rr-row.on')?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- legend ----------
  function renderLegend() {
    const m = M(), dom = level === 'b' ? domB : domH, mid = (dom[0] + dom[1]) / 2, LF = level === 'b' ? m.lf : (m.hlf || m.lf);
    $('#legend').innerHTML = `<div class="rr-lg-t">${esc(m.label)}<span>${level === 'b' ? 'by borough' : 'per hexagon · ~0.7 km²'}</span></div>
      <div class="rr-lg-d">${esc(level === 'b' ? m.desc : (m.hdesc || m.desc))}</div>
      <div class="rr-lg-bar" style="background:linear-gradient(90deg,${m.ramp.join(',')})"></div>
      <div class="rr-lg-l"><span>${LF(dom[0])}</span><span>${m.div ? 'London avg' : LF(mid)}</span><span>${LF(dom[1])}</span></div>
      ${dim === '3d' ? `<div class="rr-lg-h">${icon('box', { size: 13 })}Height = new building seen from orbit</div>` : ''}`;
  }

  renderDetail(); renderRank(); renderLegend();

  // ---------- map ----------
  if (!window.maplibregl) {
    $('#mapc').innerHTML = `<div class="empty" style="height:100%;background:transparent;color:rgba(255,255,255,.6)">Map engine offline</div>`;
    return;
  }
  const container = $('#mapc');
  const map = new maplibregl.Map({ container, style: STYLE, bounds: LONDON, fitBoundsOptions: { padding: PAD }, ...HOME, maxPitch: 70, minZoom: 8.5, maxZoom: 17, attributionControl: { compact: true }, dragRotate: true });
  let styleOk = false;
  const fb = setTimeout(() => { if (!styleOk) map.setStyle(FALLBACK_STYLE); }, 7000);
  map.on('error', e => { if (!styleOk && /style/i.test(String(e?.error?.message || ''))) { clearTimeout(fb); map.setStyle(FALLBACK_STYLE); } });

  const fcB = () => ({ type: 'FeatureCollection', features: boros });
  const fcH = () => ({ type: 'FeatureCollection', features: hexes });
  const ptsB = { type: 'FeatureCollection', features: boros.filter(f => f.properties.centroid).map(f => ({ type: 'Feature', geometry: { type: 'Point', coordinates: f.properties.centroid }, properties: { t: short(f.properties.name), r: -f.properties.rent_now } })) };
  const ptsH = { type: 'FeatureCollection', features: hoodList.map(h => ({ type: 'Feature', geometry: { type: 'Point', coordinates: h.centroid }, properties: { t: h.name, r: -h.n } })) };

  function addLayers() {
    if (map.getSource('boro')) return;
    const layers = map.getStyle().layers || [];
    const top = layers.find(l => l.type === 'symbol')?.id;
    map.addSource('boro', { type: 'geojson', data: fcB() });
    map.addSource('hex', { type: 'geojson', data: fcH() });
    map.addSource('boro-pts', { type: 'geojson', data: ptsB });
    map.addSource('hex-pts', { type: 'geojson', data: ptsH });
    const fillOpacity = ['interpolate', ['linear'], ['zoom'], 9, 0.86, 11, 0.74, 13, 0.55, 15, 0.4, 17, 0.3];
    map.addLayer({ id: 'b-fill', type: 'fill', source: 'boro', maxzoom: HEX_Z, paint: { 'fill-color': ['get', '_c'], 'fill-opacity': fillOpacity } }, top);
    map.addLayer({ id: 'h-fill', type: 'fill', source: 'hex', minzoom: HEX_Z, paint: { 'fill-color': ['get', '_c'], 'fill-opacity': fillOpacity } }, top);
    map.addLayer({ id: 'b-ext', type: 'fill-extrusion', source: 'boro', maxzoom: HEX_Z, paint: { 'fill-extrusion-color': ['get', '_c'], 'fill-extrusion-height': ['get', '_h'], 'fill-extrusion-opacity': 0.9, 'fill-extrusion-vertical-gradient': true } }, top);
    // Street level: flatten + fade the hexagons so streets and names stay readable.
    map.addLayer({ id: 'h-ext', type: 'fill-extrusion', source: 'hex', minzoom: HEX_Z, paint: { 'fill-extrusion-color': ['get', '_c'],
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12, ['get', '_h'], 14, ['*', ['get', '_h'], 0.35], 16, ['*', ['get', '_h'], 0.1]],
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.9, 14, 0.65, 16, 0.45] } }, top);
    map.addLayer({ id: 'h-line', type: 'line', source: 'hex', minzoom: HEX_Z, paint: { 'line-color': '#0B0F14', 'line-opacity': 0.35, 'line-width': 0.6 } }, top);
    map.addLayer({ id: 'b-line', type: 'line', source: 'boro', paint: { 'line-color': '#FFFFFF', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.35, 12, 0.6], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 13, 1.6] } }, top);
    map.addLayer({ id: 'hover-b', type: 'line', source: 'boro', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': '#FFFFFF', 'line-width': 2 } });
    map.addLayer({ id: 'hover-h', type: 'line', source: 'hex', minzoom: HEX_Z, filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#FFFFFF', 'line-width': 2 } });
    map.addLayer({ id: 'sel-b', type: 'line', source: 'boro', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': '#FFFFFF', 'line-width': 3.5 } });
    map.addLayer({ id: 'sel-h', type: 'line', source: 'hex', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#FFFFFF', 'line-width': 3 } });
    const lbl = { 'text-font': FONT, 'text-allow-overlap': false, 'text-padding': 4, 'text-max-width': 7, 'symbol-sort-key': ['get', 'r'] };
    const lp = { 'text-color': '#FFFFFF', 'text-halo-color': 'rgba(0,0,0,.75)', 'text-halo-width': 1.4 };
    map.addLayer({ id: 'b-lbl', type: 'symbol', source: 'boro-pts', maxzoom: HEX_Z, layout: { ...lbl, 'text-field': ['get', 't'], 'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 11, 13] }, paint: lp });
    map.addLayer({ id: 'h-lbl', type: 'symbol', source: 'hex-pts', minzoom: HEX_Z + 0.4, maxzoom: 14.5, layout: { ...lbl, 'text-field': ['get', 't'], 'text-size': 12 }, paint: lp });
    // Basemap place labels clash with ours at city zoom.
    for (const l of layers) if (/^place_(suburbs|villages|town|hamlet)/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
    applyDim(false);
  }
  map.on('style.load', () => { styleOk = true; clearTimeout(fb); addLayers(); });

  function applyDim(animate = true) {
    const flat = dim === '2d';
    for (const id of ['b-fill', 'h-fill']) map.getLayer(id) && map.setLayoutProperty(id, 'visibility', flat ? 'visible' : 'none');
    for (const id of ['b-ext', 'h-ext']) map.getLayer(id) && map.setLayoutProperty(id, 'visibility', flat ? 'none' : 'visible');
    if (animate) map.easeTo({ pitch: flat ? 0 : 50, bearing: flat ? 0 : -12, duration: 900 });
    page.querySelectorAll('#dim button').forEach(b => b.classList.toggle('on', b.dataset.d === dim));
    renderLegend();
  }
  const setData = () => { map.getSource('boro')?.setData(fcB()); map.getSource('hex')?.setData(fcH()); };

  // hover tooltip
  const tipEl = $('#rr-tip');
  const tipRow = (lab, val, on) => `<div class="rr-tr${on ? ' on' : ''}"><span>${lab}</span><b>${val}</b></div>`;
  function showTip(p, x, y) {
    const kind = p._kind;
    tipEl.innerHTML = `<div class="rr-th"><b>${esc(p.name)}</b><span>${kind === 'b' ? 'Borough' : `One hexagon · ${esc(short(p.borough))}`}</span></div>
      ${tipRow('Rent now', `${money(p.rent_now)}<small>/mo</small>`, metric === 'rent_now')}
      ${tipRow('In 12 months', `${money(p.rent_12m)} <em class="${p.change_pct > 0 ? 'up' : 'dn'}">${pct(p.change_pct, 1)}</em>`, metric === 'change_pct')}
      ${tipRow(kind === 'b' ? 'Built change' : 'Built-up share', `${kind === 'b' ? pct(p.built_change_pct, 1) : pts(p.built_change_pct)} <small>vs London</small>`, metric === 'built')}
      ${tipRow('Pressure', `${fmt(p.pressure)}<small>/100</small>`, metric === 'pressure')}
      <div class="rr-tf">Click for details</div>`;
    tipEl.hidden = false;
    const r = container.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    tipEl.style.left = Math.min(r.width - w - 8, x + 16) + 'px';
    tipEl.style.top = Math.max(8, Math.min(r.height - h - 8, y + 16)) + 'px';
  }
  const pickLayers = () => (map.getZoom() >= HEX_Z ? (dim === '2d' ? ['h-fill'] : ['h-ext']) : (dim === '2d' ? ['b-fill'] : ['b-ext']));
  map.on('mousemove', e => {
    if (!map.getLayer('b-fill')) return;
    const f = map.queryRenderedFeatures(e.point, { layers: pickLayers() })[0];
    const p = f && (f.properties._kind === 'h' ? hexes.find(x => x.properties.id === f.properties.id)?.properties : boros.find(x => x.properties.name === f.properties.name)?.properties);
    map.getCanvas().style.cursor = p ? 'pointer' : '';
    if (!p) { tipEl.hidden = true; if (hover) { hover = null; map.setFilter('hover-b', ['==', ['get', 'name'], '']); map.setFilter('hover-h', ['==', ['get', 'id'], '']); } return; }
    if (hover !== p) {
      hover = p;
      map.setFilter('hover-b', ['==', ['get', 'name'], p._kind === 'b' ? p.name : '']);
      map.setFilter('hover-h', ['==', ['get', 'id'], p._kind === 'h' ? p.id : '']);
    }
    showTip(p, e.point.x, e.point.y);
  });
  map.on('mouseout', () => { tipEl.hidden = true; });
  map.on('movestart', () => { tipEl.hidden = true; });
  map.on('click', e => {
    if (!map.getLayer('b-fill')) return;
    const f = map.queryRenderedFeatures(e.point, { layers: pickLayers() })[0];
    if (!f) return select(null);
    const p = f.properties._kind === 'h' ? hexes.find(x => x.properties.id === f.properties.id)?.properties : boros.find(x => x.properties.name === f.properties.name)?.properties;
    select(p || null);
  });

  function select(p) {
    sel = p ? { p } : null;
    if (map.getLayer('sel-b')) {
      map.setFilter('sel-b', ['==', ['get', 'name'], p && p._kind === 'b' ? p.name : '']);
      map.setFilter('sel-h', p && p._kind === 'h' ? ['==', ['get', 'id'], p.id]
        : p && p._kind === 'n' ? ['==', ['get', 'name'], p.name] : ['==', ['get', 'id'], '']);
    }
    renderDetail(); renderRank();
  }
  function homeCam() {
    const c = map.cameraForBounds(LONDON, { padding: PAD });
    if (!c) return {};
    return dim === '2d' ? { center: c.center, zoom: c.zoom, pitch: 0, bearing: 0 }
      : { center: [c.center.lng, c.center.lat - 0.012], zoom: c.zoom + 0.28, pitch: HOME.pitch, bearing: HOME.bearing };
  }
  function goHome() { map.flyTo({ ...homeCam(), duration: 1200 }); }
  map.once('load', () => map.jumpTo(homeCam()));
  function flyTo(p) {
    const bb = p._bb || (p.centroid && [[p.centroid[0] - 0.01, p.centroid[1] - 0.006], [p.centroid[0] + 0.01, p.centroid[1] + 0.006]]);
    if (!bb) return;
    const flat = dim === '2d';
    map.fitBounds(bb, { padding: 70, maxZoom: p._kind === 'b' ? HEX_Z - 0.15 : 13.6, minZoom: p._kind === 'b' ? 0 : HEX_Z + 0.5, pitch: flat ? 0 : 50, bearing: flat ? 0 : -12, duration: 1300 });
  }

  // level follows zoom; the toggle zooms
  const syncLevel = () => {
    const l = map.getZoom() >= HEX_Z && hexes.length ? 'h' : 'b';
    if (l !== level) { level = l; renderRank(); renderLegend(); }
    page.querySelectorAll('#lvl button').forEach(b => b.classList.toggle('on', b.dataset.l === level));
  };
  map.on('zoomend', syncLevel); map.on('moveend', syncLevel);
  page.querySelectorAll('#lvl button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.l === 'h' && !hexes.length) return;
    if (b.dataset.l === 'b') goHome(); else map.easeTo({ zoom: Math.max(12, map.getZoom()), duration: 1000 });
  }));
  if (!hexes.length) $('#lvl [data-l="h"]').disabled = true;
  page.querySelectorAll('#dim button').forEach(b => b.addEventListener('click', () => { dim = b.dataset.d; applyDim(); }));
  page.querySelectorAll('.rr-zoom button').forEach(b => b.addEventListener('click', () => {
    const z = +b.dataset.z;
    if (z === 0) goHome();
    else map.easeTo({ zoom: map.getZoom() + z, duration: 400 });
  }));
  page.querySelectorAll('#metric button').forEach(b => b.addEventListener('click', () => {
    page.querySelectorAll('#metric button').forEach(x => x.classList.toggle('on', x === b));
    metric = b.dataset.m; recolor(); setData(); renderLegend(); renderRank();
  }));
  $('#sort').addEventListener('click', () => { desc = !desc; renderRank(); });

  // search
  const q = $('#rr-q'), res = $('#rr-res');
  const index = [...boros.map(f => f.properties), ...hoodList];
  let hits = [], hi = 0;
  const drawHits = () => {
    res.hidden = !hits.length;
    res.innerHTML = hits.map((p, i) => `<button class="${i === hi ? 'on' : ''}" data-i="${i}">${icon(p._kind === 'b' ? 'landmark' : 'map-pin', { size: 14 })}<b>${esc(p.name)}</b><small>${p._kind === 'b' ? 'Borough' : esc(short(p.borough))}</small></button>`).join('');
    res.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', ev => { ev.preventDefault(); pick(hits[+b.dataset.i]); }));
  };
  const pick = p => { if (!p) return; q.value = p.name; hits = []; drawHits(); q.blur(); select(p); flyTo(p); };
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    hits = s ? index.filter(p => p.name.toLowerCase().includes(s)).sort((a, b) => a.name.toLowerCase().indexOf(s) - b.name.toLowerCase().indexOf(s) || (a._kind === 'b' ? -1 : 1)).slice(0, 7) : [];
    hi = 0; drawHits();
  });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { hi = Math.min(hits.length - 1, hi + 1); drawHits(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); drawHits(); e.preventDefault(); }
    else if (e.key === 'Enter') pick(hits[hi]);
    else if (e.key === 'Escape') { hits = []; drawHits(); q.blur(); }
  });
  q.addEventListener('blur', () => setTimeout(() => { hits = []; drawHits(); }, 120));
  map.once('mousedown', () => $('#rr-hint')?.classList.add('gone'));
  map.once('wheel', () => $('#rr-hint')?.classList.add('gone'));

  const ro = new ResizeObserver(() => map.resize()); ro.observe(container);
  return () => { clearTimeout(fb); ro.disconnect(); try { map.remove(); } catch {} };
}
