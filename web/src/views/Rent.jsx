// Rent Radar: London rents × new building seen from orbit.
// MapLibre (CARTO streets) with borough polygons at city zoom and H3 neighbourhood hexagons (~0.7 km²) from zoom 11.
// 2D / 3D toggle, metric toggle (recolours map + legend + ranking), hover tooltip, click for details, search.
// Ported from vanilla js/views/rent.js: React owns every panel, MapLibre keeps the map and its layers.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Topbar } from '@/components/orbit/chrome.jsx';
import { Icon } from '@/lib/icons.jsx';
import { api, useAsync } from '@/lib/api.js';
import { MODULE_META } from '@/lib/meta.js';
import { fmt, isNum, money, pct, plainAI, tint } from '@/lib/format.js';
import { CountUp } from '@/lib/dom.jsx';
import { watchMap } from '@/lib/motion.js';

const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const FALLBACK_STYLE = {
  version: 8, glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
  sources: { r: { type: 'raster', tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap © CARTO' } },
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0B0F14' } }, { id: 'r', type: 'raster', source: 'r' }],
};
const FONT = ['Montserrat Medium', 'Open Sans Bold', 'Noto Sans Regular'];
const LONDON = [[-0.53, 51.28], [0.345, 51.695]];
const HOME = { pitch: 45, bearing: -12 };
const PAD = { top: 72, bottom: 36, left: 36, right: 72 };
const HEX_Z = 11; // neighbourhood hexagons from this zoom

const SEQ = ['#FDE68A', '#FB923C', '#EA580C', '#991B1B'];
const DIV = ['#0F766E', '#5EEAD4', '#57534E', '#FDBA74', '#EA580C'];
const pts = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)} pts` : '–');
const METRICS = {
  pressure: { label: 'Pressure', key: 'pressure', ramp: SEQ, f: v => `${fmt(v)}/100`, lf: v => fmt(v), desc: 'Expected rent growth, ranked across London (0 = calmest, 100 = hottest)' },
  rent_now: { label: 'Rent now', key: 'rent_now', ramp: SEQ, f: v => money(v), lf: v => money(v), desc: 'Typical 1-bed rent per month today' },
  change_pct: { label: '12-month change', key: 'change_pct', ramp: SEQ, f: v => pct(v, 1), lf: v => pct(v, 1), desc: 'Forecast rent change over the next 12 months' },
  built: { label: 'Built change', key: 'built_change_pct', ramp: DIV, div: true, f: v => pct(v, 1), lf: v => pct(v, 0), desc: 'New building seen by Sentinel-2 since 2019, vs the London average',
    hf: v => pts(v), hlf: v => pts(v, 0), hdesc: 'Change in built-up share of land since 2019 (Sentinel-2), vs the London average' },
};

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
const short = n => String(n || '').replace(' and ', ' & ').replace(' upon Thames', '');
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/** Fill single-cell holes in the hexagon grid (cells with no satellite result, e.g. at Canary Wharf). */
function fillHexGaps(hexes) {
  if (hexes.length < 20) return;
  const K = Math.cos(51.5 * Math.PI / 180);
  const pt = f => [f.properties.centroid[0] * K, f.properties.centroid[1]];
  const P = hexes.map(pt);
  const mid = P[Math.floor(P.length / 2)];
  const near = P.map(q => [q, Math.hypot(q[0] - mid[0], q[1] - mid[1])]).filter(x => x[1] > 0).sort((a, b) => a[1] - b[1]).slice(0, 6);
  if (near.length < 6) return;
  const r = near[5][1], offs = near.map(([q]) => [q[0] - mid[0], q[1] - mid[1]]);
  const cellOf = q => `${Math.round(q[0] / (r * 0.5))},${Math.round(q[1] / (r * 0.5))}`;
  const grid = new Map();
  P.forEach((q, i) => grid.set(cellOf(q), i));
  const find = q => { const [cx, cy] = cellOf(q).split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const i = grid.get(`${cx + dx},${cy + dy}`); if (i != null && Math.hypot(P[i][0] - q[0], P[i][1] - q[1]) < r * 0.4) return i; }
    return null; };
  const seen = new Set(), add = [];
  P.forEach(q => offs.forEach(([ox, oy]) => {
    const g = [q[0] + ox, q[1] + oy], k = cellOf(g);
    if (seen.has(k)) return; seen.add(k);
    if (find(g) != null) return;
    const nb = offs.map(([a, b]) => find([g[0] + a, g[1] + b])).filter(i => i != null);
    if (nb.length < 5) return;
    const src = hexes[nb[0]], [sx, sy] = [(P[nb[0]][0] - g[0]) / K, P[nb[0]][1] - g[1]];
    const props = { ...src.properties, id: `fill-${k}`, centroid: [g[0] / K, g[1]] };
    for (const key of ['rent_now', 'rent_12m', 'change_pct', 'built_change_pct', 'pressure', 'built_share_2019', 'built_share_latest']) props[key] = mean(nb.map(i => hexes[i].properties[key]).filter(isNum));
    const names = {}; nb.forEach(i => (names[hexes[i].properties.name] = (names[hexes[i].properties.name] || 0) + 1));
    props.name = Object.entries(names).sort((a, b) => b[1] - a[1])[0][0];
    const shift = c => (typeof c[0] === 'number' ? [c[0] - sx, c[1] - sy] : c.map(shift));
    add.push({ type: 'Feature', geometry: { type: src.geometry.type, coordinates: shift(src.geometry.coordinates) }, properties: props });
  }));
  hexes.push(...add);
}

export default function Rent() {
  const meta = MODULE_META.rent;
  const { data } = useAsync(async () => {
    const [geo, hexGeo, mod] = await Promise.all([api('/api/rent'), api('/api/rent/hex').catch(() => null), api('/api/modules/rent').catch(() => null)]);
    const boros = (geo?.features || []).filter(f => f?.geometry && f.properties?.name);
    const hexes = (hexGeo?.features || []).filter(f => f?.geometry && f.properties?.id && f.properties.centroid);
    fillHexGaps(hexes);
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
    const Lmed = {}; for (const m of Object.values(METRICS)) Lmed[m.key] = quant(boros.map(f => f.properties[m.key]).filter(isNum), 0.5);
    return {
      boros, hexes, hoodList, Lmed, hexMeta: hexGeo?.meta || {},
      avgRent: mean(boros.map(f => f.properties.rent_now).filter(isNum)),
      avgNext: mean(boros.map(f => f.properties.rent_12m).filter(isNum)),
      insight: plainAI(mod?.insights?.cards?.[0]?.text) || mod?.insights?.headline
        || 'East London is adding rooftops fastest, yet rents still lead the city. New supply is not keeping up.',
    };
  }, []);

  const [metric, setMetric] = useState('pressure');
  const [level, setLevel] = useState('b');
  const [dim, setDim] = useState('3d');
  const [desc, setDesc] = useState(true);
  const [sel, setSel] = useState(null);
  const [tip, setTip] = useState(null); // {p, x, y}
  const [hintGone, setHintGone] = useState(false);

  const container = useRef(null);
  const mapRef = useRef(null);
  const tipEl = useRef(null);
  // Latest state for the MapLibre handlers, which live outside the render cycle.
  const st = useRef({ metric, level, dim, sel });
  useEffect(() => { st.current = { metric, level, dim, sel }; }, [metric, level, dim, sel]);

  const M = METRICS[metric];
  // Stable identities: the map effect and the colour memo must not re-run on every render.
  const EMPTY = useMemo(() => [], []);
  const boros = data?.boros || EMPTY, hexes = data?.hexes || EMPTY, hoodList = data?.hoodList || EMPTY;

  // ---------- colour domains ----------
  const doms = useMemo(() => {
    if (!data) return { b: [0, 1], h: [0, 1] };
    const m = METRICS[metric];
    const domainOf = feats => {
      const v = feats.map(p => p[m.key]).filter(isNum);
      if (!v.length) return [0, 1];
      let lo = quant(v, 0.03), hi = quant(v, 0.97);
      if (m.div) { const a = Math.max(Math.abs(lo), Math.abs(hi), 1); lo = -a; hi = a; }
      if (metric === 'pressure') { lo = 0; hi = 100; }
      return [lo, hi === lo ? lo + 1 : hi];
    };
    const b = domainOf(boros.map(f => f.properties)), h = domainOf(hexes.map(f => f.properties));
    const colorFor = (p, dom) => (isNum(p[m.key]) ? rampColor(m.ramp, (p[m.key] - dom[0]) / (dom[1] - dom[0])) : '#44403C');
    boros.forEach(f => { const p = f.properties; p._c = colorFor(p, b); p._h = 250 + Math.max(0, p.built_change_pct ?? 0) * 170; });
    hexes.forEach(f => { const p = f.properties; p._c = colorFor(p, h); p._h = 40 + Math.max(0, p.built_change_pct ?? 0) * 26; });
    return { b, h };
  }, [data, metric, boros, hexes]);
  const colorFor = (p, dom) => (isNum(p[M.key]) ? rampColor(M.ramp, (p[M.key] - dom[0]) / (dom[1] - dom[0])) : '#44403C');

  const flyTo = useCallback(p => {
    const map = mapRef.current; if (!map) return;
    const bb = p._bb || (p.centroid && [[p.centroid[0] - 0.01, p.centroid[1] - 0.006], [p.centroid[0] + 0.01, p.centroid[1] + 0.006]]);
    if (!bb) return;
    const flat = st.current.dim === '2d';
    map.fitBounds(bb, { padding: 70, maxZoom: p._kind === 'b' ? HEX_Z - 0.15 : 13.6, minZoom: p._kind === 'b' ? 0 : HEX_Z + 0.5, pitch: flat ? 0 : 50, bearing: flat ? 0 : -12, duration: 1300 });
  }, []);

  const homeCam = useCallback(() => {
    const map = mapRef.current;
    const c = map?.cameraForBounds(LONDON, { padding: PAD });
    if (!c) return {};
    return st.current.dim === '2d' ? { center: c.center, zoom: c.zoom, pitch: 0, bearing: 0 }
      : { center: [c.center.lng, c.center.lat - 0.012], zoom: c.zoom + 0.28, pitch: HOME.pitch, bearing: HOME.bearing };
  }, []);
  const goHome = useCallback(() => mapRef.current?.flyTo({ ...homeCam(), duration: 1200 }), [homeCam]);

  // ---------- the map ----------
  useEffect(() => {
    if (!data || !boros.length) return undefined;
    const fcB = () => ({ type: 'FeatureCollection', features: boros });
    const fcH = () => ({ type: 'FeatureCollection', features: hexes });
    const ptsB = { type: 'FeatureCollection', features: boros.filter(f => f.properties.centroid).map(f => ({ type: 'Feature', geometry: { type: 'Point', coordinates: f.properties.centroid }, properties: { t: short(f.properties.name), r: -f.properties.rent_now } })) };
    const ptsH = { type: 'FeatureCollection', features: hoodList.map(h => ({ type: 'Feature', geometry: { type: 'Point', coordinates: h.centroid }, properties: { t: h.name, r: -h.n } })) };

    const map = watchMap(new maplibregl.Map({
      container: container.current, style: STYLE, bounds: LONDON, fitBoundsOptions: { padding: PAD }, ...HOME,
      maxPitch: 70, minZoom: 8.5, maxZoom: 17, attributionControl: { compact: true }, dragRotate: true,
    }));
    mapRef.current = map;
    let styleOk = false;
    const fb = setTimeout(() => { if (!styleOk) map.setStyle(FALLBACK_STYLE); }, 7000);
    map.on('error', e => { if (!styleOk && /style/i.test(String(e?.error?.message || ''))) { clearTimeout(fb); map.setStyle(FALLBACK_STYLE); } });

    function applyDim() {
      const flat = st.current.dim === '2d';
      for (const id of ['b-fill', 'h-fill']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', flat ? 'visible' : 'none');
      for (const id of ['b-ext', 'h-ext']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', flat ? 'none' : 'visible');
    }

    function addLayers() {
      if (map.getSource('boro')) return;
      const layers = map.getStyle().layers || [];
      const top = layers.find(l => l.type === 'symbol')?.id;
      map.addSource('boro', { type: 'geojson', data: fcB() });
      map.addSource('hex', { type: 'geojson', data: fcH() });
      map.addSource('boro-pts', { type: 'geojson', data: ptsB });
      map.addSource('hex-pts', { type: 'geojson', data: ptsH });
      const fillOpacity = ['interpolate', ['linear'], ['zoom'], 9, 0.84, 10, 0.75, 12, 0.55, 13, 0.45, 14, 0.35, 17, 0.28];
      map.addLayer({ id: 'b-fill', type: 'fill', source: 'boro', maxzoom: HEX_Z, paint: { 'fill-color': ['get', '_c'], 'fill-opacity': fillOpacity } }, top);
      map.addLayer({ id: 'h-fill', type: 'fill', source: 'hex', minzoom: HEX_Z, paint: { 'fill-color': ['get', '_c'], 'fill-opacity': fillOpacity } }, top);
      map.addLayer({ id: 'b-ext', type: 'fill-extrusion', source: 'boro', maxzoom: HEX_Z, paint: { 'fill-extrusion-color': ['get', '_c'], 'fill-extrusion-height': ['get', '_h'], 'fill-extrusion-opacity': 0.9, 'fill-extrusion-vertical-gradient': true } }, top);
      // Street level: flatten + fade the hexagons so streets and names stay readable.
      map.addLayer({ id: 'h-ext', type: 'fill-extrusion', source: 'hex', minzoom: HEX_Z, paint: { 'fill-extrusion-color': ['get', '_c'],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12, ['get', '_h'], 14, ['*', ['get', '_h'], 0.35], 16, ['*', ['get', '_h'], 0.1]],
        'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.85, 12, 0.7, 13, 0.5, 14, 0.36, 16, 0.3] } }, top);
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
      // Street / place names stay readable over the colour: light text with a dark halo.
      for (const l of layers) if (l.type === 'symbol' && /road|street|place|poi|water/.test(l.id) && map.getLayoutProperty(l.id, 'visibility') !== 'none') {
        try { map.setPaintProperty(l.id, 'text-color', '#F5F5F4'); map.setPaintProperty(l.id, 'text-halo-color', 'rgba(8,10,14,.9)'); map.setPaintProperty(l.id, 'text-halo-width', 1.6); } catch { /* ignore */ }
      }
      applyDim();
    }
    map.on('style.load', () => { styleOk = true; clearTimeout(fb); addLayers(); });

    const pickLayers = () => (map.getZoom() >= HEX_Z ? (st.current.dim === '2d' ? ['h-fill'] : ['h-ext']) : (st.current.dim === '2d' ? ['b-fill'] : ['b-ext']));
    let hover = null;
    map.on('mousemove', e => {
      if (!map.getLayer('b-fill')) return;
      const f = map.queryRenderedFeatures(e.point, { layers: pickLayers() })[0];
      const p = f && (f.properties._kind === 'h' ? hexes.find(x => x.properties.id === f.properties.id)?.properties : boros.find(x => x.properties.name === f.properties.name)?.properties);
      map.getCanvas().style.cursor = p ? 'pointer' : '';
      if (!p) {
        setTip(null);
        if (hover) { hover = null; map.setFilter('hover-b', ['==', ['get', 'name'], '']); map.setFilter('hover-h', ['==', ['get', 'id'], '']); }
        return;
      }
      if (hover !== p) {
        hover = p;
        map.setFilter('hover-b', ['==', ['get', 'name'], p._kind === 'b' ? p.name : '']);
        map.setFilter('hover-h', ['==', ['get', 'id'], p._kind === 'h' ? p.id : '']);
      }
      setTip({ p, x: e.point.x, y: e.point.y });
    });
    map.on('mouseout', () => setTip(null));
    map.on('movestart', () => setTip(null));
    map.on('click', e => {
      if (!map.getLayer('b-fill')) return;
      const f = map.queryRenderedFeatures(e.point, { layers: pickLayers() })[0];
      if (!f) return setSel(null);
      const p = f.properties._kind === 'h' ? hexes.find(x => x.properties.id === f.properties.id)?.properties : boros.find(x => x.properties.name === f.properties.name)?.properties;
      setSel(p || null);
    });

    // level follows zoom
    const syncLevel = () => setLevel(map.getZoom() >= HEX_Z && hexes.length ? 'h' : 'b');
    map.on('zoomend', syncLevel);
    map.on('moveend', syncLevel);
    map.once('load', () => map.jumpTo(homeCam()));
    map.once('mousedown', () => setHintGone(true));
    map.once('wheel', () => setHintGone(true));

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container.current);
    return () => { clearTimeout(fb); ro.disconnect(); try { map.remove(); } catch { /* ignore */ } mapRef.current = null; };
  }, [data, boros, hexes, hoodList, homeCam]);

  // metric recolour → push the new feature colours to the map
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource('boro')) return;
    map.getSource('boro').setData({ type: 'FeatureCollection', features: boros });
    map.getSource('hex').setData({ type: 'FeatureCollection', features: hexes });
  }, [doms, boros, hexes]);

  // 2D / 3D
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('b-fill')) return;
    const flat = dim === '2d';
    for (const id of ['b-fill', 'h-fill']) map.setLayoutProperty(id, 'visibility', flat ? 'visible' : 'none');
    for (const id of ['b-ext', 'h-ext']) map.setLayoutProperty(id, 'visibility', flat ? 'none' : 'visible');
    map.easeTo({ pitch: flat ? 0 : 50, bearing: flat ? 0 : -12, duration: 900 });
  }, [dim]);

  // selection outline
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('sel-b')) return;
    const p = sel;
    map.setFilter('sel-b', ['==', ['get', 'name'], p && p._kind === 'b' ? p.name : '']);
    map.setFilter('sel-h', p && p._kind === 'h' ? ['==', ['get', 'id'], p.id]
      : p && p._kind === 'n' ? ['==', ['get', 'name'], p.name] : ['==', ['get', 'id'], '']);
  }, [sel]);

  // tooltip placement inside the map card
  useLayoutEffect(() => {
    if (!tip || !tipEl.current || !container.current) return;
    const el = tipEl.current, r = container.current.getBoundingClientRect();
    el.style.left = Math.min(r.width - el.offsetWidth - 8, tip.x + 16) + 'px';
    el.style.top = Math.max(8, Math.min(r.height - el.offsetHeight - 8, tip.y + 16)) + 'px';
  }, [tip]);

  const zoomBy = z => {
    const map = mapRef.current; if (!map) return;
    if (z === 0) goHome(); else map.easeTo({ zoom: map.getZoom() + z, duration: 400 });
  };
  const setLevelByZoom = l => {
    const map = mapRef.current; if (!map) return;
    if (l === 'h' && !hexes.length) return;
    map.stop();
    if (l === 'b') goHome(); else map.easeTo({ zoom: Math.max(12, map.getZoom()), duration: 1000 });
  };

  return (
    <>
      <Topbar
        crumb="Modules  /  Rent Radar"
        title="Rent Radar"
        iconSquare={<div className="icon-sq lg" style={{ background: tint(meta.color) }}><Icon name="building-2" size={22} /></div>}
        tagline="London · new building seen from orbit × rents"
        right={
          <ToggleGroup type="single" className="seg dark" value={metric} onValueChange={v => v && setMetric(v)}>
            {Object.entries(METRICS).map(([k, m]) => (
              <ToggleGroupItem key={k} value={k} className={k === metric ? 'on' : undefined}>{m.label}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <section className="rent-row rr">
        <div className="map3d">
          <div className="mapc" ref={container}>
            {data && !boros.length ? (
              <div className="empty" style={{ height: '100%', background: 'transparent', color: 'rgba(255,255,255,.6)' }}>Borough data is being built on Modal…</div>
            ) : null}
          </div>
          <div className="rr-tl">
            <Search boros={boros} hoodList={hoodList} onPick={p => { setSel(p); flyTo(p); }} />
            <div className="rr-toggles">
              <div className="rr-seg glass-s">
                {['2d', '3d'].map(d => <button key={d} className={d === dim ? 'on' : ''} onClick={() => setDim(d)}>{d.toUpperCase()}</button>)}
              </div>
              <div className="rr-seg glass-s">
                <button className={level === 'b' ? 'on' : ''} onClick={() => setLevelByZoom('b')}>Boroughs</button>
                <button className={level === 'h' ? 'on' : ''} disabled={!hexes.length} onClick={() => setLevelByZoom('h')}>Neighbourhoods</button>
              </div>
            </div>
          </div>
          <div className="rr-zoom glass-s">
            <button title="Zoom in" onClick={() => zoomBy(1)}><Icon name="plus" size={16} /></button>
            <button title="Zoom out" onClick={() => zoomBy(-1)}><Icon name="minus" size={16} /></button>
            <button title="Reset view" onClick={() => zoomBy(0)}><Icon name="maximize" size={15} /></button>
          </div>
          <Legend M={M} level={level} dim={dim} dom={level === 'b' ? doms.b : doms.h} />
          <div className="rr-tip" ref={tipEl} hidden={!tip}>{tip ? <TipBody p={tip.p} metric={metric} /> : null}</div>
          <div className={`rr-hint glass-s${hintGone ? ' gone' : ''}`}>
            <Icon name="mouse-pointer-click" size={14} />
            <span>Hover an area · click for details · scroll to zoom to street level</span>
          </div>
        </div>
        <div className="side rr-side">
          <div className="card rr-detail">
            {!data ? <div className="skeleton" style={{ height: 150 }} />
              : !boros.length ? <div className="empty">Pending</div>
                : <Detail sel={sel} data={data} hoodList={hoodList} onClose={() => setSel(null)} />}
          </div>
          <div className="card rr-rank">
            <div className="rr-rank-h">
              <div>
                <div className="card-title">{desc ? 'Top' : 'Bottom'} {level === 'b' ? 'boroughs' : 'neighbourhoods'}</div>
                <div className="rr-rank-s">
                  By {M.label.toLowerCase()} · {(level === 'b' ? boros.length : hoodList.length)} {level === 'b' ? 'boroughs' : 'areas'} · click a row to fly there
                </div>
              </div>
              <button className="rr-sort" title="Flip order" onClick={() => setDesc(d => !d)}>
                <Icon name="arrow-down-wide-narrow" size={15} /><span>{desc ? 'Highest' : 'Lowest'}</span>
              </button>
            </div>
            <Rank
              rows={level === 'b' ? boros.map(f => f.properties) : hoodList}
              M={M} level={level} desc={desc} sel={sel} dom={level === 'b' ? doms.b : doms.h}
              colorFor={colorFor}
              onPick={p => { setSel(p); flyTo(p); }}
            />
          </div>
          <div className="card ink-card rr-ins">
            <div className="lbl"><Icon name="sparkles" size={15} />Gemini sees</div>
            <p>{data?.insight || 'Reading London from orbit…'}</p>
          </div>
        </div>
      </section>
    </>
  );
}

/* ---------- side: detail card ---------- */
function StatRow({ label, v, refV, f, max, hint }) {
  const w = isNum(v) && max ? Math.min(100, Math.abs(v) / max * 100) : 0;
  const rw = isNum(refV) && max ? Math.min(100, Math.abs(refV) / max * 100) : 0;
  return (
    <div className="rr-stat" title={hint ? String(hint).replace(/<[^>]+>/g, '') : undefined}>
      <div className="rr-stat-l">
        <span>{label}{hint ? <span className="rr-d-i"><Icon name="info" size={12} /></span> : null}</span>
        <b>{isNum(v) ? f(v) : '–'}</b>
      </div>
      <div className="rr-stat-bar">
        <i style={{ width: `${w}%` }} className={isNum(v) && v < 0 ? 'neg' : ''} />
        {isNum(refV) ? <em style={{ left: `${rw}%` }} title={`London median ${f(refV)}`} /> : null}
      </div>
    </div>
  );
}

function Detail({ sel, data, hoodList, onClose }) {
  const { avgRent, avgNext, Lmed, hexes, hexMeta } = data;
  if (!sel) {
    return (
      <>
        <div className="rr-d-top"><div><div className="rr-d-k">Greater London</div><div className="rr-d-n">Average 1-bed rent</div></div></div>
        <div className="avg-line">
          <span className="a">{money(avgRent)}</span>
          <Icon name="arrow-right" size={18} className="rr-arrow" />
          <CountUp as="span" className="b" to={avgNext} prefix="£" placeholder={money(avgNext)} />
        </div>
        <div className="rr-d-chg">{pct((avgNext / avgRent - 1) * 100, 1)} in 12 months</div>
        <div className="rr-d-tip">
          <Icon name="info" size={14} />
          <span>Click any area on the map or in the ranking for its details. Zoom in past the borough level to see {hexes.length ? `${fmt(hexes.length)} neighbourhood hexagons` : 'neighbourhoods'}.</span>
        </div>
      </>
    );
  }
  const p = sel, kind = p._kind;
  const sub = kind === 'b' ? 'London borough' : kind === 'h' ? `One hexagon (~0.7 km²) · ${short(p.borough)}` : `Neighbourhood average · ${short(p.borough)}`;
  const area = kind === 'h' ? hoodList.find(h => h.key === p.name) : null;
  const areaTip = area && area.n > 1 ? `Whole ${area.name} area (${area.n} hexagons, as ranked): ${money(area.rent_now)} · ${pct(area.change_pct, 1)} · pressure ${fmt(area.pressure)}/100` : '';
  const bs = isNum(p.built_share_2019) && isNum(p.built_share_latest)
    ? `Built-up share of land ${Math.round(p.built_share_2019)}% → ${Math.round(p.built_share_latest)}% (Sentinel-2, 2019 → ${hexMeta.latest?.year || 'now'})`
    : (p.why || '');
  return (
    <>
      <div className="rr-d-top">
        <div>
          <div className="rr-d-k">{sub}</div>
          <div className="rr-d-n" title={areaTip || undefined}>{p.name}{areaTip ? <span className="rr-d-i"><Icon name="info" size={13} /></span> : null}</div>
        </div>
        <button className="rr-x" title="Back to London" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      <div className="avg-line">
        <span className="a">{money(p.rent_now)}</span>
        <Icon name="arrow-right" size={18} className="rr-arrow" />
        <span className="b">{money(p.rent_12m)}</span>
      </div>
      <div className="rr-d-chg">{pct(p.change_pct, 1)} in 12 months <span>· London {pct(Lmed.change_pct, 1)}</span></div>
      <div className="rr-stats">
        <StatRow label="Rent pressure" v={p.pressure} refV={Lmed.pressure} f={v => `${fmt(v)}/100`} max={100} />
        {kind === 'b'
          ? <StatRow label="New building since 2019" v={p.built_change_pct} refV={Lmed.built_change_pct} f={v => pct(v, 1)} max={30} hint={bs} />
          : <StatRow label="Built-up share since 2019" v={p.built_change_pct} refV={0} f={v => `${pts(v)} vs London`} max={20} hint={bs} />}
      </div>
      <div className="rr-legend-mini"><em />London median</div>
    </>
  );
}

/* ---------- side: ranking ---------- */
function Rank({ rows, M, level, desc, sel, dom, colorFor, onPick }) {
  const box = useRef(null);
  const F = level === 'b' ? M.f : (M.hf || M.f);
  const list = rows.filter(p => isNum(p[M.key])).sort((a, b) => (desc ? b[M.key] - a[M.key] : a[M.key] - b[M.key]));
  const vals = list.map(p => p[M.key]), maxAbs = Math.max(...vals.map(Math.abs), 1e-6), lo = Math.min(0, ...vals);
  const selKey = sel ? (sel.key || sel.name) : null;

  useLayoutEffect(() => {
    const on = box.current?.querySelector('.rr-row.on');
    if (!on) return;
    const b = box.current, t = on.offsetTop - b.offsetTop;
    if (t < b.scrollTop || t + on.offsetHeight > b.scrollTop + b.clientHeight) b.scrollTop = t - b.clientHeight / 2 + on.offsetHeight / 2;
  }, [selKey, level, desc, M]);

  return (
    <div className="rr-list" ref={box}>
      {list.map((p, i) => {
        const v = p[M.key], w = M.div ? Math.abs(v) / maxAbs * 50 : (lo < 0 ? (v - lo) / (maxAbs - lo) : v / maxAbs) * 100;
        const key = p.key || p.name;
        return (
          <button className={`rr-row${key === selKey ? ' on' : ''}`} key={key} onClick={() => onPick(p)}>
            <span className="rr-rk">{i + 1}</span>
            <span className="rr-nm">
              <b>{p.name}</b>
              {p._kind === 'n' ? (
                <small>{key === selKey && sel._kind === 'h' ? `area avg · ${p.n} hex` : `${short(p.borough)}${p.n > 1 ? ` · ${p.n} hexagons` : ''}`}</small>
              ) : null}
            </span>
            <span className="rr-v">{F(v)}</span>
            <span className="rr-bar">
              {M.div ? (<>
                <i className="dv" style={{ ...(v >= 0 ? { left: '50%' } : { left: `${50 - w}%` }), width: `${w}%`, background: colorFor(p, dom) }} />
                <b className="mid" />
              </>) : (
                <i style={{ width: `${Math.max(2, w)}%`, background: colorFor(p, dom) }} />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------- legend + hover tooltip ---------- */
function Legend({ M, level, dim, dom }) {
  const mid = (dom[0] + dom[1]) / 2, LF = level === 'b' ? M.lf : (M.hlf || M.lf);
  return (
    <div className="rr-legend glass-s">
      <div className="rr-lg-t">{M.label}<span>{level === 'b' ? 'by borough' : 'per hexagon · ~0.7 km²'}</span></div>
      <div className="rr-lg-d">{level === 'b' ? M.desc : (M.hdesc || M.desc)}</div>
      <div className="rr-lg-bar" style={{ background: `linear-gradient(90deg,${M.ramp.join(',')})` }} />
      <div className="rr-lg-l"><span>{LF(dom[0])}</span><span>{M.div ? 'London avg' : LF(mid)}</span><span>{LF(dom[1])}</span></div>
      {dim === '3d' ? <div className="rr-lg-h"><Icon name="box" size={13} />Height = new building seen from orbit</div> : null}
    </div>
  );
}

const TipRow = ({ lab, on, children }) => <div className={`rr-tr${on ? ' on' : ''}`}><span>{lab}</span><b>{children}</b></div>;

function TipBody({ p, metric }) {
  const kind = p._kind;
  return (
    <>
      <div className="rr-th"><b>{p.name}</b><span>{kind === 'b' ? 'Borough' : `One hexagon · ${short(p.borough)}`}</span></div>
      <TipRow lab="Rent now" on={metric === 'rent_now'}>{money(p.rent_now)}<small>/mo</small></TipRow>
      <TipRow lab="In 12 months" on={metric === 'change_pct'}>
        {money(p.rent_12m)} <em className={p.change_pct > 0 ? 'up' : 'dn'}>{pct(p.change_pct, 1)}</em>
      </TipRow>
      <TipRow lab={kind === 'b' ? 'Built change' : 'Built-up share'} on={metric === 'built'}>
        {kind === 'b' ? pct(p.built_change_pct, 1) : pts(p.built_change_pct)} <small>vs London</small>
      </TipRow>
      <TipRow lab="Pressure" on={metric === 'pressure'}>{fmt(p.pressure)}<small>/100</small></TipRow>
      <div className="rr-tf">Click for details</div>
    </>
  );
}

/* ---------- search ---------- */
function Search({ boros, hoodList, onPick }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [hi, setHi] = useState(0);
  const input = useRef(null);
  const index = useMemo(() => [...boros.map(f => f.properties), ...hoodList], [boros, hoodList]);

  const search = s => {
    const t = s.trim().toLowerCase();
    setHits(t ? index.filter(p => p.name.toLowerCase().includes(t))
      .sort((a, b) => a.name.toLowerCase().indexOf(t) - b.name.toLowerCase().indexOf(t) || (a._kind === 'b' ? -1 : 1)).slice(0, 7) : []);
    setHi(0);
  };
  const pick = p => { if (!p) return; setQ(p.name); setHits([]); input.current?.blur(); onPick(p); };

  return (
    <div className="rr-search glass-s">
      <span className="rr-si"><Icon name="search" size={15} /></span>
      <input
        ref={input}
        value={q}
        placeholder="Search a borough or area…"
        autoComplete="off"
        spellCheck="false"
        onChange={e => { setQ(e.target.value); search(e.target.value); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { setHi(h => Math.min(hits.length - 1, h + 1)); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { setHi(h => Math.max(0, h - 1)); e.preventDefault(); }
          else if (e.key === 'Enter') pick(hits[hi]);
          else if (e.key === 'Escape') { setHits([]); input.current.blur(); }
        }}
        onBlur={() => setTimeout(() => setHits([]), 120)}
      />
      <div className="rr-res" hidden={!hits.length}>
        {hits.map((p, i) => (
          <button key={p.key || p.name} className={i === hi ? 'on' : ''} onMouseDown={e => { e.preventDefault(); pick(p); }}>
            <Icon name={p._kind === 'b' ? 'landmark' : 'map-pin'} size={14} />
            <b>{p.name}</b>
            <small>{p._kind === 'b' ? 'Borough' : short(p.borough)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
