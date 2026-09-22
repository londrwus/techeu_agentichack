// The Orbit chart language (MODULES.md): solid history + soft area, dashed accent forecast from "Today",
// optional p10–p90 band, dashed "Today" divider with pill, end dot with halo, floating HTML callout card.
//
//   const fc = forecastChart(el, { history, forecast, accent, unit, calloutTitle, compact });
//   fc.update({...}); fc.dispose();
//
// history: [{month, price}], forecast: [{month, p10, p50, p90}] (months "YYYY-MM").
// Options: accent ('#F97316'), unit ('£'), calloutTitle ('Latte'), compact (false), band (false),
//   months (history months shown; default 12 compact / 18 hero), calloutIndex (forecast index, default last),
//   valueFmt (v => string), showCallout (true), yMin / yMax.
import { fmtGBP, isNum, arrowIconName } from './format.js';
import { onResize } from './dom.jsx';
import { iconSvg } from './icons.jsx';
import { initChart } from './echarts.js';
import { graphic } from 'echarts';
import { axisTooltip, tipHtml, fmtMonth } from './chartTheme.js';

const arrowIcon = (v, size = 13) => iconSvg(arrowIconName(v), { size, stroke: 2.25 });

const HIST = '#334155';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monShort = m => { const [y, mo] = m.split('-'); return `${MON[+mo - 1]} ${y.slice(2)}`; };
const monLong = m => { const [y, mo] = m.split('-'); return `${MON[+mo - 1]} ${y}`; };
const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

