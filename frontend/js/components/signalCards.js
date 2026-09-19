// Signal row shared by every module screen (MODULES.md): Price · Risk · Earth.
//   const sc = signalCards(el, moduleData, { accent, priceItem, earthMetric, earthSub }); sc.dispose();
// priceItem: item object or item_id (default items[1] ?? items[0]).
// earthMetric: 'ndvi' (default) or 'ndwi' (GPU reservoirs). Cards with no data are hidden.
import { forecastChart } from './forecastChart.js';
import { isNum, ITEM_META, shortRegion, commodityOf, riskOf, onResize } from './ui.js';
import { axisTooltip, tipHtml, fmtMonth, fmtPct } from './chartTheme.js';

const axisTxt = { color: '#A8A29E', fontSize: 11, fontWeight: 500 };

export function signalCards(el, data, opts = {}) {
  const accent = opts.accent || data?.module?.color || '#F97316';
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

  // 1 · Price signal
  if (item?.history?.length && item?.forecast?.length) {
    const body = head('price', 'Price signal', /timesfm/i.test(item.model || '') ? 'TimesFM forecast' : (item.model || 'Forecast'));
    const fc = forecastChart(body, {
      history: item.history, forecast: item.forecast, accent, unit: item.unit || '£', compact: true,
      calloutTitle: opts.priceTitle || ITEM_META[item.item_id]?.short || item.name,
    });
    disposers.push(() => fc.dispose());
  } else hide('price');

  // 2 · Risk signal (Jev, per region): horizontal labelled bars, 0–100% chance of a supply hit.
  const risks = judg.map(j => ({ j, v: riskOf(j) })).filter(r => isNum(r.v)).sort((a, b) => b.v - a.v).slice(0, 5);
  if (risks.length) {
    const body = head('risk', 'Supply risk by region', 'Judged by Jev');
    body.innerHTML = `<div class="sig-chart"></div><div class="sig-note">Chance of a supply hit (bad harvest, drought, outage)</div>`;
    const riskWord = v => (v >= 0.66 ? 'High' : v >= 0.33 ? 'Medium' : 'Low');
    const riskColor = v => (v >= 0.66 ? '#EF4444' : v >= 0.33 ? '#F59E0B' : '#94A3B8');
    const regOf = r => regions.find(x => x.region_id === r.j.region_id) || r.j;
    const nameOf = r => shortRegion(r.j.name || regOf(r));
    const rows = [...risks].reverse(); // ECharts draws category 0 at the bottom
    const chart = echarts.init(body.querySelector('.sig-chart'));
    chart.setOption({
      animationDuration: 500,
      grid: { left: 88, right: 92, top: 2, bottom: 2 },
      xAxis: { type: 'value', min: 0, max: 1, show: false },
      yAxis: {
        type: 'category', data: rows.map(nameOf), axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#44403C', fontSize: 12, fontWeight: 600, width: 80, overflow: 'truncate', align: 'left', margin: 86 },
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

  // 3 · Earth signal (satellite anomaly vs 5-yr per region)
  const key = `${metric}_vs_5yr_pct`;
  const want = metric === 'ndwi' ? 'water' : 'crop';
  let bars = regions.filter(r => isNum(r?.anomaly?.[key]));
  if (bars.some(r => r.signal === want)) bars = bars.filter(r => r.signal === want);
  bars = bars.slice(0, 6);
  if (bars.length) {
    const body = head('earth', 'Earth signal', opts.earthSub || (metric === 'ndwi' ? 'Reservoir level vs 5-yr' : 'Crop health vs 5-yr'));
    body.innerHTML = `<div class="sig-chart"></div>`;
    const vals = bars.map(r => 100 + r.anomaly[key]);
    const iMin = vals.indexOf(Math.min(...vals));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const chart = echarts.init(body.firstElementChild);
    chart.setOption({
      animationDuration: 300,
      tooltip: axisTooltip(ps => {
        const i = (Array.isArray(ps) ? ps[0] : ps)?.dataIndex; const r = bars[i]; if (!r) return '';
        const a = r.anomaly[key], last = (r.series || []).filter(s => isNum(s?.[metric])).pop();
        return tipHtml({
          title: shortRegion(r), tag: a < 0 ? 'Below 5-yr avg' : 'Above 5-yr avg',
          rows: [{ color: i === iMin && a < 0 ? '#F59E0B' : '#CBD5E1', label: metric === 'ndwi' ? 'Water vs 5-yr' : 'Crop health vs 5-yr', value: fmtPct(a) },
            last ? { label: `${metric.toUpperCase()} · ${fmtMonth(last.month)}`, value: last[metric].toFixed(2) } : null],
          note: r.name || '',
        });
      }, { pointer: 'shadow' }),
      grid: { left: 2, right: 2, top: 26, bottom: 22 },
      xAxis: { type: 'category', data: bars.map(r => shortRegion(r)), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...axisTxt, interval: 0, overflow: 'truncate', width: Math.max(40, Math.floor((body.clientWidth || 320) / bars.length) - 4) } },
      yAxis: { type: 'value', show: false, min: Math.max(0, lo - Math.max(12, (hi - lo) * 0.6)), max: hi + 2 },
      series: [{
        type: 'bar', barCategoryGap: '18%',
        data: vals.map((v, i) => ({
          value: v,
          itemStyle: { color: i === iMin && bars[i].anomaly[key] < 0 ? '#F59E0B' : '#CBD5E1', borderRadius: [4, 4, 0, 0] },
          label: i === iMin && bars[i].anomaly[key] < 0 ? {
            show: true, position: 'top', formatter: 'Under avg.', color: '#B45309', backgroundColor: '#FEF3C7',
            fontSize: 10, fontWeight: 600, padding: [3, 6], borderRadius: 4, distance: 6,
          } : { show: false },
        })),
        animationDelay: i => i * 40,
      }],
    });
    disposers.push(onResize(body, () => chart.resize()), () => chart.dispose());
  } else hide('earth');

  if ([...el.children].every(c => c.hidden)) el.hidden = true;
  return { dispose() { disposers.forEach(d => { try { d(); } catch (e) { console.warn(e); } }); } };
}
