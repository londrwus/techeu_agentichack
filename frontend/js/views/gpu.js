// GPU & Gadgets screen (MODULES.md §09, AI-era edition).
// Hero left: "What's driving GPU prices" waterfall of forecast drivers[] + before/after tile of an AI campus.
//            Falls back to the reservoir chart ("Water for the fabs") when drivers[] is missing.
// Hero right: GPU | Laptop forecast card. Signal row below (shared).
import { moduleHeader, wireScan } from '../components/moduleHeader.js';
import { forecastChart } from '../components/forecastChart.js';
import { signalCards } from '../components/signalCards.js';
import { loadModule, ACCENT, ITEM_META, fmtGBP, esc, isNum, pct, countAll, retailSeries, shortRegion, onResize, monthLabel } from '../components/ui.js';
import { icons } from '../lib.js';

const ACC = ACCENT.gpu;
const UP = '#DC2626', DOWN = '#16A34A', INK = '#0C0A09';
const PRODUCT = { gpu: 'RTX-class graphics card', laptop: 'Mid-range laptop' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monShort = m => `${MON[+m.slice(5) - 1]} ${m.slice(2, 4)}`;

function ensureCss() {
  if (document.getElementById('gpu-css')) return;
  document.head.appendChild(Object.assign(document.createElement('link'), { id: 'gpu-css', rel: 'stylesheet', href: '/static/css/gpu.css' }));
}

/** Short label + source tag for a driver row. */
function driverLabel(d) {
  const n = String(d.name || d.label || d.id || 'Driver');
  const s = String(d.source || '');
  const rules = [
    [/inflation|cpi/i, 'UK inflation', 'ONS CPI'], [/momentum/i, 'Price momentum', '24-month trend'], [/timesfm|trend/i, 'Price trend', 'TimesFM'], [/ai.*demand|demand/i, 'AI data-centre demand', 'Jev · news'],
    [/hbm|memory|cowos/i, 'HBM memory squeeze', 'Jev · news'], [/export|tariff/i, 'Export controls', 'Jev · news'],
    [/build/i, 'Data-centre build-out', 'Sentinel-2'], [/water|reservoir/i, 'Fab water stress', 'Sentinel-2'],
  ];
  const r = rules.find(([re]) => re.test(n));
  const src = /sentinel/i.test(s) ? 'Sentinel-2' : /jev/i.test(s) ? 'Jev · news' : /timesfm/i.test(s) ? 'TimesFM' : r?.[2] || '';
  return { name: r ? r[1] : n.replace(/\s*\(.*?\)/g, ''), src };
}
const contrib = d => [d.contribution_pct, d.contribution, d.pts, d.impact_pct, d.value_pct].find(isNum);

// ---------------------------------------------------------------- AI campus before/after tile
function buildSites(data, item) {
  const regions = data.regions || [];
  const ai = item?.ai_era?.buildout_sites || [];
  const sites = regions.filter(r => ['datacenter', 'fab', 'built'].includes(r.signal) && r.series?.length);
  const growth = r => ai.find(s => s.region_id === r.region_id)?.growth_since_start_pts ?? r.anomaly?.built_frac_vs_5yr_pct ?? -99;
  const order = { datacenter: 0, fab: 1, built: 2 };
  return sites.sort((a, b) => (order[a.signal] - order[b.signal]) || growth(b) - growth(a)).slice(0, 4).map(r => {
    const clear = r.series.filter(s => s.thumb && (s.cloud_pct ?? 0) <= 5);
    const pool = clear.length >= 2 ? clear : r.series.filter(s => s.thumb);
    const site = ai.find(s => s.region_id === r.region_id);
    return { r, before: pool[0], after: pool[pool.length - 1], growth: site?.growth_since_start_pts ?? site?.growth_2y_pts ?? r.anomaly?.built_frac_vs_5yr_pct };
  }).filter(s => s.after);
}

function compareHtml(s) {
  const [head, loc] = String(s.r.name).split(',');
  const name = `${head.replace(/\s*\(.*?\)|\s+(AI\s+)?campus|\s+fabs?/gi, '').trim()}${loc ? ' · ' + loc.trim().replace(/\s+[A-Z]{2}$/, '') : ''}`;
  return `<div class="compare gpu-cmp">
      <img src="/${s.after.thumb}" alt="${esc(name)} ${s.after.month}">
      ${s.before && s.before !== s.after ? `<img class="before" src="/${s.before.thumb}" alt="${esc(name)} ${s.before.month}" style="clip-path:inset(0 50% 0 0)">
      <div class="handle" style="left:50%"><div class="knob"><i data-lucide="chevrons-left-right"></i></div></div>
      <span class="tag" style="left:10px">${monShort(s.before.month)}</span>` : ''}
      <span class="tag" style="right:10px">${monShort(s.after.month)}</span>
      <span class="site">${esc(name)}</span></div>`;
}

function wireCompare(cmp) {
  const bImg = cmp?.querySelector('.before'), handle = cmp?.querySelector('.handle');
  cmp?.querySelectorAll('img').forEach(im => im.addEventListener('error', () => (im.style.visibility = 'hidden')));
  if (!bImg) return;
  const setP = p => { bImg.style.clipPath = `inset(0 ${100 - p}% 0 0)`; handle.style.left = p + '%'; };
  const set = x => { const r = cmp.getBoundingClientRect(); setP(Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100))); };
  let drag = false;
  cmp.addEventListener('pointerdown', e => { drag = true; cmp.setPointerCapture(e.pointerId); set(e.clientX); });
  cmp.addEventListener('pointermove', e => drag && set(e.clientX));
  cmp.addEventListener('pointerup', () => (drag = false));
  let t = 0;
  const intro = () => { if (drag || !cmp.isConnected) return; t += 0.02; setP(50 + 24 * Math.sin(t * Math.PI)); if (t < 2) requestAnimationFrame(intro); };
  setTimeout(() => requestAnimationFrame(intro), 700);
}

