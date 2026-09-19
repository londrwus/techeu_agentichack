import { api, MODULE_META, REGION_META, ITEM_META, esc, fmt, pct, money, isNum, tint, deltaPill, countUp, icons, monthLabel, retailMapper, headlineBucket, BUCKET_COLOR, showTip, hideTip } from '../lib.js';
import { topbar, wireScan } from './common.js';

const BENCH = { latte: 'arabica futures', chocolate: 'cocoa futures', olive_oil: 'olive oil benchmark', orange_juice: 'orange juice futures',
  bread: 'wheat futures', pint: 'barley price', wine: 'grape costs', gpu: 'chip prices', laptop: 'component costs' };
const INSIGHT_ICONS = ['sparkles', 'trending-up', 'wallet'];

export async function render(page, moduleId) {
  const meta = MODULE_META[moduleId] || { name: moduleId, emoji: '•', color: '#A8A29E' };
  const iconSq = `<div class="icon-sq lg" style="background:${tint(meta.color)}">${meta.emoji}</div>`;
  const shell = (right = '', chips = '') => topbar({ crumb: `Modules  /  ${meta.name}`, title: meta.name, iconSq, pill: chips, right });
  page.innerHTML = shell() + `<div class="mod-row1"><div class="card skeleton"></div><div class="card skeleton"></div></div>
    <div class="mod-row2"><div class="card skeleton"></div><div class="card skeleton"></div><div class="card skeleton"></div></div>`;
  wireScan(page); icons();

  const data = await api(`/api/modules/${moduleId}`);
  if (!data) { page.querySelector('.mod-row1').outerHTML = `<div class="empty">No data for this module yet.</div>`; return; }
  const items = data.items || [];
  let cur = items.find(i => i.backtest?.orbit_signal?.flagged) || items.find(i => isNum(i.change_6m_pct)) || items[0];
  const chips = items.length > 1 ? `<div class="chips" id="chips">${items.map(i => `<button class="chip" data-id="${i.item_id}">${ITEM_META[i.item_id]?.emoji || ''} ${esc(ITEM_META[i.item_id]?.short || i.name)}</button>`).join('')}</div>` : '';

  page.innerHTML = shell('', chips) + `
  <div class="backtest" id="bt" hidden><i data-lucide="history"></i><span></span></div>
  <section class="mod-row1">
    <div class="card price-card" id="price"></div>
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">12-month forecast</div><div class="card-sub" id="fc-sub"></div></div>
        <div class="chart-legend"><span><i style="background:var(--text-1)"></i>History</span><span><i style="background:var(--accent)"></i>Forecast (p50)</span><span><i class="band"></i>p10–p90</span></div>
      </div>
      <div class="chart" id="fc"></div>
    </div>
  </section>
  <section class="mod-row2">
    <div class="card" id="sat"></div>
    <div class="card" id="jev"></div>
    <div class="insights" id="ins"></div>
  </section>`;
  wireScan(page);

  let chart = null;
  const onResize = () => chart?.resize();
  window.addEventListener('resize', onResize);

  const select = item => {
    cur = item;
    page.querySelectorAll('#chips .chip').forEach(c => c.classList.toggle('on', c.dataset.id === item?.item_id));
    renderPrice(page, item);
    chart = renderChart(page, item, chart);
    renderSat(page, data.regions || [], item);
    const bt = item?.backtest, btEl = page.querySelector('#bt');
    if (bt && btEl) {
      const os = bt.orbit_signal;
      let txt = isNum(bt.predicted_change_pct) && isNum(bt.actual_change_pct)
        ? `Backtest ${monthLabel(bt.as_of, true)}: called ${pct(bt.predicted_change_pct)}, actual ${pct(bt.actual_change_pct)}`
        : 'Backtest';
      if (os && isNum(os.pressure)) {
        txt = `Backtest ${monthLabel(bt.as_of, true)} · model alone ${pct(bt.predicted_change_pct)} · + satellites ${pct(os.predicted_change_pct)} · actual ${pct(bt.actual_change_pct)}`
          + (os.flagged ? ` — Orbit flagged it 6 months early. ${os.story || ''}` : '');
        btEl.classList.toggle('muted', !os.flagged);
        btEl.title = `${os.story || ''} ${os.method || ''} (in-sample fit)`;
      }
      btEl.querySelector('span').textContent = txt;
      btEl.hidden = false;
    } else if (btEl) btEl.hidden = true;
    icons();
  };
  page.querySelectorAll('#chips .chip').forEach(c => c.addEventListener('click', () => select(items.find(i => i.item_id === c.dataset.id))));
  select(cur);
  renderJev(page, data.signals);
  renderInsights(page, data.insights);
  icons();
  return () => { window.removeEventListener('resize', onResize); chart?.dispose(); hideTip(); };
}

