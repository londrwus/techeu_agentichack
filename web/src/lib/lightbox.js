// Satellite lightbox: click ANY satellite tile anywhere in the app to open it big.
// Works by global click delegation, so views only need to render one of:
//   <img data-sat-region="minas_coffee" data-sat-month="2026-08">   (ui.js satImg() does this)
//   <img class="sat" src="/tiles/{region}/{YYYY-MM}.png">            (or any <img> whose src is a /tiles/ PNG)
// Opt out on a subtree (e.g. a drag-compare slider) with data-no-lightbox.
// ECharts and MapLibre are imported on demand so the entry bundle stays small.
// Tabs: "Satellite tile" (wheel/drag zoom, month scrubber + timelapse) · "Explore" (MapLibre on EOX Sentinel-2 cloudless).
import { api } from './api.js';
import { esc, isNum } from './format.js';
import { MODULE_META, ITEM_META } from './meta.js';
import { iconSvg as icon } from './icons.jsx';
import { axisTooltip, tipHtml, fmtMonth, fmtPct } from './chartTheme.js';

const EOX = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg';
const TILE_RE = /\/tiles\/([^/]+)\/(\d{4}-\d{2})\.png/;
const MODULES = ['groceries', 'latte', 'beer_wine', 'gpu'];

let regionsP = null;
function regionIndex() {
  regionsP ||= Promise.all(MODULES.map(m => api(`/api/modules/${m}`))).then(ms => {
    const idx = {};
    ms.forEach((m, k) => (m?.regions || []).forEach(r => { idx[r.region_id] ||= { ...r, module: r.module || MODULES[k] }; }));
    return idx;
  });
  return regionsP;
}

function targetOf(el) {
  if (!el || el.closest?.('[data-no-lightbox], .lb')) return null;
  const tagged = el.closest?.('[data-sat-region]');
  if (tagged) return { region: tagged.dataset.satRegion, month: tagged.dataset.satMonth || null, el: tagged };
  if (el.tagName === 'IMG') {
    const m = TILE_RE.exec(el.getAttribute('src') || '');
    if (m) return { region: m[1], month: m[2], el };
  }
  return null;
}

// ---------- modal ----------
let root = null, state = null;

function close() {
  if (!root) return;
  clearInterval(state?.timer);
  try { state?.map?.remove(); } catch {}
  try { state?.spark?.dispose(); } catch {}
  root.remove(); root = null; state = null;
  document.removeEventListener('keydown', onKey, true);
}

function onKey(e) {
  if (!state) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  else if (e.key === 'ArrowRight' && state.tab === 'tile') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft' && state.tab === 'tile') { e.preventDefault(); step(-1); }
  else if (e.key === ' ' && state.tab === 'tile' && state.series.length > 1) { e.preventDefault(); togglePlay(); }
}

export async function openLightbox(regionId, month) {
  close();
  root = document.createElement('div');
  root.className = 'lb';
  root.innerHTML = `<div class="lb-panel" role="dialog" aria-modal="true" aria-label="Satellite image">
    <div class="lb-loading">${icon('loader', { size: 22, cls: 'spin' })}</div></div>`;
  document.body.appendChild(root);
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('mousedown', e => { if (e.target === root) close(); });

  const idx = await regionIndex().catch(() => ({}));
  if (!root) return;
  const r = idx[regionId] || { region_id: regionId, name: regionId.replace(/_/g, ' '), series: [] };
  let series = (r.series || []).filter(s => s?.thumb && s.month);
  if (!series.length && month) series = [{ month, thumb: `tiles/${regionId}/${month}.png` }];
  let i = series.findIndex(s => s.month === month);
  if (i < 0) i = series.length - 1;
  state = { r, series, i, tab: 'tile', timer: 0, map: null, spark: null, z: 1, tx: 0, ty: 0 };
  render();
}

