// Groceries — Shop (MODULES.md 06b): Amazon-style product grid, Keepa-style detail, weekly basket.
// Owner: groceries screen agent. Renders only real /api/modules/groceries data; hides widgets without data.
import { topbar, wireScan } from './common.js';
import { backtestBadge } from '../components/moduleHeader.js';
import { forecastChart } from '../components/forecastChart.js';
import { loadModule, ACCENT, esc, isNum, countUp, retailSeries, shortRegion, satImg, icon, itemIcon, moduleIcon, arrowIcon } from '../components/ui.js';
import { tipHtml, fmtMonth, fmtPct } from '../components/chartTheme.js';
import { toast } from '../lib.js';

const ACC = ACCENT.groceries;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mon = m => MON[+m.split('-')[1] - 1];
const monY = m => `${mon(m)} ${m.slice(0, 4)}`;
const gbp = v => (isNum(v) ? '£' + v.toFixed(2) : '–');
const DEFAULT_QTY = { chocolate: 2, olive_oil: 1, orange_juice: 2, bread: 1 };
const QTY_KEY = 'orbit.groceries.qty';
const REC = {
  stock: { label: 'Stock up now', cls: 'stock' },
  wait: { label: 'Wait', cls: 'wait' },
  hold: { label: 'Hold', cls: 'hold' },
};

function ensureCss() {
  if (document.getElementById('gs-css')) return;
  const l = document.createElement('link');
  l.id = 'gs-css'; l.rel = 'stylesheet'; l.href = '/static/css/groceries.css';
  document.head.appendChild(l);
}
function loadQty() {
  try { return { ...DEFAULT_QTY, ...JSON.parse(localStorage.getItem(QTY_KEY) || '{}') }; } catch { return { ...DEFAULT_QTY }; }
}
function saveQty(q) { try { localStorage.setItem(QTY_KEY, JSON.stringify(q)); } catch { /* ignore */ } }

