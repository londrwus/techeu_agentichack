// Orbit motion layer: self-contained, auto-initialises on import.
// Page fade + staggered section rise, top progress bar for /api fetches, image blur-up reveal,
// chart/map skeleton-until-rendered, smoother ECharts defaults. Every hidden state has a 1.5 s safety reveal.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SAFETY = 1500;
const noAnim = el => { try { return getComputedStyle(el).animationName === 'none'; } catch { return false; } };

/* ---------------- progress bar ---------------- */
const bar = document.createElement('div');
bar.id = 'mo-bar';
let inflight = 0, routeBusy = false, showT = 0, doneT = 0, shown = false;
function busy() { return inflight > 0 || routeBusy; }
function tick() {
  if (busy()) {
    clearTimeout(doneT);
    if (!shown && !showT) showT = setTimeout(() => {
      showT = 0; if (!busy()) return;
      shown = true; bar.className = ''; void bar.offsetWidth; bar.className = 'run';
    }, 120);
  } else {
    clearTimeout(showT); showT = 0;
    if (shown) { shown = false; bar.className = 'done'; doneT = setTimeout(() => { bar.className = ''; }, 600); }
  }
}
const _fetch = window.fetch.bind(window);
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/\/api\//.test(url)) return _fetch(input, init);
  inflight++; tick();
  const end = () => { inflight = Math.max(0, inflight - 1); tick(); };
  return _fetch(input, init).then(r => { end(); return r; }, e => { end(); throw e; });
};

/* ---------------- page transitions ---------------- */
const view = document.getElementById('view');
let routeSeen = new Set(), routeStart = 0;
const sig = el => el.tagName + '.' + [...el.classList].filter(c => !c.startsWith('mo-')).sort().join('.');
const isBlock = el => el.nodeType === 1 && !/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(el.tagName);

function targets(nodes) {
  const out = [];
  for (const n of nodes) {
    if (!isBlock(n)) continue;
    const kids = [...n.children].filter(k => k.classList.contains('card') || k.tagName === 'SECTION');
    if (!n.classList.contains('card') && kids.length >= 2) out.push(...kids); else out.push(n);
  }
  return out;
}
function rise(nodes) {
  if (REDUCED) return;
  const list = targets(nodes).filter(noAnim);
  list.forEach((el, i) => {
    el.style.setProperty('--mo-i', Math.min(i, 8));
    el.classList.add('mo-rise');
    const clear = () => { el.classList.remove('mo-rise'); el.style.removeProperty('--mo-i'); };
    el.addEventListener('animationend', e => { if (e.target === el) clear(); }, { once: true });
    setTimeout(clear, SAFETY);
  });
}
function onNewPage(page) {
  routeSeen = new Set(); routeStart = performance.now();
  if (!REDUCED) {
    page.classList.add('mo-page');
    setTimeout(() => page.classList.remove('mo-page'), SAFETY);
  }
  const first = [...page.children];
  first.forEach(c => routeSeen.add(sig(c)));
  if (!page.classList.contains('full')) rise(first);
  // Content that replaces skeletons (new element signatures) rises in; identical re-renders stay still.
  new MutationObserver(muts => {
    if (performance.now() - routeStart > 8000 || page.classList.contains('full')) return;
    const added = muts.flatMap(m => [...m.addedNodes]).filter(isBlock);
    const fresh = added.filter(n => !routeSeen.has(sig(n)));
    added.forEach(n => routeSeen.add(sig(n)));
    if (fresh.length) rise(fresh);
  }).observe(page, { childList: true });
}
if (view) {
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList.contains('page')) onNewPage(n);
  }).observe(view, { childList: true });
  const p0 = view.querySelector('.page'); if (p0) onNewPage(p0);
}
window.addEventListener('hashchange', () => { routeBusy = true; tick(); setTimeout(() => { routeBusy = false; tick(); }, 80); });

