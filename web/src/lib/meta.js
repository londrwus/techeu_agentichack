// Module / item / region metadata, mirroring orbit/config.py (ported from frontend/js/lib.js).
import { MODULE_ICON, ITEM_ICON } from './icons.jsx';

export const MODULE_IDS = ['groceries', 'latte', 'beer_wine', 'gpu'];

export const MODULE_META = {
  groceries: { name: 'Groceries', color: '#F97316', icon: MODULE_ICON.groceries },
  latte: { name: 'Latte Index', color: '#A16207', icon: MODULE_ICON.latte },
  beer_wine: { name: 'Beer & Wine', color: '#EAB308', icon: MODULE_ICON.beer_wine },
  gpu: { name: 'GPU & Gadgets', color: '#6366F1', icon: MODULE_ICON.gpu },
  rent: { name: 'Rent Radar', color: '#10B981', icon: MODULE_ICON.rent },
};

export const ITEM_META = {
  chocolate: { short: 'Choc' }, olive_oil: { short: 'Olive oil' }, orange_juice: { short: 'OJ' }, bread: { short: 'Bread' },
  latte: { short: 'Latte' }, pint: { short: 'Pint' }, wine: { short: 'Wine' }, gpu: { short: 'GPU' },
  laptop: { short: 'Laptop' }, rent_1bed: { short: 'Rent' },
};
for (const [id, m] of Object.entries(ITEM_META)) m.icon = ITEM_ICON[id];

/** region -> [item, signal] (mirrors orbit/config.py REGIONS) */
export const REGION_META = {
  jaen_olives: ['olive_oil', 'crop'], soubre_cocoa: ['chocolate', 'crop'], ashanti_cocoa: ['chocolate', 'crop'],
  saopaulo_oranges: ['orange_juice', 'crop'], poltava_wheat: ['bread', 'crop'], minas_coffee: ['latte', 'crop'],
  daklak_coffee: ['latte', 'crop'], huila_coffee: ['latte', 'crop'], hallertau_hops: ['pint', 'crop'],
  zatec_hops: ['pint', 'crop'], bordeaux_vines: ['wine', 'crop'], rioja_vines: ['wine', 'crop'],
  baoshan_reservoir: ['gpu', 'water'], tsengwen_reservoir: ['gpu', 'water'], hsinchu_park: ['laptop', 'built'],
  kaohsiung_port: ['laptop', 'port'],
};

/** Module accents from MODULES.md (forecast line, active risk curve, sparklines). */
export const ACCENT = { groceries: '#F97316', latte: '#A16207', beer_wine: '#CA8A04', gpu: '#6366F1', rent: '#10B981' };

/** Commodity word for a region, e.g. "Wine" / "Latte" (Earth card sub-line, supply-risk tooltips).
 *
 *  The vanilla build tried a regex over the region name first, but its source carried a stray U+0008
 *  (frontend/js/components/ui.js:72: `.match(/<BS>(coffee|...)/i)`), so the pattern could never match
 *  and every region fell through to its item name. That fallback is the copy that shipped and is on
 *  every screenshot, so it is what this port does — deliberately, not by accident.
 */
export function commodityOf(region) {
  const it = region?.item_id || region?.item;
  return ITEM_META[it]?.short || 'Supply';
}
