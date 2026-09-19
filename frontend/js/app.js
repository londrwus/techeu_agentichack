// Orbit SPA: hash router + shared shell.
import { icons, $$, api, hideTip } from './lib.js';
import * as overview from './views/overview.js';
import * as module from './views/module.js';
import * as rent from './views/rent.js';
import * as mission from './views/mission.js';
import * as ask from './views/ask.js';

const view = document.getElementById('view');
let cleanup = null, seq = 0;

function parse() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
  const [name, arg] = parts;
  if (name === 'module' && arg === 'rent') return { name: 'rent', key: 'rent' };
  if (name === 'module' && arg) return { name: 'module', arg, key: `module/${arg}` };
  if (['overview', 'rent', 'mission', 'ask'].includes(name)) return { name, key: name, arg: arg && decodeURIComponent(parts.slice(1).join('/')) };
  return { name: 'overview', key: 'overview' };
}

async function route() {
  const r = parse();
  hideTip();
  try { cleanup?.(); } catch (e) { console.warn(e); }
  cleanup = null;
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.route === r.key));
  view.innerHTML = '';
  view.scrollTop = 0;
  const page = document.createElement('div');
  page.className = 'page';
  view.appendChild(page);
  const mod = { overview, module, rent, mission, ask }[r.name];
  const token = ++seq;
  try {
    const c = (await mod.render(page, r.arg)) || null;
    if (token === seq) cleanup = c; else c?.();
  } catch (e) {
    console.error('[render]', e);
    page.insertAdjacentHTML('beforeend', `<div class="empty">This view hit a snag. Data may still be building.</div>`);
  }
  icons();
}

window.addEventListener('hashchange', route);
route();

// Sidebar footer: live region count.
api('/api/summary').then(s => {
  const n = s?.stats?.regions_watched;
  if (n) document.getElementById('side-regions').textContent = `${n} satellite regions watched`;
});