function renderPrice(page, it) {
  const el = page.querySelector('#price');
  if (!it) { el.innerHTML = `<div class="empty">No items.</div>`; return; }
  const now = it.retail_now, nxt = isNum(it.retail_12m) ? it.retail_12m : it.retail_6m;
  const horizon = isNum(it.retail_12m) ? (it.forecast || [])[Math.min(11, (it.forecast || []).length - 1)]?.month : (it.forecast || [])[5]?.month;
  const ch = isNum(nxt) && isNum(now) ? (nxt / now - 1) * 100 : null;
  el.innerHTML = `
    <div>
      <div class="price-name">${esc(it.name)}</div>
      <div class="price-line ${now >= 1000 ? 'big-num' : ''}"><span class="price-now num">${money(now)}</span>
        ${isNum(nxt) ? `<span class="price-arrow"><i data-lucide="arrow-right"></i></span><span class="price-next ${ch < 0 ? 'fall' : ''}" id="pnext">${money(nxt)}</span>` : ''}</div>
      ${isNum(ch) ? deltaPill(ch, horizon ? `by ${monthLabel(horizon, true)}` : 'in 12 mo', 1) : `<span class="pill flat">Forecast running on Modal…</span>`}
    </div>
    <div class="tiles2">
      <div class="stat"><div class="v" id="pp">–</div><div class="l">chance it rises</div></div>
      <div class="stat"><div class="v ${it.change_6m_pct < 0 ? 'green' : ''}">${pct(it.change_6m_pct)}</div><div class="l">price change · 6 mo</div></div>
    </div>`;
  if (isNum(it.prob_up_6m)) countUp(el.querySelector('#pp'), it.prob_up_6m * 100, { suffix: '%' });
  const pn = el.querySelector('#pnext');
  if (pn && isNum(nxt)) countUp(pn, nxt, { digits: nxt >= 1000 ? 0 : 2, prefix: '£', dur: 1100 });
}

