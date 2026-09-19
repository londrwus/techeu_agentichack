// Beer & Wine screen (MODULES.md §08): crop-health heatmap (region × year, summer NDVI vs region mean)
// + Pint | Wine forecast card, signal row below. Owner: beer_wine screen agent.
import { moduleHeader, wireScan } from '../components/moduleHeader.js';
import { forecastChart } from '../components/forecastChart.js';
import { signalCards } from '../components/signalCards.js';
import { loadModule, ACCENT, ITEM_META, fmtGBP, esc, isNum, pct, shortRegion, countUp, satImg } from '../components/ui.js';

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

function ensureCss() {
  if (document.querySelector('link[data-bw-css]')) return;
  const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/static/css/beer_wine.css' });
  l.dataset.bwCss = '1';
  document.head.appendChild(l);
}

const kindOf = r => /hop/i.test(r.name || r.region_id) ? 'Hops' : /vine|grape|wine/i.test(r.name || r.region_id) ? 'Wine grapes' : 'Crop';

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

function heatCard(hd) {
  const legend = `<div class="bw-scale">Stressed<span></span>${SCALE.map(s => `<i style="background:${s[1]}"></i>`).join('')}<span></span>Healthy</div>`;
  const nowY = hd.years.at(-1);
  const cols = `grid-template-columns:130px repeat(${hd.years.length}, minmax(0,1fr));grid-template-rows:auto repeat(${hd.rows.length}, minmax(44px,1fr))`;
  let g = `<div></div>` + hd.years.map(y => `<div class="bw-yr${y === nowY ? ' now' : ''}">${y}</div>`).join('');
  hd.rows.forEach((row, ri) => {
    const r = row.region;
    g += `<div class="bw-row" data-item="${esc(r.item || '')}"><b>${esc(shortRegion(r))}</b><small><i></i>${kindOf(r)}</small></div>`;
    hd.years.forEach((y, ci) => {
      const c = row.cells[y];
      const now = y === nowY ? ' now' : '';
      if (!c) { g += `<div class="bw-cell na${now}" data-col="${ci}">·</div>`; return; }
      const v = Math.round(c.pct), [, bg, fg] = bucket(v);
      g += `<div class="bw-cell${now}" data-col="${ci}" data-r="${ri}" data-y="${y}" style="background:${bg};color:${fg}">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}</div>`;
    });
  });
  const sub = `Sentinel-2 NDVI, Jun–Aug mean vs ${hd.years.length}-year average, %`;
  return `<section class="bw-card bw-heat">
    <div class="bw-head"><div><div class="bw-title">Crop health by region</div><div class="bw-sub">${sub}</div></div>${legend}</div>
    <div class="bw-grid" style="${cols}">${g}</div>
  </section>`;
}

function fcCard(items) {
  const seg = items.length > 1
    ? `<div class="seg">${items.map((it, i) => `<button data-item="${esc(it.item_id)}" class="${i ? '' : 'on'}">${esc(ITEM_META[it.item_id]?.short || it.name)}</button>`).join('')}</div>` : '';
  return `<section class="bw-card bw-fc">${seg}
    <div class="lbl"></div>
    <div class="hero-price"><b class="bw-big">–</b><span class="bw-from"></span></div>
    <div class="fc-host"></div>
    <div class="stat-strip"></div>
  </section>`;
}

