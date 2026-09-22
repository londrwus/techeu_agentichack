// News hub: Jev reads the world's commodity news live (design: frontend/NEWS_HUB.md, Pencil "10 News hub").
// Idle: latest judged headlines from /api/news/latest. "Scan the news": SSE /api/news/scan?mode=live
// (auto-fallback to mode=replay, the server's recorded scan) streams judged headlines into a firehose feed.
//
// Ported from frontend/js/views/news.js. React renders the shell, the feed rows, the pressure bars and the
// done banner; the 60 fps bits that must not re-render the tree — the counter lerp, the feed's slide-in
// offset and the FLIP re-order — stay on refs, exactly as they did before.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { graphic } from 'echarts';
import { Icon } from '@/lib/icons.jsx';
import { api } from '@/lib/api.js';
import { isNum } from '@/lib/format.js';
import { hideTip, showTip } from '@/lib/dom.jsx';
import { initChart } from '@/lib/echarts.js';
import { axisTooltip, tipHtml } from '@/lib/chartTheme.js';

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
const itIconName = id => ITEMS[id]?.[1] || 'newspaper';
const itColor = id => ITEMS[id]?.[2] || '#A8A29E';
const itMod = id => ITEMS[id]?.[3];
const COST_PER_TOKEN = 0.042e-6 * 1.25; // Jev input price + a small allowance for output

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

function localPressure(items) {
  const acc = {};
  for (const it of items) if ((it.relevant_p ?? 1) >= 0.5 && isNum(it.price_pressure)) (acc[it.item_id] ||= []).push(it.price_pressure * (it.confidence ?? 0.6));
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
}

