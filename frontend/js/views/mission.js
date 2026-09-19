import { api, allModules, MODULE_META, esc, fmt, isNum, tint, countUp, icons } from '../lib.js';
import { scan, onScan, startScan, stopScan } from '../scan.js';
import { wireBriefing } from './common.js';

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
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export async function render(page, arg) {
  page.innerHTML = `
  <header class="topbar">
    <div><div class="title-row"><h1>Mission Control</h1><span id="mc-pill"></span></div>
      <div class="tagline">Every satellite tile, every headline, re-judged in under a minute.</div></div>
    <div class="actions" id="mc-actions"></div>
  </header>
  <section class="counter-row">
    ${counter('c1', 'box', 'var(--p-modal)', 'Modal containers', 'Modal')}
    ${counter('c2', 'image', 'var(--accent)', 'Tiles processed', 'Sentinel-2')}
    ${counter('c3', 'gavel', 'var(--m-gpu)', 'Jev judgments / sec', 'TypeSafe Jev')}
    ${counter('c4', 'cpu', 'var(--ink)', 'Forecast model', 'on Modal')}
  </section>
  <section class="mc-row">
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">Sentinel-2 tiles, arriving live</div><div class="card-sub" id="tiles-sub">16 regions · one Modal container per tile</div></div>
        <div class="pct" id="pct">–</div>
      </div>
      <div class="progress"><i id="prog"></i></div>
      <div class="tile-grid" id="grid"></div>
    </div>
    <div class="side">
      <div class="card" style="padding:20px">
        <div class="prov-title">Gemini sees · Jev judges · Modal scales</div>
        <div class="prov"><div class="lg" style="background:var(--p-modal)"><i data-lucide="server"></i></div><div><div class="nm">Modal</div><div class="rl" id="pv-modal-r">CPU fan-out + GPU forecast</div></div><div class="st" style="color:var(--p-modal)" id="pv-modal">–</div></div>
        <div class="prov"><div class="lg" style="background:var(--p-gemini)"><i data-lucide="eye"></i></div><div><div class="nm">Google Gemini</div><div class="rl">3.8-flash · vision + TTS</div></div><div class="st" style="color:var(--p-gemini)" id="pv-gem">–</div></div>
        <div class="prov"><div class="lg" style="background:var(--p-jev)"><i data-lucide="scale"></i></div><div><div class="nm">TypeSafe Jev</div><div class="rl">jev-latest · typed judgments</div></div><div class="st" style="color:var(--p-jev)" id="pv-jev">–</div></div>
      </div>
      <div class="card" style="padding:20px;flex:1">
        <div class="card-head"><div style="font-size:15px;font-weight:700">Jev judgments / sec</div><div style="font-size:13px;color:var(--text-3)" id="peak">peak –</div></div>
        <div class="tput" id="tput">${Array.from({ length: 30 }, () => '<i></i>').join('')}</div>
      </div>
    </div>
  </section>`;
  icons();

  let stats = await api('/api/stats', { fresh: true }) || {};
  const mods = await allModules();
  const regionName = {}, regionMod = {};
  const idleTiles = [];
  mods.forEach(m => (m.regions || []).forEach(r => {
    regionName[r.region_id] = (r.name || r.region_id).split(',')[0].replace(/ \(.*?\)/, '');
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
      c.innerHTML = ev.thumb ? `<img src="/${esc(ev.thumb)}" alt="" onerror="this.remove()"><span class="lab">${esc(regionName[ev.region_id] || ev.region_id || '')}</span>`
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
    const active = Math.max(l.containers_active || 0, l.modal_runners || 0);
    const jps = scan.jevHistory.length ? scan.jevHistory[scan.jevHistory.length - 1] : 0;
    const gpu = l.gpu_model || stats.gpu_model;
    if (live || scan.finished) {
      setCounter('c1', live ? active : scan.peakContainers, live ? '/ 100' : 'peak');
      setCounter('c2', l.tiles_done || 0, `/ ${fmt(l.tiles_total || 0)}`);
      setCounter('c3', live ? jps : scan.peakJps, live ? '' : 'peak');
    } else {
      setCounter('c1', stats.modal_containers_peak || 0, 'peak');
      setCounter('c2', stats.tiles_processed_total ?? stats.tiles_processed ?? 0, 'total');
      setCounter('c3', 0, 'idle');
    }
    setCounter('c4', gpuShort(gpu), '');
    const gt = stats.gpu_type ? String(stats.gpu_type).replace(/\s*\(.*\)/, '') : null;
    page.querySelector('#c4 .src').lastChild.textContent = /timesfm/i.test(gpu || '') ? `TimesFM 3.0 · ${gt || 'GPU'} on Modal` : `${gpuFamily(gpu)} on Modal`;

    // progress + grid
    const total = live || scan.finished ? (l.tiles_total || 0) : idleTiles.length;
    const done = live || scan.finished ? (l.tiles_done || 0) : idleTiles.length;
    const p = total ? Math.round((done / total) * 100) : 0;
    page.querySelector('#pct').textContent = total ? p + '%' : '–';
    page.querySelector('#prog').style.width = p + '%';
    page.querySelector('#tiles-sub').textContent = live || scan.finished
      ? `${fmt(total)} tiles · one Modal container per tile${l.month ? ' · ' + l.month : ''}`
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
    page.querySelector('#pv-modal').textContent = live ? `${active} live` : `peak ${fmt(Math.max(stats.modal_containers_peak || 0, scan.peakContainers))}`;
    page.querySelector('#pv-modal-r').textContent = (/timesfm/i.test(gpu || '') ? 'CPU fan-out + TimesFM 3.0' : `CPU fan-out + ${gpuShort(gpu)} GPU`);
    page.querySelector('#pv-gem').textContent = `${fmt(stats.gemini_calls_total ?? stats.gemini_calls ?? 0)} calls`;
    page.querySelector('#pv-jev').textContent = `${fmt(jevTotal)} judged`;

    // throughput
    const hist = scan.jevHistory.slice(-30);
    const pad = Array(30 - hist.length).fill(0).concat(hist);
    const max = Math.max(10, ...pad);
    page.querySelectorAll('#tput i').forEach((b, i) => (b.style.height = Math.max(2, (pad[i] / max) * 100) + '%'));
    page.querySelector('#peak').textContent = `peak ${fmt(scan.peakJps)}`;
  };

  draw();
  if ((arg === 'scan' || arg === 'replay') && !scan.running) startScan(arg === 'replay' ? 'replay' : 'auto');
  const off = onScan(draw);
  const poll = setInterval(async () => { stats = (await api('/api/stats', { fresh: true })) || stats; if (!scan.running) draw(); }, 4000);
  return () => { off(); clearInterval(poll); };
}

function counter(id, icon, color, label, src) {
  return `<div class="card counter" id="${id}">
    <div class="counter-head"><div class="icon-sq" style="background:${color === 'var(--ink)' ? 'var(--bg)' : `color-mix(in srgb, ${color} 14%, transparent)`};color:${color}"><i data-lucide="${icon}"></i></div>${label}</div>
    <div class="v"><span class="cv">–</span><small></small></div>
    <span class="src" style="--c:${color}">${src}</span></div>`;
}
