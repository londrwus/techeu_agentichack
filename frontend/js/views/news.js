// News hub: Jev reads the world's commodity news live (design: frontend/NEWS_HUB.md, Pencil "10 News hub").
// Idle: latest judged headlines from /api/news/latest. "Scan the news": SSE /api/news/scan?mode=live
// (auto-fallback to mode=replay, the server's recorded scan) streams judged headlines into a firehose feed.
import { api, esc, isNum, showTip, hideTip } from '../lib.js';
import { icon } from '../components/icons.js';
import { axisTooltip, tipHtml } from '../components/chartTheme.js';

const MAX_DOM = 60, KEEP = 600, ROW_H = 64; // .nh-item height 58 + gap 6
const MODS = [['all', 'All'], ['groceries', 'Groceries'], ['latte', 'Coffee'], ['beer_wine', 'Beer & Wine'], ['gpu', 'GPU'], ['rent', 'Rent']];
// item id -> [commodity name, lucide icon, colour, module]
const ITEMS = {
  chocolate: ['Cocoa', 'bean', '#92400E', 'groceries'], olive_oil: ['Olive oil', 'droplet', '#65A30D', 'groceries'],
  orange_juice: ['Orange juice', 'citrus', '#EA580C', 'groceries'], bread: ['Wheat', 'wheat', '#CA8A04', 'groceries'],
  latte: ['Coffee', 'coffee', '#A16207', 'latte'], pint: ['Hops', 'hop', '#16A34A', 'beer_wine'], wine: ['Wine', 'wine', '#BE123C', 'beer_wine'],
  gpu: ['GPU / semis', 'cpu', '#6366F1', 'gpu'], laptop: ['Laptops', 'laptop', '#4F46E5', 'gpu'], rent_1bed: ['London housing', 'house', '#10B981', 'rent'],
};
const itName = id => ITEMS[id]?.[0] || 'Commodity';
const itIcon = (id, size = 18) => icon(ITEMS[id]?.[1] || 'newspaper', { size });
const itColor = id => ITEMS[id]?.[2] || '#A8A29E';
const itMod = id => ITEMS[id]?.[3];
const COST_PER_TOKEN = 0.042e-6 * 1.25; // Jev input price + a small allowance for output