export default function News() {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('all');
  const [movingOnly, setMovingOnly] = useState(false);
  const [sub, setSub] = useState('newest on top');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(null);
  const [pressure, setPressure] = useState({});
  const [jev, setJev] = useState({ calls: '–', lat: '–' });
  const [sparkStarted, setSparkStarted] = useState(false);

  const head = useRef(null), list = useRef(null), sparkBox = useRef(null);
  const kHead = useRef(null), kJudg = useRef(null), kJps = useRef(null), kThru = useRef(null), kCont = useRef(null), kCost = useRef(null), kTime = useRef(null), kTm = useRef(null);
  const peakEl = useRef(null), tendEl = useRef(null);

  const buffer = useRef([]);
  const queue = useRef([]);
  const offset = useRef(0);
  const lastIns = useRef(0);
  const run = useRef(null);
  const es = useRef(null);
  const sampler = useRef(0);
  const spark = useRef([]);
  const chart = useRef(null);
  const alive = useRef(true);
  const stateRef = useRef({ filter, movingOnly });
  stateRef.current = { filter, movingOnly };

  const passes = useCallback(it => {
    const { filter: f, movingOnly: mo } = stateRef.current;
    return (f === 'all' || it.module_id === f) && (!mo || isMoving(it));
  }, []);

  // .page.nh scopes the whole screen; .live is the scanning state.
  useEffect(() => {
    const page = head.current?.closest('.page');
    page?.classList.add('nh');
    return () => page?.classList.remove('nh');
  }, []);
  useEffect(() => {
    const page = head.current?.closest('.page');
    page?.classList.toggle('live', running);
  }, [running]);

  /* ---------- smooth counters: one rAF loop lerps display -> target ---------- */
  const K = useRef(null);
  if (!K.current) {
    K.current = {
      head: { v: 0, t: 0, f: fmtInt, ref: kHead }, judg: { v: 0, t: 0, f: fmtInt, ref: kJudg },
      jps: { v: 0, t: 0, f: fmtInt, ref: kJps }, thru: { v: 0, t: 0, f: fmtInt, ref: kThru },
      cont: { v: 0, t: 0, f: fmtInt, ref: kCont }, cost: { v: 0, t: 0, f: fmtCost, ref: kCost },
    };
  }
  const setK = (k, v) => { if (isNum(v)) K.current[k].t = v; };
  const setJps = v => { setK('jps', v); setK('thru', v); };

  const rebuild = useCallback(() => {
    queue.current = [];
    offset.current = 0;
    if (list.current) list.current.style.transform = '';
    setRows(buffer.current.filter(passes).slice(0, MAX_DOM).map(it => ({ it, fresh: false })));
  }, [passes]);

  useEffect(() => { rebuild(); }, [filter, movingOnly, rebuild]);

  const addItems = (items, { animate = true } = {}) => {
    buffer.current = items.slice().reverse().concat(buffer.current).slice(0, KEEP);
    if (animate) queue.current.push(...items); else rebuild();
  };

  /* ---------- throughput area chart ---------- */
  const drawSpark = useCallback(() => {
    const c = chart.current; if (!c) return;
    const last = spark.current.at(-1);
    const peak = spark.current.reduce((m, p) => Math.max(m, p[1]), 0);
    c.setOption({
      xAxis: { max: Math.max(1, last?.[0] || 0) }, yAxis: { max: Math.max(10, peak * 1.12) },
      series: [{ data: spark.current }, { data: last && spark.current.length > 1 ? [last] : [] }],
    });
    if (peakEl.current) peakEl.current.textContent = peak ? `peak ${fmtInt(peak)} / s` : '';
    if (tendEl.current) tendEl.current.textContent = last ? `${last[0].toFixed(1)} s` : '';
  }, []);

  const sample = useCallback(() => {
    const r = run.current;
    if (!r || r.done) return;
    const now = performance.now(), t = (now - r.t0) / 1000;
    r.hist.push([now, r.judgments]);
    while (r.hist.length > 2 && now - r.hist[0][0] > 1500) r.hist.shift();
    const [t0, j0] = r.hist[0];
    const rate = now - t0 > 200 ? ((r.judgments - j0) * 1000) / (now - t0) : 0;
    setJps(rate);
    spark.current.push([+t.toFixed(2), Math.round(rate)]);
    drawSpark();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawSpark]);

  /* ---------- the rAF loop: counters, elapsed, paced inserts, slide-in decay ---------- */
  useEffect(() => {
    alive.current = true;
    let raf = 0;
    const frame = () => {
      if (!alive.current) return;
      raf = requestAnimationFrame(frame);
      for (const k of Object.values(K.current)) {
        if (k.v !== k.t) {
          const d = k.t - k.v;
          k.v = Math.abs(d) < (k.f === fmtCost ? 2e-5 : 1) ? k.t : k.v + d * 0.2;
          if (k.ref.current) k.ref.current.textContent = k.f(k.v);
        }
      }
      const r = run.current;
      if (r && !r.done) {
        const s = ((performance.now() - r.t0) / 1000).toFixed(1);
        if (kTime.current) kTime.current.textContent = s;
        if (kTm.current) kTm.current.textContent = s + ' s';
      }
      // Feed: one card at a time at a readable-but-furious pace (faster when the queue backs up).
      const now = performance.now();
      const q = queue.current;
      if (q.length && now - lastIns.current > (q.length > 24 ? 60 : q.length > 8 ? 90 : 140)) {
        lastIns.current = now;
        const [it] = q.splice(0, 1);
        if (passes(it)) {
          setRows(rs => [{ it, fresh: true }, ...rs].slice(0, MAX_DOM));
          offset.current = Math.min(offset.current + ROW_H, ROW_H * 3);
        }
      }
      // React detaches refs before passive-effect cleanup, so a frame can land after unmount.
      if (list.current) {
        if (offset.current > 0.5) { offset.current *= 0.84; list.current.style.transform = `translateY(${-offset.current}px)`; }
        else if (offset.current) { offset.current = 0; list.current.style.transform = ''; }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => { alive.current = false; cancelAnimationFrame(raf); };
  }, [passes]);

  // "2 s ago" labels tick while on screen
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);

  /* ---------- the ECharts throughput spark ---------- */
  useEffect(() => {
    const c = initChart(sparkBox.current, null, { renderer: 'canvas' });
    chart.current = c;
    c.setOption({
      animation: false,
      grid: { left: 2, right: 8, top: 8, bottom: 2 },
      xAxis: { type: 'value', min: 0, max: 1, show: false },
      yAxis: { type: 'value', min: 0, show: false },
      tooltip: axisTooltip(ps => { const p = ps[0]; return tipHtml({ title: `${(+p.value[0]).toFixed(1)} s`, rows: [{ color: '#F97316', label: 'Judgments / s', value: fmtInt(p.value[1]) }] }); }),
      series: [
        { type: 'line', smooth: 0.45, symbol: 'none', data: [], lineStyle: { color: '#F97316', width: 2, cap: 'round' },
          areaStyle: { color: new graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(249,115,22,.22)' }, { offset: 1, color: 'rgba(249,115,22,.05)' }]) } },
        { type: 'effectScatter', data: [], symbolSize: 8, itemStyle: { color: '#F97316' }, rippleEffect: { scale: 2.4, brushType: 'fill', period: 1.2 }, tooltip: { show: false }, z: 5 },
      ],
    });
    const ro = window.ResizeObserver ? new ResizeObserver(() => c.resize()) : null;
    ro?.observe(sparkBox.current);
    return () => { ro?.disconnect(); c.dispose(); chart.current = null; };
  }, []);

  /* ---------- scan event handling ---------- */
  const finish = useCallback(d => {
    const r = run.current;
    if (!r || r.done) return;
    sample();
    r.done = true;
    clearInterval(sampler.current); sampler.current = 0;
    es.current?.close(); es.current = null;
    const secs = d?.seconds ?? (performance.now() - r.t0) / 1000;
    const res = { total_judged: d?.total_judged ?? r.judged, judgments: d?.judgments ?? r.judgments, seconds: secs, cost_usd: d?.cost_usd ?? K.current.cost.t };
    if (kTime.current) kTime.current.textContent = secs.toFixed(1);
    setK('head', res.total_judged); setK('judg', res.judgments); setK('cost', res.cost_usd);
    setK('cont', isNum(d?.containers_peak) ? d.containers_peak : 0);
    setJps(isNum(d?.judgments_per_s) ? d.judgments_per_s : res.judgments / Math.max(secs, 0.5));
    if (isNum(d?.jev_calls)) setJev(j => ({ ...j, calls: fmtInt(d.jev_calls) }));
    drawSpark();
    const byItem = r.byItem || localPressure(buffer.current);
    setPressure(byItem);
    setDone({ res, byItem });
    setSub(`newest on top · ${fmtInt(res.total_judged)} judged`);
    setRunning(false);
    if (kTm.current) kTm.current.textContent = '';
    // stop the slide-in shortly after: flush whatever is still queued in one go
    r.flushT = setTimeout(() => { if (alive.current && run.current === r && queue.current.length) rebuild(); }, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawSpark, rebuild, sample]);

  const onEvent = useCallback(ev => {
    const r = run.current;
    if (!alive.current || !r) return;
    switch (ev.type) {
      case 'start':
        r.started = true; r.target = ev.target || 0;
        setSub('Fetching headlines…');
        break;
      case 'fetched':
        r.fetched = ev.total_fetched || r.fetched;
        if (!r.judged) setSub(<>Fetching <b>{fmtInt(r.fetched)}</b> headlines…</>);
        break;
      case 'judged': {
        const t = performance.now();
        const items = (ev.items || []).map(it => ({ ...it, _t: t, module_id: it.module_id || itMod(it.item_id) }));
        addItems(items);
        if (queue.current.length > 48) { // firehose: show the freshest, favour price-moving news
          const mv = queue.current.filter(isMoving).slice(-40);
          const keep = new Set(mv.concat(queue.current.filter(x => !isMoving(x)).slice(-(48 - mv.length))));
          queue.current = queue.current.filter(x => keep.has(x));
        }
        r.judged = ev.total_judged ?? r.judged + items.length;
        r.judgments = ev.judgments ?? r.judgments;
        r.calls = ev.jev_calls ?? r.calls;
        r.contSum += ev.containers_active || 0; r.contN++;
        setK('head', r.judged); setK('judg', r.judgments); setK('cont', ev.containers_active);
        if (isNum(ev.tokens_in)) setK('cost', ev.tokens_in * COST_PER_TOKEN);
        const el = isNum(ev.elapsed_s) ? ev.elapsed_s : (t - r.t0) / 1000;
        const next = { calls: fmtInt(r.calls), lat: '–' };
        if (r.calls) {
          const lat = Math.max(0.15, Math.min(9.9, (el - (r.firstJudged ??= el) + 0.8) * (r.contSum / r.contN) / r.calls));
          next.lat = lat < 1 ? Math.round(lat * 1000) + ' ms' : lat.toFixed(1) + ' s';
        }
        setJev(next);
        const tot = Math.max(r.target, r.fetched, r.judged);
        setSub(<>Jev judging <b>{fmtInt(r.judged)}</b>{r.fetched ? ` / ${fmtInt(Math.max(r.fetched, r.judged))}` : tot ? ` / ${fmtInt(tot)}` : ''} · <b>{fmtInt(ev.containers_active)}</b> containers</>);
        if (!r.gotPressure && r.judged - (r.lastLocal || 0) > 60) { r.lastLocal = r.judged; setPressure(localPressure(buffer.current)); }
        break;
      }
      case 'pressure':
        if (ev.by_item && Object.keys(ev.by_item).length) { r.gotPressure = true; r.byItem = ev.by_item; setPressure(ev.by_item); }
        break;
      case 'done':
        finish(ev);
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finish]);

  const loadIdle = useCallback(async (force = false) => {
    const d = await api('/api/news/latest?limit=300&module=all');
    let items = d?.items || [];
    const totals = d?.totals;
    if (!alive.current || (run.current && !force)) return;
    items = items.map(it => ({ ...it, module_id: it.module_id || itMod(it.item_id) }));
    buffer.current = items.slice(0, KEEP);
    rebuild();
    setK('head', totals?.headlines); setK('judg', totals?.judgments);
    const allTime = Object.assign({}, ...Object.values(d?.by_module || {}).map(m => m?.item_pressure || {}));
    setPressure(Object.keys(allTime).length ? allTime : localPressure(items));
    if (!run.current) setSub('newest on top · latest judged');
  }, [rebuild]);

  const connect = useCallback(mode => {
    const myRun = run.current;
    let src;
    const fallback = () => {
      if (run.current !== myRun) return;
      if (mode === 'live') return connect('replay');
      // Both sources failed (server offline): end the run cleanly.
      finish(null);
      setDone(null);
      setSub('News scan unavailable right now · showing the latest judged headlines');
      if (!buffer.current.length) loadIdle(true);
      return undefined;
    };
    try { src = new EventSource(`/api/news/scan?mode=${mode}`); } catch { return fallback(); }
    es.current = src;
    let got = false;
    src.onmessage = m => {
      if (run.current !== myRun) return;
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      got = true; onEvent(ev);
    };
    src.onerror = () => {
      src.close();
      if (run.current !== myRun || myRun.done) return;
      if (!got) fallback();   // nothing arrived: try the next source
      else finish(null);      // stream broke mid-way: close out with what we have
    };
    return undefined;
  }, [finish, loadIdle, onEvent]);

  const startScan = mode => {
    if (run.current && !run.current.done) return;
    es.current?.close();
    clearTimeout(run.current?.flushT);
    run.current = { t0: performance.now(), mode, judged: 0, judgments: 0, calls: 0, contSum: 0, contN: 0, hist: [], fetched: 0, target: 0 };
    spark.current = [[0, 0]]; drawSpark();
    setSparkStarted(true);
    buffer.current = []; queue.current = []; setPressure({});
    // keep the idle headlines on screen: fresh verdicts push them down as they arrive
    for (const k of Object.keys(K.current)) { K.current[k].t = 0; K.current[k].v = 0.0001; }
    setJev({ calls: '0', lat: '–' });
    setDone(null);
    setSub('Connecting to Modal…');
    setRunning(true);
    if (kTm.current) kTm.current.textContent = '0.0 s';
    clearInterval(sampler.current); sampler.current = setInterval(sample, 250);
    connect(mode);
  };

  // Pre-start Modal containers (fetch + judge) so the live scan has no cold start; refreshed on hover.
  const warmT = useRef(0);
  const warm = () => { if (Date.now() - warmT.current > 60000) { warmT.current = Date.now(); fetch('/api/news/warm').catch(() => {}); } };

  useEffect(() => {
    warm();
    loadIdle();
    return () => {
      es.current?.close();
      clearTimeout(run.current?.flushT);
      clearInterval(sampler.current);
      hideTip();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <header className="topbar" ref={head}>
        <div>
          <div className="crumb">Agents  /  News hub</div>
          <div className="title-row">
            <div className="icon-sq lg nh-tile"><Icon name="newspaper" size={22} /></div>
            <h1>News hub</h1>
          </div>
          <div className="tagline">Jev reads the world&apos;s commodity news in seconds</div>
        </div>
        <div className="nh-actions">
          <button className="nh-replay" title="Replay a recorded scan" onClick={() => startScan('replay')}>
            <Icon name="rotate-ccw" size={13} />Replay
          </button>
          <div className="nh-engine"><Icon name="zap" size={16} /><b>Jev</b><span>on Modal · jev-latest</span></div>
          <button className={`btn primary nh-scan${running ? ' running' : ''}`} onMouseEnter={warm} onClick={() => startScan('live')}>
            <span className="ic">{running ? <Icon name="loader" size={18} className="spin" /> : <Icon name="radar" size={18} />}</span>
            <span className="nh-lb">{running ? 'Scanning…' : 'Scan the news'}</span>
            <span className="tm" ref={kTm} />
          </button>
        </div>
      </header>

      <section className="nh-kpis">
        <Kpi icon="newspaper" label="Headlines read" vref={kHead} init="–" />
        <Kpi icon="scale" label="Jev judgments" vref={kJudg} init="–" />
        <Kpi icon="gauge" label="Judgments / sec" vref={kJps} init="0" cls="jps" />
        <Kpi icon="server" label="Modal containers" vref={kCont} init="0" suffix=" / 100" />
        <Kpi icon="coins" label="Cost" vref={kCost} init="$0.000" />
        <Kpi icon="timer" label="Elapsed" vref={kTime} init="0.0" suffix=" s" />
      </section>

      <section className="nh-body">
        <div className="nh-feedcol">
          <div className="nh-done" hidden={!done}>{done ? <DoneBanner {...done} /> : null}</div>
          <div className="nh-feedhead">
            <div className="l"><i className="nh-dot" /><b>Live feed</b><span>{sub}</span></div>
            <button className={`nh-toggle${movingOnly ? ' on' : ''}`} onClick={() => setMovingOnly(v => !v)}>
              <i className="sw" />Only price-moving
            </button>
          </div>
          <div className="nh-chips">
            {MODS.map(([id, nm]) => (
              <button key={id} className={`nh-chip${id === filter ? ' on' : ''}`} onClick={() => setFilter(id)}>{nm}</button>
            ))}
          </div>
          <div className="nh-feed">
            <div className="nh-list" ref={list}>
              {rows.length
                ? rows.map(({ it, fresh }, i) => <Row key={it.id ?? i} it={it} fresh={fresh} newest={i === 0 && fresh} />)
                : <div className="nh-empty">No headlines match this filter yet.</div>}
            </div>
          </div>
        </div>

        <div className="nh-side">
          <PressureCard pressure={pressure} buffer={buffer} />
          <div className="card nh-thru">
            <div className="nh-thru-h">
              <div><div className="h">Throughput</div><div className="sub">Jev judgments per second</div></div>
              <div className="big"><span ref={kThru}>0</span><small> / s</small></div>
            </div>
            <div className="nh-sparkwrap">
              <div className="nh-spark" ref={sparkBox} />
              {sparkStarted ? null : <div className="nh-spark-hint">Live once you scan</div>}
            </div>
            <div className="nh-thru-ax"><span>0 s</span><span ref={peakEl} /><span ref={tendEl} /></div>
          </div>
          <div className="card nh-jev">
            <div className="h">
              <span className="t"><i className="mk"><Icon name="zap" size={13} /></i>Jev at work</span>
              <span>relevance · item · direction · severity</span>
            </div>
            <div className="nh-jevgrid">
              <div><b>4</b><span>per headline</span></div>
              <div><b>25</b><span>per batch</span></div>
              <div><b>{jev.calls}</b><span>Jev calls</span></div>
              <div><b>{jev.lat}</b><span>avg latency</span></div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function Kpi({ icon, label, vref, init, suffix = '', cls = '' }) {
  return (
    <div className={`nh-kpi ${cls}`}>
      <div className="val"><span ref={vref}>{init}</span>{suffix ? <small>{suffix}</small> : null}</div>
      <div className="lab"><Icon name={icon} size={14} />{label}</div>
    </div>
  );
}

function Row({ it, fresh, newest }) {
  const [vc, vi, vp] = verdict(it);
  const sev = String(it.severity?.label || '').toLowerCase();
  const rel = isNum(it.relevant_p) ? Math.round(it.relevant_p * 100) : null;
  const conf = isNum(it.confidence) ? Math.round(it.confidence * 100) : null;
  const major = sev === 'major' && (vc === 'up' || vc === 'down');
  const p = pressureOf(it);
  return (
    <div className={`nh-item${fresh ? ' new' : ''}${major ? ' major' : ''}${newest ? ' newest' : ''}`} style={{ '--c': itColor(it.item_id) }}>
      <div className="nh-ic"><Icon name={itIconName(it.item_id)} size={18} /></div>
      <div className="nh-txt">
        <div className="nh-title">{it.url ? <a href={it.url} target="_blank" rel="noopener noreferrer">{it.title}</a> : it.title}</div>
        <div className="nh-meta">
          {fresh ? <b className="nh-newtag">NEW</b> : null}
          <span className="nh-com">{itName(it.item_id)}</span><i>·</i>
          <span className="nh-src">{it.source || 'News'}</span>
          {it._t ? <><i>·</i><span className="nh-ago">{agoLabel(it._t)}</span></> : it.date ? <><i>·</i><span>{dateLabel(it.date)}</span></> : null}
          {conf != null ? <><i>·</i><span>conf {conf}%</span></> : null}
        </div>
      </div>
      <div className="nh-rel"><span>REL {rel ?? '–'}</span><div className="bar"><i className={rel > 80 ? 'hi' : ''} style={{ width: `${rel ?? 0}%` }} /></div></div>
      <div className="nh-sevcell">{sev ? <span className={`nh-sev ${sev}`}>{sev}</span> : null}</div>
      <div className={`nh-verdict ${vc}`} title={`Jev price pressure (−1 cheaper … +1 pricier)${vp != null ? ` · P(direction) ${Math.round(vp * 100)}%` : ''}`}>
        <Icon name={vi} size={14} strokeWidth={2.2} />
        {vc === 'none' ? '' : (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toFixed(2)}
      </div>
    </div>
  );
}

/** Pressure bars, sorted by pressure with a FLIP re-order (at most once a second, like the vanilla build). */
function PressureCard({ pressure, buffer }) {
  const box = useRef(null);
  const prevPos = useRef(new Map());
  const prevVals = useRef({});
  const first = useRef(true);
  const ids = Object.keys(ITEMS).slice().sort((a, b) => (pressure[b] ?? -9) - (pressure[a] ?? -9));

  useLayoutEffect(() => {
    const rowsEls = [...(box.current?.children || [])];
    for (const r of rowsEls) {
      const id = r.dataset.i;
      const before = prevPos.current.get(id);
      const now = r.getBoundingClientRect().top;
      if (before != null && before !== now) {
        r.style.transition = 'none';
        r.style.transform = `translateY(${before - now}px)`;
        requestAnimationFrame(() => { r.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1)'; r.style.transform = ''; });
      }
      prevPos.current.set(id, now);
      const v = pressure[id];
      if (!first.current && isNum(v) && Math.abs((prevVals.current[id] ?? 0) - v) > 0.01) {
        r.classList.remove('pulse'); void r.offsetWidth; r.classList.add('pulse');
      }
      if (isNum(v)) prevVals.current[id] = v;
    }
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pressure]);

  const tipFor = (id, e) => {
    const v = pressure[id];
    const n = buffer.current.filter(it => it.item_id === id && isMoving(it)).length;
    showTip(tipHtml({ title: itName(id), tag: 'Jev', rows: [
      { color: isNum(v) && v < 0 ? '#16A34A' : '#DC2626', label: 'Net price pressure', value: isNum(v) ? fmtSigned(v) : '–' },
      { label: 'Price-moving headlines', value: fmtInt(n) },
    ], note: isNum(v) ? (v > 0.05 ? 'News points to higher prices' : v < -0.05 ? 'News points to easing prices' : 'News is balanced') : '' }), e.clientX, e.clientY);
  };

  return (
    <div className="card nh-press">
      <div className="h">Pressure by commodity<span>Jev · live</span></div>
      <div className="nh-bars" ref={box} onMouseLeave={hideTip}>
        {ids.map(id => {
          const raw = pressure[id];
          const c = isNum(raw) ? Math.max(-1, Math.min(1, raw)) : null;
          const w = c == null ? 0 : Math.abs(c) * 50;
          const cls = c == null ? 'flat' : c > 0.03 ? 'up' : c < -0.03 ? 'down' : 'flat';
          return (
            <div className="nh-bar" data-i={id} key={id} style={{ '--c': itColor(id) }} onMouseMove={e => tipFor(id, e)}>
              <span className="ic"><Icon name={itIconName(id)} size={14} /></span>
              <span className="nm">{itName(id)}</span>
              <div className="tr">
                <i className={c == null ? '' : cls === 'flat' ? '' : cls}
                   style={c == null ? undefined : { left: `${c >= 0 ? 50 : 50 - w}%`, width: `${Math.max(w, 0.8)}%` }} />
              </div>
              <span className={`v ${cls}`}>{c == null ? '–' : fmtSigned(c)}</span>
            </div>
          );
        })}
      </div>
      <div className="nh-axis">
        <span className="dn"><Icon name="arrow-left" size={11} />cheaper</span>
        <span className="up">pricier<Icon name="arrow-right" size={11} /></span>
      </div>
    </div>
  );
}

function DoneBanner({ res, byItem }) {
  const movers = Object.entries(byItem || {}).filter(([, v]) => isNum(v)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
  const secs = +res.seconds;
  return (
    <>
      <div className="ok"><Icon name="check" size={20} strokeWidth={2.4} /></div>
      <div className="sum">
        <div className="k">Scan complete</div>
        <div className="line">
          <b>{fmtInt(res.total_judged)}</b><span>headlines</span><i className="sep" />
          <b>{fmtInt(res.judgments)}</b><span>Jev judgments</span><i className="sep" />
          <b>{secs < 20 ? secs.toFixed(1) : Math.round(secs)} s</b><i className="sep" />
          <b>{fmtCost(res.cost_usd)}</b>
        </div>
      </div>
      {movers.length ? (
        <div className="mv">
          <div className="k">Top movers</div>
          <div className="chips">
            {movers.map(([id, v]) => (
              <span className={`nh-mover ${v >= 0 ? 'up' : 'down'}`} key={id} style={{ '--c': itColor(id) }}>
                <Icon name={itIconName(id)} size={15} />
                <b>{itName(id)}</b>
                <Icon name={v >= 0 ? 'arrow-up-right' : 'arrow-down-right'} size={13} strokeWidth={2.4} />
                <em>{fmtSigned(v)}</em>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

