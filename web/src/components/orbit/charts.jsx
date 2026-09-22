// React wrappers around the two imperative chart helpers (ECharts lives outside React's render loop).
import { useEffect, useMemo, useRef } from 'react';
import { forecastChart } from '@/lib/forecastChart.js';
import { signalCards } from '@/lib/signalCards.js';
import { initChart } from '@/lib/echarts.js';
import { onResize } from '@/lib/dom.jsx';

const stable = o => JSON.stringify(o, (k, v) => (typeof v === 'function' ? undefined : v));

/** The Orbit forecast chart (history + dashed forecast + p10–p90 band + callout). */
export function ForecastChart({ className, style, afterUpdate, ...opts }) {
  const host = useRef(null);
  const inst = useRef(null);
  const key = stable(opts);
  useEffect(() => {
    inst.current = forecastChart(host.current, opts);
    afterUpdate?.(inst.current);
    return () => { inst.current?.dispose(); inst.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!inst.current) return;
    inst.current.update(opts);
    afterUpdate?.(inst.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <div ref={host} className={className} style={style} />;
}

/** Price · Risk · Earth signal row shared by the module screens. */
export function SignalRow({ data, className, ...opts }) {
  const host = useRef(null);
  const key = stable({ ...opts, n: data?.items?.length, m: data?.module?.id });
  useEffect(() => {
    if (!data) return undefined;
    const el = host.current;
    const sc = signalCards(el, data, opts);
    return () => { sc.dispose(); el.innerHTML = ''; el.hidden = false; el.className = className || ''; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key]);
  return <section ref={host} className={className} />;
}

/** Declarative ECharts host: `option` is re-applied whenever it changes, and the chart auto-resizes. */
export function EChart({ option, className, style, onInit, notMerge = true, opts }) {
  const host = useRef(null);
  const chart = useRef(null);
  const key = useMemo(() => stable(option), [option]);
  useEffect(() => {
    const c = initChart(host.current, null, opts);
    chart.current = c;
    const stop = onResize(host.current, () => c.resize());
    const off = onInit?.(c);
    return () => { off?.(); stop(); c.dispose(); chart.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (option) chart.current?.setOption(option, notMerge); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  return <div ref={host} className={className} style={style} />;
}
