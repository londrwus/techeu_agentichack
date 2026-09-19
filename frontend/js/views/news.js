// News hub: Jev reads the world's commodity news live.
// Idle: latest judged headlines from /api/news/latest. "Scan the news": SSE /api/news/scan?mode=live
// (auto-fallback to mode=replay, the server's recorded scan) streams judged headlines into a firehose feed.
import { api, esc, isNum, showTip, hideTip, MODULE_META } from '../lib.js';
import { icon, itemIcon, moduleIcon } from '../components/icons.js';
import { axisTooltip, tipHtml } from '../components/chartTheme.js';

const MAX_DOM = 60, KEEP = 600, ROW_H = 86; // .nh-item height 78 + gap 8
const MODS = [['all', 'All', 'layers'], ['groceries', 'Groceries'], ['latte', 'Coffee'], ['beer_wine', 'Beer & Wine'], ['gpu', 'GPU'], ['rent', 'Rent']];
const ITEMS = [
  ['chocolate', 'Chocolate', 'groceries'], ['olive_oil', 'Olive oil', 'groceries'], ['orange_juice', 'Orange juice', 'groceries'],
  ['bread', 'Bread', 'groceries'], ['latte', 'Coffee', 'latte'], ['pint', 'Beer', 'beer_wine'], ['wine', 'Wine', 'beer_wine'],
  ['gpu', 'GPUs', 'gpu'], ['laptop', 'Laptops', 'gpu'], ['rent_1bed', 'London rent', 'rent'],
];
const ITEM_NAME = Object.fromEntries(ITEMS.map(([id, n]) => [id, n]));
const ITEM_MOD = Object.fromEntries(ITEMS.map(([id, , m]) => [id, m]));
const COST_PER_TOKEN = 0.042e-6 * 1.25; // Jev input price + a small allowance for output