// ---------------------------------------------------------------- hero A: drivers waterfall
function driversHero(card, data, item) {
  const drivers = (item.drivers || []).filter(d => isNum(contrib(d)) && Math.abs(contrib(d)) >= 0.05);
  const total = isNum(item.change_6m_pct) ? item.change_6m_pct : drivers.reduce((a, d) => a + contrib(d), 0);
  const short = ITEM_META[item.item_id]?.short || item.name;
  const sites = buildSites(data, item);
  const water = item.orbit_overlay?.water_anomaly_pct ?? (() => { const w = item.ai_era?.water_sites || []; return w.length ? w.reduce((a, x) => a + x.anomaly_pct, 0) / w.length : null; })();
  let si = 0;

  card.innerHTML = `
    <div class="card-head">
      <div><div class="card-title">What's driving ${esc(short === 'GPU' ? 'GPU' : short.toLowerCase())} prices</div>
        <div class="card-sub">Contribution to the 6-month forecast · % points</div></div>
      <div class="gpu-stat">
        <div class="row"><b data-count="${total}" data-digits="1" data-prefix="${total >= 0 ? '+' : ''}" data-suffix="%">${pct(total, 1)}</b></div>
        <div class="s">${esc(short)} in 6 months · ${drivers.length} drivers</div>
      </div>
    </div>
    <div class="gpu-body">
      <div class="gpu-plot"><div class="chart"></div></div>
      <div class="gpu-tiles">
        ${sites.length ? `<div class="cmp-host" style="flex:1;min-height:0;display:flex"></div>` : ''}
        ${sites.length > 1 ? `<div class="gpu-dots">${sites.map((_, i) => `<button data-i="${i}" title="${esc(shortRegion(sites[i].r.name))}"></button>`).join('')}</div>` : ''}
        <div class="build-pill"></div>
        ${isNum(water) ? `<span class="gpu-chip ${water < 0 ? 'up' : 'down'}"><i data-lucide="droplets"></i>Taiwan reservoirs ${pct(water, 0)}</span>` : ''}
        <div class="gpu-cap">Sentinel-2 · 10 m · drag to compare</div>
      </div>
    </div>`;

  const showSite = i => {
    si = i; const s = sites[i]; if (!s) return;
    const host = card.querySelector('.cmp-host');
    host.innerHTML = compareHtml(s);
    wireCompare(host.querySelector('.compare'));
    card.querySelectorAll('.gpu-dots button').forEach((b, k) => b.classList.toggle('on', k === i));
    card.querySelector('.build-pill').innerHTML = isNum(s.growth)
      ? `<span class="gpu-chip ind"><i data-lucide="building-2"></i>Built-up ${s.growth >= 0 ? '+' : ''}${s.growth.toFixed(0)} pts since ${s.before?.month?.slice(0, 4) || ''}</span>` : '';
    icons();
  };
  card.querySelectorAll('.gpu-dots button').forEach(b => b.addEventListener('click', () => showSite(+b.dataset.i)));
  if (!sites.length) card.querySelector('.gpu-body').style.gridTemplateColumns = '1fr';
  showSite(0);

  // Waterfall rows: drivers top→bottom, then the total.
  const rows = []; let cum = 0;
  drivers.forEach(d => { const v = contrib(d); const L = driverLabel(d); rows.push({ ...L, v, a: cum, b: cum + v, d }); cum += v; });
  rows.push({ name: `${short} · 6-mo change`, src: 'All drivers', v: total, a: 0, b: total, total: true });
  const plot = card.querySelector('.gpu-plot');
  const chart = echarts.init(plot.querySelector('.chart'));
  const topI = rows.reduce((bi, r, i) => (!r.total && !/momentum|timesfm|trend/i.test(r.d?.name || '') && r.v > 0 && r.v > (rows[bi]?.v ?? 0) ? i : bi), -1);
  const ext = Math.max(...rows.flatMap(r => [Math.abs(r.a), Math.abs(r.b)]), 0.5);
  const lo = Math.min(0, ...rows.flatMap(r => [r.a, r.b])), hi = Math.max(0, ...rows.flatMap(r => [r.a, r.b]));
  const pad = ext * 0.28;
  const color = (r, i) => (r.total ? INK : r.v < 0 ? DOWN : i === topI ? UP : '#F87171');

  chart.setOption({
    animation: true,
    grid: { left: 172, right: 36, top: 4, bottom: 26 },
    xAxis: {
      type: 'value', min: Math.floor((lo - (lo < 0 ? pad : 0)) * 2) / 2, max: Math.ceil((hi + pad * (topI >= 0 ? 2.2 : 1)) * 2) / 2,
      axisLabel: { color: '#A8A29E', fontSize: 11, fontWeight: 500, formatter: v => (v > 0 ? '+' : '') + v + '%' },
      splitLine: { lineStyle: { color: '#F1F0EE' } }, axisLine: { show: false }, axisTick: { show: false },
    },
    yAxis: {
      type: 'category', inverse: true, data: rows.map(r => r.name), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: {
        formatter: (v, i) => `{n${rows[i]?.total ? 't' : ''}|${v}}\n${i === topI ? '{h|Top driver}  ' : ''}{s|${rows[i]?.src || ''}}`, margin: 14, align: 'right',
        rich: { n: { fontSize: 13, fontWeight: 600, color: '#1C1917', lineHeight: 18 }, nt: { fontSize: 13, fontWeight: 800, color: INK, lineHeight: 18 }, s: { fontSize: 11, fontWeight: 500, color: '#A8A29E', lineHeight: 15 }, h: { fontSize: 10, fontWeight: 700, color: UP, backgroundColor: '#FEE2E2', borderRadius: 4, padding: [1, 4] } },
      },
    },
    series: [{
      type: 'custom', data: rows.map((r, i) => [r.a, r.b, i]), encode: { x: [0, 1], y: 2 }, clip: false,
      renderItem: (params, api) => {
        const r = rows[params.dataIndex];
        const p0 = api.coord([r.a, params.dataIndex]), p1 = api.coord([r.b, params.dataIndex]);
        const bh = Math.min(26, api.size([0, 1])[1] * 0.56);
        const x = Math.min(p0[0], p1[0]), w = Math.max(2, Math.abs(p1[0] - p0[0])), y = p0[1] - bh / 2;
        const kids = [{
          type: 'rect', shape: { x, y, width: w, height: bh, r: 4 }, style: { fill: color(r, params.dataIndex) },
          enterFrom: { shape: { width: 0, x: p0[0] } }, enterAnimation: { duration: 450, delay: 120 + params.dataIndex * 70 },
        }, {
          type: 'text', style: {
            text: `${r.v >= 0 ? '+' : '−'}${Math.abs(r.v).toFixed(1)}${params.dataIndex === topI ? ' pts' : ''}`, x: x + w + 6, y: p0[1],
            textAlign: 'left', textVerticalAlign: 'middle', fill: r.total ? INK : r.v < 0 ? DOWN : UP, fontSize: params.dataIndex === topI ? 13 : 12, fontWeight: 700,
          }, enterFrom: { style: { opacity: 0 } }, enterAnimation: { duration: 300, delay: 450 + params.dataIndex * 70 },
        }];
        if (!r.total && params.dataIndex < rows.length - 1) { // connector to next row
          const n = api.coord([r.b, params.dataIndex + 1]);
          kids.push({ type: 'line', shape: { x1: p1[0], y1: y + bh, x2: n[0], y2: n[1] - bh / 2 }, style: { stroke: '#D6D3D1', lineWidth: 1, lineDash: [2, 3] } });
        }
        return { type: 'group', children: kids };
      },
    }, {
      type: 'line', data: [], markLine: { silent: true, symbol: 'none', lineStyle: { color: '#A8A29E', width: 1 }, label: { show: false }, data: [{ xAxis: 0 }] },
    }],
  });

  const off = onResize(plot, () => chart.resize());
  countAll(card);
  return () => { off(); chart.dispose(); };
}