export function forecastChart(el, opts = {}) {
  if (!el) return { update() {}, dispose() {}, chart: null };
  el.classList.add('fc');
  el.innerHTML = `<div class="fc-plot"></div><div class="fc-callout"></div>`;
  const plot = el.firstElementChild, call = el.lastElementChild;
  const chart = initChart(plot, null, { renderer: 'canvas' });
  let o = {}, pt = null, shown = false, timer = 0;

  function build() {
    const accent = o.accent || '#F97316';
    const unit = o.unit || '£';
    const fmt = o.valueFmt || (v => fmtGBP(v, { unit }));
    const axisFmt = v => (unit === '£' ? (v >= 1000 ? '£' + Math.round(v).toLocaleString('en-GB') : '£' + v.toFixed(v >= 100 ? 0 : 2)) : (v >= 100 ? Math.round(v) : v.toFixed(2)));
    const hAll = (o.history || []).filter(p => isNum(p?.price));
    const fc = (o.forecast || []).filter(p => isNum(p?.p50));
    const nH = o.months ?? (o.compact ? 12 : 18);
    const h = hAll.slice(-nH);
    if (!h.length && !fc.length) { chart.clear(); call.classList.remove('on'); return; }
    const months = [...h.map(p => p.month), ...fc.map(p => p.month)];
    const iToday = h.length - 1;
    const lastP = h.length ? h[iToday].price : fc[0].p50;
    const pad = n => Array(n).fill(null);
    const histData = [...h.map(p => p.price), ...pad(fc.length)];
    const fcData = [...pad(Math.max(0, iToday)), ...(h.length ? [lastP] : []), ...fc.map(p => p.p50)];
    const ci = Math.min(fc.length - 1, o.calloutIndex ?? fc.length - 1);
    const iEnd = months.length - 1;
    const band = o.band && fc.some(p => isNum(p.p10) && isNum(p.p90));

    // X labels: 3–4 only (first, today, mid-forecast, last).
    const show = new Set([0, iToday, iEnd]);
    if (iEnd - iToday >= 6) show.add(iToday + Math.round((iEnd - iToday) / 2));
    if (iToday >= 8) show.add(Math.round(iToday / 2));
    const lbl = [...show].sort((a, b) => a - b).filter((v, k, a) => k === 0 || v - a[k - 1] >= 3);

    const vals = [...h.map(p => p.price), ...fc.map(p => p.p50), ...(band ? fc.flatMap(p => [p.p10, p.p90]) : [])].filter(isNum);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || hi * 0.05 || 1;
    // Nice y bounds on a round step so the min/max labels never collide.
    const raw = (span * 1.4) / 5, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw);
    const yLo = Math.max(0, Math.floor((lo - span * (o.compact ? 0.25 : 0.15)) / step) * step);
    const yHi = Math.ceil((hi + span * (o.compact ? 0.35 : 0.15)) / step) * step;

    const series = [
      { // 0 history
        name: 'History', type: 'line', data: histData, symbol: 'none', smooth: false, z: 3,
        lineStyle: { color: HIST, width: o.compact ? 2 : 2.5 },
        areaStyle: { color: new graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(100,116,139,.18)' }, { offset: 1, color: 'rgba(100,116,139,0)' }]) },
        animationDuration: 800,
        markLine: h.length ? {
          silent: true, symbol: 'none', animation: false,
          lineStyle: { type: [3, 4], color: '#A8A29E', width: 1 },
          label: o.compact ? { show: false } : {
            show: true, position: 'end', formatter: 'Today', color: '#fff', backgroundColor: '#0C0A09',
            fontSize: 10, fontWeight: 600, padding: [3, 6], borderRadius: 5,
          },
          data: [{ xAxis: iToday }],
        } : undefined,
      },
      { // 1 forecast p50
        name: 'Forecast', type: 'line', data: fcData, symbol: 'none', smooth: false, z: 4, connectNulls: false,
        lineStyle: { type: [7, 5], width: o.compact ? 2 : 2.5, color: accent },
        animationDuration: 600, animationDelay: 800,
      },
      { // 2 dots: today (white w/ slate stroke), end (accent + halo)
        type: 'scatter', z: 5, silent: true, animationDelay: 1200,
        data: [
          ...(h.length && !o.compact ? [{ value: [iToday, lastP], symbolSize: 10, itemStyle: { color: '#fff', borderColor: HIST, borderWidth: 2.5 } }] : []),
          ...(fc.length ? [
            { value: [iEnd, fc[fc.length - 1].p50], symbolSize: o.compact ? 14 : 20, itemStyle: { color: alpha(accent, 0.15) } },
            { value: [iEnd, fc[fc.length - 1].p50], symbolSize: o.compact ? 7 : 10, itemStyle: { color: accent, borderColor: '#fff', borderWidth: 2 } },
          ] : []),
        ],
      },
    ];
    if (band) {
      const off = pad(Math.max(0, iToday));
      const first = h.length ? [lastP] : [];
      series.push(
        { type: 'line', stack: 'band', data: [...off, ...first, ...fc.map(p => p.p10)], symbol: 'none', lineStyle: { opacity: 0 }, silent: true, animationDelay: 800 },
        { type: 'line', stack: 'band', data: [...off, ...(h.length ? [0] : []), ...fc.map(p => p.p90 - p.p10)], symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: alpha(accent, 0.12) }, silent: true, animationDelay: 800 },
      );
    }

    chart.setOption({
      animation: true,
      grid: o.compact ? { left: 4, right: 12, top: 12, bottom: 6 } : { left: 8, right: 24, top: 28, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category', data: months, boundaryGap: false, show: !o.compact,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#A8A29E', fontSize: 11, fontWeight: 500, interval: i => lbl.includes(i), formatter: monShort, hideOverlap: true },
      },
      yAxis: {
        type: 'value', show: !o.compact, scale: true,
        min: o.yMin ?? yLo, max: o.yMax ?? yHi, interval: o.yMin == null && o.yMax == null ? step : undefined, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#A8A29E', fontSize: 11, fontWeight: 500, formatter: axisFmt },
        splitLine: { lineStyle: { color: '#F1F0EE' } },
      },
      tooltip: axisTooltip(ps => {
        const p0 = Array.isArray(ps) ? ps[0] : ps; const i = p0 ? (months.indexOf(p0.axisValue) >= 0 ? months.indexOf(p0.axisValue) : p0.dataIndex) : null;
        if (i == null || !months[i]) return '';
        const name = o.calloutTitle || o.itemName || '';
        if (i <= iToday) {
          const v = h[i]?.price, ch = lastP && i < iToday ? (lastP / v - 1) * 100 : null;
          return tipHtml({
            title: fmtMonth(months[i]), tag: i === iToday ? 'Today' : '',
            rows: [{ color: HIST, label: name ? `${name} price` : 'Price', value: fmt(v) }],
            note: isNum(ch) ? `Since then: ${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(1)}% to today` : (i === iToday ? 'Latest observed price' : ''),
          });
        }
        const f = fc[i - h.length]; if (!f) return '';
        const ch = lastP ? (f.p50 / lastP - 1) * 100 : null;
        const rows = [{ color: accent, dashed: true, label: 'Expected', value: fmt(f.p50) }];
        if (isNum(f.p10) && isNum(f.p90)) rows.push({ label: 'Likely range', value: `${fmt(f.p10)} – ${fmt(f.p90)}` });
        if (isNum(ch)) rows.push({ label: 'vs today', html: `<span class="delta ${ch > 0.05 ? 'up' : ch < -0.05 ? 'down' : 'flat'}">${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(1)}%</span>` });
        return tipHtml({ title: fmtMonth(months[i]), tag: 'Forecast', rows, note: name ? `${name} · 80% of outcomes fall in the range` : '80% of outcomes fall in the range' });
      }),
      series,
    }, true);

    // Callout content.
    if (o.showCallout === false || !fc.length) { call.classList.remove('on'); pt = null; return; }
    const cv = fc[ci].p50, delta = lastP ? (cv / lastP - 1) * 100 : null;
    const cls = !isNum(delta) ? '' : delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat';
    call.className = `fc-callout${o.compact ? ' compact' : ''}${shown ? ' on' : ''}`;
    call.innerHTML = `<div class="t">${o.calloutTitle ? `${o.calloutTitle} · ` : ''}${monLong(fc[ci].month)} forecast</div>
      <div class="v"><b>${fmt(cv)}</b>${isNum(delta) ? `<span class="delta ${cls}">${arrowIcon(delta)}${Math.abs(delta).toFixed(1)}%</span>` : ''}</div>`;
    pt = { x: h.length + ci, y: cv, rising: isNum(delta) && delta > 0 };
  }

  function place() {} // callout is docked above the plot (CSS), no overlap with series

  function reveal() {
    place();
    if (!pt || shown) return;
    clearTimeout(timer);
    timer = setTimeout(() => { shown = true; call.classList.add('on'); }, 900);
  }

  const stop = onResize(el, () => chart.resize());

  const api = {
    chart,
    update(next = {}) { o = { ...o, ...next }; build(); reveal(); return api; },
    dispose() { clearTimeout(timer); stop(); chart.dispose(); },
  };
  api.update(opts);
  return api;
}
