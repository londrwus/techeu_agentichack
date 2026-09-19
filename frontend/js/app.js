// Orbit SPA: hash router + shared shell.
// Routes: #/earth (default) #/overview #/groceries #/latte #/beer_wine #/gpu #/rent #/mission #/ask #/news #/track
// Legacy #/module/{id} links map onto the per-module views.
import { icons, $$, api, hideTip } from './lib.js';
import * as earth from './views/earth.js';
import * as overview from './views/overview.js';
import * as groceries from './views/groceries.js';
import * as latte from './views/latte.js';
import * as beer_wine from './views/beer_wine.js';
import * as gpu from './views/gpu.js';
import * as rent from './views/rent.js';
import * as mission from './views/mission.js';
import * as ask from './views/ask.js';
import * as news from './views/news.js';
import * as track from './views/track_record.js';
import { watchIcons } from './components/icons.js';
import { installLightbox } from './components/lightbox.js';

const VIEWS = { earth, overview, groceries, latte, beer_wine, gpu, rent, mission, ask, news, track };
// Views whose content fills the whole content area edge-to-edge (the sidebar stays identical on every page).
const FULL_BLEED = new Set(['earth']);

const view = document.getElementById('view');
let cleanup = null, seq = 0;

function parse() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'earth').split('/');
  let [name, ...rest] = parts;
  if (name === 'module' && rest[0]) { name = rest[0]; rest = rest.slice(1); }
  if (!VIEWS[name]) name = 'earth';
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  return { name, key: name, arg };
}

async function route() {
  const r = parse();
  hideTip();
  try { cleanup?.(); } catch (e) { console.warn(e); }
  cleanup = null;
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.route === r.key));
  document.body.classList.toggle('full-bleed', FULL_BLEED.has(r.name));
  document.body.dataset.view = r.name;
  view.innerHTML = '';
  view.scrollTop = 0;
  const page = document.createElement('div');
  page.className = FULL_BLEED.has(r.name) ? 'page full' : 'page';
  view.appendChild(page);
  const token = ++seq;
  try {
    const c = (await VIEWS[r.name].render(page, r.arg)) || null;
    if (token === seq) cleanup = typeof c === 'function' ? c : null; else if (typeof c === 'function') c();
  } catch (e) {
    console.error('[render]', e);
    page.insertAdjacentHTML('beforeend', `<div class="empty">This view hit a snag. Data may still be building.</div>`);
  }
  icons();
}

watchIcons();
installLightbox();
window.addEventListener('hashchange', route);
route();

// Sidebar footer: live region count.
Promise.all(['groceries', 'latte', 'beer_wine', 'gpu'].map(m => api(`/api/modules/${m}`).catch(() => null))).then(ms => {
  const ids = new Set(ms.flatMap(m => (m?.regions || []).map(r => r.region_id)));
  if (ids.size) document.getElementById('side-regions').textContent = `${ids.size} satellite regions watched`;
});
