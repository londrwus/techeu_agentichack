// 00 Earth: full-bleed Sentinel-2 basemap with the regions that set tomorrow's prices.
// The router adds body.rail (sidebar → 56px glass rail). render() returns a cleanup function.
import { api, esc, isNum, countUp, icons, MODULE_IDS, ITEM_META } from '../lib.js';
import { fmtGBP, commodityOf, riskOf } from '../components/ui.js';

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

function ensureCss() {
  if (document.getElementById('earth-css')) return;
  const l = Object.assign(document.createElement('link'), { id: 'earth-css', rel: 'stylesheet', href: '/static/css/earth.css' });
  document.head.appendChild(l);
}

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

export async function render(el) {
  ensureCss();
  el.innerHTML = `<div class="earth-stage ea">
    <div class="ea-map"></div>
    <div class="ea-shade"></div>
    <div class="ea-overlay"></div>
    <div class="ea-leader" hidden></div>
    <div class="glass-panel earth-title ea-in">
      <div class="kicker"><i class="live"></i><span class="ea-kicker">Live from Sentinel-2</span></div>
      <h1>Where tomorrow's prices grow</h1>
      <div class="sub">Farm &amp; fab regions · greener = more production</div>
    </div>
    <div class="glass-panel ea-stats ea-in" hidden></div>
    <a class="btn primary ea-scan ea-in" href="#/mission"><i data-lucide="radar"></i>Scan now</a>
    <div class="glass-panel ea-card" hidden></div>
    <div class="glass-panel ea-legend ea-in">
      <div class="ea-leg-t">Production</div>
      <div class="ea-ramp"></div>
      <div class="ea-leg-lh"><span>low</span><span>high</span></div>
      <div class="ea-leg-row"><i class="ring"></i>Health below 5-yr</div>
      <div class="ea-leg-row"><i class="tech"></i>Chips &amp; AI (water, fabs)</div>
    </div>
    <div class="glass-panel ea-chips ea-in"><div class="ea-chip-row"></div></div>
    <div class="ea-attrib">Sentinel-2 cloudless by EOX — CC BY-NC-SA 4.0</div>
  </div>`;
  icons();
  const $ = s => el.querySelector(s);
  const stage = $('.ea'), overlay = $('.ea-overlay'), cardEl = $('.ea-card'), leader = $('.ea-leader');
  let alive = true, map = null, raf = 0, drifting = true, selected = null;
  const cleanups = [];

  // ---------- data ----------
  const [summary, rentMod, rentGeo, ...mods] = await Promise.all([
    api('/api/summary'), api('/api/modules/rent'), api('/api/rent'), ...MODULE_IDS.map(id => api(`/api/modules/${id}`)),
  ]);
  if (!alive) return;
  const modules = mods.filter(Boolean);
  const pressureOf = id => summary?.modules?.find(m => m.module_id === id)?.pressure;
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
  // London as a pseudo-region for Rent Radar
  const boroughs = (rentGeo?.features || []).map(f => f.properties || {});
  const avg = (arr, k) => { const v = arr.map(x => x[k]).filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const london = {
    region_id: 'london', name: 'London, UK', lat: LONDON.lat, lon: LONDON.lon, module_id: 'rent', item_id: 'rent_1bed', london: true,
    metric: { value: avg(boroughs, 'built_change_pct'), label: 'Built-up vs 2019', bad: false },
  };

  // ---------- title + stats ----------
  if (latest) $('.ea-kicker').textContent = `Live from Sentinel-2 · ${monthCaps(latest)}`;
  const nFarm = regions.filter(r => !r.tech).length, nTech = regions.length - nFarm;
  if (regions.length) $('.earth-title .sub').textContent = `${nFarm} farm & ${nTech} chip regions · greener = more production`;
  const tiles = summary?.stats?.tiles_processed;
  const heads = modules.reduce((s, m) => s + (m.signals?.n_headlines || 0), 0);
  const press = avg(summary?.modules || [], 'pressure');
  const stats = [[tiles, 'tiles seen', ''], [heads || summary?.stats?.jev_judgments, heads ? 'headlines judged' : 'Jev judgments', ''], [press, 'avg pressure', 'hot']].filter(s => isNum(s[0]) && s[0] > 0);
  if (stats.length) {
    const st = $('.ea-stats');
    st.innerHTML = stats.map(([, l, c]) => `<div class="ea-stat"><b class="${c}">0</b><span>${l}</span></div>`).join('');
    st.hidden = false;
    st.querySelectorAll('b').forEach((b, i) => setTimeout(() => countUp(b, Math.round(stats[i][0]), { dur: 1400 }), 300 + i * 120));
  }

  // ---------- markers (own overlay, projected from map or a static mercator fallback) ----------
  const maxRisk = Math.max(0.01, ...regions.map(r => r.risk ?? 0));
  const all = [...regions, london];
  for (const r of all) {
    const size = r.london ? 14 : Math.round(22 + 22 * Math.min(1, (r.risk ?? 0.35) / maxRisk));
    const cls = r.london ? 'london' : r.tech ? 'tech' : 'farm';
    const node = document.createElement('button');
    node.className = `ea-mk ${cls}${r.metric.bad ? ' bad' : ''}`;
    node.style.setProperty('--s', size + 'px');
    node.innerHTML = `<i class="dot"></i><span class="lbl">${esc(r.london ? 'London · Rent' : r.name.split(',')[0])}</span>`;
    node.addEventListener('click', e => { e.stopPropagation(); stopDrift(); select(r, { fly: false }); });
    overlay.appendChild(node);
    r.node = node;
  }

  function project(lon, lat) {
    if (map) {
      const c = map.getCenter().lng;
      const l = lon + 360 * Math.round((c - lon) / 360); // nearest world copy
      return map.project([l, lat]);
    }
    // fallback: plain web-mercator of HOME view
    const W = stage.clientWidth, H = stage.clientHeight, ws = 512 * 2 ** HOME.zoom;
    const mx = l => (l + 180) / 360 * ws, my = la => { const s = Math.sin(la * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws; };
    return { x: W / 2 + mx(lon) - mx(HOME.center[0]), y: H / 2 + my(lat) - my(HOME.center[1]) };
  }

  function place() {
    for (const r of all) { const p = project(r.lon, r.lat); r.node.style.transform = `translate(${p.x}px, ${p.y}px)`; }
    placeCard();
  }

  // ---------- selected-region card ----------
  function cardHtml(r) {
    const it = items[r.item_id] || {};
    const m = r.metric;
    const pressure = pressureOf(r.module_id);
    const label = CHIPS.find(c => c[0] === r.item_id)?.[1] || it.name || '';
    const sub = r.london ? `1-bed flat · ${boroughs.length || 33} boroughs` : r.tech ? KIND[r.signal] || 'Chip supply' : `${commodityOf(r)} · feeds ${label.toLowerCase()}`;
    const month = r.series?.at(-1)?.month;
    const thumb = !r.london && month ? `<img class="ea-thumb" src="/tiles/${esc(r.region_id)}/${esc(month)}.png" alt="" onerror="this.remove()">` : '';
    const now = it.retail_now, fut = it.retail_6m;
    const nameShort = r.london ? 'London' : r.name.replace(/\s*\(.*?\)/, '');
    return `<a class="ea-card-link" href="#/${MOD_ROUTE[r.module_id] || 'overview'}">
      <div class="ea-c-head"><div><div class="ea-c-name">${esc(nameShort)}</div><div class="ea-c-sub">${esc(sub)}</div></div>${thumb}</div>
      ${isNum(m.value) ? `<div class="ea-c-lab">${esc(m.label)}</div><div class="ea-c-big ${m.bad ? 'bad' : 'ok'}">${pctTxt(m.value)}</div>` : ''}
      ${isNum(pressure) ? `<div class="ea-c-lab">Price pressure</div><div class="ea-c-press"><b>${Math.round(pressure)}</b><span>/100</span></div>
        <div class="ea-bar"><i style="width:${Math.max(2, Math.min(100, pressure))}%"></i></div>` : ''}
      ${isNum(now) && isNum(fut) ? `<div class="ea-c-lab">${esc(label)}, London · in 6 months</div>
        <div class="ea-c-price"><span class="was">${fmtGBP(now)}</span><i data-lucide="arrow-right"></i><b class="${fut >= now ? 'up' : 'down'}">${fmtGBP(fut)}</b></div>` : ''}
    </a>`;
  }

  function placeCard() {
    if (!selected || cardEl.hidden) { leader.hidden = true; return; }
    const p = project(selected.lon, selected.lat);
    const W = stage.clientWidth, H = stage.clientHeight, cw = cardEl.offsetWidth, ch = cardEl.offsetHeight;
    const off = 44 + 34, rightSide = p.x + off + cw < W - 16;
    const x = rightSide ? p.x + off : p.x - off - cw;
    const y = Math.max(120, Math.min(H - 116 - ch, p.y - 96));
    cardEl.style.transform = `translate(${x}px, ${y}px)`;
    const offscreen = p.x < 0 || p.x > W || p.y < 0 || p.y > H;
    cardEl.classList.toggle('off', offscreen);
    leader.hidden = offscreen;
    const x1 = rightSide ? p.x + 34 : x + cw, x2 = rightSide ? x : p.x - 34;
    leader.style.transform = `translate(${x1}px, ${p.y}px)`;
    leader.style.width = Math.max(0, x2 - x1) + 'px';
  }

  function select(r, { fly = true } = {}) {
    if (!r) return;
    selected?.node?.classList.remove('sel');
    selected = r;
    r.node?.classList.add('sel');
    el.querySelectorAll('.ea-chip').forEach(c => c.classList.toggle('on', c.dataset.item === r.item_id));
    cardEl.innerHTML = cardHtml(r);
    icons();
    cardEl.classList.remove('show');
    cardEl.hidden = false;
    const reveal = () => { if (!alive || selected !== r) return; placeCard(); requestAnimationFrame(() => cardEl.classList.add('show')); };
    if (fly && map) {
      leader.hidden = true;
      cardEl.classList.add('flying');
      map.flyTo({ center: [r.lon, r.lat], zoom: r.london ? 6.5 : 5.5, duration: 2000, essential: true });
      map.once('moveend', () => { cardEl.classList.remove('flying'); reveal(); });
    } else reveal();
  }

  // ---------- chips ----------
  const mainRegion = id => {
    if (id === 'rent_1bed') return london;
    const rs = regions.filter(r => r.item_id === id);
    return rs.sort((a, b) => stressOf(b) - stressOf(a))[0] || null;
  };
  const chipRow = $('.ea-chip-row');
  chipRow.innerHTML = `<button class="ea-home" title="Whole world"><i data-lucide="globe"></i></button>` + CHIPS.filter(([id]) => mainRegion(id)).map(([id, label, icon]) =>
    `<button class="ea-chip" data-item="${id}"><span class="ea-ph"><img src="/static/assets/products/${id}.jpg" alt="" onerror="this.parentNode.innerHTML='<i data-lucide=&quot;${icon}&quot;></i>';window.lucide&&lucide.createIcons()"></span>${esc(label)}</button>`).join('');
  icons();
  chipRow.addEventListener('click', e => {
    const home = e.target.closest('.ea-home');
    if (home && map) { stopDrift(); map.flyTo({ ...HOME, duration: 1800 }); return; }
    const c = e.target.closest('.ea-chip'); if (!c) return;
    stopDrift();
    select(mainRegion(c.dataset.item));
  });

  // ---------- map ----------
  const ML = window.maplibregl;
  if (ML) {
    try {
      map = new ML.Map({
        container: $('.ea-map'), attributionControl: false, renderWorldCopies: true,
        style: {
          version: 8,
          sources: { s2: { type: 'raster', tiles: [EOX], tileSize: 256, maxzoom: 14 } },
          layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0A0F2C' } },
            { id: 's2', type: 'raster', source: 's2', paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 1200 }, 'raster-saturation': -0.05, 'raster-brightness-max': 0.92 } }],
        },
        center: HOME.center, zoom: 1.2, minZoom: 1, maxZoom: 12, dragRotate: false, pitchWithRotate: false,
      });
      try { map.setProjection?.({ type: 'globe' }); } catch { /* mercator on MapLibre 4 */ }
      map.on('move', place);
      map.on('load', () => {
        map.setPaintProperty('s2', 'raster-opacity', 1);
        map.easeTo({ zoom: HOME.zoom, duration: 3000, easing: t => 1 - Math.pow(1 - t, 3) });
        map.once('moveend', () => { if (alive && drifting) startDrift(); });
      });
      for (const ev of ['mousedown', 'wheel', 'touchstart', 'dragstart']) map.on(ev, stopDrift);
    } catch (e) { console.warn('[earth] map failed, static fallback', e); map = null; }
  }
  if (!map) stage.classList.add('static');

  // idle drift: gentle longitude sway until the user touches anything
  function startDrift() {
    const t0 = performance.now(), c0 = map.getCenter();
    const step = now => {
      if (!alive || !drifting) return;
      const t = (now - t0) / 1000;
      map.jumpTo({ center: [c0.lng + 22 * Math.sin(t / 14), c0.lat + 3 * Math.sin(t / 21)] });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function stopDrift() { drifting = false; cancelAnimationFrame(raf); }

  const onResize = () => place();
  window.addEventListener('resize', onResize);
  cleanups.push(() => window.removeEventListener('resize', onResize));

  place();
  // default selection: the most stressed farm region (else anything)
  const first = [...regions].filter(r => !r.tech).sort((a, b) => stressOf(b) - stressOf(a))[0] || regions[0];
  setTimeout(() => select(first, { fly: false }), 900);

  return () => {
    alive = false; stopDrift();
    cleanups.forEach(f => f());
    try { map?.remove(); } catch { /* ignore */ }
  };
}