function renderChart(page, it, chart) {
  const box = page.querySelector('#fc');
  const sub = page.querySelector('#fc-sub');
  const hist = (it?.history || []).filter(h => isNum(h.price)).slice(-24);
  const fc = (it?.forecast || []).filter(f => isNum(f.p50));
  sub.textContent = `${it?.model || 'Time-series model'} on Modal · p10–p90 band`;
  if (!window.echarts || (!hist.length && !fc.length)) {
    chart?.dispose();
    box.innerHTML = `<div class="empty" style="height:100%">${window.echarts ? 'Forecast is being computed on Modal…' : 'Chart library offline'}</div>`;
    return null;
  }
  const map = retailMapper(it);
  const f = v => (map ? map(v) : v);
  const unitFmt = v => (map ? (v >= 100 ? '£' + Math.round(v).toLocaleString('en-GB') : '£' + v.toFixed(2)) : (v >= 100 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(2)));
  const months = [...hist.map(h => h.month), ...fc.map(x => x.month)];
  const n = months.length, ti = hist.length - 1;
  const lastP = hist.length ? f(hist[ti].price) : null;
  const pad = arr => [...Array(hist.length).fill(null), ...arr];
  const histS = [...hist.map(h => f(h.price)), ...fc.map(() => null)];
  const p50 = pad(fc.map(x => f(x.p50)));
  const lo = pad(fc.map(x => f(x.p10 ?? x.p50)));
  const band = pad(fc.map(x => f(x.p90 ?? x.p50) - f(x.p10 ?? x.p50)));
  if (ti >= 0) { p50[ti] = lastP; lo[ti] = lastP; band[ti] = 0; }
  const endV = p50[n - 1];
  const labelIdx = new Set([0, Math.max(0, ti - 12), ti, n - 1]);
  if (!chart || chart.isDisposed()) { box.innerHTML = ''; chart = echarts.init(box, null, { renderer: 'canvas' }); }
  const css = getComputedStyle(document.documentElement);
  const C = k => css.getPropertyValue(k).trim();
  chart.setOption({
    animationDuration: 900,
    grid: { left: 56, right: 44, top: 44, bottom: 30 },
    tooltip: { trigger: 'axis', valueFormatter: v => (isNum(v) ? unitFmt(v) : '–'), formatter: ps => {
      const i = ps[0]?.dataIndex; const lines = [];
      if (histS[i] != null) lines.push(`History <b>${unitFmt(histS[i])}</b>`);
      if (i > ti && p50[i] != null) lines.push(`p50 <b>${unitFmt(p50[i])}</b><br><span style="color:#A8A29E">p10–p90 ${unitFmt(lo[i])} – ${unitFmt(lo[i] + band[i])}</span>`);
      return `<b>${monthLabel(months[i], true)}</b><br>${lines.join('<br>')}`;
    } },
    xAxis: { type: 'category', data: months, boundaryGap: false, axisLine: { lineStyle: { color: C('--border') } }, axisTick: { show: false },
      axisLabel: { color: C('--text-3'), fontSize: 12, interval: i => labelIdx.has(i), formatter: m => monthLabel(m, true), hideOverlap: true, showMaxLabel: true } },
    yAxis: { type: 'value', scale: true, splitNumber: 3, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: C('--border') } },
      axisLabel: { color: C('--text-3'), fontSize: 12, formatter: unitFmt } },
    series: [
      { name: 'lo', type: 'line', data: lo, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false }, silent: true },
      { name: 'band', type: 'line', data: band, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(249,115,22,.15)' }, silent: true },
      { name: 'History', type: 'line', data: histS, symbol: 'none', lineStyle: { width: 3, color: C('--text-1') }, itemStyle: { color: C('--text-1') },
        markLine: ti >= 0 ? { symbol: 'none', silent: true, lineStyle: { color: C('--text-3'), width: 2, type: 'solid' },
          label: { formatter: 'Today', position: 'end', backgroundColor: C('--ink'), color: '#fff', padding: [4, 8], borderRadius: 6, fontWeight: 600, fontSize: 12 },
          data: [{ xAxis: ti }] } : undefined },
      { name: 'Forecast', type: 'line', data: p50, symbol: 'none', lineStyle: { width: 3, color: C('--accent') }, itemStyle: { color: C('--accent') },
        markPoint: isNum(endV) ? { symbol: 'circle', symbolSize: 11, itemStyle: { color: C('--accent') },
          label: { show: true, position: 'top', distance: 12, formatter: unitFmt(endV), backgroundColor: C('--accent'), color: '#fff', padding: [4, 8], borderRadius: 6, fontWeight: 700, fontSize: 13 },
          data: [{ coord: [n - 1, endV] }] } : undefined },
      { name: 'today', type: 'scatter', data: ti >= 0 ? [[ti, lastP]] : [], symbolSize: 14, itemStyle: { color: '#fff', borderColor: C('--text-1'), borderWidth: 3 }, z: 5, silent: true, tooltip: { show: false } },
    ],
  }, true);
  requestAnimationFrame(() => chart.resize());
  return chart;
}

function shortRegion(name = '') { return name.split(',')[0].replace(/ \(.*?\)/, ''); }
const chipName = n => shortRegion(n).replace(/ (coffee|robusta|hops|vineyards|olive groves|cocoa belt|cocoa farms|citrus belt|wheat fields|reservoir)$/i, '');

