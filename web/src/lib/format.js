// Formatting + small data helpers, ported 1:1 from the vanilla frontend/js/lib.js.
export const isNum = v => typeof v === 'number' && isFinite(v);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

/** £ formatting: £4.40, £1,790; compact → £1.8k. Non-£ units print the number with the unit suffix. */
export function fmtGBP(v, { compact = false, unit = '£', digits } = {}) {
  if (!isNum(v)) return '–';
  if (unit && unit !== '£') return `${v >= 100 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(digits ?? 2)}${unit.startsWith('/') ? unit : ' ' + unit}`;
  if (compact && Math.abs(v) >= 1000) return '£' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (Math.abs(v) >= 1000) return '£' + Math.round(v).toLocaleString('en-GB');
  return '£' + v.toFixed(digits ?? 2);
}

export const deltaClass = v => (v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat');
export const deltaIconName = v => (v > 0.05 ? 'trending-up' : v < -0.05 ? 'trending-down' : 'minus');
export const arrowIconName = v => (v > 0.05 ? 'arrow-up-right' : v < -0.05 ? 'arrow-down-right' : 'arrow-right');

export function agoText(iso) {
  if (!iso) return 'Live';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s) || s < 0) return 'Updated just now';
  if (s < 90) return 'Updated just now';
  if (s < 3600) return `Updated ${Math.round(s / 60)} mins ago`;
  if (s < 86400 * 2) return `Updated ${Math.round(s / 3600)} h ago`;
  return `Updated ${Math.round(s / 86400)} days ago`;
}

const COMMODITY_WORDS = /\b(coffee|arabica|robusta|cocoa|olives?|olive oil|oranges?|wheat|hops|vines?|vineyards?|grapes?|citrus|groves?|belt|farms?|fields?|estates?|plantations?|reservoir|fabs?|science park|park|port)\b/gi;
/** "Sul de Minas coffee, Brazil" → "Sul de Minas". */
export function shortRegion(nameOrRegion) {
  const n = typeof nameOrRegion === 'string' ? nameOrRegion : (nameOrRegion?.name || nameOrRegion?.region_id || '');
  const s = n.split(',')[0].replace(/\(.*?\)/g, '').replace(/^port of\s+/i, '').replace(COMMODITY_WORDS, '').replace(/\s{2,}/g, ' ').trim();
  return s || n.split(',')[0];
}

/** Jev risk 0..1 from a region judgment: P(high)+P(severe)+½P(medium) from probs, else a 0..1 score. */
export function riskOf(j) {
  const hr = j?.harvest_risk || j?.risk;
  if (!hr) return null;
  const p = hr.probs;
  if (p && Object.keys(p).length) return Math.min(1, (p.high || 0) + (p.severe || 0) + 0.5 * (p.medium || 0));
  return isNum(hr.score) && hr.score <= 1 ? hr.score : null;
}

/** Latest month (YYYY-MM) of a region's satellite series. */
export function latestMonth(region) {
  const s = region?.series || [];
  for (let i = s.length - 1; i >= 0; i--) if (s[i]?.thumb || s[i]?.month) return s[i].month;
  return null;
}
export function tileUrl(regionId, month) { return month ? `/tiles/${regionId}/${month}.png` : null; }

/** Retail price path for an item: history/forecast rescaled so the last history point = retail_now. */
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
  // Labels from modal_app/signals.py: strongly_down | down | unchanged | up | strongly_up
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

/** Turn raw model decimals in AI prose into plain words. */
export function plainAI(text) {
  const word = v => (v >= 0.5 ? 'strongly rising' : v >= 0.2 ? 'rising' : v > 0.02 ? 'slightly rising' : v >= -0.02 ? 'flat' : v > -0.2 ? 'slightly easing' : 'easing');
  return String(text || '').replace(/(supply pressure)\s*(?:at|of|is|=)?\s*(-?\d*\.\d+)/gi, (_, w, n) => `${w} ${word(+n)}`);
}
