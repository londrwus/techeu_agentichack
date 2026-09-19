// Shared ECharts hover language: every chart gets a white tooltip card + crosshair.
// Reuse in any view:
//   import { axisTooltip, itemTooltip, tipHtml, fmtMonth, fmtMoney } from '../components/chartTheme.js';
//   chart.setOption({ tooltip: axisTooltip(params => tipHtml({ title: fmtMonth(month), rows: [{ color, label: 'Price', value: fmtMoney(v) }] })), ... });
// tipHtml rows: { color, label, value, dashed?, sub? } ; note: small grey line under the rows ; tag: chip next to the title ('Forecast').

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "2027-03" -> "Mar 2027" (anything else is returned unchanged). */
export function fmtMonth(m) {
  const r = /^(\d{4})-(\d{2})/.exec(String(m || ''));
  return r ? `${MON[+r[2] - 1]} ${r[1]}` : String(m ?? '');
}
/** £4.40 · £1,790 ; non-£ units: "71.2 ¢/lb". */
export function fmtMoney(v, unit = '£') {
  if (typeof v !== 'number' || !isFinite(v)) return '–';
  if (unit && unit !== '£') return `${v >= 100 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(2)}${unit.startsWith('/') ? unit : ' ' + unit}`;
  return '£' + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(2));
}
export const fmtPct = (v, d = 1) => (typeof v === 'number' && isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%` : '–');

/** Base tooltip box (tokens: white card, 1px border, radius 12, soft shadow). */
export const TOOLTIP_BASE = {
  confine: true, enterable: false, transitionDuration: 0.15,
  backgroundColor: '#FFFFFF', borderColor: '#E7E5E4', borderWidth: 1, padding: [10, 12],
  textStyle: { color: '#1C1917', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12 },
  extraCssText: 'border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12);',
};

/** Axis tooltip with a dashed vertical crosshair (line charts, bars over time). */
export function axisTooltip(formatter, { pointer = 'line', dark = false } = {}) {
  return {
    ...TOOLTIP_BASE, ...(dark ? DARK : {}), trigger: 'axis', formatter,
    axisPointer: pointer === 'shadow'
      ? { type: 'shadow', shadowStyle: { color: 'rgba(120,113,108,.08)' } }
      : { type: 'line', snap: true, lineStyle: { color: dark ? 'rgba(255,255,255,.5)' : '#A8A29E', width: 1, type: [4, 4] }, label: { show: false } },
  };
}
/** Item tooltip (bars, dots, maps). */
export function itemTooltip(formatter, { dark = false } = {}) {
  return { ...TOOLTIP_BASE, ...(dark ? DARK : {}), trigger: 'item', formatter };
}
const DARK = {
  backgroundColor: 'rgba(10,15,44,.92)', borderColor: 'rgba(255,255,255,.14)',
  textStyle: { ...TOOLTIP_BASE.textStyle, color: '#fff' }, extraCssText: 'border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.4);backdrop-filter:blur(8px);',
};

/** Tooltip body HTML. */
export function tipHtml({ title = '', tag = '', rows = [], note = '' } = {}) {
  const head = `<div class="ct-head"><span class="ct-title">${e(title)}</span>${tag ? `<span class="ct-tag">${e(tag)}</span>` : ''}</div>`;
  const body = rows.filter(Boolean).map(r => `<div class="ct-row">${r.color ? `<i class="ct-sw${r.dashed ? ' dashed' : ''}" style="--c:${r.color}"></i>` : ''}<span class="ct-lab">${e(r.label)}</span><b class="ct-val">${r.html ?? e(r.value)}</b></div>${r.sub ? `<div class="ct-sub">${e(r.sub)}</div>` : ''}`).join('');
  return `<div class="ct">${head}${body}${note ? `<div class="ct-note">${e(note)}</div>` : ''}</div>`;
}
