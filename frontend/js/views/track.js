// Track record (placeholder): backtests / evaluation, filled in later.
import { topbar, wireScan } from './common.js';

export async function render(el) {
  el.innerHTML = topbar({ crumb: 'Agents  /  Track record', title: 'Track record', tagline: 'How Orbit would have called past price moves' })
    + `<div class="empty">Track record is being computed.</div>`;
  wireScan(el);
}