// ---------------------------------------------------------------- hero B (fallback): reservoir chart
function reservoirHero(card, data) {
  const res = (data.regions || []).filter(r => r.signal === 'water' && r.series?.length);
  if (!res.length) { card.innerHTML = `<div class="empty">Reservoir data is still building.</div>`; return () => {}; }
  const anom = r => r.anomaly?.water_frac_vs_5yr_pct ?? r.anomaly?.ndwi_vs_5yr_pct ?? 0;
  res.sort((a, b) => anom(a) - anom(b));
  const [main, other] = res;
  const hasFrac = main.series.some(s => isNum(s.water_frac));
  // % of capacity: water_frac relative to the region's max clear value, else NDWI rescaled (-0.7..0.3 → 0..100).
  const level = r => {
    const ok = r.series.filter(s => (s.cloud_pct ?? 0) <= 20);
    const mx = Math.max(...ok.map(s => s.water_frac).filter(isNum), 1e-6);
    return s => ((s.cloud_pct ?? 0) > 20 ? null : hasFrac && isNum(s.water_frac) ? Math.min(100, (s.water_frac / mx) * 100) : isNum(s.ndwi) ? Math.max(0, Math.min(100, (s.ndwi + 0.7) * 100)) : null);
  };
  const lvM = level(main), months = main.series.slice(-24).map(s => s.month);
  const byM = (r, f) => { const m = new Map(r.series.map(s => [s.month, f(s)])); return months.map(k => (isNum(m.get(k)) ? +m.get(k).toFixed(1) : null)); };
  const smooth = a => a.map((v, i) => { const w = a.slice(Math.max(0, i - 1), i + 2).filter(isNum).sort((x, y) => x - y); return isNum(v) && w.length ? w[w.length >> 1] : v; });
  const mainD = smooth(byM(main, lvM)), otherD = other ? smooth(byM(other, level(other))) : [];
  const allM = main.series.map(s => [s.month, lvM(s)]).filter(([, v]) => isNum(v));
  const avg5 = months.map(m => { const vs = allM.filter(([k]) => k.slice(5) === m.slice(5) && k < m && k >= `${+m.slice(0, 4) - 5}`).map(x => x[1]); return vs.length ? +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1) : null; });
  const lastI = mainD.map((v, i) => [v, i]).filter(([v]) => isNum(v)).pop()?.[1] ?? months.length - 1;
  const now = mainD[lastI], base = avg5[lastI];
  const minI = mainD.reduce((bi, v, i) => (isNum(v) && (!isNum(mainD[bi]) || v < mainD[bi]) ? i : bi), 0);
  const name = shortRegion(main.name).replace(/\s*II$/, '');
  const a = anom(main);
  const tile = main.series.filter(s => s.thumb && (s.cloud_pct ?? 0) <= 10).pop() || main.series.filter(s => s.thumb).pop();

  card.innerHTML = `
    <div class="card-head">
      <div><div class="card-title">Water for the fabs</div><div class="card-sub">Reservoir level, % of capacity · 24 months</div></div>
      ${isNum(now) ? `<div class="gpu-stat"><div class="row"><b data-count="${now}" data-suffix="%">${Math.round(now)}%</b>
        ${isNum(base) ? `<span class="gpu-chip ${now < base ? 'up' : 'down'}">${now - base >= 0 ? '+' : '−'}${Math.abs(Math.round(now - base))} pts vs 5-yr</span>` : ''}</div>
        <div class="s">${esc(name)} today${isNum(base) ? ` · 5-yr avg ${Math.round(base)}%` : ''}</div></div>` : ''}
    </div>
    <div class="gpu-body">
      <div class="gpu-plot"><div class="chart"></div><div class="fc-callout"></div></div>
      <div class="gpu-tiles">
        ${tile ? `<div class="tile-box"><img class="sat-img" src="/${tile.thumb}" alt="${esc(name)}" onerror="this.style.visibility='hidden'"><span class="site">${esc(name)} · ${monthLabel(tile.month, true)}</span></div>` : ''}
        <div class="gpu-legend"><span><i style="border-color:${ACC}"></i>${esc(name)}</span>${other ? `<span><i style="border-color:#94A3B8"></i>${esc(shortRegion(other.name).replace(/\s*II$/, ''))}</span>` : ''}<span><i class="dash"></i>5-yr average</span></div>
        ${isNum(a) ? `<span class="gpu-chip ${a < 0 ? 'up' : 'down'}"><i data-lucide="droplets"></i>Water area ${pct(a, 0)} vs 5-yr</span>` : ''}
      </div>
    </div>`;
  const plot = card.querySelector('.gpu-plot'), call = plot.querySelector('.fc-callout');
  const chart = echarts.init(plot.querySelector('.chart'));
  const endData = mainD.map((v, i) => (i === lastI ? v : null));
  chart.setOption({
    grid: { left: 40, right: 8, top: 10, bottom: 26 },
    xAxis: { type: 'category', data: months, boundaryGap: false, axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: '#A8A29E', fontSize: 11, interval: i => i === 0 || i === months.length - 1 || i === 12, formatter: monShort } },
    yAxis: { type: 'value', min: 0, max: 100, interval: 25, axisLabel: { color: '#A8A29E', fontSize: 11, formatter: '{value}%' }, splitLine: { lineStyle: { color: '#F1F0EE' } } },
    series: [
      { type: 'line', data: avg5, symbol: 'none', connectNulls: true, lineStyle: { type: [5, 4], color: '#A8A29E', width: 1.5 }, z: 1 },
      ...(other ? [{ type: 'line', data: otherD, symbol: 'none', connectNulls: true, lineStyle: { color: '#94A3B8', width: 2 }, z: 2 }] : []),
      { type: 'line', data: mainD, symbol: 'none', connectNulls: true, lineStyle: { color: ACC, width: 2.5 }, z: 3, animationDuration: 900,
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(99,102,241,.16)' }, { offset: 1, color: 'rgba(99,102,241,0)' }]) } },
      { type: 'scatter', data: endData, symbolSize: 9, itemStyle: { color: ACC, borderColor: '#fff', borderWidth: 2 }, z: 5 },
    ],
  });
  const place = () => {
    const v = mainD[minI]; if (!isNum(v)) return;
    const earlier = main.series.filter(s => s.month < months[minI]).map(lvM).filter(isNum);
    const sinceY = earlier.length && Math.min(...earlier) > v ? main.series[0].month.slice(0, 4) : null;
    call.innerHTML = `<div class="t">${esc(name)} · ${monthLabel(months[minI], true)}</div><div class="v"><b>${Math.round(v)}%</b>${sinceY ? `<span class="delta up">lowest since ${sinceY}</span>` : ''}</div>`;
    const [x, y] = chart.convertToPixel({ seriesIndex: other ? 2 : 1 }, [minI, v]);
    const W = plot.clientWidth, H = plot.clientHeight, w = call.offsetWidth || 170, h = call.offsetHeight || 60;
    call.style.left = Math.max(0, Math.min(W - w, x - w / 2)) + 'px';
    call.style.top = Math.max(0, Math.min(H - h, y + 16)) + 'px';
  };
  const tmr = setTimeout(() => { place(); call.classList.add('on'); }, 1000);
  const off = onResize(plot, () => { chart.resize(); place(); });
  countAll(card);
  return () => { clearTimeout(tmr); off(); chart.dispose(); };
}

