import { api, allModules, MODULE_META, ITEM_META, REGION_META, esc, pct, isNum, countUp, icons, showTip, hideTip } from '../lib.js';
import { icon, moduleIcon, itemIcon } from '../components/icons.js';
import { axisTooltip, tipHtml, fmtMonth, fmtMoney, fmtPct } from '../components/chartTheme.js';
import { topbar, wireScan, agoText } from './common.js';

const BASKET = ['chocolate', 'olive_oil', 'orange_juice', 'latte', 'pint', 'wine', 'bread', 'gpu'];
const MOD_ORDER = ['groceries', 'latte', 'beer_wine', 'gpu', 'rent'];
const BASEMAP = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const shortName = n => String(n || '').replace(/\s*\(.*?\)/, '');

function loadCss() {
  if (document.getElementById('ov-css')) return;
  document.head.appendChild(Object.assign(document.createElement('link'), { id: 'ov-css', rel: 'stylesheet', href: '/static/css/overview.css' }));
}

export async function render(page) {
  loadCss();
  page.innerHTML = topbar({
    title: 'Overview', pill: `<span class="pill live" id="ov-live">Live</span>`,
    tagline: 'Satellites see prices rising months before you pay them.',
    right: `<button class="btn" id="share"><i data-lucide="share-2"></i>Share</button>`,
  }) + `
  <section class="ov-kpis" id="kpis">${MOD_ORDER.map(() => `<div class="kc skeleton"></div>`).join('')}</section>
  <section class="ov-bottom">
    <div class="card" id="basket">
      <div class="card-head">
        <div><div class="card-title">Tomorrow's Basket</div><div class="card-sub">Expected price change in 6 months</div></div>
        <div class="basket-total"><div class="v num" id="basket-v">–</div><div class="l">basket vs today</div></div>
      </div>
      <div class="waffle-cols" id="basket-cols"><div class="empty">Loading forecasts…</div></div>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>Rising fast (≥3%)</span>
        <span><i style="background:var(--accent-light)"></i>Rising</span>
        <span><i style="background:var(--muted)"></i>1 square = +0.5%</span>
      </div>
    </div>
    <div class="card" id="watch">
      <div class="card-head">
        <div><div class="card-title">Satellite watch</div><div class="card-sub" id="watch-sub">Sentinel-2</div></div>
        <div class="seg" id="seg">${['All', 'Crops', 'Water', 'Built'].map((s, i) => `<button class="${i ? '' : 'on'}" data-f="${s}">${s}</button>`).join('')}</div>
      </div>
      <div class="ov-map" id="map"><button class="ov-fit" id="fit" title="Show all regions">${icon('maximize-2', { size: 14 })}All regions</button></div>
      <div class="stat-row">
        <div class="stat"><div class="v" id="st-n">–</div><div class="l">regions watched</div></div>
        <div class="stat"><div class="v red" id="st-d">–</div><div class="l">in drought stress</div></div>
        <div class="stat"><div class="v red" id="st-a">–</div><div class="l">avg NDVI vs 5-yr</div></div>
      </div>
      <div class="legend">${MOD_ORDER.map(m => `<span><i class="round" style="background:${MODULE_META[m].color}"></i>${MODULE_META[m].name.replace(' Index', '').replace(' & Gadgets', '').replace(' Radar', '')}</span>`).join('')}</div>
    </div>
  </section>`;
  wireScan(page);
  icons();
  page.querySelector('#share').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); page.querySelector('#share').lastChild.textContent = 'Copied'; } catch {}
  });

  const [summary, mods, rent] = await Promise.all([api('/api/summary', { fresh: true }), allModules(), api('/api/modules/rent')]);
  const items = Object.fromEntries([...mods, rent].filter(Boolean).flatMap(m => m.items || []).map(i => [i.item_id, i]));
  const disposeKpis = renderKpis(page, summary, items);
  renderBasket(page, items);
  const disposeMap = renderMap(page, mods);
  return () => { disposeKpis(); disposeMap(); hideTip(); };
}

