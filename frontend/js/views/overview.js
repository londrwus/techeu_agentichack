import { api, allModules, MODULE_META, ITEM_META, REGION_META, esc, fmt, pct, isNum, tint, deltaPill, countUp, icons, showTip, hideTip } from '../lib.js';
import { topbar, wireScan, agoText } from './common.js';

const BASKET = ['chocolate', 'olive_oil', 'orange_juice', 'latte', 'pint', 'wine', 'bread', 'gpu'];
const MOD_ORDER = ['groceries', 'latte', 'beer_wine', 'gpu', 'rent'];

export async function render(page) {
  page.innerHTML = topbar({
    title: 'Overview', pill: `<span class="pill live" id="ov-live">Live</span>`,
    tagline: 'Satellites see prices rising months before you pay them.',
    right: `<button class="btn" id="share"><i data-lucide="share-2"></i>Share</button>`,
  }) + `
  <section class="kpi-row" id="kpis">${MOD_ORDER.map(() => `<div class="card kpi skeleton" style="height:216px"></div>`).join('')}</section>
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
        <div><div class="card-title">Satellite watchlist</div><div class="card-sub" id="watch-sub">16 regions · Sentinel-2</div></div>
        <div class="seg" id="seg">${['All', 'Crops', 'Water', 'Built'].map((s, i) => `<button class="${i ? '' : 'on'}" data-f="${s}">${s}</button>`).join('')}</div>
      </div>
      <div class="map" id="map"><img class="world" src="/static/assets/world-dots.png" alt=""></div>
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

  const [summary, mods] = await Promise.all([api('/api/summary', { fresh: true }), allModules()]);
  renderKpis(page, summary);
  renderBasket(page, mods);
  const cleanupMap = renderMap(page, mods);
  return cleanupMap;
}

function renderKpis(page, summary) {
  const el = page.querySelector('#kpis');
  const live = page.querySelector('#ov-live');
  if (live) live.textContent = agoText(summary?.generated_at);
  const byId = Object.fromEntries((summary?.modules || []).map(m => [m.module_id, m]));
  el.innerHTML = MOD_ORDER.map(id => {
    const m = byId[id] || {};
    const meta = MODULE_META[id];
    const color = m.color || meta.color;
    const href = id === 'rent' ? '#/rent' : `#/module/${id}`;
    return `<a class="card kpi" href="${href}" title="${esc(m.top_item || '')}">
      <div class="kpi-head"><div class="icon-sq" style="background:${tint(color)}">${m.emoji || meta.emoji}</div>${esc(m.name || meta.name)}</div>
      <div><div class="kpi-label">Price pressure</div>
        <div class="big" style="margin-top:6px"><span class="cu" data-to="${isNum(m.pressure) ? m.pressure : ''}">–</span><small>/100</small></div></div>
      <div class="bar"><i style="background:${color}" data-w="${isNum(m.pressure) ? m.pressure : 0}"></i></div>
      ${deltaPill(m.change_6m_pct, 'in 6 mo') || `<span class="pill flat">Forecast pending</span>`}
    </a>`;
  }).join('');
  icons();
  requestAnimationFrame(() => {
    el.querySelectorAll('.bar i').forEach(i => (i.style.width = Math.max(0, Math.min(100, i.dataset.w)) + '%'));
    el.querySelectorAll('.cu').forEach(c => c.dataset.to !== '' && countUp(c, Number(c.dataset.to)));
  });
}

function renderBasket(page, mods) {
  const items = Object.fromEntries(mods.flatMap(m => m.items || []).map(i => [i.item_id, i]));
  const rows = BASKET.map(id => ({ id, ...ITEM_META[id], v: items[id]?.change_6m_pct, name: items[id]?.name }))
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
    return `<div class="wcol" title="${esc(r.name || r.short)}: ${pct(r.v, 1)} in 6 months">
      <div class="val ${hot ? 'hot' : r.v < 0 ? 'neg' : ''}">${pct(r.v)}</div>
      <div class="wstack">${sq}</div>
      <div class="emo">${r.emoji}</div><div class="nm">${esc(r.short)}</div></div>`;
  }).join('');
}

function anomalyOf(reg) {
  const sig = REGION_META[reg.region_id]?.[1];
  const a = reg.anomaly || {};
  if (sig === 'water' && isNum(a.ndwi_vs_5yr_pct)) return { v: a.ndwi_vs_5yr_pct, idx: 'NDWI' };
  if (isNum(a.ndvi_vs_5yr_pct)) return { v: a.ndvi_vs_5yr_pct, idx: 'NDVI' };
  return null;
}

