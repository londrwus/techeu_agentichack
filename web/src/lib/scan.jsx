// Live scan controller shared by every page: SSE /api/scan -> store -> React.
// Ported from frontend/js/scan.js; the listener Set is now an external store that
// components subscribe to with useScan().
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { fmt } from './format.js';

export const MAX_CONTAINERS = 100; // Modal account limit (process_tile 75 + judge 20 + fetch 5)

const EMPTY = {
  running: false, events: 0, tiles: [], last: null, t0: 0, elapsed: 0,
  jevHistory: [], peakJps: 0, peakContainers: 0, finished: false,
};

let state = { ...EMPTY };
const listeners = new Set();
let es = null, jpsTimer = null, lastJev = 0;

/** Mutable-free snapshot for useSyncExternalStore. */
export const getScan = () => state;
function set(patch) { state = { ...state, ...patch }; listeners.forEach(fn => { try { fn(state); } catch (e) { console.warn(e); } }); }

export function onScan(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const subscribe = fn => onScan(fn);

/** Live scan state inside a component. */
export const useScan = () => useSyncExternalStore(subscribe, getScan, getScan);

export function startScan(mode = 'auto') {
  if (state.running) return;
  set({ ...EMPTY, running: true, t0: performance.now() });
  lastJev = 0;
  let got = false;
  try { es = new EventSource(`/api/scan${mode === 'replay' ? '?mode=replay' : ''}`); } catch (e) { console.warn(e); return finish(); }
  es.onmessage = m => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    got = true;
    const tiles = (ev.kind === 'tile' || (ev.type === 'progress' && ev.thumb)) ? [...state.tiles, ev] : state.tiles;
    set({
      events: state.events + 1, last: ev, tiles,
      peakContainers: Math.min(MAX_CONTAINERS, Math.max(state.peakContainers, ev.containers_active || 0)),
    });
    if (ev.type === 'done') finish();
  };
  es.onerror = () => {
    console.warn('[scan] stream error');
    if (!got && mode !== 'replay') { closeES(); set({ running: false }); return startScan('replay'); }
    finish();
  };
  jpsTimer = setInterval(() => {
    const j = state.last?.jev_judgments || 0;
    const rate = Math.max(0, j - lastJev); lastJev = j;
    const jevHistory = [...state.jevHistory, rate].slice(-30);
    set({ elapsed: (performance.now() - state.t0) / 1000, jevHistory, peakJps: Math.max(state.peakJps, rate) });
  }, 1000);
}

function closeES() { try { es?.close(); } catch { /* ignore */ } es = null; clearInterval(jpsTimer); }

function finish() {
  if (!state.running) return;
  closeES();
  const elapsed = (performance.now() - state.t0) / 1000;
  set({ running: false, finished: true, elapsed });
  const l = state.last || {};
  toast.custom(() => (
    <div className="toast">
      <span>Scan complete · {fmt(l.tiles_done)} tiles · {fmt(l.jev_judgments)} Jev judgments · {elapsed.toFixed(0)}s</span>
      <a href="#/overview">Back to Overview →</a>
    </div>
  ), { duration: 6000 });
}

export function stopScan() {
  if (!state.running) return;
  closeES();
  set({ running: false, finished: true });
}

/** "Scan now" from any page: jump to Mission Control and start. */
export function scanNow() {
  location.hash = '#/mission';
  startScan();
}