/* ---------- KPI cards: icon + name, one big number, sparkline, one delta line ---------- */
function renderKpis(page, summary, items) {
  const el = page.querySelector('#kpis');
  const live = page.querySelector('#ov-live');
  if (live) live.textContent = agoText(summary?.generated_at);
  const byId = Object.fromEntries((summary?.modules || []).map(m => [m.module_id, m]));
  el.innerHTML = MOD_ORDER.map(id => {
    const m = byId[id] || {};
    const meta = MODULE_META[id];
    const href = `#/${id}`;
    const it = items[m.top_item_id] || {};
    const ch = isNum(m.change_6m_pct) ? m.change_6m_pct : it.change_6m_pct;
    const p = isNum(m.prob_up_6m) ? m.prob_up_6m : it.prob_up_6m;
    const trend = !isNum(p) ? 'minus' : p >= 0.5 ? 'trending-up' : 'trending-down';
    return `<a class="kc" href="${href}" style="--mc:${meta.color}">
      <div class="kc-head"><span class="kc-name">${moduleIcon(id, { size: 15 })}${esc(meta.name)}</span></div>
      <div class="kc-big num"><span class="cu" data-to="${isNum(ch) ? ch : ''}">–</span><small>in 6 mo</small></div>
      <div class="kc-sub" title="${esc(m.top_item || it.name || '')}">${esc(shortName(m.top_item || it.name) || 'Forecast pending')}</div>
      <div class="kc-spark" data-item="${esc(m.top_item_id || '')}"></div>
      <div class="kc-foot"><span class="kc-trend ${p >= 0.5 ? 'up' : 'down'}">${icon(trend, { size: 14 })}</span><span class="kc-prob" title="Probability the price is higher in 6 months">${isNum(p) ? `${Math.round(p * 100)}%<span class="kc-lu"> likely up</span>` : 'Pending'}</span>
        <span class="kc-press" title="Price pressure index: 0 = easing, 100 = strong upward pressure">Pressure <b>${isNum(m.pressure) ? Math.round(m.pressure) : '–'}</b></span></div>
    </a>`;
  }).join('');
  el.querySelectorAll('.cu').forEach(c => {
    if (c.dataset.to === '') return;
    const v = Number(c.dataset.to);
    countUp(c, Math.abs(v), { digits: 1, prefix: v > 0 ? '+' : v < 0 ? '−' : '', suffix: '%' });
  });
  const charts = [...el.querySelectorAll('.kc-spark')].map(box => sparkline(box, items[box.dataset.item], box.closest('.kc').style.getPropertyValue('--mc')));
  const ro = new ResizeObserver(() => charts.forEach(c => c?.resize()));
  ro.observe(el);
  return () => { ro.disconnect(); charts.forEach(c => c?.dispose()); };
}

function sparkline(box, item, color) {
  if (!window.echarts || !item?.history?.length) { box.classList.add('empty'); return null; }
  const hist = item.history.slice(-24);
  const fc = (item.forecast || []).slice(0, 6);
  const months = [...hist.map(h => h.month), ...fc.map(f => f.month)];
  const nH = hist.length, last = hist[nH - 1].price;
  const hData = [...hist.map(h => h.price), ...fc.map(() => null)];
  const fData = [...hist.map((_, i) => (i === nH - 1 ? last : null)), ...fc.map(f => f.p50)];
  const vals = [...hist.map(h => h.price), ...fc.map(f => f.p50)];
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.15 || hi * 0.02;
  const c = echarts.init(box, null, { renderer: 'svg' });
  c.setOption({
    animationDuration: 600,
    grid: { left: 2, right: 2, top: 4, bottom: 4 },
    xAxis: { type: 'category', data: months, show: false, boundaryGap: false },
    yAxis: { type: 'value', show: false, min: lo - pad, max: hi + pad },
    tooltip: { ...axisTooltip(ps => {
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
    }), confine: false, appendToBody: true,
      // Show the card below the sparkline so the line stays visible.
      position: (pt, _p, _d, _r, size) => {
        const bb = box.getBoundingClientRect();
        return [Math.max(-bb.left + 8, Math.min(pt[0] - size.contentSize[0] / 2, window.innerWidth - bb.left - size.contentSize[0] - 8)), bb.height + 12];
      } },
    series: [
      { type: 'line', data: hData, symbol: 'none', smooth: 0.3, lineStyle: { width: 1.5, color: '#A8A29E' }, emphasis: { disabled: true },
        areaStyle: { color: 'rgba(168,162,158,.08)' } },
      { type: 'line', data: fData, symbol: 'none', smooth: 0.3, lineStyle: { width: 2, color, type: [4, 3] }, emphasis: { disabled: true } },
    ],
  });
  return c;
}

