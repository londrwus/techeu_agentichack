// Latte Index screen (MODULES.md §07): hero forecast + Sul de Minas before/after, then the shared signal row.
import { moduleHeader, wireScan, backtestBadge } from '../components/moduleHeader.js';
import { forecastChart } from '../components/forecastChart.js';
import { signalCards } from '../components/signalCards.js';
import { loadModule, ACCENT, fmtGBP, isNum, esc, monthLabel, shortRegion, countAll, deltaText, icon } from '../components/ui.js';

const ID = 'latte', REGION = 'minas_coffee';

function css() {
  if (document.getElementById('latte-css')) return;
  document.head.insertAdjacentHTML('beforeend', '<link id="latte-css" rel="stylesheet" href="/static/css/latte.css">');
}

const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };

/** Latest clear tile + same season 5 years earlier (lowest cloud within ±1 month). */
function pickPair(region) {
  const s = (region?.series || []).filter(p => p?.thumb && isNum(p.cloud_pct));
  if (s.length < 2) return null;
  const recent = s.slice(-4);
  const clear = recent.filter(p => p.cloud_pct <= 10);
  const after = clear.length ? clear[clear.length - 1] : recent.reduce((a, b) => (b.cloud_pct < a.cloud_pct ? b : a));
  const target = addMonths(after.month, -60);
  const win = [-1, 0, 1].map(d => addMonths(target, d));
  let cands = s.filter(p => win.includes(p.month));
  if (!cands.length) cands = s.filter(p => p.month < addMonths(after.month, -36)).slice(-3);
  if (!cands.length) return null;
  const before = cands.reduce((a, b) => (b.cloud_pct < a.cloud_pct - 0.5 || (Math.abs(b.cloud_pct - a.cloud_pct) <= 0.5 && b.month === target) ? b : a));
  return { before, after };
}