function renderSat(page, regions, it) {
  const el = page.querySelector('#sat');
  const mine = regions.filter(r => REGION_META[r.region_id]?.[0] === it?.item_id);
  const list = (mine.length ? mine : regions).filter(Boolean);
  if (!list.length) { el.innerHTML = `<div class="card-title">From orbit</div><div class="empty" style="margin-top:16px">No satellite regions for this module.</div>`; return; }
  let reg = list.slice().sort((a, b) => (a.anomaly?.ndvi_vs_5yr_pct ?? 0) - (b.anomaly?.ndvi_vs_5yr_pct ?? 0))[0];
  const draw = () => {
    const series = (reg.series || []).filter(s => s.thumb);
    // clearest scene near a target month (same season), so the before/after is not a cloud
    const clearest = (y, m, span = 1) => {
      const want = new Set();
      for (let d = -span; d <= span; d++) {
        let mm = m + d, yy = y; if (mm < 1) { mm += 12; yy--; } if (mm > 12) { mm -= 12; yy++; }
        want.add(`${yy}-${String(mm).padStart(2, '0')}`);
      }
      const c = series.filter(s => want.has(s.month) && s.ndvi != null)
        .sort((a, b) => (a.cloud_pct ?? 100) - (b.cloud_pct ?? 100) || (b.month > a.month ? 1 : -1));
      return c[0] || null;
    };
    const lastS = series[series.length - 1];
    let after = null, before = null;
    if (lastS) {
      const [y, m] = lastS.month.split('-').map(Number);
      after = clearest(y, m - 1, 1) || lastS;
      const [ay, am] = after.month.split('-').map(Number);
      before = clearest(ay - 5, am, 1) || clearest(ay - 4, am, 1) || series[0];
      if (before === after) before = null;
    }
    const sig = REGION_META[reg.region_id]?.[1];
    const aKey = sig === 'water' ? 'ndwi_vs_5yr_pct' : 'ndvi_vs_5yr_pct';
    const a = reg.anomaly?.[aKey];
    const idx = sig === 'water' ? 'NDWI' : 'NDVI';
    const pill = isNum(a) ? `<span class="pill ${a < 0 ? 'up' : 'down'}"><i data-lucide="${sig === 'water' ? 'droplets' : 'leaf'}"></i>${idx} ${pct(a)}</span>` : '';
    el.innerHTML = `<div class="card-head"><div><div class="card-title">${esc(shortRegion(reg.name))}, from orbit</div>
        <div class="card-sub">Sentinel-2 · 10 m${after ? ' · ' + monthLabel(after.month, true) : ''}</div></div>${pill}</div>
      ${list.length > 1 ? `<div class="region-chips">${list.map(r => `<button class="chip ${r === reg ? 'on' : ''}" data-r="${r.region_id}">${esc(chipName(r.name))}</button>`).join('')}</div>` : ''}
      ${after ? `<div class="compare" id="cmp">
          <img src="/${after.thumb}" alt="latest">
          ${before ? `<img class="before" src="/${before.thumb}" alt="before" style="clip-path:inset(0 50% 0 0)">
          <div class="handle" style="left:50%"><div class="knob"><i data-lucide="chevrons-left-right"></i></div></div>
          <span class="tag" style="left:12px">${monthLabel(before.month, true)}</span>` : ''}
          <span class="tag" style="right:12px">${monthLabel(after.month, true)}</span></div>`
        : `<div class="empty" style="margin-top:16px">Satellite tiles are still downloading…</div>`}`;
    el.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => { reg = list.find(r => r.region_id === b.dataset.r); draw(); }));
    const cmp = el.querySelector('#cmp');
    el.querySelectorAll('.compare img').forEach(im => im.addEventListener('error', () => (im.style.visibility = 'hidden')));
    if (cmp && before) {
      const bImg = cmp.querySelector('.before'), handle = cmp.querySelector('.handle');
      const set = x => {
        const r = cmp.getBoundingClientRect();
        const p = Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100));
        bImg.style.clipPath = `inset(0 ${100 - p}% 0 0)`; handle.style.left = p + '%';
      };
      let drag = false;
      cmp.addEventListener('pointerdown', e => { drag = true; cmp.setPointerCapture(e.pointerId); set(e.clientX); });
      cmp.addEventListener('pointermove', e => drag && set(e.clientX));
      cmp.addEventListener('pointerup', () => (drag = false));
      // gentle intro sweep so the audience sees it's a comparison
      let t = 0; const intro = () => { if (drag || !cmp.isConnected) return; t += 0.02; const p = 50 + 22 * Math.sin(t * Math.PI) ; bImg.style.clipPath = `inset(0 ${100 - p}% 0 0)`; handle.style.left = p + '%'; if (t < 2) requestAnimationFrame(intro); };
      setTimeout(() => requestAnimationFrame(intro), 400);
    }
    icons();
  };
  draw();
}