function renderMap(page, mods) {
  const map = page.querySelector('#map');
  const img = map.querySelector('img.world');
  const regions = mods.flatMap(m => (m.regions || []).map(r => ({ ...r, module: r.module || m.module?.id, color: m.module?.color || MODULE_META[m.module?.id]?.color })))
    .filter(r => isNum(r.lat) && isNum(r.lon));
  // Stats
  const an = regions.map(anomalyOf).filter(Boolean);
  const nd = regions.map(r => r.anomaly?.ndvi_vs_5yr_pct).filter(isNum);
  const stress = an.filter(a => a.v < -10).length;
  page.querySelector('#watch-sub').textContent = `${regions.length || 16} regions · Sentinel-2`;
  countUp(page.querySelector('#st-n'), regions.length || 16);
  if (an.length) countUp(page.querySelector('#st-d'), stress); else page.querySelector('#st-d').textContent = '–';
  const avg = nd.length ? nd.reduce((a, b) => a + b, 0) / nd.length : null;
  const sa = page.querySelector('#st-a');
  sa.textContent = pct(avg);
  if (isNum(avg) && avg >= 0) sa.className = 'v green';

  // Pins
  const pins = regions.map(r => {
    const a = anomalyOf(r);
    const p = document.createElement('div');
    p.className = 'pin' + (a && a.v < -10 ? ' pulse' : '');
    p.style.setProperty('--c', r.color);
    p.addEventListener('mousemove', e => showTip(`<b>${MODULE_META[r.module]?.emoji || ''} ${esc(r.name)}</b>${a ? `<span class="${a.v < 0 ? 'red' : 'green'}" style="font-weight:700">${a.idx} ${pct(a.v)} vs 5-yr</span>` : '<span class="muted">Anomaly pending</span>'}<div class="muted">Click to open ${esc(MODULE_META[r.module]?.name || '')}</div>`, e.clientX, e.clientY));
    p.addEventListener('mouseleave', hideTip);
    p.addEventListener('click', () => { hideTip(); location.hash = `#/module/${r.module}`; });
    map.appendChild(p);
    return { r, p, a };
  });
  const worst = pins.filter(x => x.a).sort((x, y) => x.a.v - y.a.v)[0];
  let callout = null;
  if (worst && worst.a.v < 0) {
    callout = document.createElement('div');
    callout.className = 'callout';
    const short = worst.r.name.replace(/ \(.*?\)/, '').replace(/ coffee| robusta| olive groves| cocoa belt| cocoa farms| citrus belt| wheat fields| hops| vineyards/i, '');
    callout.innerHTML = `<b>${MODULE_META[worst.r.module]?.emoji || ''} ${esc(short)}</b><span class="red">${worst.a.idx} ${pct(worst.a.v)} vs 5-yr</span>`;
    map.appendChild(callout);
  }

  const layout = () => {
    const mw = map.clientWidth, mh = map.clientHeight;
    if (!mw) return;
    const k = mw / 667, off = mw / 504, dy = (mh - mw * 267 / 504) / 2;
    Object.assign(img.style, { width: 1408 * k + 'px', height: 768 * k + 'px', left: -340.9 * off + 'px', top: -142.8 * off + dy + 'px' });
    for (const { r, p } of pins) {
      p.style.left = (721 + r.lon * 2.84) * k - 340.9 * off + 'px';
      p.style.top = (403 - r.lat * 3.06) * k - 142.8 * off + dy + 'px';
    }
    if (callout && worst) {
      const x = parseFloat(worst.p.style.left), y = parseFloat(worst.p.style.top);
      callout.style.left = Math.max(110, Math.min(mw - 110, x)) + 'px';
      callout.style.top = y + 'px';
      callout.style.transform = y > mh * 0.6 ? 'translate(-50%, calc(-100% - 18px))' : 'translate(-50%, 18px)';
    }
  };
  const ro = new ResizeObserver(layout);
  ro.observe(map);
  layout();

  // Filter
  const segs = page.querySelectorAll('#seg button');
  segs.forEach(b => b.addEventListener('click', () => {
    segs.forEach(x => x.classList.toggle('on', x === b));
    const f = b.dataset.f;
    const want = { All: null, Crops: ['crop'], Water: ['water'], Built: ['built', 'port'] }[f];
    pins.forEach(({ r, p }) => p.classList.toggle('dim', !!want && !want.includes(REGION_META[r.region_id]?.[1])));
    if (callout) callout.hidden = !!want && !want.includes(REGION_META[worst.r.region_id]?.[1]);
  }));
  icons();
  return () => ro.disconnect();
}
