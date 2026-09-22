// Signal row shared by every module screen (MODULES.md): Price · Risk · Earth.
//   const sc = signalCards(el, moduleData, { accent, priceItem, earthMetric, earthSub }); sc.dispose();
// priceItem: item object or item_id (default items[1] ?? items[0]).
// earthMetric: 'ndvi' (default) or 'ndwi' (GPU reservoirs). Cards with no data are hidden.
import { forecastChart } from './forecastChart.js';
import { isNum, shortRegion, riskOf } from './format.js';
import { ITEM_META, commodityOf } from './meta.js';
import { onResize } from './dom.jsx';
import { initChart } from './echarts.js';
import { axisTooltip, tipHtml, fmtMonth, fmtPct } from './chartTheme.js';


export function signalCards(el, data, opts = {}) {
  const items = data?.items || [];
  const regions = data?.regions || [];
  const judg = data?.signals?.region_judgments || [];
  const metric = opts.earthMetric || (data?.module?.id === 'gpu' ? 'ndwi' : 'ndvi');

  let item = opts.priceItem;
  if (typeof item === 'string') item = items.find(i => i.item_id === item);
  item = item || items[1] || items[0];

  el.classList.add('sig-row');
  el.innerHTML = ['price', 'risk', 'earth'].map(k => `<div class="card sig" data-sig="${k}"><div class="sig-head"><b></b><span></span></div><div class="sig-body"></div></div>`).join('');
  const cardOf = k => el.querySelector(`[data-sig="${k}"]`);
  const head = (k, title, sub) => { const c = cardOf(k); c.querySelector('b').textContent = title; c.querySelector('span').textContent = sub || ''; return c.querySelector('.sig-body'); };
  const hide = k => { cardOf(k).hidden = true; };
  const disposers = [];

  // 1 · Raw TimesFM for the SAME item as the hero chart, so the gap to the hero is the value Orbit's signals add.
  //     Hidden when the item has no separate model_forecast (never show a different item here).
  const f6 = (item?.forecast || []).slice(0, 6), m6 = (item?.model_forecast || []).slice(0, 6);
  if (item?.history?.length && m6.length && f6.length) {
    const short = ITEM_META[item.item_id]?.short || item.name;
    const body = head('price', 'Raw TimesFM', `${short} · before Orbit's signals`);
    body.innerHTML = `<div class="sig-chart"></div><div class="sig-note"></div>`;
    const fc = forecastChart(body.firstElementChild, {
      history: item.history, forecast: m6, accent: '#78716C', unit: item.unit || '£', compact: true, calloutTitle: 'TimesFM only',
    });
    const a = m6.at(-1).p50, b = f6.at(-1).p50, d = isNum(a) && isNum(b) && a ? (b / a - 1) * 100 : null;
    if (isNum(d)) body.lastElementChild.innerHTML = `Orbit's news &amp; satellite signals add <b style="color:${d >= 0 ? 'var(--up)' : 'var(--down)'}">${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%</b> on top`;
    disposers.push(() => fc.dispose());
  } else hide('price');

  // 2 · Risk signal (Jev, per region): horizontal labelled bars, 0–100% chance of a supply hit.
  const risks = judg.map(j => ({ j, v: riskOf(j) })).filter(r => isNum(r.v)).sort((a, b) => b.v - a.v).slice(0, 5);
  if (risks.length) {
    const body = head('risk', 'Supply risk by region', 'Judged by Jev');
    const why = data?.module?.id === 'gpu' || metric === 'ndwi' ? 'drought, power or fab outage' : 'bad harvest, drought, disease';
    body.innerHTML = `<div class="sig-chart"></div><div class="sig-note">Chance of a supply hit (${why})</div>`;
    const riskWord = v => (v >= 0.66 ? 'High' : v >= 0.33 ? 'Medium' : 'Low');
    const riskColor = v => (v >= 0.66 ? '#EF4444' : v >= 0.33 ? '#F59E0B' : '#94A3B8');
    const regOf = r => regions.find(x => x.region_id === r.j.region_id) || r.j;
    const nameOf = r => shortRegion(r.j.name || regOf(r));
    const rows = [...risks].reverse(); // ECharts draws category 0 at the bottom
    const chart = initChart(body.querySelector('.sig-chart'));
    chart.setOption({
      animationDuration: 500,
      grid: { left: 112, right: 92, top: 2, bottom: 2 },
      xAxis: { type: 'value', min: 0, max: 1, show: false },
      yAxis: {
        type: 'category', data: rows.map(nameOf), axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#44403C', fontSize: 11.5, fontWeight: 600, width: 104, overflow: 'break', lineHeight: 13, align: 'left', margin: 110 },
      },
      series: [{
        type: 'bar', barWidth: 10, barCategoryGap: '40%',
        showBackground: true, backgroundStyle: { color: '#F1F0EE', borderRadius: 5 },
        data: rows.map(r => ({ value: r.v, itemStyle: { color: riskColor(r.v), borderRadius: 5 } })),
        label: {
          show: true, position: 'insideRight', offset: [92, 0], align: 'right', fontSize: 12, fontWeight: 700, color: '#1C1917',
          formatter: p => `${Math.round(rows[p.dataIndex].v * 100)}%  {w|${riskWord(rows[p.dataIndex].v)}}`,
          rich: { w: { fontSize: 11, fontWeight: 600, color: '#78716C' } },
        },
        animationDelay: i => i * 50,
      }],
      tooltip: axisTooltip(ps => {
        const p = Array.isArray(ps) ? ps[0] : ps; const r = rows[p?.dataIndex]; if (!r) return '';
        const reg = regOf(r);
        const probs = r.j.harvest_risk?.probs || {};
        const conf = r.j.confidence ?? r.j.harvest_risk?.confidence;
        return tipHtml({
          title: shortRegion(reg), tag: `${riskWord(r.v)} risk`,
          rows: [{ color: riskColor(r.v), label: `${commodityOf(reg)} supply-hit chance`, value: Math.round(r.v * 100) + '%' },
            isNum(probs.severe) ? { label: 'Chance of a severe hit', value: Math.round(probs.severe * 100) + '%' } : null,
            isNum(probs.low) ? { label: 'Chance all is fine', value: Math.round(probs.low * 100) + '%' } : null,
            isNum(conf) ? { label: 'How sure Jev is', value: Math.round(conf * 100) + '%' } : null],
          note: 'From satellite stats + news headlines',
        });
      }, { pointer: 'shadow' }),
    });
    disposers.push(onResize(body, () => chart.resize()), () => chart.dispose());
  } else hide('risk');

  // 3 · Earth signal: diverging bars from a zero baseline = % vs the 5-yr average, each labelled with its value.
  const key = `${metric}_vs_5yr_pct`;
  const want = metric === 'ndwi' ? 'water' : 'crop';
  let bars = regions.filter(r => isNum(r?.anomaly?.[key]));
  if (bars.some(r => r.signal === want)) bars = bars.filter(r => r.signal === want);
  bars = bars.slice(0, 6);
  if (bars.length) {
    const body = head('earth', 'Earth signal', opts.earthSub || (metric === 'ndwi' ? 'Reservoir water vs 5-yr avg' : 'Crop health vs 5-yr avg'));
    body.innerHTML = `<div class="sig-chart"></div>`;
    const vals = bars.map(r => Math.round(r.anomaly[key]));
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = (hi - lo) || 10;
    const col = v => (v <= -10 ? '#F59E0B' : v < 0 ? '#FCD34D' : '#86EFAC');
    const chart = initChart(body.firstElementChild);
    chart.setOption({
      animationDuration: 300,
      tooltip: axisTooltip(ps => {
        const i = (Array.isArray(ps) ? ps[0] : ps)?.dataIndex; const r = bars[i]; if (!r) return '';
        const a = r.anomaly[key], last = (r.series || []).filter(s => isNum(s?.[metric])).pop();
        return tipHtml({
          title: shortRegion(r), tag: a < 0 ? 'Below 5-yr avg' : 'Above 5-yr avg',
          rows: [{ color: col(vals[i]), label: metric === 'ndwi' ? 'Water vs 5-yr avg' : 'Crop health vs 5-yr avg', value: fmtPct(vals[i], 0) },
            last ? { label: `${metric.toUpperCase()} · ${fmtMonth(last.month)}`, value: last[metric].toFixed(2) } : null],
          note: r.name || '',
        });
      }, { pointer: 'shadow' }),
      grid: { left: 2, right: 2, top: 20, bottom: 22 },
      xAxis: { type: 'category', data: bars.map(r => shortRegion(r)), axisLine: { show: true, onZero: true, lineStyle: { color: '#D6D3D1' } }, axisTick: { show: false },
        axisLabel: { show: false } },
      yAxis: { type: 'value', show: false, min: lo - span * 0.22, max: hi + span * 0.22 },
      series: [{
        type: 'bar', barCategoryGap: '22%',
        data: vals.map(v => ({
          value: v, itemStyle: { color: col(v), borderRadius: v < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] },
          label: { show: true, position: v < 0 ? 'bottom' : 'top', formatter: `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`, fontSize: 11, fontWeight: 700, color: v <= -10 ? '#B45309' : '#44403C', distance: 3 },
        })),
        animationDelay: i => i * 40,
      }],
    });
    // Region names in their own row under the plot (the zero line moves, so they can't hang off the axis).
    const names = document.createElement('div');
    names.className = 'sig-names';
    names.innerHTML = bars.map(r => `<span title="${(r.name || '').replace(/"/g, '&quot;')}">${shortRegion(r)}</span>`).join('');
    body.appendChild(names);
    disposers.push(onResize(body, () => chart.resize()), () => chart.dispose());
  } else hide('earth');

  if ([...el.children].every(c => c.hidden)) el.hidden = true;
  return { dispose() { disposers.forEach(d => { try { d(); } catch (e) { console.warn(e); } }); } };
}
