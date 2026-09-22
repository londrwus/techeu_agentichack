// Imperative DOM helpers shared by the chart/map layers: count-up, resize observer, hover tooltip.
// Ported from frontend/js/lib.js + components/ui.js. React owns the markup; these drive the bits
// that live outside React's render loop (ECharts, MapLibre overlays).
import { useEffect, useRef } from 'react';
import { isNum } from './format.js';

/** Animate el's text from its current value to `to`. */
export function countUp(el, to, { dur = 900, digits = 0, prefix = '', suffix = '' } = {}) {
  if (!el) return;
  if (!isNum(to)) { el.textContent = '–'; return; }
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    const v = from + (to - from) * e;
    el.textContent = prefix + v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + suffix;
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Element whose number counts up on mount / when `to` changes (`as` picks the tag, default <span>). */
export function CountUp({ as: Tag = 'span', to, digits = 0, prefix = '', suffix = '', dur = 900, placeholder = '–', ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!isNum(to)) { if (ref.current) ref.current.textContent = placeholder; return; }
    countUp(ref.current, to, { dur, digits, prefix, suffix });
  }, [to, digits, prefix, suffix, dur, placeholder]);
  return <Tag ref={ref} {...rest}>{placeholder}</Tag>;
}

/** Count-up for every [data-count] element inside root (data-count=value, data-digits, data-prefix, data-suffix). */
export function countAll(root) {
  root?.querySelectorAll('[data-count]').forEach(el => countUp(el, Number(el.dataset.count), {
    digits: Number(el.dataset.digits || 0), prefix: el.dataset.prefix || '', suffix: el.dataset.suffix || '',
  }));
}

/** Observe size changes; returns disconnect(). */
export function onResize(el, fn) {
  if (!window.ResizeObserver) { window.addEventListener('resize', fn); return () => window.removeEventListener('resize', fn); }
  let raf = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fn); });
  ro.observe(el);
  return () => { cancelAnimationFrame(raf); ro.disconnect(); };
}

/* ---------------- hover tooltip (the single #tooltip node App renders) ---------------- */
const tip = () => document.getElementById('tooltip');

/** Hover card at the cursor. `box` (a DOMRect, optional) keeps it inside that element. */
export function showTip(html, x, y, box = null) {
  const t = tip(); if (!t) return;
  t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, hgt = t.offsetHeight;
  const R = box ? Math.min(window.innerWidth - 12, box.right - 8) : window.innerWidth - 12;
  const B = box ? Math.min(window.innerHeight - 12, box.bottom - 8) : window.innerHeight - 12;
  const L = box ? box.left + 8 : 8, T = box ? box.top + 8 : 8;
  const left = x + 14 + w > R ? x - 14 - w : x + 14;
  const top = y + 14 + hgt > B ? y - 14 - hgt : y + 14;
  t.style.left = Math.max(L, left) + 'px';
  t.style.top = Math.max(T, top) + 'px';
}
export function hideTip() { const t = tip(); if (t) t.hidden = true; }

/** Bind showTip/hideTip to an element's pointer events (React-friendly). */
export const tipProps = (html, box = null) => ({
  onMouseMove: e => showTip(typeof html === 'function' ? html() : html, e.clientX, e.clientY, box?.()),
  onMouseLeave: hideTip,
});
