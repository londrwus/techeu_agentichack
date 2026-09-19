// Placeholder module screen (header + hero forecast + signal row). Screen views replace this with their own layout.
import { moduleHeader, wireScan } from './moduleHeader.js';
import { forecastChart } from './forecastChart.js';
import { signalCards } from './signalCards.js';
import { loadModule, ACCENT, ITEM_META, fmtGBP } from './ui.js';

export async function renderModuleStub(el, id) {
  el.innerHTML = moduleHeader(id, null) + `<div class="card skeleton" style="height:500px"></div>`;
  wireScan(el);
  const data = await loadModule(id);
  if (!data) { el.innerHTML = moduleHeader(id, null) + `<div class="empty">No data for this module yet.</div>`; wireScan(el); return; }
  const accent = ACCENT[id], item = data.items?.[0];
  el.innerHTML = moduleHeader(id, data) + `
    <section class="card" style="height:440px">
      <div class="card-head"><div><div class="card-title">${item ? item.name : ''}</div>
        <div class="card-sub">${item ? `${fmtGBP(item.history?.at(-1)?.price, { unit: item.unit })} today` : ''}</div></div></div>
      <div class="fc-host" style="flex:1"></div>
    </section>
    <section></section>`;
  wireScan(el);
  const fc = item ? forecastChart(el.querySelector('.fc-host'), { history: item.history, forecast: item.forecast, accent, unit: item.unit, calloutTitle: ITEM_META[item.item_id]?.short || item.name, band: true }) : null;
  const sc = signalCards(el.querySelector('section:last-child'), data, { accent });
  return () => { fc?.dispose(); sc.dispose(); };
}