/** "Chocolate bar (100g)" → {name:"Chocolate bar", size:"100 g"} */
function splitName(n) {
  const m = String(n || '').match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (!m) return { name: n, size: '' };
  return { name: m[1], size: m[2].replace(/(\d)([a-zA-Z])/, '$1 $2') };
}
function recOf(it) {
  if (!isNum(it.chg)) return null;
  if (isNum(it.prob) && it.prob >= 0.6 && it.chg >= 2) return 'stock';
  if (it.chg <= -2) return 'wait';
  return isNum(it.prob) ? 'hold' : null;
}
function pillCls(v) { return v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat'; }
function pill(v) {
  if (!isNum(v)) return '';
  const c = pillCls(v);
  return `<span class="gs-pill ${c}">${arrowIcon(v, 12)}${Math.abs(v).toFixed(1)}%</span>`;
}
/** Product packshot, whole object visible (contain on white). Falls back to a Lucide item icon. */
function photo(id, cls = '') {
  return `<span class="gs-pic ${cls}"><img src="/static/assets/products/${id}.jpg" alt="" data-no-lightbox onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="gs-noimg" hidden>${itemIcon(id, { size: 28 })}</span></span>`;
}
/** Best recent satellite month for a region: latest with a thumb and cloud ≤ 60 %, else latest thumb. */
function bestMonth(r) {
  const s = (r?.series || []).filter(p => p?.thumb && p.month);
  const clear = s.filter(p => !isNum(p.cloud_pct) || p.cloud_pct <= 60);
  return (clear.at(-1) || s.at(-1))?.month || null;
}
function regionLabel(r) {
  const parts = String(r.name || '').split(',');
  const country = parts.length > 1 ? parts.at(-1).trim() : '';
  return shortRegion(r) + (country ? `, ${country}` : '');
}
/** Sparkline points: last 12 months of shelf price + 6 forecast months (p50, with p10/p90). */
function sparkPts(it) {
  return [
    ...it.hist.slice(-12).filter(p => isNum(p.price)).map(p => ({ month: p.month, v: p.price })),
    ...it.fc.slice(0, 6).filter(p => isNum(p.p50)).map(p => ({ month: p.month, v: p.p50, lo: p.p10, hi: p.p90, fc: true })),
  ];
}
const SW = 160, SH = 30;
const sx = (i, n) => i / (n - 1) * (SW - 4) + 2;
function sparkline(it) {
  const pts = it.spark;
  if (pts.length < 3) return '';
  const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v)), sp = hi - lo || 1;
  const xy = pts.map((p, i) => [sx(i, pts.length), SH - 4 - (p.v - lo) / sp * (SH - 8)]);
  pts.forEach((p, i) => { p.x = xy[i][0] / SW; p.y = xy[i][1] / SH; });
  const k = pts.findIndex(p => p.fc), nH = k < 0 ? pts.length : k;
  const path = a => a.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const col = isNum(it.chg) && it.chg < 0 ? 'var(--down)' : ACC;
  const hPath = path(xy.slice(0, nH)), fPath = k > 0 ? path(xy.slice(nH - 1)) : '';
  return `<div class="gs-sparkw" data-spark="${it.id}">
    <svg class="gs-spark" viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="none">
      <path d="${hPath}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${fPath ? `<path class="fc" d="${fPath}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="3 3" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` : ''}
    </svg>
    ${k > 0 ? `<i class="gs-snow" style="left:${(xy[nH - 1][0] / SW * 100).toFixed(2)}%"></i>` : ''}
    <i class="gs-sline" hidden></i><i class="gs-sdot" hidden style="--c:${col}"></i>
  </div>`;
}
function pUp(h) { const p = h?.supply_effect?.probs || {}; return (p.strongly_up || 0) + (p.up || 0); }
function pDown(h) { const p = h?.supply_effect?.probs || {}; return (p.strongly_down || 0) + (p.down || 0); }

/** Normalise items with everything the widgets need. */
function buildItems(data) {
  const regions = data.regions || [];
  const judg = data.signals?.region_judgments || [];
  const heads = data.signals?.headlines || [];
  return (data.items || []).map(raw => {
    const { history: hist, forecast: fc } = retailSeries(raw);
    const now = isNum(raw.retail_now) ? raw.retail_now : hist.at(-1)?.price;
    const p6 = isNum(raw.retail_6m) ? raw.retail_6m : fc[5]?.p50 ?? fc.at(-1)?.p50;
    const chg = isNum(raw.change_6m_pct) ? raw.change_6m_pct : (isNum(now) && isNum(p6) ? (p6 / now - 1) * 100 : null);
    const region = regions.find(r => (r.item || r.item_id) === raw.item_id && bestMonth(r)) || regions.find(r => (r.item || r.item_id) === raw.item_id);
    const j = region && judg.find(x => x.region_id === region.region_id);
    const seen = new Set();
    const hl = heads.filter(h => h.item_id === raw.item_id && h.title && !seen.has(h.title) && seen.add(h.title))
      .sort((a, b) => Math.max(pUp(b), pDown(b)) - Math.max(pUp(a), pDown(a)) || pUp(b) - pUp(a)).slice(0, 3);
    const it = {
      id: raw.item_id, raw, ...splitName(raw.name), hist, fc, now, p6, chg, prob: raw.prob_up_6m,
      region, month: region ? bestMonth(region) : null, judg: j, hl,
      nHl: heads.filter(h => h.item_id === raw.item_id).length,
    };
    it.rec = recOf(it);
    it.spark = sparkPts(it);
    return it;
  });
}

function cardHtml(it, i) {
  const rec = it.rec && REC[it.rec];
  return `<button class="gs-card" data-id="${it.id}" style="animation-delay:${i * 40}ms">
    <div class="gs-photo">${photo(it.id)}</div>
    ${rec ? `<span class="gs-badge ${rec.cls}"><i></i>${rec.label}</span>` : ''}
    <div class="gs-info">
      ${it.region ? `<div class="gs-origin">${satImg(it.region.region_id, it.month, { alt: it.region.name })}${esc(regionLabel(it.region))}</div>` : ''}
      <div class="gs-name">${esc(it.name)}${it.size ? `<small>${esc(it.size)}</small>` : ''}</div>
      <div class="gs-price">${gbp(it.now)}</div>
      ${isNum(it.p6) ? `<div class="gs-then"><span>in 6 months ${gbp(it.p6)}</span>${pill(it.chg)}</div>` : ''}
      ${sparkline(it)}
    </div>
  </button>`;
}

function evidenceHtml(it, data) {
  const r = it.region, parts = [];
  if (r) {
    const ndvi = r.anomaly?.ndvi_vs_5yr_pct;
    const p = it.judg?.harvest_risk?.probs;
    const risk = p ? (p.high || 0) + (p.severe || 0) : null;
    parts.push(`<div class="gs-farm">${satImg(r.region_id, it.month, { alt: r.name })}
      <div style="min-width:0"><div class="gs-eyebrow">Sentinel-2 · ${it.month ? monY(it.month) : ''}</div>
        <div class="gs-farm-name">${esc(regionLabel(r))}</div>
        <div class="gs-stats">
          ${isNum(ndvi) ? `<div><b style="color:${ndvi < 0 ? '#EA580C' : 'var(--down)'}">${ndvi > 0 ? '+' : ndvi < 0 ? '−' : ''}${Math.abs(ndvi).toFixed(0)}%</b><span>Crop health</span></div>` : ''}
          ${isNum(risk) ? `<div><b>${Math.round(risk * 100)}%</b><span>Harvest risk</span></div>` : ''}
        </div></div></div>`);
  }
  if (it.hl.length) {
    parts.push(`<div class="gs-why"><b>Why it moves</b><span>Jev · ${(it.nHl || data.signals?.n_judgments || 0).toLocaleString('en-GB')} headlines judged</span></div>`);
    parts.push(it.hl.map(h => {
      const up = pUp(h), dn = pDown(h), isUp = up >= dn;
      const d = h.date ? `${mon(h.date.slice(0, 7))} ${h.date.slice(0, 4)}` : '';
      return `<a class="gs-hl" href="${esc(h.url || '#')}" target="_blank" rel="noopener">
        <div style="min-width:0"><div class="t">${esc(h.title)}</div><div class="s">${esc(h.source || '')}${d ? ` · ${d}` : ''}</div></div>
        <div class="p"><b class="${isUp ? 'up' : 'down'}">${arrowIcon(isUp ? 1 : -1, 12)}${Math.min(99, Math.round((isUp ? up : dn) * 100))}%</b><span>chance price ${isUp ? 'rises' : 'falls'}</span></div></a>`;
    }).join(''));
  }
  return parts.length ? `<div class="gs-ev">${parts.join('')}</div>` : '';
}

export async function render(el) {
  ensureCss();
  const head = d => topbar({
    crumb: 'Modules  /  Groceries  /  Shop', title: 'Groceries',
    iconSq: `<div class="icon-sq lg" style="background:${ACC}1A;color:${ACC}">${moduleIcon('groceries', { size: 22 })}</div>`,
    right: d ? backtestBadge(d) : '',
  });
  el.innerHTML = head(null) + `<div class="card skeleton" style="height:600px"></div>`;
  wireScan(el);
  const data = await loadModule('groceries');
  if (!el.isConnected) return;
  if (!data?.items?.length) { el.innerHTML = head(null) + `<div class="empty">No groceries data yet.</div>`; wireScan(el); return; }

  const items = buildItems(data);
  const qty = loadQty();
  const state = { filter: 'all', sort: 'rise', sel: [...items].sort((a, b) => (b.chg ?? -99) - (a.chg ?? -99))[0]?.id, range: 12 };
  const cnt = {
    all: items.length, rising: items.filter(i => i.chg > 0).length,
    falling: items.filter(i => i.chg < 0).length, staples: items.length,
  };
  const chip = (k, l) => `<button class="gs-chip${k === 'all' ? ' on' : ''}" data-f="${k}" ${cnt[k] ? '' : 'disabled'}>${l}<span>${cnt[k]}</span></button>`;

  el.innerHTML = head(data) + `
  <div class="gs">
    <div class="gs-shop">
      <div class="gs-filter">
        <div class="gs-chips">${chip('all', 'All')}${chip('rising', 'Rising')}${chip('falling', 'Falling')}${chip('staples', 'Staples')}</div>
        <label class="gs-sort">Sort by <select>
          <option value="rise">Biggest 6-mo rise</option><option value="drop">Biggest 6-mo drop</option>
          <option value="prob">Most likely to rise</option><option value="price">Price: low to high</option>
        </select><i data-lucide="chevron-down"></i></label>
      </div>
      <div class="gs-grid">${items.map(cardHtml).join('')}</div>
      <section class="card gs-detail"></section>
    </div>
    <aside class="card gs-cart"></aside>
  </div>`;
  wireScan(el);
  const $ = s => el.querySelector(s);
  const grid = $('.gs-grid'), detail = $('.gs-detail'), cart = $('.gs-cart');
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  let fc = null;

  // ---------- grid: filter + sort ----------
  function applyGrid() {
    const keyF = { rise: i => -(i.chg ?? -99), drop: i => i.chg ?? 99, prob: i => -(i.prob ?? 0), price: i => i.now ?? 0 }[state.sort];
    const show = { all: () => true, staples: () => true, rising: i => i.chg > 0, falling: i => i.chg < 0 }[state.filter];
    [...items].sort((a, b) => keyF(a) - keyF(b)).forEach(it => {
      const c = grid.querySelector(`[data-id="${it.id}"]`);
      c.hidden = !show(it); grid.appendChild(c);
      c.classList.toggle('sel', it.id === state.sel && !detail.hidden);
    });
  }
  el.querySelectorAll('.gs-chip').forEach(b => b.addEventListener('click', () => {
    state.filter = b.dataset.f;
    el.querySelectorAll('.gs-chip').forEach(x => x.classList.toggle('on', x === b));
    applyGrid();
  }));
  $('.gs-sort select').addEventListener('change', e => { state.sort = e.target.value; applyGrid(); });
  grid.addEventListener('click', e => {
    if (e.target.closest('[data-sat-region]')) return; // satellite thumb → lightbox only
    const c = e.target.closest('.gs-card'); if (!c) return;
    const wasHidden = detail.hidden;
    state.sel = c.dataset.id; detail.hidden = false; applyGrid();
    if (wasHidden) renderDetail(); else { detail.classList.add('fade'); setTimeout(() => { renderDetail(); detail.classList.remove('fade'); }, 150); }
  });

  // ---------- detail ----------
  function renderDetail() {
    fc?.dispose(); fc = null;
    const it = byId[state.sel]; if (!it) { detail.hidden = true; return; }
    const hShown = it.hist.slice(-state.range), last = it.fc.slice(0, 6).at(-1)?.month;
    const ev = evidenceHtml(it, data);
    detail.innerHTML = `
      <div class="gs-dhead">${photo(it.id, 'gs-dthumb')}
        <div><div class="gs-dtitle">${esc(it.name)}${it.size ? ` · ${esc(it.size)}` : ''}</div>
          <div class="gs-dsub">Price history &amp; ${esc((it.raw.model || 'TimesFM').split('+')[0].trim())} forecast${hShown[0] && last ? ` · ${monY(hShown[0].month)} – ${monY(last)}` : ''}</div></div>
        <div class="gs-seg">${[12, 36, 60].map(m => `<button data-r="${m}" class="${m === state.range ? 'on' : ''}">${m / 12}Y</button>`).join('')}</div>
        <button class="gs-x" title="Close">${icon('x', { size: 16 })}</button>
      </div>
      <div class="gs-dbody${ev ? '' : ' solo'}"><div class="gs-chartwrap"><div class="fc gs-chart"></div><div class="gs-call"></div></div>${ev}</div>`;
    window.lucide?.createIcons();
    detail.querySelector('.gs-x').addEventListener('click', () => { detail.hidden = true; fc?.dispose(); fc = null; applyGrid(); });
    detail.querySelectorAll('.gs-seg button').forEach(b => b.addEventListener('click', () => {
      state.range = +b.dataset.r;
      detail.querySelectorAll('.gs-seg button').forEach(x => x.classList.toggle('on', x === b));
      drawChart(it);
      const s = detail.querySelector('.gs-dsub'); const h0 = it.hist.slice(-state.range)[0];
      if (s && h0 && last) s.innerHTML = s.innerHTML.replace(/· \w{3} \d{4} – /, `· ${monY(h0.month)} – `);
    }));
    drawChart(it);
    // Drop headlines that would overflow the evidence column.
    const ev2 = detail.querySelector('.gs-ev');
    requestAnimationFrame(() => { while (ev2 && ev2.scrollHeight > ev2.clientHeight + 1 && ev2.querySelectorAll('.gs-hl').length > 1) [...ev2.querySelectorAll('.gs-hl')].pop().remove(); });
  }
  function drawChart(it) {
    const wrap = detail.querySelector('.gs-chartwrap'); if (!wrap) return;
    const host = wrap.querySelector('.gs-chart');
    const f6 = it.fc.slice(0, 6), hv = it.hist.slice(-state.range);
    if (!hv.length && !f6.length) { wrap.remove(); return; }
    // Leave the top ~40% free for the callout card (Keepa-style headroom).
    const vals = [...hv.map(p => p.price), ...f6.flatMap(p => [p.p10, p.p50, p.p90])].filter(isNum);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || hi * 0.05 || 1;
    const raw = (span * 1.8) / 5, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw);
    const yMin = Math.max(0, Math.floor((lo - span * 0.08) / step) * step), yMax = Math.ceil((hi + span * 0.75) / step) * step;
    const opts = { history: it.hist, forecast: f6, accent: ACC, unit: '£', band: true, months: state.range, showCallout: false, yMin, yMax };
    if (fc) fc.update(opts); else fc = forecastChart(host, opts);
    fc.chart?.setOption({ series: [{ step: 'end' }], yAxis: { interval: step } });
    const f = f6.at(-1), call = wrap.querySelector('.gs-call');
    if (!f || !isNum(it.now)) { call.hidden = true; return; }
    const d = (f.p50 / it.now - 1) * 100, c = pillCls(d);
    call.innerHTML = `<div class="t">${esc(it.name)} · ${monY(f.month)}</div>
      <div class="v"><b>${gbp(f.p50)}</b><span class="delta ${c}">${arrowIcon(d)}${Math.abs(d).toFixed(1)}%</span></div>
      ${isNum(f.p10) && isNum(f.p90) ? `<div class="l3">likely ${gbp(f.p10)} – ${gbp(f.p90)}${isNum(it.prob) ? ` · ${Math.round(it.prob * 100)}% chance it rises` : ''}</div>` : ''}`;
    call.classList.remove('on'); void call.offsetWidth; call.classList.add('on');
  }

  // ---------- cart ----------
  cart.innerHTML = `
    <div class="gs-chead"><div><h2>Your weekly basket</h2><div class="sub"></div></div>
      <div class="gs-cicon">${icon('shopping-basket', { size: 18 })}</div></div>
    <div class="gs-rows">${items.map(it => `
      <div class="gs-row" data-id="${it.id}">${photo(it.id)}
        <div style="min-width:0"><div class="nm">${esc(it.name)}</div>
          <div class="gs-step"><button data-d="-1" aria-label="Less">${icon('minus', { size: 12, stroke: 2.25 })}</button><span class="q"></span><button data-d="1" aria-label="More">${icon('plus', { size: 12, stroke: 2.25 })}</button></div></div>
        <div class="amt"><b class="now"></b><span class="then"></span></div>
      </div>`).join('')}</div>
    <div class="gs-bars-wrap"><div class="gs-bars-head"><b>Basket cost by month</b><span>£ · TimesFM p50</span></div><div class="gs-bars"></div></div>
    <div class="gs-tot"><div>Total today<b class="t0"></b></div><div>Same basket in 6 months<b class="t6"></b></div></div>
    <div class="gs-save"></div>
    <button class="gs-buy">${icon('package-plus', { size: 18 })}<span></span></button>`;
  window.lucide?.createIcons();

  // Months: today (last history) + next 6 forecast months, only if every item has them.
  const months = (() => {
    const base = items[0];
    const ms = [base.hist.at(-1)?.month, ...base.fc.slice(0, 6).map(p => p.month)].filter(Boolean);
    return items.every(i => i.hist.length && i.fc.length >= 6) ? ms : [];
  })();
  const priceAt = (it, k) => (k === 0 ? it.now : it.fc[k - 1]?.p50);
  let barTot = [];

  function renderCart(first = false) {
    const stock = items.filter(i => i.rec === 'stock' && qty[i.id] > 0);
    const wait = items.filter(i => i.rec === 'wait' && qty[i.id] > 0);
    const n = items.reduce((s, i) => s + (qty[i.id] || 0), 0);
    cart.querySelector('.gs-chead .sub').textContent = `${n} item${n === 1 ? '' : 's'} · prices in 6 months`;
    let t0 = 0, t6 = 0;
    items.forEach(it => {
      const q = qty[it.id] || 0, row = cart.querySelector(`.gs-row[data-id="${it.id}"]`);
      const a = q * (it.now || 0), b = q * (it.p6 ?? it.now ?? 0);
      t0 += a; t6 += b;
      row.querySelector('.q').textContent = q;
      row.querySelector('.now').textContent = gbp(a);
      const th = row.querySelector('.then'), c = pillCls(b - a > 0.004 ? 1 : b - a < -0.004 ? -1 : 0);
      th.className = `then ${c}`; th.textContent = isNum(it.p6) ? `→ ${gbp(b)}` : '';
    });
    countUp(cart.querySelector('.t0'), t0, { digits: 2, prefix: '£', dur: first ? 900 : 400 });
    countUp(cart.querySelector('.t6'), t6, { digits: 2, prefix: '£', dur: first ? 900 : 400 });

    // bars
    const barsWrap = cart.querySelector('.gs-bars-wrap');
    barsWrap.hidden = !months.length || !n;
    if (months.length && n) {
      const tot = months.map((_, k) => items.reduce((s, it) => s + (qty[it.id] || 0) * (priceAt(it, k) || 0), 0));
      barTot = tot;
      const lo = Math.min(...tot), hi = Math.max(...tot), span = hi - lo || hi * 0.02 || 1;
      const floor = lo - span * 1.2, peak = tot.indexOf(hi);
      cart.querySelector('.gs-bars').innerHTML = tot.map((v, k) => {
        const hPct = 18 + 82 * (v - floor) / (hi - floor || 1);
        return `<div class="gs-bar" data-k="${k}"><span class="v${k === 0 || k === peak ? ' hi' : ''}">${v.toFixed(2)}</span><i class="${k === 0 ? 'now' : k === peak ? 'peak' : ''}" style="height:${first ? 0 : hPct}%" data-h="${hPct}"></i><span class="m">${mon(months[k])}</span></div>`;
      }).join('');
      if (first) requestAnimationFrame(() => requestAnimationFrame(() => cart.querySelectorAll('.gs-bar i').forEach((b, k) => { b.style.transitionDelay = `${k * 40}ms`; b.style.height = b.dataset.h + '%'; })));
    }

    // savings + button
    const save = stock.reduce((s, i) => s + qty[i.id] * ((i.p6 ?? i.now) - i.now), 0);
    const sv = cart.querySelector('.gs-save'), btn = cart.querySelector('.gs-buy');
    sv.hidden = !stock.length; btn.hidden = !stock.length;
    if (stock.length) {
      const names = l => l.map(i => i.name.split(' ')[0].toLowerCase()).join(' + ');
      sv.innerHTML = `<div class="r"><span>Stock up on ${stock.length} item${stock.length > 1 ? 's' : ''} now</span><b>Save ${gbp(save)}</b></div>
        <div class="l">Buy ${esc(names(stock))} today${wait.length ? `, wait on ${esc(names(wait))}` : ''}</div>`;
      btn.querySelector('span').textContent = `Stock up on ${stock.length} item${stock.length > 1 ? 's' : ''}`;
    }
  }
  cart.addEventListener('click', e => {
    const b = e.target.closest('.gs-step button');
    if (b) {
      const id = b.closest('.gs-row').dataset.id;
      qty[id] = Math.max(0, Math.min(20, (qty[id] || 0) + Number(b.dataset.d)));
      saveQty(qty); renderCart();
      return;
    }
    if (e.target.closest('.gs-buy')) toast('<i data-lucide="check-circle-2"></i> Added to plan', 2500);
  });

  // ---------- hover tooltips (sparklines + basket bars) ----------
  const tip = document.createElement('div');
  tip.className = 'gs-tip'; tip.hidden = true; document.body.appendChild(tip);
  const showTip = (html, x, y) => {
    tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let l = x + 14, t = y - h - 12;
    if (l + w > innerWidth - 8) l = x - w - 14;
    if (t < 8) t = y + 16;
    tip.style.left = l + 'px'; tip.style.top = t + 'px';
  };
  const hideTip = () => { tip.hidden = true; };
  grid.addEventListener('mousemove', e => {
    const w = e.target.closest('.gs-sparkw');
    grid.querySelectorAll('.gs-sparkw.hov').forEach(x => { if (x !== w) { x.classList.remove('hov'); x.querySelector('.gs-sline').hidden = x.querySelector('.gs-sdot').hidden = true; } });
    if (!w) return hideTip();
    const it = byId[w.dataset.spark], pts = it?.spark || [];
    if (!pts.length) return;
    const r = w.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width;
    let i = 0; pts.forEach((p, j) => { if (Math.abs(p.x - fx) < Math.abs(pts[i].x - fx)) i = j; });
    const p = pts[i], line = w.querySelector('.gs-sline'), dot = w.querySelector('.gs-sdot');
    w.classList.add('hov');
    line.hidden = dot.hidden = false;
    line.style.left = dot.style.left = (p.x * 100) + '%'; dot.style.top = (p.y * 100) + '%';
    const vs = isNum(it.now) ? (p.v / it.now - 1) * 100 : null, isNow = !p.fc && i === pts.findIndex(q => q.fc) - 1;
    showTip(tipHtml({
      title: fmtMonth(p.month), tag: p.fc ? 'Forecast' : isNow ? 'Today' : '',
      rows: [
        { color: p.fc ? ACC : '#334155', dashed: p.fc, label: p.fc ? 'Expected price' : 'Shelf price', value: gbp(p.v) },
        p.fc && isNum(p.lo) && isNum(p.hi) ? { label: 'Likely range', value: `${gbp(p.lo)} – ${gbp(p.hi)}` } : null,
        !isNow && isNum(vs) ? { label: 'vs today', value: fmtPct(vs) } : null,
      ],
    }), e.clientX, e.clientY);
  });
  grid.addEventListener('mouseleave', () => { hideTip(); grid.querySelectorAll('.gs-sparkw.hov').forEach(x => { x.classList.remove('hov'); x.querySelector('.gs-sline').hidden = x.querySelector('.gs-sdot').hidden = true; }); });
  const bars = cart.querySelector('.gs-bars');
  bars.addEventListener('mousemove', e => {
    const b = e.target.closest('.gs-bar');
    bars.querySelectorAll('.gs-bar.hov').forEach(x => x !== b && x.classList.remove('hov'));
    if (!b) return hideTip();
    b.classList.add('hov');
    const k = +b.dataset.k, v = barTot[k], m = months[k];
    const lines = items.filter(it => (qty[it.id] || 0) > 0).map(it => ({ label: `${qty[it.id]} × ${it.name}`, value: gbp(qty[it.id] * (priceAt(it, k) || 0)) }));
    showTip(tipHtml({
      title: fmtMonth(m), tag: k === 0 ? 'Today' : 'Forecast',
      rows: [{ color: k === 0 ? '#334155' : ACC, label: 'Basket total', value: gbp(v) }, ...lines,
        k > 0 && isNum(barTot[0]) ? { label: 'vs today', value: `${v - barTot[0] >= 0 ? '+' : '−'}${gbp(Math.abs(v - barTot[0]))}` } : null],
      note: k > 0 ? 'TimesFM median (p50) forecast' : '',
    }), e.clientX, e.clientY);
  });
  bars.addEventListener('mouseleave', () => { hideTip(); bars.querySelectorAll('.gs-bar.hov').forEach(x => x.classList.remove('hov')); });
  // Detail chart has its own crosshair tooltip (forecastChart) — fade the static callout while hovering it.
  detail.addEventListener('mouseover', e => { if (e.target.closest('.gs-chartwrap')) detail.classList.add('hovering'); });
  detail.addEventListener('mouseout', e => { if (!e.relatedTarget?.closest?.('.gs-chartwrap')) detail.classList.remove('hovering'); });

  applyGrid();
  renderDetail();
  renderCart(true);
  window.lucide?.createIcons();
  return () => { fc?.dispose(); tip.remove(); };
}
