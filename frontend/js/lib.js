// Shared helpers: fetch with cache, DOM, formatting, count-up, icons, tooltip.
const cache = new Map();

export async function api(path, { fresh = false } = {}) {
  if (!fresh && cache.has(path)) return cache.get(path);
  const p = fetch(path).then(r => (r.ok ? r.json() : null)).catch(e => { console.warn('[api]', path, e); return null; });
  cache.set(path, p);
  const v = await p;
  if (v == null) cache.delete(path);
  return v;
}

export const MODULE_IDS = ['groceries', 'latte', 'beer_wine', 'gpu'];
export const MODULE_META = {
  groceries: { name: 'Groceries', emoji: '🛒', color: '#F97316', icon: 'shopping-cart' },
  latte: { name: 'Latte Index', emoji: '☕', color: '#A16207', icon: 'coffee' },
  beer_wine: { name: 'Beer & Wine', emoji: '🍺', color: '#EAB308', icon: 'beer' },
  gpu: { name: 'GPU & Gadgets', emoji: '🖥️', color: '#6366F1', icon: 'cpu' },
  rent: { name: 'Rent Radar', emoji: '🏠', color: '#10B981', icon: 'building-2' },
};
export const ITEM_META = {
  chocolate: { short: 'Choc', emoji: '🍫' }, olive_oil: { short: 'Olive oil', emoji: '🫒' },
  orange_juice: { short: 'OJ', emoji: '🍊' }, bread: { short: 'Bread', emoji: '🍞' },
  latte: { short: 'Latte', emoji: '☕' }, pint: { short: 'Pint', emoji: '🍺' },
  wine: { short: 'Wine', emoji: '🍷' }, gpu: { short: 'GPU', emoji: '🖥️' },
  laptop: { short: 'Laptop', emoji: '💻' }, rent_1bed: { short: 'Rent', emoji: '🏠' },
};
// region -> {item, signal} (mirrors orbit/config.py REGIONS)
export const REGION_META = {
  jaen_olives: ['olive_oil', 'crop'], soubre_cocoa: ['chocolate', 'crop'], ashanti_cocoa: ['chocolate', 'crop'],
  saopaulo_oranges: ['orange_juice', 'crop'], poltava_wheat: ['bread', 'crop'], minas_coffee: ['latte', 'crop'],
  daklak_coffee: ['latte', 'crop'], huila_coffee: ['latte', 'crop'], hallertau_hops: ['pint', 'crop'],
  zatec_hops: ['pint', 'crop'], bordeaux_vines: ['wine', 'crop'], rioja_vines: ['wine', 'crop'],
  baoshan_reservoir: ['gpu', 'water'], tsengwen_reservoir: ['gpu', 'water'], hsinchu_park: ['laptop', 'built'],
  kaohsiung_port: ['laptop', 'port'],
};

/** All four product modules (cached). Missing ones are skipped. */
export async function allModules() {
  const res = await Promise.all(MODULE_IDS.map(id => api(`/api/modules/${id}`)));
  return res.filter(Boolean);
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function icons() { try { window.lucide?.createIcons(); } catch (e) { console.warn(e); } }

export const isNum = v => typeof v === 'number' && isFinite(v);
export function money(v, unit = '£') {
  if (!isNum(v)) return '–';
  if (unit !== '£') return v >= 100 ? v.toFixed(0) : v.toFixed(2);
  return '£' + (v >= 1000 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(2));
}
export function pct(v, digits = 0) {
  if (!isNum(v)) return '–';
  const s = Math.abs(v).toFixed(digits);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + s + '%';
}
export const fmt = v => (isNum(v) ? Math.round(v).toLocaleString('en-GB') : '–');
export function monthLabel(m, long = false) {
  if (!m) return '';
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1, 1);
  return d.toLocaleString('en-GB', long ? { month: 'short', year: 'numeric' } : { month: 'short' });
}
export function tint(hex, a = '22') { return (hex || '#A8A29E') + a; }

export function deltaPill(v, suffix = 'in 6 mo', digits = 0) {
  if (!isNum(v)) return '';
  const cls = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
  const ic = v > 0.05 ? 'trending-up' : v < -0.05 ? 'trending-down' : 'minus';
  return `<span class="pill ${cls}"><i data-lucide="${ic}"></i>${pct(v, digits)} ${esc(suffix)}</span>`;
}

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

const tip = () => document.getElementById('tooltip');
export function showTip(html, x, y) {
  const t = tip(); if (!t) return;
  t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, hgt = t.offsetHeight;
  t.style.left = Math.min(window.innerWidth - w - 12, x + 14) + 'px';
  t.style.top = Math.max(8, Math.min(window.innerHeight - hgt - 12, y + 14)) + 'px';
}
export function hideTip() { const t = tip(); if (t) t.hidden = true; }

let toastTimer;
export function toast(html, ms = 6000) {
  const t = document.getElementById('toast'); if (!t) return;
  t.innerHTML = html; t.hidden = false; icons();
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/** Map a commodity price to a retail price via pass-through. */
export function retailMapper(item) {
  const now = item.retail_now;
  const hist = item.history || [], fc = item.forecast || [];
  const last = hist.length ? hist[hist.length - 1].price : null;
  if (!isNum(now) || !isNum(last) || last <= 0) return null;
  let share = item.commodity_share;
  if (!isNum(share)) {
    const p = fc[Math.min(11, fc.length - 1)]?.p50, r = item.retail_12m ?? item.retail_6m;
    const pi = item.retail_12m != null ? p : fc[Math.min(5, fc.length - 1)]?.p50;
    if (isNum(pi) && isNum(r) && Math.abs(pi / last - 1) > 0.004) share = (r / now - 1) / (pi / last - 1);
  }
  if (!isNum(share) || share <= 0 || share > 1.5) share = 0.3;
  return p => (isNum(p) ? now * (1 + share * (p / last - 1)) : null);
}

/** Classify a Jev-judged headline into waffle buckets. */
export function headlineBucket(hd) {
  // Labels from modal_app/signals.py: strongly_down | down | unchanged | up | strongly_up (consumer price pressure)
  if (isNum(hd?.relevant_p) && hd.relevant_p < 0.5) return 'none';
  const lab = String(hd?.supply_effect?.label || '').toLowerCase();
  const sev = String(hd?.severity?.label || '').toLowerCase();
  if (/strongly_up|tight/.test(lab)) return /minor|low/.test(sev) ? 'tight_lo' : 'tight_hi';
  if (/^up$/.test(lab)) return /major|high|severe/.test(sev) ? 'tight_hi' : 'tight_lo';
  if (/down|loos/.test(lab)) return 'loose';
  if (isNum(hd?.price_pressure)) {
    if (hd.price_pressure > 0.5) return 'tight_hi';
    if (hd.price_pressure > 0.15) return 'tight_lo';
    if (hd.price_pressure < -0.15) return 'loose';
  }
  return 'none';
}
export const BUCKET_COLOR = { tight_hi: 'var(--up)', tight_lo: 'var(--up-light)', none: 'var(--muted)', loose: 'var(--down)' };
