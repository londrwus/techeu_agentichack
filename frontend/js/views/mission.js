import { api, allModules, MODULE_META, esc, fmt, isNum, tint, countUp, icons } from '../lib.js';
import { scan, onScan, startScan, stopScan, MAX_CONTAINERS } from '../scan.js';
import { wireBriefing } from './common.js';
import { showTip, hideTip } from '../lib.js';
import { tipHtml, fmtMonth } from '../components/chartTheme.js';
import { shortRegion } from '../components/ui.js';

function gpuShort(model) {
  const m = String(model || '').match(/(B200|H200|H100|A100|A10G|L40S|L4|T4)/i);
  if (m) return m[1].toUpperCase();
  if (/timesfm/i.test(model || '')) return 'TimesFM';
  return model ? String(model).split(' ')[0] : 'GPU';
}
function gpuFamily(model) {
  const s = String(model || '').replace(/\s*(on|·)?\s*(NVIDIA\s*)?(B200|H200|H100|A100|A10G|L40S|L4|T4).*$/i, '').trim();
  return s || 'Forecast';
}
function ensureCss() {
  if (document.getElementById('views-misc-css')) return;
  document.head.appendChild(Object.assign(document.createElement('link'), { id: 'views-misc-css', rel: 'stylesheet', href: '/static/css/views_misc.css' }));
}

