// Signal row shared by every module screen (MODULES.md): Price · Risk · Earth.
//   const sc = signalCards(el, moduleData, { accent, priceItem, earthMetric, earthSub }); sc.dispose();
// priceItem: item object or item_id (default items[1] ?? items[0]).
// earthMetric: 'ndvi' (default) or 'ndwi' (GPU reservoirs). Cards with no data are hidden.
import { forecastChart } from './forecastChart.js';
import { esc, isNum, ITEM_META, shortRegion, commodityOf, riskOf, onResize } from './ui.js';

const GREYS = ['#94A3B8', '#CBD5E1', '#E2E8F0', '#E2E8F0', '#E2E8F0'];
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

  // 2 · Risk signal (Jev, per region)
  const risks = judg.map(j => ({ j, v: riskOf(j) })).filter(r => isNum(r.v)).sort((a, b) => b.v - a.v).slice(0, 5);
  if (risks.length) {
    const body = head('risk', 'Risk signal', 'Jev · per region');
    body.innerHTML = `<div class="sig-chart"></div><div class="sig-legend"></div><div class="fc-callout compact on sig-call"></div>`;
    const worst = risks[0];
    const reg = regions.find(r => r.region_id === worst.j.region_id) || worst.j;
    const prev = worst.j.prev_score ?? worst.j.harvest_risk?.prev_score;
    body.querySelector('.sig-call').innerHTML = `<div class="t">${esc(commodityOf(reg))} supply risk</div>
      <div class="v"><b>${worst.v.toFixed(2)}</b>${isNum(prev) ? `<span class="delta ${worst.v >= prev ? 'up' : 'down'}">${worst.v >= prev ? '↑' : '↓'} ${Math.abs(worst.v - prev).toFixed(2)}</span>` : ''}</div>`;
    const colors = risks.map((_, i) => (i === 0 ? accent : GREYS[i - 1]));
    body.querySelector('.sig-legend').innerHTML = risks.slice(0, 3).map((r, i) => `<span><i style="background:${colors[i]}"></i>${esc(shortRegion(r.j.name || r.j.region_id))}</span>`).join('');
    const chart = echarts.init(body.querySelector('.sig-chart'));
    const hasHist = risks.every(r => Array.isArray(r.j.history) && r.j.history.length > 1);
    let option;
    if (hasHist) { // multi-line: one curve per region
      const months = risks[0].j.history.map(p => p.month);
      option = {
        grid: { left: 4, right: 8, top: 66, bottom: 6 },
        xAxis: { type: 'category', data: months, show: false, boundaryGap: false },
        yAxis: { type: 'value', min: 0, max: 1, show: true, axisLabel: { show: false }, splitLine: { lineStyle: { color: '#F1F0EE' } } },
        series: risks.slice(0, 3).reverse().map((r, k, arr) => {
          const i = arr.length - 1 - k;
          return { type: 'line', data: r.j.history.map(p => p.score ?? p.v), symbol: 'none', lineStyle: { color: colors[i], width: i === 0 ? 2 : 1.5 }, z: 10 - i };
        }),
      };
    } else { // dot plot (lollipops): one point per region
      option = {
        grid: { left: 4, right: 8, top: 66, bottom: 6 },
        xAxis: { type: 'category', data: risks.map(r => shortRegion(r.j.name || r.j.region_id)), show: false },
        yAxis: { type: 'value', min: 0, max: 1, axisLabel: { show: false }, splitLine: { lineStyle: { color: '#F1F0EE' } } },
        series: [
          { type: 'bar', barWidth: 2, data: risks.map((r, i) => ({ value: r.v, itemStyle: { color: colors[i] } })), animationDelay: i => i * 40 },
          { type: 'scatter', symbolSize: 12, data: risks.map((r, i) => ({ value: r.v, itemStyle: { color: colors[i], borderColor: '#fff', borderWidth: 2 } })), animationDelay: i => 300 + i * 40 },
        ],
      };
    }
    chart.setOption({ animationDuration: 600, tooltip: { show: false }, ...option });
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
      animationDuration: 300, tooltip: { show: false },
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
