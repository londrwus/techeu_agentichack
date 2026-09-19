// Live scan controller shared by every page: SSE /api/scan -> state -> listeners.
import { toast, fmt } from './lib.js';

export const scan = {
  running: false, events: 0, tiles: [], last: null, t0: 0, elapsed: 0,
  jevHistory: [], peakJps: 0, peakContainers: 0, finished: false,
  listeners: new Set(),
};
let es = null, jpsTimer = null, lastJev = 0;
export const MAX_CONTAINERS = 100; // Modal account limit (process_tile 75 + judge 20 + fetch 5)

function emit() { scan.listeners.forEach(fn => { try { fn(scan); } catch (e) { console.warn(e); } }); }
export function onScan(fn) { scan.listeners.add(fn); return () => scan.listeners.delete(fn); }

export function startScan(mode = 'auto') {
  if (scan.running) return;
  Object.assign(scan, { running: true, events: 0, tiles: [], last: null, t0: performance.now(), elapsed: 0,
    jevHistory: [], peakJps: 0, peakContainers: 0, finished: false });
  lastJev = 0;
  document.getElementById('nav-scan-dot')?.removeAttribute('hidden');
  let got = false;
  try { es = new EventSource(`/api/scan${mode === 'replay' ? '?mode=replay' : ''}`); } catch (e) { console.warn(e); return finish(); }
  es.onmessage = m => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    got = true; scan.events++; scan.last = ev;
    scan.peakContainers = Math.min(MAX_CONTAINERS, Math.max(scan.peakContainers, ev.containers_active || 0));
    if (ev.kind === 'tile' || (ev.type === 'progress' && ev.thumb)) scan.tiles.push(ev);
    emit();
    if (ev.type === 'done') finish();
  };
  es.onerror = () => {
    console.warn('[scan] stream error');
    if (!got && mode !== 'replay') { closeES(); scan.running = false; return startScan('replay'); }
    finish();
  };
  jpsTimer = setInterval(() => {
    scan.elapsed = (performance.now() - scan.t0) / 1000;
    const j = scan.last?.jev_judgments || 0;
    const rate = Math.max(0, j - lastJev); lastJev = j;
    scan.jevHistory.push(rate); if (scan.jevHistory.length > 30) scan.jevHistory.shift();
    scan.peakJps = Math.max(scan.peakJps, rate);
    emit();
  }, 1000);
  emit();
}

function closeES() { try { es?.close(); } catch {} es = null; clearInterval(jpsTimer); }

function finish() {
  if (!scan.running) return;
  closeES();
  scan.running = false; scan.finished = true;
  scan.elapsed = (performance.now() - scan.t0) / 1000;
  document.getElementById('nav-scan-dot')?.setAttribute('hidden', '');
  const l = scan.last || {};
  toast(`<i data-lucide="check-circle-2"></i> Scan complete · ${fmt(l.tiles_done)} tiles · ${fmt(l.jev_judgments)} Jev judgments · ${scan.elapsed.toFixed(0)}s <a href="#/overview">Back to Overview →</a>`);
  emit();
}

export function stopScan() {
  if (!scan.running) return;
  closeES(); scan.running = false; scan.finished = true;
  document.getElementById('nav-scan-dot')?.setAttribute('hidden', '');
  emit();
}

/** "Scan now" from any page: jump to Mission Control and start. */
export function scanNow() {
  location.hash = '#/mission';
  startScan();
}
