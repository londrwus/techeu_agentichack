// GPU & Gadgets screen (MODULES.md §09, AI-era edition).
// Hero left: "What's driving GPU prices" = verdict sentence + a £ "price bridge" (today -> 6 months) of grouped
//            drivers[] with evidence tooltips, + before/after tile of an AI campus (Zoom opens the lightbox).
//            Falls back to the reservoir chart ("Water for the fabs") when drivers[] is missing.
// Hero right: GPU | Laptop forecast card. Signal row below (shared).
import { moduleHeader, wireScan } from '../components/moduleHeader.js';
import { forecastChart } from '../components/forecastChart.js';
import { signalCards } from '../components/signalCards.js';
import { loadModule, ACCENT, ITEM_META, fmtGBP, esc, isNum, pct, countAll, retailSeries, shortRegion, onResize, monthLabel } from '../components/ui.js';
import { icons } from '../lib.js';
import { icon, itemIcon } from '../components/icons.js';
import { axisTooltip, tipHtml, fmtMonth } from '../components/chartTheme.js';

const ACC = ACCENT.gpu;
const UP = '#DC2626', DOWN = '#16A34A', INK = '#0C0A09';
const PRODUCT = { gpu: 'RTX-class graphics card', laptop: 'Mid-range laptop' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monShort = m => `${MON[+m.slice(5) - 1]} ${m.slice(2, 4)}`;

function ensureCss() {
  if (document.getElementById('gpu-css')) return;
  document.head.appendChild(Object.assign(document.createElement('link'), { id: 'gpu-css', rel: 'stylesheet', href: '/static/css/gpu.css' }));
}

// ---------------------------------------------------------------- drivers -> plain-English groups in £
const contrib = d => [d.contribution_pct, d.contribution, d.pts, d.impact_pct, d.value_pct].find(isNum);

/** Source families: tag text, icon, colour. */
const SRC = {
  hist: { t: 'Price history', ic: 'chart-line', c: '#475569', bg: '#F1F5F9' },
  news: { t: 'News · Jev', ic: 'newspaper', c: '#6D28D9', bg: '#F3E8FF' },
  sat: { t: 'Satellite', ic: 'satellite', c: '#0F766E', bg: '#CCFBF1' },
  mkt: { t: 'Markets', ic: 'landmark', c: '#B45309', bg: '#FEF3C7' },
  mix: { t: 'Several', ic: 'layers', c: '#57534E', bg: '#F5F5F4' },
};
/** Raw driver name -> group. Order matters (first match wins). `ai` marks the AI-era signals. */
const GROUPS = [
  { k: 'skip', re: /crop/i },
  { k: 'mkt', re: /gbp|usd|oil|brent|gas|inflation|cpi|fertil/i, label: 'Pound, oil & inflation', ic: 'pound-sterling', src: 'mkt' },
  { k: 'ai', re: /ai.*demand|demand/i, label: 'AI data-centres buying chips', ic: 'brain-circuit', src: 'news', ai: 1 },
  { k: 'mem', re: /hbm|memory|cowos|dram/i, label: 'Memory chip shortage', ic: 'memory-stick', src: 'news', ai: 1 },
  { k: 'build', re: /build/i, label: 'Data-centres seen from space', ic: 'building-2', src: 'sat', ai: 1 },
  { k: 'export', re: /export|tariff/i, label: 'Export rules & tariffs', ic: 'ship', src: 'news', ai: 1 },
  { k: 'water', re: /water|reservoir/i, label: 'Water for Taiwan chip fabs', ic: 'droplets', src: 'sat', ai: 1 },
  { k: 'trend', re: /./, label: 'Recent price trend', ic: 'trending-up', src: 'hist' },
];

/** Taiwan fab reservoirs as the satellite sees them (same metric as the Earth tab: NDWI vs 5-yr, % below/above). */
function reservoirs(data) {
  const w = (data?.regions || []).filter(r => r.signal === 'water')
    .map(r => ({ r, a: r.anomaly?.ndwi_vs_5yr_pct ?? r.anomaly?.water_frac_vs_5yr_pct })).filter(x => isNum(x.a));
  if (!w.length) return null;
  const worst = w.reduce((a, b) => (b.a < a.a ? b : a));
  return { sites: w, worst, low: worst.a < -10 };
}

/** Drivers (contribution in % points of the 6-month change) -> grouped rows in £, tiny ones folded into "Other".
 *  The water row is made to agree with the satellite: low reservoirs can only push prices up (the same size is taken
 *  from the trend row so the total still matches the forecast). */
function driverGroups(item, now, data) {
  const by = new Map();
  (item.drivers || []).forEach(d => {
    const v = contrib(d); if (!isNum(v)) return;
    const g = GROUPS.find(x => x.re.test(String(d.name || d.label || d.id || '')));
    if (!g || g.k === 'skip') return;
    const row = by.get(g.k) || by.set(g.k, { ...g, pts: 0, parts: [] }).get(g.k);
    row.pts += v; row.parts.push(d);
  });
  const res = reservoirs(data), wat = by.get('water'), tr = by.get('trend');
  if (res && wat) {
    const pts = Math.max(Math.abs(wat.pts), 0.06), want = res.low ? pts : -pts;
    if (tr) tr.pts -= want - wat.pts;
    wat.pts = want;
    wat.label = res.low ? `Fab reservoirs ${Math.round(Math.abs(res.worst.a))}% below avg` : 'Fab reservoirs above avg';
  }
  let rows = [...by.values()].map(r => ({ ...r, gbp: (r.pts / 100) * now }));
  const small = rows.filter(r => Math.abs(r.pts) < 0.06);
  rows = rows.filter(r => Math.abs(r.pts) >= 0.06);
  const oth = small.reduce((a, r) => a + r.pts, 0);
  const pos = rows.filter(r => r.gbp >= 0).sort((a, b) => b.gbp - a.gbp), neg = rows.filter(r => r.gbp < 0).sort((a, b) => a.gbp - b.gbp);
  const other = small.length && Math.abs(oth) >= 0.005
    ? [{ k: 'other', label: 'Other small effects', ic: 'ellipsis', src: 'mix', pts: oth, gbp: (oth / 100) * now, parts: small.flatMap(r => r.parts), groups: small }] : [];
  return [...pos, ...other, ...neg];
}

const gbpS = v => `${v >= 0 ? '+' : '−'}£${Math.abs(v) >= 10 ? Math.round(Math.abs(v)).toLocaleString('en-GB') : Math.abs(v).toFixed(1).replace(/\.0$/, '')}`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Evidence for a group's hover tooltip: rows + one plain-English note. */
function evidence(g, item, data) {
  const hs = (data.signals?.headlines || []).filter(h => !h.item_id || h.item_id === 'none' || h.item_id === item.item_id);
  const judged = key => hs.filter(h => (h.ai?.[key]?.value ?? 0) > 0.25).sort((a, b) => (b.ai?.[key]?.value ?? 0) - (a.ai?.[key]?.value ?? 0));
  const ae = item.ai_era || {};
  const head = list => (list[0]?.title ? `e.g. “${clip(list[0].title, 90)}”` : '');
  switch (g.k) {
    case 'trend': {
      const t = item.orbit_overlay?.trend_24m_pct_per_year;
      return { rows: [isNum(t) && { label: 'Last 24 months', value: `${pct(t, 0)} a year` }, { label: 'Forecast models', value: `${g.parts.length} agree` }],
        note: 'Models trained on years of past prices (TimesFM, ETS/ARIMA, momentum) expect the recent direction to carry on.' };
    }
    case 'ai': { const l = judged('ai_demand');
      return { rows: [isNum(ae.ai_index_now) && { label: 'AI demand index', value: `${Math.round(ae.ai_index_now)} vs ${Math.round(ae.ai_index_baseline ?? 50)} normal` }, l.length && { label: 'Headlines about AI buying', value: l.length.toLocaleString('en-GB') }],
        note: `Jev read the news: big AI labs are buying more chips, so less stock is left for shops. ${head(l)}` }; }
    case 'mem': { const l = judged('supply_constraint');
      return { rows: [l.length && { label: 'Headlines about shortages', value: l.length.toLocaleString('en-GB') }],
        note: `Memory chips (HBM, DRAM) go into every graphics card. Fewer chips → higher prices. ${head(l)}` }; }
    case 'export': { const l = judged('export_controls');
      return { rows: [{ label: 'Headlines about trade rules', value: l.length.toLocaleString('en-GB') }], note: 'Export bans and tariffs make chips harder to ship.' }; }
    case 'build': { const s = [...(ae.buildout_sites || [])].sort((a, b) => (b.growth_2y_pts ?? 0) - (a.growth_2y_pts ?? 0));
      return { rows: s.slice(0, 3).map(x => ({ label: shortRegion(x.name), value: isNum(x.transformed_pct_first_year) ? `${Math.round(x.transformed_pct_first_year)}% → ${Math.round(x.transformed_pct_now)}% built` : `${Math.round(x.transformed_pct_now)}% built` })),
        note: 'Sentinel-2 shows fields turning into AI data-centres. Every new campus needs tens of thousands of GPUs.' }; }
    case 'water': { const res = reservoirs(data);
      return { rows: (res?.sites || []).sort((a, b) => a.a - b.a).map(x => ({ label: shortRegion(x.r.name).replace(/\s*II$/, ''), value: `${pct(x.a, 0)} vs 5-yr avg` })),
        note: res?.low ? 'Chip fabs use huge amounts of water. Sentinel-2 sees Taiwan reservoirs well below normal, so drought cuts at the fabs are a risk → nudges prices up.'
          : 'Chip fabs use huge amounts of water. Reservoirs are at or above normal, so no drought risk → nudges prices slightly lower.' }; }
    case 'mkt': return { rows: g.parts.map(d => ({ label: String(d.name).replace(/\s*\(.*?\)/g, '').replace('EU gas / fertiliser proxy', 'Gas prices'), value: pct(contrib(d), 2) + ' pts' })), note: 'GPUs are priced in dollars: a weaker pound or pricier energy makes them dearer in UK shops.' };
    case 'other': return { rows: (g.groups || []).map(x => ({ label: x.label, value: gbpS(x.gbp) })), note: 'Drivers too small to matter on their own.' };
    default: return { rows: [], note: '' };
  }
}

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

// ---------------------------------------------------------------- hero A: "price bridge" from today to 6 months out, in £
function driversHero(card, data, item) {
  const short = ITEM_META[item.item_id]?.short || item.name;
  const noun = short === 'GPU' ? 'GPU' : short.toLowerCase();
  const { history, forecast } = retailSeries(item);
  const now = item.retail_now ?? history.at(-1)?.price;
  const f6 = forecast[Math.min(5, forecast.length - 1)];
  const groups = driverGroups(item, now, data);
  const later = [item.retail_6m, f6?.p50].find(isNum) ?? now * (1 + (isNum(item.change_6m_pct) ? item.change_6m_pct : groups.reduce((a, g) => a + g.pts, 0)) / 100);
  const totalGbp = later - now, totalPct = (totalGbp / now) * 100;
  const when = f6?.month ? fmtMonth(f6.month) : 'six months';
  const sites = buildSites(data, item);

  // Verdict sentence + push/pull summary (AI-era signals summed so the story is one line).
  const dir = Math.abs(totalPct) < 1 ? 'flat' : totalPct > 0 ? 'up' : 'down';
  const verdict = dir === 'flat' ? `${short} prices likely <b class="flat">flat</b> to ${esc(when)}`
    : `${short} prices likely <b class="${dir}">${dir === 'up' ? 'up' : 'down'} ${Math.abs(totalPct).toFixed(1)}%</b> by ${esc(when)}`;
  const aiSum = groups.filter(g => g.ai).reduce((a, g) => a + g.gbp, 0);
  const trend = groups.find(g => g.k === 'trend'), mkt = groups.find(g => g.k === 'mkt');
  const forces = [trend && { l: 'recent price trend', v: trend.gbp }, Math.abs(aiSum) >= 0.5 && { l: 'AI signals from news & satellites', v: aiSum }, mkt && { l: 'pound & energy', v: mkt.gbp }].filter(Boolean);
  const push = forces.filter(f => f.v > 0).sort((a, b) => b.v - a.v), pull = forces.filter(f => f.v < 0).concat(
    groups.filter(g => g.ai && g.gbp < 0 && Math.abs(aiSum) >= 0.5 && aiSum > 0).map(g => ({ l: g.k === 'water' ? 'Taiwan reservoirs above normal' : g.label.toLowerCase(), v: g.gbp })));
  const fl = a => a.map(f => `${esc(f.l)} <b>${gbpS(f.v)}</b>`).join(', ');

  // Scale for the floating bars: cumulative £ from today (0) to the forecast.
  let cum = 0;
  const rows = groups.map(g => { const r = { ...g, a: cum, b: cum + g.gbp }; cum += g.gbp; return r; });
  const lo = Math.min(0, ...rows.flatMap(r => [r.a, r.b]), totalGbp), hi = Math.max(0, ...rows.flatMap(r => [r.a, r.b]), totalGbp);
  const X = v => ((v - lo) / ((hi - lo) || 1)) * 100;
  const topI = rows.reduce((bi, r, i) => (r.gbp > (rows[bi]?.gbp ?? 0) ? i : bi), -1);
  const src = s => `<span class="gd-src" style="--c:${SRC[s].c};--bg:${SRC[s].bg}">${icon(SRC[s].ic, { size: 11, stroke: 2 })}${SRC[s].t}</span>`;

  card.innerHTML = `
    <div class="card-head">
      <div><div class="card-title">What's driving ${esc(noun)} prices</div>
        <div class="card-sub">Where the 6-month forecast comes from, in pounds · hover a row for the evidence</div></div>
    </div>
    <div class="gd-verdict">
      <div class="gd-big">${verdict}</div>
      <div class="gd-path"><span>${fmtGBP(now)} today</span>${icon('arrow-right', { size: 16, stroke: 2 })}<b>${fmtGBP(later)}</b>
        ${isNum(item.prob_up_6m) ? `<span class="gd-prob">${Math.round(item.prob_up_6m * 100)}% chance it rises</span>` : ''}</div>
      <div class="gd-why">
        ${push.length ? `<span class="gd-f up">${icon('arrow-up', { size: 12, stroke: 2.5 })}Pushing up</span><span>${fl(push)}</span>` : ''}
        ${pull.length ? `<span class="gd-f down">${icon('arrow-down', { size: 12, stroke: 2.5 })}Pulling down</span><span>${fl(pull)}</span>` : ''}
      </div>
    </div>
    <div class="gpu-body">
      <div class="gd-bridge">
        ${rows.map((r, i) => `
        <div class="gd-row" data-i="${i}">
          <div class="gd-lab"><span class="gd-ic">${icon(r.ic, { size: 16 })}</span><div><div class="gd-n" title="${esc(r.label)}">${esc(r.label)}</div><div class="gd-tags">${src(r.src)}${i === topI ? '<span class="gd-top">Biggest</span>' : ''}</div></div></div>
          <div class="gd-track"><i class="gd-zero" style="left:${X(0)}%"></i><i class="gd-end" style="left:${X(totalGbp)}%"></i>
            <div class="gd-bar ${r.gbp < 0 ? 'down' : i === topI ? 'up top' : 'up'}" style="left:${X(Math.min(r.a, r.b))}%;--w:${Math.max(0.6, X(Math.max(r.a, r.b)) - X(Math.min(r.a, r.b)))}%;--d:${150 + i * 80}ms"></div></div>
          <div class="gd-v ${r.gbp < 0 ? 'down' : 'up'}">${gbpS(r.gbp)}</div>
        </div>`).join('')}
        <div class="gd-row total" data-i="total">
          <div class="gd-lab"><span class="gd-ic">${icon('equal', { size: 16 })}</span><div><div class="gd-n">Forecast change</div><span class="gd-sub">${fmtGBP(now)} → ${fmtGBP(later)}</span></div></div>
          <div class="gd-track"><i class="gd-zero" style="left:${X(0)}%"></i>
            <div class="gd-bar total" style="left:${X(Math.min(0, totalGbp))}%;--w:${Math.max(0.6, Math.abs(X(totalGbp) - X(0)))}%;--d:${150 + rows.length * 80}ms"></div></div>
          <div class="gd-v">${gbpS(totalGbp)}<small>${pct(totalPct, 1)}</small></div>
        </div>
      </div>
      <div class="gpu-tiles">
        ${sites.length ? `<div class="gd-sat-h">${icon('satellite', { size: 13, stroke: 2 })}Seen from space</div><div class="cmp-host"></div>` : ''}
        ${sites.length > 1 ? `<div class="gpu-dots">${sites.map((_, i) => `<button data-i="${i}" title="${esc(shortRegion(sites[i].r.name))}"></button>`).join('')}</div>` : ''}
        <div class="build-pill"></div>
        <div class="gpu-cap">Sentinel-2 · 10 m · drag to compare, click Zoom to explore</div>
      </div>
    </div>`;

  // Satellite before/after with a zoom button (the slider itself is a drag target, so it opts out of click-to-zoom).
  const showSite = i => {
    const s = sites[i]; if (!s) return;
    const host = card.querySelector('.cmp-host');
    host.innerHTML = compareHtml(s) + `<button class="gd-zoom" data-sat-region="${esc(s.r.region_id)}" data-sat-month="${esc(s.after.month)}" title="Open full-size satellite view">${icon('maximize-2', { size: 13, stroke: 2 })}Zoom</button>`;
    host.querySelector('.compare')?.setAttribute('data-no-lightbox', '');
    host.querySelector('.gd-zoom').addEventListener('pointerdown', e => e.stopPropagation());
    wireCompare(host.querySelector('.compare'));
    card.querySelectorAll('.gpu-dots button').forEach((b, k) => b.classList.toggle('on', k === i));
    card.querySelector('.build-pill').innerHTML = isNum(s.growth)
      ? `<span class="gpu-chip ind">${icon('building-2', { size: 13 })}Built-up land ${s.growth >= 0 ? '+' : ''}${s.growth.toFixed(0)} pts since ${s.before?.month?.slice(0, 4) || ''}</span>` : '';
  };
  card.querySelectorAll('.gpu-dots button').forEach(b => b.addEventListener('click', () => showSite(+b.dataset.i)));
  if (!sites.length) card.querySelector('.gpu-body').style.gridTemplateColumns = '1fr';
  showSite(0);

  // Hover tooltip with the evidence behind each row (same look as the ECharts tooltips).
  const tip = document.createElement('div');
  tip.className = 'gd-tip'; tip.hidden = true; document.body.appendChild(tip);
  const move = e => {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 16) + 'px';
    tip.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - h / 2)) + 'px';
  };
  card.querySelectorAll('.gd-row').forEach(el => {
    el.addEventListener('mouseenter', e => {
      const r = rows[+el.dataset.i];
      if (r) {
        const ev = evidence(r, item, data);
        tip.innerHTML = tipHtml({ title: r.label, tag: SRC[r.src].t,
          rows: [{ color: r.gbp < 0 ? DOWN : UP, label: 'Effect on price', value: `${gbpS(r.gbp)} (${pct(r.pts, 2)} pts)` }, ...ev.rows.filter(Boolean)], note: ev.note });
      } else {
        tip.innerHTML = tipHtml({ title: `${short} forecast · ${when}`, tag: 'Total',
          rows: [{ label: 'Today', value: fmtGBP(now) }, { color: ACC, label: 'Expected', value: fmtGBP(later) },
            isNum(f6?.p10) && { label: 'Likely range', value: `${fmtGBP(f6.p10)} – ${fmtGBP(f6.p90)}` },
            isNum(item.prob_up_6m) && { label: 'Chance it rises', value: `${Math.round(item.prob_up_6m * 100)}%` }],
          note: 'The sum of all the drivers above.' });
      }
      tip.hidden = false; move(e);
      if (r?.k === 'build') card.querySelector('.cmp-host')?.classList.add('glow');
    });
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', () => { tip.hidden = true; card.querySelector('.cmp-host')?.classList.remove('glow'); });
  });
  requestAnimationFrame(() => card.querySelector('.gd-bridge')?.classList.add('on'));
  return () => tip.remove();
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
    tooltip: axisTooltip(ps => { const i = ps[0]?.dataIndex ?? 0; return tipHtml({ title: fmtMonth(months[i]), rows: [
      isNum(mainD[i]) && { color: ACC, label: name, value: `${Math.round(mainD[i])}% full` },
      other && isNum(otherD[i]) && { color: '#94A3B8', label: shortRegion(other.name).replace(/\s*II$/, ''), value: `${Math.round(otherD[i])}% full` },
      isNum(avg5[i]) && { color: '#A8A29E', dashed: true, label: '5-yr average', value: `${Math.round(avg5[i])}%` }] }); }),
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
  const aiG = isNum(now) ? driverGroups(item, now, data).filter(g => g.ai) : [];
  const aiSum = aiG.reduce((a, g) => a + g.gbp, 0);
  const water = (data.regions || []).filter(r => r.signal === 'water').map(r => r.anomaly?.ndwi_vs_5yr_pct).filter(isNum);
  const stat2 = aiG.length ? { v: gbpS(aiSum), l: 'from AI signals', cls: aiSum >= 0 ? 'up' : 'down' }
    : water.length ? { v: pct(Math.min(...water), 0), l: 'reservoir vs 5-yr', cls: Math.min(...water) < 0 ? 'up' : 'down' } : null;

  card.innerHTML = `
    ${items.length > 1 ? `<div class="seg" style="align-self:flex-start">${items.map(i => `<button data-item="${i.item_id}" class="${i === item ? 'on' : ''}">${esc(ITEM_META[i.item_id]?.short || i.name)}</button>`).join('')}</div>` : ''}
    <div class="gpu-prod">
      <img src="/static/assets/products/${item.item_id}.jpg" alt="" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="ph" hidden>${itemIcon(item.item_id, { size: 20 })}</div>
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
  const vals = [...history.slice(-18).map(p => p.price), ...forecast.slice(0, 6).map(p => p.p50)].filter(isNum);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || hi * 0.05 || 1;
  const raw = span * 1.8 / 5, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw);
  const fc = forecastChart(card.querySelector('.fc-host'), {
    history, forecast: forecast.slice(0, 6), accent: ACC, unit: item.unit || '£', calloutTitle: short, months: 18, calloutIndex: 5,
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
  const sc = signalCards(el.querySelector('.gpu-sig'), data, { accent: ACC, priceItem: items.find(i => i.item_id === 'gpu') || items[0], earthMetric: 'ndwi' });
  return () => { offL?.(); offR?.(); sc.dispose(); };
}