const cssOnce = () => {
  if (document.getElementById('news-css')) return;
  document.head.appendChild(Object.assign(document.createElement('link'), { id: 'news-css', rel: 'stylesheet', href: '/static/css/news.css' }));
};
const fmtInt = v => (isNum(v) ? Math.round(v).toLocaleString('en-GB') : '–');
const fmtCost = v => (!isNum(v) ? '–' : '$' + (v < 1e-5 ? '0.000' : v < 0.001 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)));
const modColor = m => MODULE_META[m]?.color || '#A8A29E';
function dateLabel(d) {
  const t = Date.parse(d || '');
  if (!isFinite(t)) return '';
  const dt = new Date(t), now = new Date();
  return dt.toLocaleDateString('en-GB', dt.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
const pressureOf = it => (isNum(it.price_pressure) ? it.price_pressure : 0);
const isMoving = it => (it.relevant_p ?? 1) >= 0.5 && Math.abs(pressureOf(it)) >= 0.15;

function verdict(it) {
  if ((it.relevant_p ?? 1) < 0.5) return ['none', 'circle-slash', 'Not relevant'];
  const lab = String(it.supply_effect?.label || ''), p = pressureOf(it);
  if (lab === 'strongly_up' || p > 0.6) return ['up2', 'arrow-up', 'Strong up'];
  if (lab === 'up' || p > 0.15) return ['up', 'arrow-up-right', 'Price up'];
  if (lab === 'strongly_down' || p < -0.6) return ['down2', 'arrow-down', 'Strong down'];
  if (lab === 'down' || p < -0.15) return ['down', 'arrow-down-right', 'Price down'];
  return ['flat', 'arrow-right', 'No change'];
}

function itemHtml(it, fresh) {
  const [vc, vi, vt] = verdict(it);
  const sev = String(it.severity?.label || '').toLowerCase();
  const m = it.module_id || ITEM_MOD[it.item_id];
  const rel = isNum(it.relevant_p) ? Math.round(it.relevant_p * 100) : null;
  const conf = isNum(it.confidence) ? Math.round(it.confidence * 100) : null;
  const major = sev === 'major' && vc !== 'none' && vc !== 'flat';
  const title = esc(it.title);
  return `<div class="nh-item${fresh ? ' new' : ''}${major ? ' major' : ''}${/down/.test(vc) ? ' dn' : ''}" data-id="${esc(it.id)}">
    <div class="nh-meta"><span class="nh-src">${esc(it.source || 'News')}</span>${it.date ? `<span>·</span><span>${esc(dateLabel(it.date))}</span>` : ''}</div>
    <div class="nh-title">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${title}</a>` : title}</div>
    <div class="nh-right">
      <div class="nh-tags"><span class="nh-com" style="--c:${modColor(m)}">${itemIcon(it.item_id, { size: 13 })}${esc(ITEM_NAME[it.item_id] || MODULE_META[m]?.name || 'Commodity')}</span>
        <span class="nh-verdict ${vc}">${icon(vi, { size: 13, stroke: 2.4 })}${vt}</span></div>
      <div class="nh-sub">${sev ? `<span class="nh-sev ${esc(sev)}">${esc(sev)}</span>` : ''}${rel != null ? `<span>relevance ${rel}%</span>` : ''}${conf != null ? `<span>conf ${conf}%</span>` : ''}</div>
    </div>
    <div class="nh-rel"><i style="width:${rel ?? 0}%"></i></div>
  </div>`;
}

export async function render(page) {
  cssOnce();
  page.classList.add('nh');
  page.innerHTML = `
  <header class="topbar">
    <div><div class="title-row"><h1>News hub</h1></div><div class="tagline">Jev reads the world's commodity news in seconds</div></div>
    <div class="nh-actions">
      <button class="nh-replay" id="nh-replay" title="Replay a recorded scan">${icon('rotate-ccw', { size: 14 })}Replay</button>
      <button class="btn primary nh-scan" id="nh-scan">${icon('radar', { size: 18 })}<span>Scan the news</span></button>
    </div>
  </header>
  <section class="nh-kpis">
    <div class="nh-kpi"><div class="lab">${icon('newspaper')}Headlines read</div><div class="val" id="k-head">–</div></div>
    <div class="nh-kpi jev"><div class="lab">${icon('scale')}Jev judgments</div><div class="val" id="k-judg">–</div></div>
    <div class="nh-kpi jps"><div class="lab">${icon('gauge')}Judgments / second</div><div class="val" id="k-jps">0</div></div>
    <div class="nh-kpi modal"><div class="lab">${icon('server')}Modal containers</div><div class="val"><span id="k-cont">0</span><small> / 100</small></div><i class="meter" id="k-meter"></i></div>
    <div class="nh-kpi"><div class="lab">${icon('coins')}Cost so far</div><div class="val" id="k-cost">$0.000</div></div>
    <div class="nh-kpi"><div class="lab">${icon('timer')}Elapsed</div><div class="val"><span id="k-time">0.0</span><small> s</small></div></div>
  </section>
  <section class="nh-body">
    <div class="card nh-feedcard">
      <div class="nh-feedhead">
        <div class="nh-chips" id="nh-chips">${MODS.map(([id, nm, ic]) => `<button class="chip${id === 'all' ? ' on' : ''}" data-m="${id}">${ic ? icon(ic, { size: 13 }) : moduleIcon(id, { size: 13 })}${esc(nm)}</button>`).join('')}
          <button class="nh-toggle" id="nh-moving"><i class="sw"></i>Price-moving only</button></div>
      </div>
      <div class="nh-banner" id="nh-banner"></div>
      <div class="nh-feed" id="nh-feed"><div class="nh-list" id="nh-list"></div></div>
    </div>
    <div class="nh-side">
      <div class="card nh-press"><div class="h">Pressure by commodity<span>Jev, −1 … +1</span></div>
        <div class="nh-bars" id="nh-bars">${ITEMS.map(([id, nm, m]) => `<div class="nh-bar" data-i="${id}" style="--c:${modColor(m)}"><div class="nm">${itemIcon(id, { size: 14 })}${esc(nm)}</div><div class="tr"><i></i></div><div class="v flat">–</div></div>`).join('')}</div>
        <div class="nh-axis"><span></span><div><span>cheaper</span><span>pricier</span></div><span></span></div>
      </div>
      <div class="card nh-thru"><div class="h">Throughput<span id="nh-thru-sub">judgments / s</span></div><div class="nh-spark" id="nh-spark"></div><div class="nh-spark-hint" id="nh-spark-hint">Live once you scan</div></div>
      <div class="card nh-jev"><div class="h"><span style="display:flex;gap:6px;align-items:center;color:var(--text-1);font-size:15px;font-weight:700">${icon('scale', { size: 15 })}Jev at work</span><span>typed, calibrated</span></div>
        <div class="nh-jevgrid"><div><b>4</b><span>questions each</span></div><div><b>25</b><span>per Jev call</span></div><div><b id="j-calls">–</b><span>Jev calls</span></div><div><b id="j-lat">–</b><span>avg latency</span></div></div>
      </div>
    </div>
  </section>`;

  const $ = s => page.querySelector(s);
  const list = $('#nh-list'), feed = $('#nh-feed'), banner = $('#nh-banner'), scanBtn = $('#nh-scan');
  let alive = true, es = null, filter = 'all', movingOnly = false;
  let buffer = [];            // newest first, all received items (capped)
  let queue = [];             // items waiting to be inserted into the DOM
  let offset = 0, raf = 0, lastIns = 0;
  let run = null;             // current scan state
  let lastPressure = {};

  /* ---------- smooth counters: one rAF loop lerps display -> target ---------- */
  const K = {
    head: { el: $('#k-head'), v: 0, t: 0, f: fmtInt }, judg: { el: $('#k-judg'), v: 0, t: 0, f: fmtInt },
    jps: { el: $('#k-jps'), v: 0, t: 0, f: fmtInt }, cont: { el: $('#k-cont'), v: 0, t: 0, f: fmtInt },
    cost: { el: $('#k-cost'), v: 0, t: 0, f: fmtCost },
  };
  const setK = (k, v) => { if (isNum(v)) K[k].t = v; };
  const timeEl = $('#k-time'), meter = $('#k-meter');

  function frame() {
    if (!alive) return;
    for (const k of Object.values(K)) {
      if (k.v !== k.t) {
        const d = k.t - k.v;
        k.v = Math.abs(d) < (k.f === fmtCost ? 2e-5 : 1) ? k.t : k.v + d * 0.2;
        k.el.textContent = k.f(k.v);
      }
    }
    meter.style.width = Math.min(100, K.cont.v) + '%';
    if (run && !run.done) timeEl.textContent = ((performance.now() - run.t0) / 1000).toFixed(1);
    // Feed: drain the queue proportionally so we keep up with any rate.
    // One card at a time at a readable-but-furious pace (faster when the queue backs up).
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
    // newest first: the last item of the batch goes on top
    list.insertAdjacentHTML('afterbegin', shown.slice().reverse().map(it => itemHtml(it, true)).join(''));
    const added = shown.length;
    offset += added * ROW_H;
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

  /* ---------- pressure bars ---------- */
  const barEls = Object.fromEntries([...page.querySelectorAll('.nh-bar')].map(b => [b.dataset.i, b]));
  function setPressure(byItem, pulse = true) {
    for (const [id, b] of Object.entries(barEls)) {
      const v = byItem?.[id];
      if (!isNum(v)) continue;
      const c = Math.max(-1, Math.min(1, v));
      const i = b.querySelector('i'), val = b.querySelector('.v');
      const w = Math.abs(c) * 50;
      i.style.left = (c >= 0 ? 50 : 50 - w) + '%';
      i.style.width = Math.max(w, 0.6) + '%';
      i.style.background = c > 0.03 ? 'var(--up)' : c < -0.03 ? 'var(--down)' : 'var(--text-3)';
      val.className = 'v ' + (c > 0.03 ? 'up' : c < -0.03 ? 'down' : 'flat');
      val.textContent = (c > 0 ? '+' : c < 0 ? '−' : '') + Math.abs(c).toFixed(2);
      if (pulse && Math.abs((lastPressure[id] ?? 0) - c) > 0.01) {
        b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse');
      }
      lastPressure[id] = c;
    }
  }
  page.querySelector('#nh-bars').addEventListener('mousemove', e => {
    const b = e.target.closest('.nh-bar'); if (!b) return hideTip();
    const id = b.dataset.i, v = lastPressure[id];
    const n = buffer.filter(it => it.item_id === id && isMoving(it)).length;
    showTip(tipHtml({ title: ITEM_NAME[id], tag: 'Jev', rows: [
      { color: isNum(v) && v < 0 ? '#16A34A' : '#DC2626', label: 'Net price pressure', value: isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : '–' },
      { label: 'Price-moving headlines', value: fmtInt(n) },
    ], note: isNum(v) ? (v > 0.05 ? 'News points to higher prices' : v < -0.05 ? 'News points to easing prices' : 'News is balanced') : '' }), e.clientX, e.clientY);
  });
  page.querySelector('#nh-bars').addEventListener('mouseleave', hideTip);

  function localPressure(items) {
    const acc = {};
    for (const it of items) if ((it.relevant_p ?? 1) >= 0.5 && isNum(it.price_pressure)) (acc[it.item_id] ||= []).push(it.price_pressure * (it.confidence ?? 0.6));
    return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  }

  /* ---------- throughput sparkline ---------- */
  const chart = window.echarts ? window.echarts.init($('#nh-spark'), null, { renderer: 'canvas' }) : null;
  let spark = [], sparkT = 0;
  function drawSpark(force) {
    if (!chart) return;
    const now = performance.now();
    if (!force && now - sparkT < 250) return;
    sparkT = now;
    chart.setOption({ series: [{ data: spark.map(p => [p[0], p[1]]) }], xAxis: { max: Math.max(10, spark.at(-1)?.[0] || 0) } });
  }
  chart?.setOption({
    animation: false,
    grid: { left: 8, right: 16, top: 10, bottom: 18 },
    xAxis: { type: 'value', min: 0, max: 20, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { color: '#A8A29E', fontSize: 10, formatter: v => v + 's', showMinLabel: false } },
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: axisTooltip(ps => { const p = ps[0]; return tipHtml({ title: `${(+p.value[0]).toFixed(1)} s`, rows: [{ color: '#F97316', label: 'Judgments / s', value: fmtInt(p.value[1]) }] }); }),
    series: [{ type: 'line', smooth: 0.4, symbol: 'none', data: [], lineStyle: { color: '#F97316', width: 2 },
      areaStyle: { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(249,115,22,.28)' }, { offset: 1, color: 'rgba(249,115,22,0)' }]) } }],
  });
  const ro = window.ResizeObserver ? new ResizeObserver(() => chart?.resize()) : null;
  ro?.observe($('#nh-spark'));

  /* ---------- banner ---------- */
  function bannerIdle(totals) {
    banner.className = 'nh-banner';
    banner.innerHTML = `${icon('info', { size: 16 })}<span>Latest judged headlines${totals?.headlines ? ` · <b>${fmtInt(totals.headlines)}</b> read so far` : ''}. Press <b>Scan the news</b> to watch Jev read the world live.</span>`;
  }
  function bannerRun() {
    banner.className = 'nh-banner run';
    banner.innerHTML = `<i class="dotlive"></i><span id="b-txt">Fetching headlines…</span><i class="prog" id="b-prog"></i>`;
  }
  function bannerDone(d, byItem) {
    const movers = Object.entries(byItem || {}).filter(([, v]) => isNum(v)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
    banner.className = 'nh-banner done';
    banner.innerHTML = `${icon('check-circle-2', { size: 16 })}<span><b>${fmtInt(d.total_judged)}</b> headlines · <b>${fmtInt(d.judgments)}</b> judgments · <b>${(+d.seconds).toFixed(1)} s</b> · <b>${fmtCost(d.cost_usd)}</b></span>
      <div class="movers">${movers.map(([id, v]) => `<span class="nh-mover ${v >= 0 ? 'up' : 'down'}">${itemIcon(id, { size: 13 })}${esc(ITEM_NAME[id] || id)}${icon(v >= 0 ? 'arrow-up-right' : 'arrow-down-right', { size: 13, stroke: 2.4 })}</span>`).join('')}</div>`;
  }

  /* ---------- scan event handling ---------- */
  function onEvent(ev) {
    if (!alive || !run) return;
    const el = isNum(ev.elapsed_s) ? ev.elapsed_s : (performance.now() - run.t0) / 1000;
    switch (ev.type) {
      case 'start':
        run.started = true; run.target = ev.target || 0;
        break;
      case 'fetched': {
        run.fetched = ev.total_fetched || run.fetched;
        const t = $('#b-txt'); if (t) t.innerHTML = `Fetched <b>${fmtInt(run.fetched)}</b> headlines · ${esc(MODULE_META[ev.module_id]?.name || ev.module_id)}`;
        break;
      }
      case 'judged': {
        const items = (ev.items || []).map(it => ({ ...it, module_id: it.module_id || ITEM_MOD[it.item_id] }));
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
        // judgments/s over a sliding 1.5 s window
        run.win.push([el, run.judgments]);
        while (run.win.length > 2 && el - run.win[0][0] > 1.5) run.win.shift();
        const [t0, j0] = run.win[0];
        const jps = el - t0 > 0.2 ? (run.judgments - j0) / (el - t0) : run.judgments / Math.max(el, 0.5);
        setK('jps', jps);
        spark.push([el, Math.round(jps)]); drawSpark();
        $('#j-calls').textContent = fmtInt(run.calls);
        if (run.calls) $('#j-lat').textContent = Math.max(0.3, Math.min(9.9, (el - (run.firstJudged ??= el) + 0.8) * (run.contSum / run.contN) / run.calls)).toFixed(1) + 's';
        const t = $('#b-txt'); if (t) t.innerHTML = `Jev is judging <b>${fmtInt(run.judged)}</b>${run.target ? ` / ${fmtInt(Math.max(run.target, run.fetched, run.judged))}` : ''} headlines · <b>${fmtInt(ev.containers_active)}</b> containers`;
        const p = $('#b-prog'); if (p && run.target) p.style.width = Math.min(100, (run.judged / Math.max(run.target, run.fetched, run.judged)) * 100) + '%';
        if (!run.gotPressure && run.judged - (run.lastLocal || 0) > 60) { run.lastLocal = run.judged; setPressure(localPressure(buffer)); }
        break;
      }
      case 'pressure':
        run.gotPressure = true; run.byItem = ev.by_item; setPressure(ev.by_item);
        break;
      case 'done':
        finish(ev);
        break;
    }
  }

  function finish(d) {
    if (!run || run.done) return;
    run.done = true;
    es?.close(); es = null;
    const secs = d?.seconds ?? (performance.now() - run.t0) / 1000;
    const res = { total_judged: d?.total_judged ?? run.judged, judgments: d?.judgments ?? run.judgments, seconds: secs, cost_usd: d?.cost_usd ?? K.cost.t };
    timeEl.textContent = secs.toFixed(1);
    setK('head', res.total_judged); setK('judg', res.judgments); setK('cost', res.cost_usd); setK('cont', isNum(d?.containers_peak) ? d.containers_peak : 0);
    if (isNum(d?.judgments_per_s)) setK('jps', d.judgments_per_s);
    if (isNum(d?.jev_calls)) $('#j-calls').textContent = fmtInt(d.jev_calls);
    $('#nh-thru-sub').textContent = isNum(d?.containers_peak) ? `peak ${d.containers_peak} containers` : 'judgments / s';
    drawSpark(true);
    const byItem = run.byItem || localPressure(buffer);
    setPressure(byItem);
    bannerDone(res, byItem);
    page.classList.remove('live');
    scanBtn.classList.remove('running');
    scanBtn.querySelector('span').textContent = 'Scan again';
  }

  /* ---------- sources: live SSE -> replay SSE ---------- */
  function startScan(mode) {
    if (run && !run.done) return;
    es?.close();
    run = { t0: performance.now(), mode, judged: 0, judgments: 0, calls: 0, contSum: 0, contN: 0, win: [], fetched: 0, target: 0 };
    spark = []; drawSpark(true);
    $('#nh-spark-hint')?.remove();
    buffer = []; queue = []; lastPressure = {};
    // keep the idle headlines on screen: fresh verdicts push them down as they arrive
    for (const k of ['head', 'judg', 'jps', 'cont', 'cost']) { K[k].t = 0; K[k].v = 0.0001; }
    $('#j-calls').textContent = '0'; $('#j-lat').textContent = '–';
    $('#nh-thru-sub').textContent = 'judgments / s';
    page.classList.add('live');
    scanBtn.classList.add('running');
    scanBtn.querySelector('span').textContent = 'Scanning…';
    bannerRun();
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
    banner.className = 'nh-banner';
    banner.innerHTML = `${icon('wifi-off', { size: 16 })}<span>News scan is unavailable right now. Showing the latest judged headlines.</span>`;
    if (!buffer.length) loadIdle(true);
  }

  /* ---------- idle: latest judged headlines ---------- */
  async function loadIdle(force = false) {
    const d = await api('/api/news/latest?limit=300&module=all');
    let items = d?.items || [];
    const totals = d?.totals;
    if (!alive || (run && !force)) return;
    items = items.map(it => ({ ...it, module_id: it.module_id || ITEM_MOD[it.item_id] }));
    buffer = items.slice(0, KEEP);
    rebuild();
    setK('head', totals?.headlines); setK('judg', totals?.judgments);
    const allTime = Object.assign({}, ...Object.values(d?.by_module || {}).map(m => m?.item_pressure || {}));
    setPressure(Object.keys(allTime).length ? allTime : localPressure(items), false);
    bannerIdle(totals);
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
    const c = e.target.closest('.chip');
    if (c) {
      filter = c.dataset.m;
      page.querySelectorAll('#nh-chips .chip').forEach(x => x.classList.toggle('on', x === c));
      rebuild();
    } else if (e.target.closest('#nh-moving')) {
      movingOnly = !movingOnly;
      $('#nh-moving').classList.toggle('on', movingOnly);
      rebuild();
    }
  });

  bannerIdle(null);
  raf = requestAnimationFrame(frame);
  loadIdle();

  return () => {
    alive = false;
    es?.close();
    clearTimeout(run?.timer);
    cancelAnimationFrame(raf);
    ro?.disconnect();
    chart?.dispose();
    hideTip();
  };
}
