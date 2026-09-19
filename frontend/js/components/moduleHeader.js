// Module top bar per design: breadcrumb, 44px tinted icon square, title, backtest badge, Scan now.
//   page.innerHTML = moduleHeader('latte', data) + '...'; wireScan(page);
import { topbar, wireScan } from '../views/common.js';
import { MODULE_META, ACCENT, MODULE_ICON, tint, isNum, monthLabel } from './ui.js';
export { wireScan };

export function backtestBadge(data) {
  const items = data?.items || [];
  const it = items.find(i => i?.backtest?.orbit_signal?.flagged) || items.find(i => i?.backtest?.flagged);
  if (!it) return '';
  const bt = it.backtest;
  const txt = isNum(bt.lead_months) ? `Backtest: would have flagged it ${bt.lead_months} months early`
    : `Backtest ${monthLabel(bt.as_of, true)}: would have flagged it early`;
  return `<div class="backtest"><i data-lucide="history"></i><span>${txt}</span></div>`;
}

export function moduleHeader(moduleId, data, { right = '' } = {}) {
  const meta = MODULE_META[moduleId] || { name: data?.module?.name || moduleId };
  const accent = ACCENT[moduleId] || data?.module?.color || '#A8A29E';
  const iconSq = `<div class="icon-sq lg" style="background:${tint(accent)};color:${accent}"><i data-lucide="${MODULE_ICON[moduleId] || 'circle'}"></i></div>`;
  return topbar({ crumb: `Modules  /  ${meta.name}`, title: meta.name, iconSq, right: backtestBadge(data) + right });
}
