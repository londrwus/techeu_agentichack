// One icon set for the whole app: Lucide (stroke 1.75, currentColor). No emoji / OS glyphs anywhere.
//   icon('coffee')                    -> '<svg class="lucide lucide-coffee">…</svg>' (inline, no DOM pass needed)
//   icon('coffee', { size: 14 })      -> custom size
//   moduleIcon('latte') / itemIcon('pint') -> SVG for a module / item
//   <i data-lucide="coffee"></i>      -> still works anywhere: a MutationObserver upgrades late-rendered markup.
// Source: the Lucide UMD bundle loaded in index.html (window.lucide.icons).

/** Lucide names per module / item / UI role. Views should use these, never emoji. */
export const MODULE_ICON = {
  groceries: 'shopping-basket', latte: 'coffee', beer_wine: 'wine', gpu: 'cpu', rent: 'building-2',
  earth: 'globe', overview: 'layout-dashboard', ask: 'sparkles', mission: 'radar', track: 'target',
};
export const ITEM_ICON = {
  chocolate: 'candy', olive_oil: 'droplet', orange_juice: 'citrus', bread: 'wheat', latte: 'coffee',
  pint: 'beer', wine: 'wine', gpu: 'cpu', laptop: 'laptop', rent_1bed: 'key-round',
};
export const UI_ICON = {
  scan: 'radar', play: 'play', pause: 'pause', close: 'x', zoom: 'zoom-in', up: 'trending-up', down: 'trending-down',
  flat: 'minus', info: 'info', left: 'chevron-left', right: 'chevron-right', map: 'map', image: 'image', satellite: 'satellite',
};

const pascal = n => String(n).replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const cache = new Map();

function nodeToSvg(node) {
  const [tag, attrs, children] = node;
  const a = Object.entries(attrs || {}).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<${tag} ${a}>${(children || []).map(nodeToSvg).join('')}</${tag}>`;
}

/** Inline SVG string for a Lucide icon name (kebab-case). Unknown names fall back to a small circle. */
export function icon(name, { size = 18, stroke = 1.75, cls = '', title = '' } = {}) {
  const key = `${name}|${size}|${stroke}|${cls}|${title}`;
  if (cache.has(key)) return cache.get(key);
  const def = window.lucide?.icons?.[pascal(name)];
  let children = def ? (def[0] === 'svg' ? def[2] : def) : [['circle', { cx: 12, cy: 12, r: 3 }]];
  const inner = (children || []).map(nodeToSvg).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="lucide lucide-${name}${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" style="width:${size}px;height:${size}px"${title ? ` role="img" aria-label="${title}"` : ' aria-hidden="true"'}>${inner}</svg>`;
  cache.set(key, svg);
  return svg;
}
export const moduleIcon = (id, o) => icon(MODULE_ICON[id] || 'circle', o);
export const itemIcon = (id, o) => icon(ITEM_ICON[id] || 'package', o);

/** Upgrade every <i data-lucide> in the document now, and keep doing it for markup rendered later. */
let raf = 0;
export function upgradeIcons() {
  try { window.lucide?.createIcons({ attrs: { 'stroke-width': 1.75 } }); } catch (e) { console.warn(e); }
}
export function watchIcons() {
  if (!window.MutationObserver) return;
  new MutationObserver(muts => {
    if (raf) return;
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && (n.matches?.('i[data-lucide]') || n.querySelector?.('i[data-lucide]'))) {
        raf = requestAnimationFrame(() => { raf = 0; upgradeIcons(); });
        return;
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