function render() {
  const { r, series } = state;
  const mod = MODULE_META[r.module];
  const item = ITEM_META[r.item];
  const kicker = [mod?.name, item ? itemLabel(r.item) : null].filter(Boolean).join(' · ');
  const canMap = isNum(r.lat) && isNum(r.lon);
  const multi = series.length > 1;
  root.querySelector('.lb-panel').innerHTML = `
    <header class="lb-head">
      <div class="lb-titles">
        <div class="lb-kicker">${icon('satellite', { size: 14 })}Sentinel-2${kicker ? ' · ' + esc(kicker) : ''}</div>
        <h2>${esc(r.name || r.region_id)}</h2>
      </div>
      <div class="lb-tabs" role="tablist">
        <button data-tab="tile" class="on" role="tab">${icon('image', { size: 15 })}Satellite tile</button>
        ${canMap ? `<button data-tab="map" role="tab">${icon('map', { size: 15 })}Explore map</button>` : ''}
      </div>
      <button class="lb-x" aria-label="Close" title="Close (Esc)">${icon('x', { size: 18 })}</button>
    </header>
    <div class="lb-body">
      <div class="lb-stage">
        <div class="lb-tile" title="Scroll to zoom · drag to pan · double-click to reset">
          <img alt="" draggable="false">
          <div class="lb-zoomctl">
            <button data-z="in" aria-label="Zoom in">${icon('plus', { size: 16 })}</button>
            <button data-z="out" aria-label="Zoom out">${icon('minus', { size: 16 })}</button>
            <button data-z="reset" aria-label="Reset">${icon('maximize-2', { size: 15 })}</button>
          </div>
          <div class="lb-chip lb-month-chip"></div>
        </div>
        <div class="lb-map" hidden><div class="lb-map-gl"></div></div>
      </div>
      <aside class="lb-side">
        <div class="lb-month"></div>
        <div class="lb-stats"></div>
        ${multi ? `<div class="lb-spark-wrap"><div class="lb-spark-t">${({ crop: "Crop health (NDVI)", water: "Water (NDWI)", built: "Built-up (NDBI)" })[kindOf(r)]} over time</div><div class="lb-spark"></div></div>` : ''}
        <div class="lb-anom"></div>
        <div class="lb-help">${icon('info', { size: 14 })}<span>${multi ? 'Use the slider or ← → keys to travel through time. ' : ''}Scroll on the image to zoom.</span></div>
      </aside>
    </div>
    ${multi ? `<footer class="lb-scrub">
      <button class="lb-play" aria-label="Play timelapse">${icon('play', { size: 16 })}<span>Timelapse</span></button>
      <span class="lb-edge">${esc(fmtMonth(series[0].month))}</span>
      <input type="range" min="0" max="${series.length - 1}" step="1" value="${state.i}" aria-label="Month">
      <span class="lb-edge">${esc(fmtMonth(series.at(-1).month))}</span>
    </footer>` : ''}`;

  const p = root.querySelector('.lb-panel');
  p.querySelector('.lb-x').onclick = close;
  p.querySelectorAll('[data-tab]').forEach(b => (b.onclick = () => setTab(b.dataset.tab)));
  const range = p.querySelector('input[type=range]');
  if (range) range.oninput = () => { stopPlay(); show(+range.value); };
  p.querySelector('.lb-play')?.addEventListener('click', togglePlay);
  wireZoom(p.querySelector('.lb-tile'));
  anomaly();
  spark();
  show(state.i);
}

function itemLabel(id) {
  const names = { chocolate: 'Chocolate', olive_oil: 'Olive oil', orange_juice: 'Orange juice', bread: 'Bread', latte: 'Coffee', pint: 'Beer', wine: 'Wine', gpu: 'GPUs', laptop: 'Laptops' };
  return names[id] || ITEM_META[id]?.short || id;
}

