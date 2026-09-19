import { esc } from '../lib.js';
import { scan, scanNow } from '../scan.js';

export function scanBtn() {
  return scan.running
    ? `<button class="btn primary running" data-scan><i data-lucide="loader" class="spin"></i>Scanning…</button>`
    : `<button class="btn primary" data-scan><i data-lucide="satellite-dish"></i>Scan now</button>`;
}

export function topbar({ crumb, title, iconSq, pill = '', tagline, subtitle, right = '' }) {
  return `<header class="topbar">
    <div>
      ${crumb ? `<div class="crumb">${esc(crumb)}</div>` : ''}
      <div class="title-row">${iconSq || ''}<h1>${esc(title)}</h1>${pill}${subtitle ? `<span class="subtitle">${esc(subtitle)}</span>` : ''}</div>
      ${tagline ? `<div class="tagline">${esc(tagline)}</div>` : ''}
    </div>
    <div class="actions">${right}${scanBtn()}</div>
  </header>`;
}

/** Wire every [data-scan] button in root. */
export function wireScan(root) {
  root.querySelectorAll('[data-scan]').forEach(b => b.addEventListener('click', scanNow));
}

let audio = null;
/** Play/stop the Gemini TTS briefing; updates the button label. */
export function wireBriefing(btn, label = 'Play briefing') {
  if (!btn) return;
  const idle = () => { btn.innerHTML = `<i data-lucide="play"></i>${label}`; window.lucide?.createIcons(); };
  const playing = () => { btn.innerHTML = `<i data-lucide="square"></i>Stop briefing`; window.lucide?.createIcons(); };
  if (audio && !audio.paused) playing(); else idle();
  btn.addEventListener('click', async () => {
    if (audio && !audio.paused) { audio.pause(); audio.currentTime = 0; idle(); return; }
    btn.innerHTML = `<i data-lucide="loader" class="spin"></i>Loading briefing…`; window.lucide?.createIcons();
    try {
      audio = audio || new Audio('/api/briefing');
      audio.onended = () => btn.isConnected && idle();
      audio.onerror = () => { console.warn('[briefing] unavailable'); if (btn.isConnected) { btn.innerHTML = `<i data-lucide="volume-x"></i>Briefing unavailable`; window.lucide?.createIcons(); } audio = null; };
      await audio.play();
      playing();
    } catch (e) { console.warn('[briefing]', e); idle(); }
  });
}

export function agoText(iso) {
  if (!iso) return 'Live';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s) || s < 0) return 'Updated just now';
  if (s < 90) return 'Updated just now';
  if (s < 3600) return `Updated ${Math.round(s / 60)} mins ago`;
  if (s < 86400 * 2) return `Updated ${Math.round(s / 3600)} h ago`;
  return `Updated ${Math.round(s / 86400)} days ago`;
}