/* ---------- Basket waffle ---------- */
function renderBasket(page, items) {
  const rows = BASKET.map(id => ({ id, ...ITEM_META[id], it: items[id], v: items[id]?.change_6m_pct, name: items[id]?.name }))
    .filter(r => isNum(r.v));
  const cols = page.querySelector('#basket-cols');
  if (!rows.length) { cols.innerHTML = `<div class="empty">Forecasts are still being computed on Modal.</div>`; return; }
  const avg = rows.reduce((a, r) => a + r.v, 0) / rows.length;
  const bv = page.querySelector('#basket-v');
  countUp(bv, Math.abs(avg), { digits: 1, prefix: avg >= 0 ? '+' : '−', suffix: '%' });
  if (avg < 0) bv.style.color = 'var(--down)';
  cols.innerHTML = rows.map((r, ci) => {
    const n = Math.max(0, Math.min(10, Math.round(r.v / 0.5)));
    const hot = r.v >= 3;
    const fill = hot ? 'var(--accent)' : 'var(--accent-light)';
    const sq = Array.from({ length: 10 }, (_, k) =>
      `<i style="${k < n ? `background:${fill};` : ''}animation-delay:${ci * 60 + k * 35}ms"></i>`).join('');
    return `<div class="wcol" data-id="${r.id}">
      <div class="val ${hot ? 'hot' : r.v < 0 ? 'neg' : ''}">${pct(r.v, Math.abs(r.v) < 1 ? 1 : 0)}</div>
      <div class="wstack">${sq}</div>
      <div class="emo">${itemIcon(r.id, { size: 18 })}</div><div class="nm">${esc(r.short)}</div></div>`;
  }).join('');
  cols.querySelectorAll('.wcol').forEach(col => {
    const r = rows.find(x => x.id === col.dataset.id);
    const h = r.it?.history || [], f6 = (r.it?.forecast || [])[5];
    const now = h[h.length - 1];
    const html = tipHtml({
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
    col.addEventListener('mousemove', e => showTip(html, e.clientX, e.clientY));
    col.addEventListener('mouseleave', hideTip);
    col.addEventListener('click', () => { hideTip(); location.hash = `#/${moduleOfItem(r.id)}`; });
  });
}
const moduleOfItem = id => ({ chocolate: 'groceries', olive_oil: 'groceries', orange_juice: 'groceries', bread: 'groceries', latte: 'latte', pint: 'beer_wine', wine: 'beer_wine', gpu: 'gpu', laptop: 'gpu' }[id] || 'groceries');

/* ---------- Satellite watch map ---------- */
function anomalyOf(reg) {
  const sig = reg.signal || REGION_META[reg.region_id]?.[1];
  const a = reg.anomaly || {};
  if (sig === 'water' && isNum(a.ndwi_vs_5yr_pct)) return { v: a.ndwi_vs_5yr_pct, idx: 'NDWI' };
  if (isNum(a.ndvi_vs_5yr_pct)) return { v: a.ndvi_vs_5yr_pct, idx: 'NDVI' };
  return null;
}
const sigOf = r => r.signal || REGION_META[r.region_id]?.[1];

function regionTip(r, a) {
  const tiles = (r.series || []).filter(s => s.thumb);
  const last = tiles.filter(s => (s.cloud_pct ?? 0) < 30).slice(-1)[0] || tiles.slice(-1)[0];
  const meta = MODULE_META[r.module] || {};
  return `<div class="ov-tip">
    ${last ? `<img src="/${esc(last.thumb)}" alt="">` : ''}
    <div class="ov-tip-b">
      <div class="ov-tip-m" style="color:${meta.color}">${moduleIcon(r.module, { size: 13 })}${esc(meta.name || '')}</div>
      <div class="ov-tip-n">${esc(r.name)}</div>
      ${a ? `<div class="ov-tip-v ${a.v < 0 ? 'red' : 'green'}">${a.idx} ${fmtPct(a.v, 0)} vs 5-yr avg</div>` : '<div class="muted">Anomaly pending</div>'}
      ${last ? `<div class="muted">Latest clear tile ${fmtMonth(last.month)} · ${Math.round(last.cloud_pct ?? 0)}% cloud</div>` : ''}
      <div class="muted">Click to open ${esc(meta.name || 'module')}</div>
    </div></div>`;
}

function renderMap(page, mods) {
  const map = page.querySelector('#map');
  const regions = mods.flatMap(m => (m.regions || []).map(r => ({ ...r, module: r.module || m.module?.id })))
    .filter(r => isNum(r.lat) && isNum(r.lon) && MODULE_META[r.module]);
  // Stats
  const an = regions.map(anomalyOf).filter(Boolean);
  const nd = regions.map(r => r.anomaly?.ndvi_vs_5yr_pct).filter(isNum);
  const stress = an.filter(a => a.v < -10).length;
  page.querySelector('#watch-sub').textContent = `${regions.length} regions · Sentinel-2`;
  countUp(page.querySelector('#st-n'), regions.length);
  if (an.length) countUp(page.querySelector('#st-d'), stress); else page.querySelector('#st-d').textContent = '–';
  const avg = nd.length ? nd.reduce((a, b) => a + b, 0) / nd.length : null;
  const sa = page.querySelector('#st-a');
  sa.textContent = pct(avg);
  if (isNum(avg) && avg >= 0) sa.className = 'v green';

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
  const worst = pins.filter(x => x.a).sort((x, y) => x.a.v - y.a.v)[0];
  let callout = null;
  if (worst && worst.a.v < 0) {
    callout = document.createElement('div');
    callout.className = 'ov-callout';
    callout.innerHTML = `<span style="color:${MODULE_META[worst.r.module].color}">${moduleIcon(worst.r.module, { size: 13 })}</span><b>${esc(shortName(worst.r.name).split(',')[0])}</b><span class="red">${worst.a.idx} ${fmtPct(worst.a.v, 0)}</span>`;
  }

  // Filter
  const segs = page.querySelectorAll('#seg button');
  segs.forEach(b => b.addEventListener('click', () => {
    segs.forEach(x => x.classList.toggle('on', x === b));
    const want = { All: null, Crops: ['crop'], Water: ['water'], Built: ['built', 'port'] }[b.dataset.f];
    pins.forEach(({ r, p }) => p.classList.toggle('dim', !!want && !want.includes(sigOf(r))));
    if (callout) callout.hidden = !!want && !want.includes(sigOf(worst.r));
  }));

  const ml = window.maplibregl;
  if (!ml || !regions.length) return fallbackMap(map, pins, callout, worst);

  const b = regions.reduce((acc, r) => [Math.min(acc[0], r.lon), Math.min(acc[1], r.lat), Math.max(acc[2], r.lon), Math.max(acc[3], r.lat)], [180, 90, -180, -90]);
  const bounds = [[b[0] - 4, b[1] - 4], [b[2] + 4, b[3] + 4]];
  const fit = (duration = 0) => gl.fitBounds(bounds, { padding: 24, duration });
  let touched = false;
  const gl = new ml.Map({
    container: map, bounds, fitBoundsOptions: { padding: 24 }, minZoom: 0, maxZoom: 11,
    renderWorldCopies: false, dragRotate: false, pitchWithRotate: false, attributionControl: false,
    style: {
      version: 8,
      sources: { base: { type: 'raster', tiles: [BASEMAP], tileSize: 256, maxzoom: 16, attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors' } },
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#EEF2F6' } }, { id: 'base', type: 'raster', source: 'base' }],
    },
  });
  gl.touchZoomRotate.disableRotation();
  gl.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
  gl.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');
  pins.forEach(({ r, p }) => new ml.Marker({ element: p }).setLngLat([r.lon, r.lat]).addTo(gl));
  const east = worst && worst.r.lon > (b[0] + b[2]) / 2;
  if (callout) new ml.Marker({ element: callout, anchor: east ? 'right' : 'left', offset: [east ? -16 : 16, 0] }).setLngLat([worst.r.lon, worst.r.lat]).addTo(gl);
  gl.on('movestart', e => { hideTip(); if (e.originalEvent) touched = true; });
  gl.on('load', () => fit());
  page.querySelector('#fit').addEventListener('click', () => { touched = false; fit(800); });
  const ro = new ResizeObserver(() => { gl.resize(); if (!touched) fit(); });
  ro.observe(map);
  return () => { ro.disconnect(); gl.remove(); };
}

/* Offline fallback: static dotted world image with the old projection. */
function fallbackMap(map, pins, callout, worst) {
  map.querySelector('#fit')?.remove();
  const img = Object.assign(document.createElement('img'), { className: 'world', src: '/static/assets/world-dots.png', alt: '' });
  map.appendChild(img);
  pins.forEach(({ p }) => { p.classList.add('abs'); map.appendChild(p); });
  if (callout) { callout.classList.add('abs'); map.appendChild(callout); }
  const layout = () => {
    const mw = map.clientWidth, mh = map.clientHeight;
    if (!mw) return;
    const k = mw / 1408 * 0.98, dy = (mh - 768 * k) / 2;
    Object.assign(img.style, { width: 1408 * k + 'px', height: 768 * k + 'px', left: mw * 0.01 + 'px', top: dy + 'px' });
    for (const { r, p } of pins) {
      p.style.left = (721 + r.lon * 2.84) * k + mw * 0.01 + 'px';
      p.style.top = (403 - r.lat * 3.06) * k + dy + 'px';
    }
    if (callout && worst) { callout.style.left = worst.p.style.left; callout.style.top = parseFloat(worst.p.style.top) - 14 + 'px'; }
  };
  const ro = new ResizeObserver(layout);
  ro.observe(map);
  layout();
  return () => ro.disconnect();
}