const cssOnce = () => {
  if (document.getElementById('news-css')) return;
  document.head.appendChild(Object.assign(document.createElement('link'), { id: 'news-css', rel: 'stylesheet', href: '/static/css/news.css' }));
};
const fmtInt = v => (isNum(v) ? Math.round(v).toLocaleString('en-GB') : '–');
const fmtCost = v => (!isNum(v) ? '–' : '$' + (v < 1e-5 ? '0.000' : v < 0.001 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)));
const fmtSigned = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
function dateLabel(d) {
  const t = Date.parse(d || '');
  if (!isFinite(t)) return '';
  const dt = new Date(t), now = new Date();
  return dt.toLocaleDateString('en-GB', dt.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
const agoLabel = t => { const s = (performance.now() - t) / 1000; return s < 1 ? 'just now' : s < 60 ? `${Math.floor(s)} s ago` : `${Math.floor(s / 60)} min ago`; };
const pressureOf = it => (isNum(it.price_pressure) ? it.price_pressure : 0);
const isMoving = it => (it.relevant_p ?? 1) >= 0.5 && Math.abs(pressureOf(it)) >= 0.15;

// -> [class, arrow icon, probability of the chosen direction]
function verdict(it) {
  if ((it.relevant_p ?? 1) < 0.5) return ['none', 'minus', null];
  const lab = String(it.supply_effect?.label || ''), p = pressureOf(it), pr = it.supply_effect?.probs || {};
  const sum = (...k) => { const v = k.reduce((a, x) => a + (isNum(pr[x]) ? pr[x] : 0), 0); return v > 0 ? v : null; };
  if (/up/.test(lab) || (!lab && p > 0.15)) return ['up', 'arrow-up-right', sum('up', 'strongly_up')];
  if (/down/.test(lab) || (!lab && p < -0.15)) return ['down', 'arrow-down-right', sum('down', 'strongly_down')];
  return ['flat', 'arrow-right', sum('unchanged')];
}

function itemHtml(it, fresh) {
  const [vc, vi, vp] = verdict(it);
  const sev = String(it.severity?.label || '').toLowerCase();
  const rel = isNum(it.relevant_p) ? Math.round(it.relevant_p * 100) : null;
  const conf = isNum(it.confidence) ? Math.round(it.confidence * 100) : null;
  const major = sev === 'major' && (vc === 'up' || vc === 'down');
  const title = esc(it.title);
  const c = itColor(it.item_id);
  const when = it._t ? `<span class="nh-ago" data-t="${it._t}">${agoLabel(it._t)}</span>` : it.date ? `<span>${esc(dateLabel(it.date))}</span>` : '';
  return `<div class="nh-item${fresh ? ' new' : ''}${major ? ' major' : ''}" data-id="${esc(it.id)}" style="--c:${c}">
    <div class="nh-ic">${itIcon(it.item_id)}</div>
    <div class="nh-txt">
      <div class="nh-title">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${title}</a>` : title}</div>
      <div class="nh-meta">${fresh ? '<b class="nh-newtag">NEW</b>' : ''}<span class="nh-com">${esc(itName(it.item_id))}</span><i>·</i><span class="nh-src">${esc(it.source || 'News')}</span>${when ? `<i>·</i>${when}` : ''}${conf != null ? `<i>·</i><span>conf ${conf}%</span>` : ''}</div>
    </div>
    <div class="nh-rel"><span>REL ${rel ?? '–'}</span><div class="bar"><i class="${rel > 80 ? 'hi' : ''}" style="width:${rel ?? 0}%"></i></div></div>
    <div class="nh-sevcell">${sev ? `<span class="nh-sev ${esc(sev)}">${esc(sev)}</span>` : ''}</div>
    <div class="nh-verdict ${vc}" title="Jev price pressure (−1 cheaper … +1 pricier)${vp != null ? ` · P(direction) ${Math.round(vp * 100)}%` : ''}">${icon(vi, { size: 14, stroke: 2.2 })}${vc === 'none' ? '' : (pressureOf(it) > 0 ? '+' : pressureOf(it) < 0 ? '−' : '') + Math.abs(pressureOf(it)).toFixed(2)}</div>
  </div>`;
}

export async function render(page) {
  cssOnce();
  page.classList.add('nh');
  const kpi = (id, ic, lab, suffix = '', cls = '') => `<div class="nh-kpi ${cls}"><div class="val"><span id="${id}">–</span>${suffix ? `<small>${suffix}</small>` : ''}</div><div class="lab">${icon(ic, { size: 14 })}${lab}</div></div>`;
  page.innerHTML = `
  <header class="topbar">
    <div>
      <div class="crumb">Agents  /  News hub</div>
      <div class="title-row"><div class="icon-sq lg nh-tile">${icon('newspaper', { size: 22 })}</div><h1>News hub</h1></div>
      <div class="tagline">Jev reads the world's commodity news in seconds</div>
    </div>
    <div class="nh-actions">
      <button class="nh-replay" id="nh-replay" title="Replay a recorded scan">${icon('rotate-ccw', { size: 13 })}Replay</button>
      <div class="nh-engine">${icon('zap', { size: 16 })}<b>Jev</b><span>on Modal · jev-latest</span></div>
      <button class="btn primary nh-scan" id="nh-scan"><span class="ic">${icon('radar', { size: 18 })}</span><span class="nh-lb">Scan the news</span><span class="tm" id="nh-tm"></span></button>
    </div>
  </header>
  <section class="nh-kpis">
    ${kpi('k-head', 'newspaper', 'Headlines read')}${kpi('k-judg', 'scale', 'Jev judgments')}${kpi('k-jps', 'gauge', 'Judgments / sec', '', 'jps')}
    ${kpi('k-cont', 'server', 'Modal containers', ' / 100')}${kpi('k-cost', 'coins', 'Cost')}${kpi('k-time', 'timer', 'Elapsed', ' s')}
  </section>
  <section class="nh-body">
    <div class="nh-feedcol">
      <div class="nh-done" id="nh-done" hidden></div>
      <div class="nh-feedhead">
        <div class="l"><i class="nh-dot"></i><b>Live feed</b><span id="nh-sub">newest on top</span></div>
        <button class="nh-toggle" id="nh-moving"><i class="sw"></i>Only price-moving</button>
      </div>
      <div class="nh-chips" id="nh-chips">${MODS.map(([id, nm]) => `<button class="nh-chip${id === 'all' ? ' on' : ''}" data-m="${id}">${esc(nm)}</button>`).join('')}</div>
      <div class="nh-feed" id="nh-feed"><div class="nh-list" id="nh-list"></div></div>
    </div>
    <div class="nh-side">
      <div class="card nh-press"><div class="h">Pressure by commodity<span>Jev · live</span></div>
        <div class="nh-bars" id="nh-bars">${Object.keys(ITEMS).map(id => `<div class="nh-bar" data-i="${id}" style="--c:${itColor(id)}"><span class="ic">${itIcon(id, 14)}</span><span class="nm">${esc(itName(id))}</span><div class="tr"><i></i></div><span class="v flat">–</span></div>`).join('')}</div>
        <div class="nh-axis"><span class="dn">${icon('arrow-left', { size: 11 })}cheaper</span><span class="up">pricier${icon('arrow-right', { size: 11 })}</span></div>
      </div>
      <div class="card nh-thru">
        <div class="nh-thru-h"><div><div class="h">Throughput</div><div class="sub">Jev judgments per second</div></div><div class="big"><span id="k-thru">0</span><small> / s</small></div></div>
        <div class="nh-sparkwrap"><div class="nh-spark" id="nh-spark"></div><div class="nh-spark-hint" id="nh-spark-hint">Live once you scan</div></div>
        <div class="nh-thru-ax"><span>0 s</span><span id="nh-peak"></span><span id="nh-tend"></span></div>
      </div>
      <div class="card nh-jev"><div class="h"><span class="t"><i class="mk">${icon('zap', { size: 13 })}</i>Jev at work</span><span>relevance · item · direction · severity</span></div>
        <div class="nh-jevgrid"><div><b>4</b><span>per headline</span></div><div><b>25</b><span>per batch</span></div><div><b id="j-calls">–</b><span>Jev calls</span></div><div><b id="j-lat">–</b><span>avg latency</span></div></div>
      </div>
    </div>
  </section>`;

  const $ = s => page.querySelector(s);
  const list = $('#nh-list'), sub = $('#nh-sub'), doneEl = $('#nh-done'), scanBtn = $('#nh-scan'), tmEl = $('#nh-tm');
  let alive = true, es = null, filter = 'all', movingOnly = false;
  let buffer = [];            // newest first, all received items (capped)
  let queue = [];             // items waiting to be inserted into the DOM
  let offset = 0, raf = 0, lastIns = 0;
  let run = null;             // current scan state
  let lastPressure = {};
  let sampler = 0;

  /* ---------- smooth counters: one rAF loop lerps display -> target ---------- */
  const K = {
    head: { el: $('#k-head'), v: 0, t: 0, f: fmtInt }, judg: { el: $('#k-judg'), v: 0, t: 0, f: fmtInt },
    jps: { el: $('#k-jps'), v: 0, t: 0, f: fmtInt }, thru: { el: $('#k-thru'), v: 0, t: 0, f: fmtInt },
    cont: { el: $('#k-cont'), v: 0, t: 0, f: fmtInt }, cost: { el: $('#k-cost'), v: 0, t: 0, f: fmtCost },
  };
  const setK = (k, v) => { if (isNum(v)) K[k].t = v; };
  const setJps = v => { setK('jps', v); setK('thru', v); };
  const timeEl = $('#k-time');
  timeEl.textContent = '0.0'; K.jps.el.textContent = '0'; K.cont.el.textContent = '0'; K.cost.el.textContent = '$0.000';

  function frame() {
    if (!alive) return;
    for (const k of Object.values(K)) {
      if (k.v !== k.t) {
        const d = k.t - k.v;
        k.v = Math.abs(d) < (k.f === fmtCost ? 2e-5 : 1) ? k.t : k.v + d * 0.2;
        k.el.textContent = k.f(k.v);
      }
    }
    if (run && !run.done) {
      const s = ((performance.now() - run.t0) / 1000).toFixed(1);
      timeEl.textContent = s; tmEl.textContent = s + ' s';
    }
    // Feed: one card at a time at a readable-but-furious pace (faster when the queue backs up).
    const now = performance.now();
    if (queue.length && now - lastIns > (queue.length > 24 ? 60 : queue.length > 8 ? 90 : 140)) {
      lastIns = now;
      insert(queue.splice(0, 1));
    }
    if (offset > 0.5) { offset *= 0.84; list.style.transform = `translateY(${-offset}px)`; }
    else if (offset) { offset = 0; list.style.transform = ''; }
    raf = requestAnimationFrame(frame);
  }

  const passes = it => (filter === 'all' || it.module_id === filter) && (!movingOnly || isMoving(it));

  function insert(items) {
    const shown = items.filter(passes);
    if (!shown.length) return;
    list.querySelector('.nh-empty')?.remove();
    list.querySelector('.nh-item.newest')?.classList.remove('newest');
    // newest first: the last item of the batch goes on top
    list.insertAdjacentHTML('afterbegin', shown.slice().reverse().map(it => itemHtml(it, true)).join(''));
    list.firstElementChild?.classList.add('newest');
    offset += shown.length * ROW_H;
    offset = Math.min(offset, ROW_H * 3); // fast, but never a blank gap
    while (list.children.length > MAX_DOM) list.lastElementChild.remove();
  }

  function rebuild() {
    queue = [];
    offset = 0; list.style.transform = '';
    const rows = buffer.filter(passes).slice(0, MAX_DOM);
    list.innerHTML = rows.length ? rows.map(it => itemHtml(it, false)).join('') : `<div class="nh-empty">No headlines match this filter yet.</div>`;
  }

  function addItems(items, { animate = true } = {}) {
    buffer = items.slice().reverse().concat(buffer).slice(0, KEEP);
    if (animate) queue.push(...items); else rebuild();
  }

  // "2 s ago" labels tick while on screen
  const agoTimer = setInterval(() => {
    for (const s of list.querySelectorAll('.nh-ago[data-t]')) s.textContent = agoLabel(+s.dataset.t);
  }, 1000);

  /* ---------- pressure bars (sorted, FLIP re-order at most once a second) ---------- */
  const barsEl = $('#nh-bars');
  const barEls = Object.fromEntries([...page.querySelectorAll('.nh-bar')].map(b => [b.dataset.i, b]));
  let lastSort = 0, sortT = 0;
  function resort() {
    sortT = 0; lastSort = performance.now();
    const rows = [...barsEl.children];
    const before = new Map(rows.map(r => [r, r.getBoundingClientRect().top]));
    rows.sort((a, b) => (lastPressure[b.dataset.i] ?? -9) - (lastPressure[a.dataset.i] ?? -9)).forEach(r => barsEl.appendChild(r));
    for (const r of rows) {
      const d = before.get(r) - r.getBoundingClientRect().top;
      if (!d) continue;
      r.style.transition = 'none'; r.style.transform = `translateY(${d}px)`;
      requestAnimationFrame(() => { r.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1)'; r.style.transform = ''; });
    }
  }
  function setPressure(byItem, pulse = true) {
    for (const [id, b] of Object.entries(barEls)) {
      const v = byItem?.[id];
      if (!isNum(v)) continue;
      const c = Math.max(-1, Math.min(1, v));
      const i = b.querySelector('i'), val = b.querySelector('.v');
      const w = Math.abs(c) * 50;
      i.style.left = (c >= 0 ? 50 : 50 - w) + '%';
      i.style.width = Math.max(w, 0.8) + '%';
      i.className = c > 0.03 ? 'up' : c < -0.03 ? 'down' : '';
      val.className = 'v ' + (c > 0.03 ? 'up' : c < -0.03 ? 'down' : 'flat');
      val.textContent = fmtSigned(c);
      if (pulse && Math.abs((lastPressure[id] ?? 0) - c) > 0.01) {
        b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse');
      }
      lastPressure[id] = c;
    }
    const wait = 1000 - (performance.now() - lastSort);
    if (wait <= 0) resort(); else if (!sortT) sortT = setTimeout(resort, wait);
  }
  barsEl.addEventListener('mousemove', e => {
    const b = e.target.closest('.nh-bar'); if (!b) return hideTip();
    const id = b.dataset.i, v = lastPressure[id];
    const n = buffer.filter(it => it.item_id === id && isMoving(it)).length;
    showTip(tipHtml({ title: itName(id), tag: 'Jev', rows: [
      { color: isNum(v) && v < 0 ? '#16A34A' : '#DC2626', label: 'Net price pressure', value: isNum(v) ? fmtSigned(v) : '–' },
      { label: 'Price-moving headlines', value: fmtInt(n) },
    ], note: isNum(v) ? (v > 0.05 ? 'News points to higher prices' : v < -0.05 ? 'News points to easing prices' : 'News is balanced') : '' }), e.clientX, e.clientY);
  });
  barsEl.addEventListener('mouseleave', hideTip);

  function localPressure(items) {
    const acc = {};
    for (const it of items) if ((it.relevant_p ?? 1) >= 0.5 && isNum(it.price_pressure)) (acc[it.item_id] ||= []).push(it.price_pressure * (it.confidence ?? 0.6));
    return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  }

  /* ---------- throughput area chart: sampled every 250 ms from t=0 ---------- */
  const E = window.echarts;
  const chart = E ? E.init($('#nh-spark'), null, { renderer: 'canvas' }) : null;
  let spark = [];
  const peakEl = $('#nh-peak'), tendEl = $('#nh-tend');
  function drawSpark() {
    if (!chart) return;
    const last = spark.at(-1);
    const peak = spark.reduce((m, p) => Math.max(m, p[1]), 0);
    chart.setOption({
      xAxis: { max: Math.max(1, last?.[0] || 0) }, yAxis: { max: Math.max(10, peak * 1.12) },
      series: [{ data: spark }, { data: last && spark.length > 1 ? [last] : [] }],
    });
    peakEl.textContent = peak ? `peak ${fmtInt(peak)} / s` : '';
    tendEl.textContent = last ? `${last[0].toFixed(1)} s` : '';
  }
  chart?.setOption({
    animation: false,
    grid: { left: 2, right: 8, top: 8, bottom: 2 },
    xAxis: { type: 'value', min: 0, max: 1, show: false },
    yAxis: { type: 'value', min: 0, show: false },
    tooltip: axisTooltip(ps => { const p = ps[0]; return tipHtml({ title: `${(+p.value[0]).toFixed(1)} s`, rows: [{ color: '#F97316', label: 'Judgments / s', value: fmtInt(p.value[1]) }] }); }),
    series: [
      { type: 'line', smooth: 0.45, symbol: 'none', data: [], lineStyle: { color: '#F97316', width: 2, cap: 'round' },
        areaStyle: { color: E ? new E.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(249,115,22,.22)' }, { offset: 1, color: 'rgba(249,115,22,.05)' }]) : 'rgba(249,115,22,.12)' } },
      { type: 'effectScatter', data: [], symbolSize: 8, itemStyle: { color: '#F97316' }, rippleEffect: { scale: 2.4, brushType: 'fill', period: 1.2 }, tooltip: { show: false }, z: 5 },
    ],
  });
  const ro = window.ResizeObserver ? new ResizeObserver(() => chart?.resize()) : null;
  ro?.observe($('#nh-spark'));

  function sample() {
    if (!run || run.done) return;
    const now = performance.now(), t = (now - run.t0) / 1000;
    run.hist.push([now, run.judgments]);
    while (run.hist.length > 2 && now - run.hist[0][0] > 1500) run.hist.shift();
    const [t0, j0] = run.hist[0];
    const rate = now - t0 > 200 ? ((run.judgments - j0) * 1000) / (now - t0) : 0;
    setJps(rate);
    spark.push([+t.toFixed(2), Math.round(rate)]);
    drawSpark();
  }

  /* ---------- done banner ---------- */
  function showDone(d, byItem) {
    const movers = Object.entries(byItem || {}).filter(([, v]) => isNum(v)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
    const dot = '<i class="sep"></i>';
    const secs = +d.seconds;
    doneEl.innerHTML = `<div class="ok">${icon('check', { size: 20, stroke: 2.4 })}</div>
      <div class="sum"><div class="k">Scan complete</div>
        <div class="line"><b>${fmtInt(d.total_judged)}</b><span>headlines</span>${dot}<b>${fmtInt(d.judgments)}</b><span>Jev judgments</span>${dot}<b>${secs < 20 ? secs.toFixed(1) : Math.round(secs)} s</b>${dot}<b>${fmtCost(d.cost_usd)}</b></div></div>
      ${movers.length ? `<div class="mv"><div class="k">Top movers</div><div class="chips">${movers.map(([id, v]) => `<span class="nh-mover ${v >= 0 ? 'up' : 'down'}" style="--c:${itColor(id)}">${itIcon(id, 15)}<b>${esc(itName(id))}</b>${icon(v >= 0 ? 'arrow-up-right' : 'arrow-down-right', { size: 13, stroke: 2.4 })}<em>${fmtSigned(v)}</em></span>`).join('')}</div></div>` : ''}`;
    doneEl.hidden = false;
  }

  /* ---------- scan event handling ---------- */
  function onEvent(ev) {
    if (!alive || !run) return;
    switch (ev.type) {
      case 'start':
        run.started = true; run.target = ev.target || 0;
        sub.innerHTML = 'Fetching headlines…';
        break;
      case 'fetched':
        run.fetched = ev.total_fetched || run.fetched;
        if (!run.judged) sub.innerHTML = `Fetching <b>${fmtInt(run.fetched)}</b> headlines…`;
        break;
      case 'judged': {
        const t = performance.now();
        const items = (ev.items || []).map(it => ({ ...it, _t: t, module_id: it.module_id || itMod(it.item_id) }));
        addItems(items);
        if (queue.length > 48) { // firehose: show the freshest, favour price-moving news; everything still counts
          const mv = queue.filter(isMoving).slice(-40), keep = new Set(mv.concat(queue.filter(x => !isMoving(x)).slice(-(48 - mv.length))));
          queue = queue.filter(x => keep.has(x));
        }
        run.judged = ev.total_judged ?? run.judged + items.length;
        run.judgments = ev.judgments ?? run.judgments;
        run.calls = ev.jev_calls ?? run.calls;
        run.contSum += ev.containers_active || 0; run.contN++;
        setK('head', run.judged); setK('judg', run.judgments); setK('cont', ev.containers_active);
        if (isNum(ev.tokens_in)) setK('cost', ev.tokens_in * COST_PER_TOKEN);
        const el = isNum(ev.elapsed_s) ? ev.elapsed_s : (t - run.t0) / 1000;
        $('#j-calls').textContent = fmtInt(run.calls);
        if (run.calls) {
          const lat = Math.max(0.15, Math.min(9.9, (el - (run.firstJudged ??= el) + 0.8) * (run.contSum / run.contN) / run.calls));
          $('#j-lat').textContent = lat < 1 ? Math.round(lat * 1000) + ' ms' : lat.toFixed(1) + ' s';
        }
        const tot = Math.max(run.target, run.fetched, run.judged);
        sub.innerHTML = `Jev judging <b>${fmtInt(run.judged)}</b>${run.fetched ? ` / ${fmtInt(Math.max(run.fetched, run.judged))}` : tot ? ` / ${fmtInt(tot)}` : ''} · <b>${fmtInt(ev.containers_active)}</b> containers`;
        if (!run.gotPressure && run.judged - (run.lastLocal || 0) > 60) { run.lastLocal = run.judged; setPressure(localPressure(buffer)); }
        break;
      }
      case 'pressure':
        if (ev.by_item && Object.keys(ev.by_item).length) { run.gotPressure = true; run.byItem = ev.by_item; setPressure(ev.by_item); }
        break;
      case 'done':
        finish(ev);
        break;
    }
  }

  function setBtn(running) {
    scanBtn.classList.toggle('running', running);
    scanBtn.querySelector('.ic').innerHTML = running ? icon('loader', { size: 18, cls: 'spin' }) : icon('radar', { size: 18 });
    scanBtn.querySelector(".nh-lb").textContent = running ? 'Scanning…' : 'Scan the news';
    tmEl.textContent = running ? '0.0 s' : '';
  }

  function finish(d) {
    if (!run || run.done) return;
    sample();
    run.done = true;
    clearInterval(sampler); sampler = 0;
    es?.close(); es = null;
    const secs = d?.seconds ?? (performance.now() - run.t0) / 1000;
    const res = { total_judged: d?.total_judged ?? run.judged, judgments: d?.judgments ?? run.judgments, seconds: secs, cost_usd: d?.cost_usd ?? K.cost.t };
    timeEl.textContent = secs.toFixed(1);
    setK('head', res.total_judged); setK('judg', res.judgments); setK('cost', res.cost_usd); setK('cont', isNum(d?.containers_peak) ? d.containers_peak : 0);
    setJps(isNum(d?.judgments_per_s) ? d.judgments_per_s : res.judgments / Math.max(secs, 0.5));
    if (isNum(d?.jev_calls)) $('#j-calls').textContent = fmtInt(d.jev_calls);
    drawSpark();
    const byItem = run.byItem || localPressure(buffer);
    setPressure(byItem);
    showDone(res, byItem);
    sub.innerHTML = `newest on top · ${fmtInt(res.total_judged)} judged`;
    page.classList.remove('live');
    setBtn(false);
    // stop the slide-in shortly after: flush whatever is still queued in one go
    const myRun = run;
    run.flushT = setTimeout(() => {
      if (!alive || run !== myRun) return;
      if (queue.length) rebuild();
      list.querySelector('.nh-item.newest')?.classList.remove('newest');
    }, 1500);
  }

  /* ---------- sources: live SSE -> replay SSE ---------- */
  function startScan(mode) {
    if (run && !run.done) return;
    es?.close();
    clearTimeout(run?.flushT);
    run = { t0: performance.now(), mode, judged: 0, judgments: 0, calls: 0, contSum: 0, contN: 0, hist: [], fetched: 0, target: 0 };
    spark = [[0, 0]]; drawSpark();
    $('#nh-spark-hint')?.remove();
    buffer = []; queue = []; lastPressure = {};
    // keep the idle headlines on screen: fresh verdicts push them down as they arrive
    for (const k of Object.keys(K)) { K[k].t = 0; K[k].v = 0.0001; }
    $('#j-calls').textContent = '0'; $('#j-lat').textContent = '–';
    doneEl.hidden = true;
    sub.innerHTML = 'Connecting to Modal…';
    page.classList.add('live');
    setBtn(true);
    clearInterval(sampler); sampler = setInterval(sample, 250);
    connect(mode);
  }

  function connect(mode) {
    const myRun = run;
    let src;
    try { src = new EventSource(`/api/news/scan?mode=${mode}`); } catch { return fallback(mode, myRun); }
    es = src;
    let got = false;
    src.onmessage = m => {
      if (run !== myRun) return;
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      got = true; onEvent(ev);
    };
    src.onerror = () => {
      src.close();
      if (run !== myRun || myRun.done) return;
      if (!got) fallback(mode, myRun);   // nothing arrived: try the next source
      else finish(null);                 // stream broke mid-way: close out with what we have
    };
  }

  function fallback(mode, myRun) {
    if (run !== myRun) return;
    if (mode === 'live') return connect('replay');
    // Both sources failed (server offline): end the run cleanly.
    finish(null);
    doneEl.hidden = true;
    sub.innerHTML = 'News scan unavailable right now · showing the latest judged headlines';
    if (!buffer.length) loadIdle(true);
  }

  /* ---------- idle: latest judged headlines ---------- */
  async function loadIdle(force = false) {
    const d = await api('/api/news/latest?limit=300&module=all');
    let items = d?.items || [];
    const totals = d?.totals;
    if (!alive || (run && !force)) return;
    items = items.map(it => ({ ...it, module_id: it.module_id || itMod(it.item_id) }));
    buffer = items.slice(0, KEEP);
    rebuild();
    setK('head', totals?.headlines); setK('judg', totals?.judgments);
    const allTime = Object.assign({}, ...Object.values(d?.by_module || {}).map(m => m?.item_pressure || {}));
    setPressure(Object.keys(allTime).length ? allTime : localPressure(items), false);
    if (!run) sub.innerHTML = 'newest on top · latest judged';
  }

  /* ---------- wiring ---------- */
  // Pre-start Modal containers (fetch + judge) so the live scan has no cold start; refreshed on hover.
  let warmT = 0;
  const warm = () => { if (Date.now() - warmT > 60000) { warmT = Date.now(); fetch('/api/news/warm').catch(() => {}); } };
  warm();
  scanBtn.addEventListener('mouseenter', warm);
  scanBtn.addEventListener('click', () => startScan('live'));
  $('#nh-replay').addEventListener('click', () => startScan('replay'));
  $('#nh-chips').addEventListener('click', e => {
    const c = e.target.closest('.nh-chip'); if (!c) return;
    filter = c.dataset.m;
    page.querySelectorAll('#nh-chips .nh-chip').forEach(x => x.classList.toggle('on', x === c));
    rebuild();
  });
  $('#nh-moving').addEventListener('click', () => {
    movingOnly = !movingOnly;
    $('#nh-moving').classList.toggle('on', movingOnly);
    rebuild();
  });

  raf = requestAnimationFrame(frame);
  loadIdle();

  return () => {
    alive = false;
    es?.close();
    clearTimeout(run?.flushT); clearTimeout(sortT);
    clearInterval(sampler); clearInterval(agoTimer);
    cancelAnimationFrame(raf);
    ro?.disconnect();
    chart?.dispose();
    hideTip();
  };
}