function renderJev(page, sig) {
  const el = page.querySelector('#jev');
  const heads = sig?.headlines || [];
  if (!sig || !heads.length) {
    el.innerHTML = `<div class="jev-big"><span class="n">–</span><span class="t">headlines judged by Jev</span></div><div class="empty" style="margin-top:16px">Jev is judging the news on Modal…</div>`;
    return;
  }
  const counts = { tight_hi: 0, tight_lo: 0, none: 0, loose: 0 };
  heads.forEach(hd => counts[headlineBucket(hd)]++);
  const N = Math.min(160, heads.length);
  const sample = Array.from({ length: N }, (_, i) => heads[Math.floor((i * heads.length) / N)]);
  // sort so the grid reads like a waffle chart: tight -> none -> loose
  const order = { tight_hi: 0, tight_lo: 1, none: 2, loose: 3 };
  sample.sort((a, b) => order[headlineBucket(a)] - order[headlineBucket(b)]);
  const total = sig.n_headlines || heads.length;
  const scale = total / heads.length;
  el.innerHTML = `<div class="jev-big"><span class="n" id="jn">0</span><span class="t">headlines judged by Jev</span></div>
    <div class="card-sub">Each square is a news story · coloured by supply effect${isNum(sig.n_judgments) ? ` · ${fmt(sig.n_judgments)} typed judgments` : ''}</div>
    <div class="waffle" id="wf">${sample.map((hd, i) => `<i data-i="${i}" style="background:${BUCKET_COLOR[headlineBucket(hd)]};animation-delay:${i * 8}ms"></i>`).join('')}</div>
    <div class="wleg">
      <div><i style="background:var(--up)"></i>Tightens supply (prices up)<b>${fmt((counts.tight_hi + counts.tight_lo) * scale)}</b></div>
      <div><i style="background:var(--muted)"></i>No effect<b>${fmt(counts.none * scale)}</b></div>
      <div><i style="background:var(--down)"></i>Loosens supply<b>${fmt(counts.loose * scale)}</b></div>
    </div>`;
  countUp(el.querySelector('#jn'), total, { dur: 1200 });
  const wf = el.querySelector('#wf');
  wf.addEventListener('mousemove', e => {
    const i = e.target?.dataset?.i; if (i == null) return hideTip();
    const hd = sample[+i];
    const probs = Object.entries(hd.supply_effect?.probs || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${esc(k.replace(/_/g, ' '))} ${Math.round(v * 100)}%`).join(' · ');
    showTip(`<b>${esc(hd.title)}</b><div class="muted">${esc(hd.source || '')}${hd.date ? ' · ' + esc(String(hd.date).slice(0, 10)) : ''}</div>
      <div style="margin-top:6px">Price effect: <b style="display:inline">${esc(String(hd.supply_effect?.label || '–').replace(/_/g, ' '))}</b>${hd.severity?.label ? ` · ${esc(hd.severity.label)}` : ''}</div>
      ${probs ? `<div class="muted">${probs}</div>` : ''}${isNum(hd.relevant_p) ? `<div class="muted">Relevant ${Math.round(hd.relevant_p * 100)}%${isNum(hd.confidence) ? ` · confidence ${Math.round(hd.confidence * 100)}%` : ''}</div>` : ''}`, e.clientX, e.clientY);
  });
  wf.addEventListener('mouseleave', hideTip);
  wf.addEventListener('click', e => { const i = e.target?.dataset?.i; const u = i != null && sample[+i]?.url; if (u) window.open(u, '_blank', 'noopener'); });
}

function renderInsights(page, ins) {
  const el = page.querySelector('#ins');
  const cards = (ins?.cards || []).slice(0, 3);
  if (!cards.length) { el.innerHTML = `<div class="card insight" style="grid-row: span 3"><div class="insight-head"><i data-lucide="sparkles"></i>Gemini insights</div><p>Gemini is reading the tiles and headlines…</p></div>`; return; }
  el.innerHTML = cards.map((c, i) => `<div class="card insight"><div class="insight-head"><i data-lucide="${INSIGHT_ICONS[i]}"></i>${esc(c.title)}</div><p>${esc(c.text)}</p></div>`).join('');
}