export async function render(el) {
  css();
  el.innerHTML = moduleHeader(ID, null) + `<div class="card skeleton" style="height:500px"></div>`;
  wireScan(el);
  const data = await loadModule(ID);
  if (!data) { el.innerHTML = moduleHeader(ID, null) + `<div class="empty">No data for this module yet.</div>`; wireScan(el); return; }

  const accent = ACCENT[ID];
  const item = data.items?.find(i => i.item_id === 'latte') || data.items?.[0];
  const region = data.regions?.find(r => r.region_id === REGION) || data.regions?.[0];
  const sig = data.signals || {};

  const flagged = backtestBadge(data);
  const right = flagged ? '' : `<a class="backtest muted" href="#/track"><i data-lucide="history"></i><span>Backtested since 2018</span></a>`;

  // Hero numbers (real data)
  const hist = item?.history || [], fc = item?.forecast || [];
  const now = isNum(item?.retail_now) ? item.retail_now : hist.at(-1)?.price;
  const end = fc.at(-1)?.p50;
  const p6 = fc[Math.min(5, fc.length - 1)];
  const chg12 = isNum(now) && isNum(end) ? (end / now - 1) * 100 : null;
  const press = sig.net_supply_pressure;

  const stats = [
    isNum(item?.prob_up_6m) && `<div><div class="v" data-count="${Math.round(item.prob_up_6m * 100)}" data-suffix="%">0%</div><div class="l">chance it rises in 6 mo</div></div>`,
    isNum(press) && `<div><div class="v" style="color:var(--${press > 0.05 ? 'up' : press < -0.05 ? 'down' : 'text-1'})">${press > 0 ? '+' : press < 0 ? '−' : ''}${Math.abs(press).toFixed(2)}</div><div class="l">coffee supply pressure · Jev</div></div>`,
    p6 && isNum(p6.p10) && isNum(p6.p90) && `<div><div class="v">p10–p90</div><div class="l">${fmtGBP(p6.p10)} – ${fmtGBP(p6.p90)} in 6 mo</div></div>`,
  ].filter(Boolean).join('');

  const pair = pickPair(region);
  const ndvi = region?.anomaly?.ndvi_vs_5yr_pct;
  const ndviPill = isNum(ndvi) ? `<span class="pill ${ndvi < 0 ? 'up' : 'down'}"><i data-lucide="leaf"></i>NDVI ${ndvi > 0 ? '+' : ndvi < 0 ? '−' : ''}${Math.abs(Math.round(ndvi))}%</span>` : '';
  const note = data.insights?.vision_notes?.find(v => v.region_id === region?.region_id)?.text;

  const fcCard = item && hist.length ? `
    <section class="card lt-fc">
      <div class="lt-fc-head">
        <div><div class="k">${esc(item.name?.replace(/\s*\((.*)\)/, ', $1') || 'Latte')}</div>
          <div class="hero-price"><b data-count="${end ?? now}" data-digits="2" data-prefix="£">£0.00</b><span>from ${fmtGBP(now)} today${isNum(chg12) ? ` · ${deltaText(chg12)} in 12 mo` : ''}</span></div></div>
        <div class="fc-legend"><span><i></i>History</span><span><i class="dash" style="--c:${accent}"></i>Forecast (p50)</span></div>
      </div>
      <div class="lt-chart"></div>
      ${stats ? `<div class="stat-strip">${stats}</div>` : ''}
    </section>` : '';

  const satCard = region ? `
    <section class="card lt-sat">
      <div class="lt-sat-head">
        <div><h3>${esc(shortRegion(region))}, from orbit</h3>
          <div class="sub">Sentinel-2${pair ? ` · ${monthLabel(pair.before.month, true)} vs ${monthLabel(pair.after.month, true)}` : ''}</div></div>
        ${ndviPill}
      </div>
      ${pair ? `<div class="compare" ${note ? `title="${esc(note)}"` : ''}>
          <img class="after" data-no-lightbox src="/${pair.after.thumb}" alt="${esc(pair.after.month)}">
          <img class="before" data-no-lightbox src="/${pair.before.thumb}" alt="${esc(pair.before.month)}" style="clip-path:inset(0 50% 0 0)">
          <div class="handle" style="left:50%"><div class="knob"><i data-lucide="chevrons-left-right"></i></div></div>
          <div class="lt-zoom">
            <button type="button" data-sat-region="${esc(region.region_id)}" data-sat-month="${esc(pair.before.month)}" title="Open ${monthLabel(pair.before.month, true)} tile">${icon('zoom-in', { size: 14 })}${monthLabel(pair.before.month, true)}</button>
            <button type="button" data-sat-region="${esc(region.region_id)}" data-sat-month="${esc(pair.after.month)}" title="Open ${monthLabel(pair.after.month, true)} tile">${icon('zoom-in', { size: 14 })}${monthLabel(pair.after.month, true)}</button>
          </div></div>
        <div class="lt-hint">Drag to compare · click a date to zoom</div>`
        : `<div class="empty" style="margin-top:16px">Satellite tiles are still downloading…</div>`}
    </section>` : '';

  el.innerHTML = moduleHeader(ID, data, { right }) + `<div class="lt-page">
      ${fcCard || satCard ? `<div class="lt-hero" ${!fcCard || !satCard ? 'style="grid-template-columns:1fr"' : ''}>${fcCard}${satCard}</div>` : ''}
      <section></section></div>`;
  wireScan(el);
  countAll(el);

  const disposers = [];
  const host = el.querySelector('.lt-chart');
  if (host) {
    const c = forecastChart(host, { history: hist, forecast: fc, accent, unit: item.unit || '£', calloutTitle: 'Latte', months: 12 });
    disposers.push(() => c.dispose());
  }

  // Before/after slider
  const cmp = el.querySelector('.compare');
  if (cmp) {
    cmp.querySelectorAll('img').forEach(im => im.addEventListener('error', () => (im.style.visibility = 'hidden')));
    const bImg = cmp.querySelector('img.before'), handle = cmp.querySelector('.handle');
    let drag = false;
    const set = x => {
      const r = cmp.getBoundingClientRect();
      const p = Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100));
      bImg.style.clipPath = `inset(0 ${100 - p}% 0 0)`; handle.style.left = p + '%';
    };
    cmp.addEventListener('pointerdown', e => { if (e.target.closest('.lt-zoom')) return; drag = true; cmp.setPointerCapture(e.pointerId); set(e.clientX); });
    cmp.addEventListener('pointermove', e => drag && set(e.clientX));
    cmp.addEventListener('pointerup', () => (drag = false));
    cmp.addEventListener('pointercancel', () => (drag = false));
  }

  // Signal row. Price card = the pure TimesFM baseline (hero shows TimesFM + Orbit signal), so it isn't a duplicate.
  const base = item?.model_forecast?.length ? { ...item, forecast: item.model_forecast, model: 'TimesFM baseline' } : item;
  const sc = signalCards(el.querySelector('.lt-page > section:last-child'), data, { accent, priceItem: base, priceTitle: 'TimesFM only' });
  disposers.push(() => sc.dispose());

  return () => disposers.forEach(d => { try { d(); } catch (e) { console.warn(e); } });
}