const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export async function render(page, arg) {
  ensureCss();
  page.innerHTML = `
  <header class="topbar">
    <div><div class="title-row"><h1>Mission Control</h1><span id="mc-pill"></span></div>
      <div class="tagline">Every satellite tile, every headline, re-judged in under a minute.</div></div>
    <div class="actions" id="mc-actions"></div>
  </header>
  <section class="counter-row">
    ${counter('c1', 'boxes', '', 'Modal containers', 'Parallel containers on Modal')}
    ${counter('c2', 'image', '', 'Tiles processed', 'Sentinel-2 satellite tiles')}
    ${counter('c3', 'gavel', '', 'Jev judgments / sec', 'Typed judgments by TypeSafe Jev')}
    ${counter('c4', 'cpu', '', 'Forecast model', 'on Modal')}
  </section>
  <section class="mc-row">
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">Sentinel-2 tiles, arriving live</div><div class="card-sub" id="tiles-sub">16 regions · fanned out on Modal</div></div>
        <div class="pct" id="pct">–</div>
      </div>
      <div class="progress"><i id="prog"></i></div>
      <div class="tile-grid" id="grid"></div>
    </div>
    <div class="side">
      <div class="card" style="padding:20px">
        <div class="prov-title">Gemini sees · Jev judges · Modal scales</div>
        <div class="prov"><div class="lg"><i data-lucide="server"></i></div><div><div class="nm">Modal</div><div class="rl" id="pv-modal-r">CPU fan-out + GPU forecast</div></div><div class="st" id="pv-modal">–</div></div>
        <div class="prov"><div class="lg"><i data-lucide="eye"></i></div><div><div class="nm">Google Gemini</div><div class="rl">3.8-flash · vision + TTS</div></div><div class="st" id="pv-gem">–</div></div>
        <div class="prov"><div class="lg"><i data-lucide="scale"></i></div><div><div class="nm">TypeSafe Jev</div><div class="rl">jev-latest · typed judgments</div></div><div class="st" id="pv-jev">–</div></div>
      </div>
      <div class="card" style="padding:20px;flex:1">
        <div class="card-head"><div style="font-size:15px;font-weight:700">Jev judgments / sec</div><div style="font-size:13px;color:var(--text-3)" id="peak">peak –</div></div>
        <div class="tput-sum" id="tput-sum"></div><div class="tput-wrap"><div class="tput" id="tput">${Array.from({ length: 30 }, () => '<i></i>').join('')}</div><div class="tput-empty" id="tput-empty">Live throughput appears here during a scan</div></div>
      </div>
    </div>
  </section>`;
  icons();

  let stats = await api('/api/stats', { fresh: true }) || {};
  const mods = await allModules();
  // Last recorded scan: shown before any live scan so the throughput card never looks empty.
  const lastScan = await api('/api/scan/last').catch(() => null);
  // Tight window around the burst (2 s either side) so the bars read as a chart, not three hairlines.
  const ghost = (() => { const j = lastScan?.jps || []; const a = j.findIndex(v => v > 0); if (a < 0) return []; let b = j.length - 1; while (b > a && !(j[b] > 0)) b--; return j.slice(Math.max(0, a - 2), Math.min(j.length, b + 3)).slice(0, 30); })();
  const regionName = {}, regionMod = {};
  const idleTiles = [];
  mods.forEach(m => (m.regions || []).forEach(r => {
    regionName[r.region_id] = shortRegion(r);
    regionMod[r.region_id] = m.module?.id;
    const last = (r.series || []).filter(s => s.thumb).pop();
    if (last) idleTiles.push({ region_id: r.region_id, thumb: last.thumb, module_id: m.module?.id });
  }));

  // ---------- tile grid (keyed updates, no flicker) ----------
  const grid = page.querySelector('#grid');
  let cells = [];
  const ensureCells = n => {
    const cols = n <= 16 ? 6 : n <= 24 ? 8 : n <= 60 ? 10 : 16;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    while (cells.length < n) { const c = document.createElement('div'); c.className = 'tile'; grid.appendChild(c); cells.push(c); }
    while (cells.length > n) cells.pop().remove();
  };
  const setCell = (c, state, ev) => {
    const key = state === 'done' || state === 'stale' ? `${state}:${ev.thumb || ev.region_id}` : state;
    if (c.dataset.key === key) return;
    c.dataset.key = key;
    c.className = 'tile ' + (state === 'proc' ? 'proc' : state === 'done' ? 'done' : state === 'stale' ? 'done stale' : '');
    if (state === 'proc') c.innerHTML = `<i data-lucide="loader"></i>`;
    else if (state === 'done' || state === 'stale') {
      const col = MODULE_META[ev.module_id || regionMod[ev.region_id]]?.color || '#A8A29E';
      const tm = /(\d{4}-\d{2})\.png$/.exec(ev.thumb || '')?.[1] || ev.month || '';
      c.innerHTML = ev.thumb ? `<img src="/${esc(ev.thumb)}" alt="${esc(regionName[ev.region_id] || '')}" data-sat-region="${esc(ev.region_id || '')}" data-sat-month="${esc(tm)}" title="${esc(regionName[ev.region_id] || ev.region_id || '')}${tm ? ' · ' + fmtMonth(tm) : ''}" onerror="this.remove()"><span class="lab">${esc(regionName[ev.region_id] || ev.region_id || '')}</span>`
        : `<span class="lab" style="color:var(--text-2);text-shadow:none">${esc(regionName[ev.region_id] || ev.region_id || 'tile')}</span>`;
      c.style.boxShadow = `inset 0 -3px 0 ${col}`;
    } else { c.innerHTML = ''; c.style.boxShadow = ''; }
    if (state === 'proc') icons();
  };

  const counters = {};
  const setCounter = (id, v, suffix) => {
    const el = page.querySelector(`#${id} .cv`), sx = page.querySelector(`#${id} small`);
    if (typeof v === 'string') { el.textContent = v; el.dataset.v = 0; }
    else if (counters[id] !== v) { countUp(el, v, { dur: 600 }); }
    counters[id] = v;
    if (sx) sx.textContent = suffix || '';
  };

  let lastRunning = null;
  const draw = () => {
    const l = scan.last || {};
    const live = scan.running;
    // header
    if (lastRunning !== live) {
      lastRunning = live;
      page.querySelector('#mc-actions').innerHTML = (live ? `<button class="btn" id="stop"><i data-lucide="square"></i>Stop</button>` : `<button class="btn" id="brief"></button>`)
        + (live ? `<button class="btn primary running"><i data-lucide="loader" class="spin"></i>Scanning…</button>` : `<button class="btn primary" id="go"><i data-lucide="satellite-dish"></i>Scan now</button>`);
      page.querySelector('#stop')?.addEventListener('click', stopScan);
      page.querySelector('#go')?.addEventListener('click', () => startScan());
      wireBriefing(page.querySelector('#brief'));
      icons();
    }
    const pill = page.querySelector('#mc-pill');
    pill.innerHTML = live ? `<span class="pill live-red">LIVE · scan running ${mmss(scan.elapsed)}${l.replay ? ' · replay' : ''}</span>`
      : scan.finished ? `<span class="pill down"><i data-lucide="check"></i>Scan complete · ${mmss(scan.elapsed)}</span>`
      : `<span class="pill live">Ready · Modal standing by</span>`;
    if (!live) icons();

    // counters
    const active = Math.min(MAX_CONTAINERS, l.containers_active || 0);
    const jps = scan.jevHistory.length ? scan.jevHistory[scan.jevHistory.length - 1] : 0;
    const gpu = l.gpu_model || stats.gpu_model;
    if (live || scan.finished) {
      setCounter('c1', live ? active : scan.peakContainers, live ? `/ ${MAX_CONTAINERS}` : 'peak');
      setCounter('c2', l.tiles_done || 0, `/ ${fmt(l.tiles_total || 0)}`);
      setCounter('c3', live ? jps : scan.peakJps, live ? '' : 'peak');
    } else {
      setCounter('c1', Math.min(MAX_CONTAINERS, stats.modal_containers_peak || 0), 'peak');
      setCounter('c2', stats.tiles_processed_total ?? stats.tiles_processed ?? 0, 'total');
      if (lastScan?.peak_jps) setCounter('c3', lastScan.peak_jps, 'last scan'); else setCounter('c3', '–', 'press Scan now');
    }
    setCounter('c4', gpuShort(gpu), '');
    const gt = stats.gpu_type ? String(stats.gpu_type).replace(/\s*\(.*\)/, '') : null;
    page.querySelector('#c4 .cap').textContent = /timesfm/i.test(gpu || '') ? `TimesFM 3.0 · ${(gt || 'GPU').replace(/^NVIDIA\s+/i, '')} GPU on Modal` : `${gpuFamily(gpu)} on Modal`;

    // progress + grid
    const total = live || scan.finished ? (l.tiles_total || 0) : idleTiles.length;
    const done = live || scan.finished ? (l.tiles_done || 0) : idleTiles.length;
    const p = total ? Math.round((done / total) * 100) : 0;
    page.querySelector('#pct').textContent = total ? p + '%' : '–';
    page.querySelector('#prog').style.width = p + '%';
    page.querySelector('#tiles-sub').textContent = live || scan.finished
      ? `${fmt(total)} tiles · fanned out on up to 75 Modal containers${l.month ? ' · ' + l.month : ''}`
      : `${idleTiles.length || 16} regions · last scan · press Scan now`;
    if (live || scan.finished) {
      const cap = Math.min(45, Math.max(total, scan.tiles.length, 16));
      ensureCells(cap);
      const shown = scan.tiles.slice(-cap);
      const remaining = Math.max(0, total - done);
      const proc = live ? Math.min(remaining, Math.max(1, Math.min(active, 6)), cap - shown.length) : 0;
      cells.forEach((c, i) => {
        if (i < shown.length) setCell(c, 'done', shown[i]);
        else if (i < shown.length + proc) setCell(c, 'proc');
        else setCell(c, 'pending');
      });
    } else {
      ensureCells(Math.max(idleTiles.length, 16));
      cells.forEach((c, i) => (idleTiles[i] ? setCell(c, 'stale', idleTiles[i]) : setCell(c, 'pending')));
    }

    // providers
    const jevTotal = (stats.jev_judgments_total ?? stats.jev_judgments ?? 0) + (live ? (l.jev_judgments || 0) : 0);
    page.querySelector('#pv-modal').textContent = live ? `${active} live` : `peak ${fmt(Math.min(MAX_CONTAINERS, Math.max(stats.modal_containers_peak || 0, scan.peakContainers)))}`;
    page.querySelector('#pv-modal-r').textContent = (/timesfm/i.test(gpu || '') ? 'CPU fan-out + TimesFM 3.0' : `CPU fan-out + ${gpuShort(gpu)} GPU`);
    page.querySelector('#pv-gem').textContent = `${fmt(stats.gemini_calls_total ?? stats.gemini_calls ?? 0)} calls`;
    page.querySelector('#pv-jev').textContent = `${fmt(jevTotal)} judged`;

    // throughput
    const hist = scan.jevHistory.slice(-30);
    const useGhost = !live && !scan.finished && ghost.length && !hist.some(v => v > 0);
    const pad = useGhost ? ghost : Array(30 - hist.length).fill(0).concat(hist);
    const max = Math.max(10, ...pad);
    page.querySelector('#tput').classList.toggle('ghost', !!useGhost);
    page.querySelectorAll('#tput i').forEach((b, i) => {
      b.hidden = i >= pad.length;
      b.style.height = Math.max(2, ((pad[i] || 0) / max) * 100) + '%';
      b.dataset.v = useGhost && pad[i] > 0 ? fmt(pad[i]) : '';
      b.dataset.t = useGhost ? `${i + 1}s` : '';
    });
    const sum = page.querySelector('#tput-sum');
    const nowJ = hist.length ? hist[hist.length - 1] : 0;
    sum.innerHTML = useGhost
      ? `<b>${fmt(lastScan.peak_jps)}</b><span>/s peak · ${fmt(lastScan.jev_judgments)} judgments on ${fmt(lastScan.tiles)} tiles in ${Math.round(lastScan.elapsed_s || 0)} s</span>`
      : live || scan.finished ? `<b>${fmt(live ? nowJ : scan.peakJps)}</b><span>/s ${live ? 'now' : 'peak'} · peak ${fmt(scan.peakJps)}/s</span>` : '';
    page.querySelector('#peak').textContent = useGhost ? `last scan · peak ${fmt(lastScan.peak_jps)}/s` : `peak ${fmt(scan.peakJps)}/s`;
    const empty = page.querySelector('#tput-empty');
    empty.hidden = hist.some(v => v > 0) || !!useGhost;
    empty.textContent = useGhost ? 'Last scan shown · press Scan now to stream live' : 'Live throughput appears here during a scan';
    empty.classList.toggle('ghost', !!useGhost);
  };

  // throughput bar tooltips: seconds ago + judgments/sec
  const tput = page.querySelector('#tput');
  tput.addEventListener('mousemove', e => {
    const bars = [...tput.children], i = bars.indexOf(e.target);
    if (i < 0) { hideTip(); return; }
    const hist = scan.jevHistory.slice(-30), isGhost = tput.classList.contains('ghost');
    const pad = isGhost ? ghost : Array(30 - hist.length).fill(null).concat(hist), v = pad[i];
    const ago = 29 - i;
    if (isGhost) {
      showTip(tipHtml({ title: `Last scan · second ${i + 1}`, tag: 'Recorded',
        rows: [{ color: '#C7D2FE', label: 'Jev judgments / sec', value: fmt(v) }],
        note: `${fmt(lastScan.jev_judgments)} judgments · ${fmt(lastScan.tiles)} tiles in ${Math.round(lastScan.elapsed_s || 0)}s` }), e.clientX, e.clientY);
      return;
    }
    showTip(tipHtml({ title: ago ? `${ago}s ago` : 'Now', tag: scan.running ? 'Live' : '',
      rows: [{ color: i === 29 ? 'var(--accent)' : '#C7D2FE', label: 'Jev judgments / sec', value: v == null ? 'no data' : fmt(v) }],
      note: v == null ? 'Press Scan now to stream live judgments.' : `Peak this scan: ${fmt(scan.peakJps)}/s` }), e.clientX, e.clientY);
  });
  tput.addEventListener('mouseleave', hideTip);

  draw();
  if ((arg === 'scan' || arg === 'replay') && !scan.running) startScan(arg === 'replay' ? 'replay' : 'auto');
  const off = onScan(draw);
  const poll = setInterval(async () => { stats = (await api('/api/stats', { fresh: true })) || stats; if (!scan.running) draw(); }, 4000);
  return () => { off(); clearInterval(poll); hideTip(); };
}

function counter(id, icon, color, label, src) {
  return `<div class="card counter" id="${id}">
    <div class="counter-head"><i data-lucide="${icon}"></i>${label}</div>
    <div class="v"><span class="cv">–</span><small></small></div>
    <div class="cap">${src}</div></div>`;
}