export async function render(el) {
  ensureCss();
  el.innerHTML = moduleHeader(ID, null) + `<div class="bw-hero"><div class="card skeleton"></div><div class="card skeleton"></div></div><div class="card skeleton" style="height:232px"></div>`;
  wireScan(el);
  const data = await loadModule(ID);
  if (!data) { el.innerHTML = moduleHeader(ID, null) + `<div class="empty">No data for this module yet.</div>`; wireScan(el); return; }

  const accent = ACCENT[ID];
  const items = (data.items || []).filter(it => it?.history?.length && it?.forecast?.length);
  const hd = heatData(data.regions || []);
  const showHeat = hd.rows.length && hd.years.length;

  el.innerHTML = moduleHeader(ID, data) + `
    <div class="bw-hero" style="${!showHeat || !items.length ? 'grid-template-columns:1fr' : ''}">
      ${showHeat ? heatCard(hd) : ''}${items.length ? fcCard(items) : ''}
    </div>
    <section class="bw-sig"></section>`;
  wireScan(el);
  const disposers = [];

  // Heatmap: column-by-column fade in + hover tooltip with the July tile.
  if (showHeat) {
    const cells = [...el.querySelectorAll('.bw-cell')];
    const timers = cells.map(c => setTimeout(() => c.classList.add('in'), 120 + 60 * Number(c.dataset.col)));
    disposers.push(() => timers.forEach(clearTimeout));
    const tip = Object.assign(document.createElement('div'), { className: 'tooltip' });
    tip.hidden = true;
    document.body.appendChild(tip);
    disposers.push(() => tip.remove());
    const grid = el.querySelector('.bw-grid');
    grid.addEventListener('mousemove', e => {
      const c = e.target.closest('.bw-cell[data-r]');
      if (!c) { tip.hidden = true; return; }
      const row = hd.rows[+c.dataset.r], cell = row.cells[c.dataset.y];
      if (tip.dataset.k !== c.dataset.r + c.dataset.y) {
        tip.dataset.k = c.dataset.r + c.dataset.y;
        tip.innerHTML = `<div class="bw-tip">${satImg(row.region.region_id, cell.month, { alt: '' })}<div>
          <b>${esc(shortRegion(row.region))} · ${c.dataset.y}</b>
          <div class="muted">Summer NDVI ${cell.ndvi.toFixed(2)} · avg ${cell.base.toFixed(2)}</div>
          <div class="v">${pct(cell.pct, 1)}</div><div class="muted">Tile: ${monLong(cell.month)}</div></div></div>`;
      }
      tip.hidden = false;
      const x = Math.min(e.clientX + 16, innerWidth - tip.offsetWidth - 12), y = Math.min(e.clientY + 16, innerHeight - tip.offsetHeight - 12);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    });
    grid.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  // Forecast card with Pint | Wine toggle.
  if (items.length) {
    const card = el.querySelector('.bw-fc');
    let fc = null;
    const show = id => {
      const it = items.find(i => i.item_id === id) || items[0];
      const h = it.history, f = it.forecast;
      const now = h.at(-1).price, end = f.at(-1).p50, short = ITEM_META[it.item_id]?.short || it.name;
      card.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.item === it.item_id));
      card.querySelector('.lbl').textContent = `${it.name}${PLACE[it.item_id] ? ', ' + PLACE[it.item_id] : ''}`;
      countUp(card.querySelector('.bw-big'), end, { digits: 2, prefix: '£', dur: 700 });
      card.querySelector('.bw-from').textContent = `from ${fmtGBP(now)} today`;
      const chg12 = now > 0 ? (end / now - 1) * 100 : null;
      const f6 = f[Math.min(5, f.length - 1)];
      const stats = [
        isNum(it.prob_up_6m) && `<div><div class="v">${Math.round(it.prob_up_6m * 100)}%</div><div class="l">chance it rises, 6 mo</div></div>`,
        isNum(chg12) && `<div><div class="v" style="color:${chg12 > 0 ? 'var(--up)' : 'var(--down)'}">${pct(chg12, 1)}</div><div class="l">by ${monLong(f.at(-1).month)}</div></div>`,
        isNum(f6?.p10) && isNum(f6?.p90) && `<div><div class="v">${fmtGBP(f6.p10)} – ${fmtGBP(f6.p90)}</div><div class="l">p10–p90, 6 mo</div></div>`,
      ].filter(Boolean);
      const strip = card.querySelector('.stat-strip');
      strip.innerHTML = stats.join('');
      strip.hidden = !stats.length;
      const opts = { history: h, forecast: f, accent, unit: it.unit || '£', calloutTitle: short, months: 12 };
      fc ? fc.update(opts) : (fc = forecastChart(card.querySelector('.fc-host'), opts));
      // Emphasise the heatmap rows that feed this item.
      el.querySelectorAll('.bw-row').forEach(r => {
        const on = r.dataset.item === it.item_id;
        r.style.setProperty('--c', accent); r.classList.toggle('on', on);
        r.style.opacity = r.dataset.item && !on ? .55 : 1;
      });
    };
    card.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => show(b.dataset.item)));
    show(items[0].item_id);
    disposers.push(() => fc?.dispose());
  }

  const sc = signalCards(el.querySelector('.bw-sig'), data, {
    accent, priceItem: items.find(i => i.item_id === 'wine') || items[1] || items[0], priceTitle: 'Wine, bottle',
  });
  disposers.push(() => sc.dispose());
  return () => disposers.forEach(d => d());
}