// What the satellite is watching at this site decides the wording: farms -> crop health, reservoirs -> water, sites -> building.
function kindOf(r) {
  const k = String(r?.signal || '') + ' ' + String(r?.region_id || '');
  if (/water|reservoir/.test(k)) return 'water';
  if (/datacenter|fab|built|port|park|dc_/.test(k)) return 'built';
  return 'crop';
}
const SPARK = {
  crop: { key: 'ndvi', label: 'NDVI (crop health)', color: '#16A34A' },
  water: { key: 'ndwi', label: 'NDWI (water)', color: '#2563EB' },
  built: { key: 'ndbi', label: 'NDBI (built-up)', color: '#78716C' },
};

function show(i) {
  if (!state || !state.series.length) return;
  state.i = Math.max(0, Math.min(state.series.length - 1, i));
  const s = state.series[state.i], p = root.querySelector('.lb-panel');
  const img = p.querySelector('.lb-tile img');
  img.src = '/' + s.thumb.replace(/^\//, '');
  img.onerror = () => { img.removeAttribute('src'); };
  p.querySelector('.lb-month-chip').textContent = fmtMonth(s.month);
  const range = p.querySelector('input[type=range]'); if (range) range.value = state.i;
  p.querySelector('.lb-month').innerHTML = `<span>Image month</span><b>${esc(fmtMonth(s.month))}</b>`;
  const stat = (k, label, hint, lo, hi) => {
    const v = s[k]; if (!isNum(v)) return '';
    const w = Math.max(2, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    return `<div class="lb-stat"><div class="lb-stat-h"><span>${label}</span><b>${v.toFixed(2)}</b></div>
      <div class="lb-bar"><i style="width:${w}%;background:var(--c-${k})"></i></div><div class="lb-stat-s">${hint}</div></div>`;
  };
  const kind = kindOf(state.r);
  const sNdvi = stat('ndvi', 'NDVI · vegetation', kind === 'crop' ? 'Higher = greener, healthier crops' : 'Higher = more plants on the ground', -0.2, 0.9);
  const sNdwi = stat('ndwi', 'NDWI · water', kind === 'water' ? 'Higher = fuller reservoir' : 'Higher = more surface water', -0.8, 0.6);
  const sNdbi = stat('ndbi', 'NDBI · built-up', 'Higher = more concrete, roofs and car parks', -0.6, 0.4);
  p.querySelector('.lb-stats').innerHTML =
    (kind === 'built' ? sNdbi + sNdvi : kind === 'water' ? sNdwi + sNdvi : sNdvi + sNdwi) +
    (isNum(s.cloud_pct) ? `<div class="lb-stat"><div class="lb-stat-h"><span>Cloud cover</span><b>${Math.round(s.cloud_pct)}%</b></div>
      <div class="lb-bar"><i style="width:${Math.max(2, s.cloud_pct)}%;background:#94A3B8"></i></div></div>` : '');
  // preload neighbours for a smooth timelapse
  [1, 2].forEach(d => { const n = state.series[state.i + d]; if (n) new Image().src = '/' + n.thumb; });
  if (state.spark) state.spark.setOption({ series: [{ markLine: { silent: true, symbol: 'none', animation: false, label: { show: false }, lineStyle: { color: '#F97316', width: 1.5, type: 'solid' }, data: [{ xAxis: state.i }] } }] });
}

function anomaly() {
  const a = state.r.anomaly || {};
  const chip = (v, lab) => (isNum(v) ? `<div class="lb-an ${v < -5 ? 'bad' : v > 5 ? 'good' : ''}"><b>${fmtPct(v)}</b><span>${lab}</span></div>` : '');
  const kind = kindOf(state.r);
  const built = a.built_frac_vs_5yr_pct ?? a.ndbi_vs_5yr_pct, water = a.water_frac_vs_5yr_pct ?? a.ndwi_vs_5yr_pct;
  root.querySelector('.lb-anom').innerHTML = kind === 'built'
    ? chip(built, 'built-up area vs 5-yr avg') + chip(a.ndvi_vs_5yr_pct, 'greenery vs 5-yr avg')
    : kind === 'water'
      ? chip(water, 'water vs 5-yr avg') + chip(a.ndvi_vs_5yr_pct, 'greenery vs 5-yr avg')
      : chip(a.ndvi_vs_5yr_pct, 'crop health vs 5-yr avg') + chip(a.ndwi_vs_5yr_pct, 'water vs 5-yr avg');
}

async function spark() {
  const el = root.querySelector('.lb-spark');
  if (!el) return;
  const { initChart } = await import('./echarts.js');
  if (!root || !root.contains(el)) return;
  const s = state.series;
  const sp = SPARK[kindOf(state.r)], key = s.some(x => isNum(x[sp.key])) ? sp.key : 'ndvi', col = key === sp.key ? sp.color : '#16A34A';
  const c = initChart(el);
  c.setOption({
    animation: false, grid: { left: 2, right: 2, top: 6, bottom: 2 },
    xAxis: { type: 'category', data: s.map(x => x.month), show: false, boundaryGap: false },
    yAxis: { type: 'value', show: false, scale: true },
    tooltip: axisTooltip(ps => {
      const i = ps?.[0]?.dataIndex, x = s[i]; if (!x) return '';
      return tipHtml({ title: fmtMonth(x.month), rows: [{ color: col, label: key === sp.key ? sp.label : 'NDVI', value: isNum(x[key]) ? x[key].toFixed(2) : '–' },
        isNum(x.cloud_pct) ? { label: 'Cloud', value: Math.round(x.cloud_pct) + '%' } : null], note: 'Click to jump to this month' });
    }),
    series: [{ type: 'line', data: s.map(x => (isNum(x[key]) ? x[key] : null)), symbol: 'none', connectNulls: true,
      lineStyle: { color: col, width: 1.75 }, areaStyle: { color: col + '1A' } }],
  });
  c.getZr().on('click', ev => {
    const [x] = c.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]) || [];
    if (isNum(x)) { stopPlay(); show(Math.round(x)); }
  });
  state.spark = c;
}