// ---------------------------------------------------------------- right: GPU | Laptop forecast card
function forecastCard(card, data, item, items, onPick) {
  const short = ITEM_META[item.item_id]?.short || item.name;
  const { history, forecast } = retailSeries(item);
  const now = item.retail_now ?? history.at(-1)?.price;
  const f6 = forecast[Math.min(5, forecast.length - 1)]?.p50;
  const later = item.retail_6m ?? f6;
  const drivers = (item.drivers || []).filter(d => isNum(contrib(d)));
  const topD = drivers.filter(d => !/momentum|timesfm|trend/i.test(d.name || '')).sort((a, b) => contrib(b) - contrib(a))[0];
  const water = (data.regions || []).filter(r => r.signal === 'water').map(r => r.anomaly?.ndwi_vs_5yr_pct).filter(isNum);
  const stat2 = topD ? { v: `${contrib(topD) >= 0 ? '+' : ''}${contrib(topD).toFixed(1)} pts`, l: driverLabel(topD).name, cls: contrib(topD) >= 0 ? 'up' : 'down' }
    : water.length ? { v: pct(Math.min(...water), 0), l: 'reservoir vs 5-yr', cls: Math.min(...water) < 0 ? 'up' : 'down' } : null;

  card.innerHTML = `
    ${items.length > 1 ? `<div class="seg" style="align-self:flex-start">${items.map(i => `<button data-item="${i.item_id}" class="${i === item ? 'on' : ''}">${esc(ITEM_META[i.item_id]?.short || i.name)}</button>`).join('')}</div>` : ''}
    <div class="gpu-prod">
      <img src="/static/assets/products/${item.item_id}.jpg" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'${ITEM_META[item.item_id]?.emoji || ''}'}))">
      <div><div class="n">${esc(PRODUCT[item.item_id] || item.name)}</div><div class="m">London retail · in 6 months</div></div>
    </div>
    <div class="hero-price"><b data-count="${later}" data-prefix="£">${fmtGBP(later)}</b>${isNum(now) ? `<span>from ${fmtGBP(now)} today</span>` : ''}</div>
    <div class="fc-host"></div>
    <div class="stat-strip">
      ${isNum(item.prob_up_6m) ? `<div><div class="v" data-count="${item.prob_up_6m * 100}" data-suffix="%">${Math.round(item.prob_up_6m * 100)}%</div><div class="l">chance it rises</div></div>` : ''}
      ${stat2 ? `<div><div class="v ${stat2.cls}">${esc(stat2.v)}</div><div class="l">${esc(stat2.l)}</div></div>` : ''}
    </div>`;
  card.querySelectorAll('[data-item]').forEach(b => b.addEventListener('click', () => onPick(b.dataset.item)));
  // Headroom above the line so the callout can sit top-left of the end point without covering the curve.
  const vals = [...history.slice(-18).map(p => p.price), ...forecast.map(p => p.p50)].filter(isNum);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || hi * 0.05 || 1;
  const raw = span * 1.8 / 5, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw);
  const fc = forecastChart(card.querySelector('.fc-host'), {
    history, forecast, accent: ACC, unit: item.unit || '£', calloutTitle: short, months: 18, calloutIndex: 5,
    yMin: Math.max(0, Math.floor((lo - span * 0.08) / step) * step), yMax: Math.ceil((hi + span * 0.7) / step) * step,
  });
  countAll(card);
  return () => fc.dispose();
}

