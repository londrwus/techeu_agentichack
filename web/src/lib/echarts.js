// ECharts bootstrap: one place that imports the library, so it only lands in the chunks that chart.
// Carries the Orbit motion defaults (smooth animation + skeleton-until-first-render) from motion.js.
import * as echarts from 'echarts';
import { REDUCED, SAFETY, noAnim } from './motion.js';

const CHART_DEFAULTS = { animationDuration: 700, animationEasing: 'cubicOut', animationDurationUpdate: 400, animationEasingUpdate: 'cubicInOut' };

/** echarts.init with the Orbit motion defaults. Every chart in the app goes through this. */
export function initChart(dom, theme = null, opts = undefined) {
  const inst = echarts.init(dom, theme, opts);
  const set = inst.setOption.bind(inst);
  let first = true;
  inst.setOption = function (opt, ...a) {
    const notMerge = a[0] === true || a[0]?.notMerge;
    if ((first || notMerge) && opt && typeof opt === 'object' && !Array.isArray(opt) && opt.animation !== false) {
      const d = {}; for (const k in CHART_DEFAULTS) if (!(k in opt)) d[k] = CHART_DEFAULTS[k];
      opt = { ...d, ...opt };
    }
    first = false;
    return set(opt, ...a);
  };
  try {
    if (dom && !REDUCED && noAnim(dom) && getComputedStyle(dom).backgroundImage === 'none') {
      dom.classList.add('mo-chart-wait');
      const off = () => dom.classList.remove('mo-chart-wait');
      inst.on('rendered', function h() { off(); inst.off('rendered', h); });
      setTimeout(off, SAFETY);
    }
  } catch (e) { console.warn('[motion] echarts', e); }
  return inst;
}

