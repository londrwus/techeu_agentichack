// One icon set for the whole app: Lucide, via lucide-react.
//   <Icon name="coffee" />            -> <svg class="lucide lucide-coffee"> sized by app.css (18px)
//   <Icon name="coffee" size={14} />  -> explicit size, like the old icon(name, {size})
//   iconSvg('coffee', { size: 14 })   -> SVG *string*, for ECharts formatters / tooltip HTML
// Replaces the vanilla build's UMD bundle + <i data-lucide> MutationObserver upgrade.
import { createElement } from 'react';
import { LUCIDE } from './lucide-icons.js';
import { renderToStaticMarkup } from 'react-dom/server';

/** Lucide names per module / item / UI role. Views use these, never emoji. */
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
function comp(name) {
  const C = LUCIDE[pascal(name)];
  if (C) return C;
  if (import.meta.env.DEV) console.warn('[icons] missing from the registry, add it to lucide-icons.js:', name);
  return LUCIDE.Circle;
}

/** Lucide icon as a React element. Omit `size` to let app.css decide (the old <i data-lucide> behaviour). */
export function Icon({ name, size, strokeWidth = 1.75, style, ...rest }) {
  return createElement(comp(name), {
    size: size ?? 24,
    strokeWidth,
    style: size ? { width: size, height: size, ...style } : style,
    ...rest,
  });
}
export const ModuleIcon = ({ id, ...rest }) => <Icon name={MODULE_ICON[id] || 'circle'} {...rest} />;
export const ItemIcon = ({ id, ...rest }) => <Icon name={ITEM_ICON[id] || 'package'} {...rest} />;

const cache = new Map();
/** Inline SVG string for a Lucide icon name (kebab-case), for HTML-string contexts. */
export function iconSvg(name, { size = 18, stroke = 1.75, cls = '', title = '' } = {}) {
  const key = `${name}|${size}|${stroke}|${cls}|${title}`;
  if (cache.has(key)) return cache.get(key);
  const svg = renderToStaticMarkup(createElement(comp(name), {
    size, strokeWidth: stroke, className: cls || undefined, style: { width: size, height: size },
    role: title ? 'img' : undefined, 'aria-label': title || undefined, 'aria-hidden': title ? undefined : true,
  }));
  cache.set(key, svg);
  return svg;
}
export const moduleIconSvg = (id, o) => iconSvg(MODULE_ICON[id] || 'circle', o);
export const itemIconSvg = (id, o) => iconSvg(ITEM_ICON[id] || 'package', o);
