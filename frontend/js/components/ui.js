// Shared UI helpers for the module screens. Re-exports the common lib helpers so views can import from one place.
import { api, esc, isNum, pct, countUp, deltaPill, monthLabel, ITEM_META, REGION_META, MODULE_META, tint } from '../lib.js';
export { api, esc, isNum, pct, countUp, deltaPill, monthLabel, ITEM_META, REGION_META, MODULE_META, tint };
import { icon, moduleIcon, itemIcon, MODULE_ICON, ITEM_ICON, UI_ICON } from './icons.js';
export { icon, moduleIcon, itemIcon, MODULE_ICON, ITEM_ICON, UI_ICON };

/** Module accents from MODULES.md (forecast line, active risk curve, sparklines). */
export const ACCENT = { groceries: '#F97316', latte: '#A16207', beer_wine: '#CA8A04', gpu: '#6366F1', rent: '#10B981' };

/** Cached GET /api/modules/{id} (null when missing). */
export const loadModule = id => api(`/api/modules/${id}`);

/** £ formatting: £4.40, £1,790; compact → £1.8k. Non-£ units print the number with the unit suffix. */
export function fmtGBP(v, { compact = false, unit = '£', digits } = {}) {
  if (!isNum(v)) return '–';
  if (unit && unit !== '£') return `${v >= 100 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(digits ?? 2)}${unit.startsWith('/') ? unit : ' ' + unit}`;
  if (compact && Math.abs(v) >= 1000) return '£' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (Math.abs(v) >= 1000) return '£' + Math.round(v).toLocaleString('en-GB');
  return '£' + v.toFixed(digits ?? 2);
}

/** Small arrow icon for a signed change (up = red, down = green in CSS). */
export const arrowIcon = (v, size = 13) => icon(v > 0.05 ? 'arrow-up-right' : v < -0.05 ? 'arrow-down-right' : 'arrow-right', { size, stroke: 2.25 });

/** Inline delta text "↗ 11.4%" coloured up (red) / down (green). */
export function deltaText(v, { digits = 1, suffix = '%' } = {}) {
  if (!isNum(v)) return '';
  const cls = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
  return `<span class="delta ${cls}">${arrowIcon(v)}${Math.abs(v).toFixed(digits)}${suffix}</span>`;
}

/** Soft pill "+17%" (up-soft/up). */
export function deltaChip(v, { digits = 0, suffix = '' } = {}) {
  if (!isNum(v)) return '';
  const cls = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
  return `<span class="dchip ${cls}">${pct(v, digits)}${suffix ? ' ' + esc(suffix) : ''}</span>`;
}

/** Card HTML. glass=true → dark glass panel (Earth/map overlays). */
export function card(inner, { cls = '', glass = false, title, sub, right = '' } = {}) {
  const head = title ? `<div class="card-head"><div><div class="card-title">${esc(title)}</div>${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}</div>${right}</div>` : '';
  return `<div class="${glass ? 'glass-panel' : 'card'} ${cls}">${head}${inner}</div>`;
}
export const glassCard = (inner, opts = {}) => card(inner, { ...opts, glass: true });

/** Latest month (YYYY-MM) of a region's satellite series. */
export function latestMonth(region) {
  const s = region?.series || [];
  for (let i = s.length - 1; i >= 0; i--) if (s[i]?.thumb || s[i]?.month) return s[i].month;
  return null;
}
/** Tile URL for region/month (month defaults to latest). */
export function tileUrl(regionId, month) { return month ? `/tiles/${regionId}/${month}.png` : null; }

/** <img> of a satellite tile that swaps to a soft placeholder when the PNG is missing.
 *  Clicking it opens the satellite lightbox (components/lightbox.js) via the data-sat-* attributes. */
export function satImg(regionId, month, { alt = '', cls = '' } = {}) {
  const src = tileUrl(regionId, month);
  if (!src) return `<div class="sat-img sat-missing ${cls}"></div>`;
  return `<img class="sat-img sat ${cls}" src="${src}" alt="${esc(alt)}" data-sat-region="${esc(regionId)}" data-sat-month="${esc(month)}" loading="lazy" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('div'),{className:'sat-img sat-missing ${cls}'}))">`;
}

const COMMODITY_WORDS = /\b(coffee|arabica|robusta|cocoa|olives?|olive oil|oranges?|wheat|hops|vines?|vineyards?|grapes?|citrus|groves?|belt|farms?|fields?|estates?|plantations?|reservoir|fabs?|science park|park|port)\b/gi;
/** "Sul de Minas coffee, Brazil" → "Sul de Minas". */
export function shortRegion(nameOrRegion) {
  const n = typeof nameOrRegion === 'string' ? nameOrRegion : (nameOrRegion?.name || nameOrRegion?.region_id || '');
  const s = n.split(',')[0].replace(/\(.*?\)/g, '').replace(/^port of\s+/i, '').replace(COMMODITY_WORDS, '').replace(/\s{2,}/g, ' ').trim();
  return s || n.split(',')[0];
}
/** Commodity word from a region name, e.g. "Coffee" / "Cocoa"; falls back to the item name. */
export function commodityOf(region) {
  const m = String(region?.name || '').match(/(coffee|arabica|robusta|cocoa|olive|orange|wheat|hops?|vine|grape|water|chip)/i);
  if (m) return m[0][0].toUpperCase() + m[0].slice(1).toLowerCase();
  const it = region?.item_id || region?.item;
  return ITEM_META[it]?.short || 'Supply';
}

/** Jev risk 0..1 from a region judgment: P(high)+P(severe)+½P(medium) from probs, else a 0..1 score. */
export function riskOf(j) {
  const hr = j?.harvest_risk || j?.risk;
  if (!hr) return null;
  const p = hr.probs;
  if (p && Object.keys(p).length) return Math.min(1, (p.high || 0) + (p.severe || 0) + 0.5 * (p.medium || 0));
  return isNum(hr.score) && hr.score <= 1 ? hr.score : null;
}

/** Count-up for every [data-count] element inside root (data-count=value, data-digits, data-prefix, data-suffix). */
export function countAll(root) {
  root.querySelectorAll('[data-count]').forEach(el => countUp(el, Number(el.dataset.count), {
    digits: Number(el.dataset.digits || 0), prefix: el.dataset.prefix || '', suffix: el.dataset.suffix || '',
  }));
}

/** Retail price path for an item: history/forecast rescaled so the last history point = retail_now.
 *  Use when an item's `history` is a commodity index but you want to show shelf prices. */
export function retailSeries(item) {
  const h = item?.history || [], f = item?.forecast || [];
  const last = h.length ? h[h.length - 1].price : null;
  if (!isNum(item?.retail_now) || !isNum(last) || last <= 0) return { history: h, forecast: f };
  const k = item.retail_now / last;
  if (Math.abs(k - 1) < 1e-6) return { history: h, forecast: f };
  return {
    history: h.map(p => ({ ...p, price: p.price * k })),
    forecast: f.map(p => ({ ...p, p10: p.p10 * k, p50: p.p50 * k, p90: p.p90 * k })),
  };
}

/** Observe size changes; returns disconnect(). */
export function onResize(el, fn) {
  if (!window.ResizeObserver) { window.addEventListener('resize', fn); return () => window.removeEventListener('resize', fn); }
  let raf = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fn); });
  ro.observe(el);
  return () => { cancelAnimationFrame(raf); ro.disconnect(); };
}