export async function render(el) {
  ensureCss();
  el.innerHTML = moduleHeader('gpu', null) + `<div class="card skeleton" style="height:500px"></div>`;
  wireScan(el);
  const data = await loadModule('gpu');
  if (!data) { el.innerHTML = moduleHeader('gpu', null) + `<div class="empty">No data for this module yet.</div>`; wireScan(el); return; }
  const items = (data.items || []).filter(i => i?.history?.length || i?.forecast?.length);
  el.innerHTML = moduleHeader('gpu', data) + `
    <section class="module-hero gpu-hero">
      <div class="card gpu-left gpu-in"></div>
      <div class="card gpu-fc gpu-in d1"></div>
    </section>
    <section class="gpu-sig gpu-in d2"></section>`;
  wireScan(el);
  let cur = items.find(i => i.item_id === 'gpu') || items[0];
  let offL = null, offR = null;
  const draw = id => {
    cur = items.find(i => i.item_id === id) || cur;
    offL?.(); offR?.();
    const left = el.querySelector('.gpu-left');
    const hasDrivers = (cur?.drivers || []).some(d => isNum(contrib(d)));
    offL = hasDrivers ? driversHero(left, data, cur) : reservoirHero(left, data);
    offR = cur ? forecastCard(el.querySelector('.gpu-fc'), data, cur, items, draw) : null;
    icons();
  };
  draw(cur?.item_id);
  const other = items.find(i => i.item_id === 'laptop') || items[1] || items[0];
  const sc = signalCards(el.querySelector('.gpu-sig'), data, { accent: ACC, priceItem: other, earthMetric: 'ndwi' });
  return () => { offL?.(); offR?.(); sc.dispose(); };
}