/* ---------------- images ---------------- */
const SKIP_IMG = '.lb, .maplibregl-map, [data-no-motion]';
function small(img) {
  const w = +img.getAttribute('width') || 0, h = +img.getAttribute('height') || 0;
  if ((w && w < 24) || (h && h < 24)) return true;
  const r = img.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
}
function handleImg(img) {
  if (img.dataset.mo || REDUCED) return;
  img.dataset.mo = '1';
  if (!img.getAttribute('src') || img.closest(SKIP_IMG) || small(img) || !noAnim(img)) return;
  if (img.complete && img.naturalWidth > 0) return; // cached: show instantly
  const box = img.parentElement;
  const shim = box && box !== document.body && noAnim(box) && getComputedStyle(box).backgroundImage === 'none';
  img.classList.add('mo-wait');
  if (shim) box.classList.add('mo-shim');
  let settled = false;
  const finish = ok => {
    if (settled) return; settled = true;
    if (shim) box.classList.remove('mo-shim');
    if (!ok) { img.classList.remove('mo-wait'); img.classList.add('mo-err'); if (shim && img.isConnected) box.classList.add('mo-img-err'); return; }
    img.classList.add('mo-reveal');
    requestAnimationFrame(() => img.classList.remove('mo-wait'));
    setTimeout(() => img.classList.remove('mo-reveal'), 450);
  };
  img.addEventListener('load', () => finish(true), { once: true });
  img.addEventListener('error', () => finish(false), { once: true });
  setTimeout(() => finish(true), SAFETY); // never leave anything invisible
}
function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.tagName === 'IMG') handleImg(root);
  else root.querySelectorAll?.('img').forEach(handleImg);
}
new MutationObserver(muts => { for (const m of muts) m.addedNodes.forEach(scan); })
  .observe(document.documentElement, { childList: true, subtree: true });

/* ---------------- ECharts: smoother defaults + skeleton until first render ---------------- */
const CHART_DEFAULTS = { animationDuration: 700, animationEasing: 'cubicOut', animationDurationUpdate: 400, animationEasingUpdate: 'cubicInOut' };
function patchEcharts() {
  const ec = window.echarts;
  if (!ec || ec.__moPatched) return;
  const init = ec.init;
  try {
    ec.init = function (dom, ...rest) {
      const inst = init.call(this, dom, ...rest);
      try {
        const set = inst.setOption;
        let first = true;
        inst.setOption = function (opt, ...a) {
          const notMerge = a[0] === true || a[0]?.notMerge;
          if ((first || notMerge) && opt && typeof opt === 'object' && !Array.isArray(opt) && opt.animation !== false) {
            const d = {}; for (const k in CHART_DEFAULTS) if (!(k in opt)) d[k] = CHART_DEFAULTS[k];
            opt = { ...d, ...opt };
          }
          first = false;
          return set.call(this, opt, ...a);
        };
        if (dom && !REDUCED && noAnim(dom) && getComputedStyle(dom).backgroundImage === 'none') {
          dom.classList.add('mo-chart-wait');
          const off = () => dom.classList.remove('mo-chart-wait');
          inst.on('rendered', function h() { off(); inst.off('rendered', h); });
          setTimeout(off, SAFETY);
        }
      } catch (e) { console.warn('[motion] echarts', e); }
      return inst;
    };
    ec.__moPatched = true;
  } catch { /* frozen namespace: leave charts as they are */ }
}

/* ---------------- MapLibre: fade the canvas in on load ---------------- */
function patchMaplibre() {
  const ml = window.maplibregl;
  if (!ml || ml.__moPatched || REDUCED) return;
  const Orig = ml.Map;
  try {
    class MoMap extends Orig {
      constructor(opts, ...rest) {
        super(opts, ...rest);
        try {
          const c = this.getContainer();
          c.classList.add('mo-map-wait', 'mo-map-in');
          const done = () => c.classList.remove('mo-map-wait');
          this.once('load', done);
          setTimeout(done, SAFETY);
        } catch {}
      }
    }
    ml.Map = MoMap;
    ml.__moPatched = true;
  } catch { /* read-only namespace */ }
}

function boot() {
  document.body.appendChild(bar);
  patchEcharts();
  patchMaplibre();
  scan(document.body);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
// Deferred CDN scripts may land later: retry the patches once they are there.
window.addEventListener('load', () => { patchEcharts(); patchMaplibre(); });