function setTab(t) {
  state.tab = t;
  const p = root.querySelector('.lb-panel');
  p.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  p.querySelector('.lb-tile').hidden = t !== 'tile';
  p.querySelector('.lb-map').hidden = t !== 'map';
  p.querySelector('.lb-scrub')?.classList.toggle('off', t !== 'tile');
  if (t === 'map') { stopPlay(); initMap(p.querySelector('.lb-map-gl')); }
}

async function initMap(el) {
  if (state.map) { state.map.resize(); return; }
  if (state.mapLoading) return;
  state.mapLoading = true;
  const { default: maplibregl } = await import('maplibre-gl');
  if (!state || state.map) return;
  const r = state.r;
  const map = new maplibregl.Map({
    container: el, center: [r.lon, r.lat], zoom: 11.5, minZoom: 3, maxZoom: 16.5, attributionControl: false,
    style: { version: 8, sources: { s2: { type: 'raster', tiles: [EOX], tileSize: 256, maxzoom: 15,
      attribution: 'Sentinel-2 cloudless by EOX (Contains modified Copernicus Sentinel data)' } },
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0A0F2C' } }, { id: 's2', type: 'raster', source: 's2' }] },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.on('load', () => {
    const b = r.bbox;
    if (Array.isArray(b) && b.length === 4) {
      const ring = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];
      map.addSource('fp', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } } });
      map.addLayer({ id: 'fp-fill', type: 'fill', source: 'fp', paint: { 'fill-color': '#F97316', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'fp-line', type: 'line', source: 'fp', paint: { 'line-color': '#F97316', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    }
  });
  const chip = document.createElement('div');
  chip.className = 'lb-chip lb-map-chip';
  chip.textContent = 'Dashed box = the area our satellite tile covers · scroll to zoom to street level';
  el.parentElement.appendChild(chip);
  state.map = map;
}

// ---------- timelapse ----------
function step(d) { stopPlay(); show(state.i + d); }
function togglePlay() { if (state?.timer) stopPlay(); else startPlay(); }
function startPlay() {
  if (!state || state.series.length < 2) return;
  if (state.i >= state.series.length - 1) show(0);
  state.timer = setInterval(() => {
    if (!state) return;
    if (state.i >= state.series.length - 1) { stopPlay(); return; }
    show(state.i + 1);
  }, 450);
  playBtn(true);
}
function stopPlay() { if (!state) return; clearInterval(state.timer); state.timer = 0; playBtn(false); }
function playBtn(on) {
  const b = root?.querySelector('.lb-play'); if (!b) return;
  b.innerHTML = `${icon(on ? 'pause' : 'play', { size: 16 })}<span>${on ? 'Pause' : 'Timelapse'}</span>`;
  b.classList.toggle('on', on);
}

// ---------- wheel / drag zoom on the tile ----------
function wireZoom(box) {
  const img = box.querySelector('img');
  const apply = () => { img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.z})`; box.classList.toggle('zoomed', state.z > 1.01); };
  const zoomBy = (k, cx = 0, cy = 0) => {
    const z = Math.max(1, Math.min(8, state.z * k)), f = z / state.z;
    state.tx = (state.tx - cx) * f + cx; state.ty = (state.ty - cy) * f + cy; state.z = z;
    if (z === 1) state.tx = state.ty = 0;
    apply();
  };
  box.addEventListener('wheel', e => {
    e.preventDefault();
    const rc = box.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rc.left - rc.width / 2, e.clientY - rc.top - rc.height / 2);
  }, { passive: false });
  let drag = null;
  box.addEventListener('pointerdown', e => { if (e.target.closest('button') || state.z <= 1) return; drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty }; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointermove', e => { if (!drag) return; state.tx = drag.tx + e.clientX - drag.x; state.ty = drag.ty + e.clientY - drag.y; apply(); });
  box.addEventListener('pointerup', () => { drag = null; });
  box.addEventListener('dblclick', () => { state.z = 1; state.tx = state.ty = 0; apply(); });
  box.querySelector('[data-z=in]').onclick = () => zoomBy(1.5);
  box.querySelector('[data-z=out]').onclick = () => zoomBy(1 / 1.5);
  box.querySelector('[data-z=reset]').onclick = () => { state.z = 1; state.tx = state.ty = 0; apply(); };
}

// ---------- global wiring: click delegation + hover hint ----------
export function installLightbox() {
  let down = null;
  document.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('click', e => {
    const t = targetOf(e.target);
    if (!t) return;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return; // it was a drag (compare sliders)
    e.preventDefault();
    hint.hidden = true;
    openLightbox(t.region, t.month);
  });
  const hint = document.createElement('div');
  hint.className = 'sat-hint'; hint.hidden = true;
  hint.innerHTML = `${icon('zoom-in', { size: 13 })}<span>Zoom</span>`;
  document.body.appendChild(hint);
  let cur = null;
  document.addEventListener('mouseover', e => {
    const t = targetOf(e.target);
    if (!t) { if (cur && !cur.contains(e.target)) { cur = null; hint.hidden = true; } return; }
    const rc = t.el.getBoundingClientRect();
    if (rc.width < 44 || rc.height < 32) { hint.hidden = true; return; }
    cur = t.el; t.el.classList.add('sat-zoomable');
    hint.hidden = false;
    hint.style.left = `${rc.right - hint.offsetWidth - 6}px`;
    hint.style.top = `${rc.top + 6}px`;
  });
  window.addEventListener('scroll', () => { hint.hidden = true; cur = null; }, true);
  window.addEventListener('hashchange', close);
}
