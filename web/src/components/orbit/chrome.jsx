// Shared page chrome: the top bar, the Scan-now button, module headers and the briefing button.
// Ported from vanilla js/views/common.js + components/moduleHeader.js.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon, MODULE_ICON } from '@/lib/icons.jsx';
import { scanNow, useScan } from '@/lib/scan.jsx';
import { isNum, monthLabel, tint } from '@/lib/format.js';
import { ACCENT, MODULE_META } from '@/lib/meta.js';

/** Primary "Scan now" button; shows the running state while the SSE scan streams. */
export function ScanButton() {
  const { running } = useScan();
  return running ? (
    <Button variant="orbitPrimary" size="orbit" className="running" onClick={scanNow}>
      <Icon name="loader" className="spin" />Scanning…
    </Button>
  ) : (
    <Button variant="orbitPrimary" size="orbit" onClick={scanNow}>
      <Icon name="satellite-dish" />Scan now
    </Button>
  );
}

export function Topbar({ crumb, title, iconSquare, pill, tagline, subtitle, right, scan = true }) {
  return (
    <header className="topbar">
      <div>
        {crumb ? <div className="crumb">{crumb}</div> : null}
        <div className="title-row">
          {iconSquare}
          <h1>{title}</h1>
          {pill}
          {subtitle ? <span className="subtitle">{subtitle}</span> : null}
        </div>
        {tagline ? <div className="tagline">{tagline}</div> : null}
      </div>
      <div className="actions">{right}{scan ? <ScanButton /> : null}</div>
    </header>
  );
}

/** The 36/44px tinted icon square used in page titles and card heads. */
export const IconSquare = ({ name, color, large = false, children, style }) => (
  <div className={large ? 'icon-sq lg' : 'icon-sq'} style={{ background: tint(color), color, ...style }}>
    {children ?? <Icon name={name} />}
  </div>
);

export function BacktestBadge({ data }) {
  const items = data?.items || [];
  const it = items.find(i => i?.backtest?.orbit_signal?.flagged) || items.find(i => i?.backtest?.flagged);
  if (!it) return null;
  const bt = it.backtest;
  const txt = isNum(bt.lead_months)
    ? `Backtest: would have flagged it ${bt.lead_months} months early`
    : `Backtest ${monthLabel(bt.as_of, true)}: would have flagged it early`;
  return <div className="backtest"><Icon name="history" /><span>{txt}</span></div>;
}

/** Module top bar per design: breadcrumb, 44px tinted icon square, title, backtest badge, Scan now. */
export function ModuleHeader({ moduleId, data, right }) {
  const meta = MODULE_META[moduleId] || { name: data?.module?.name || moduleId };
  const accent = ACCENT[moduleId] || data?.module?.color || '#A8A29E';
  return (
    <Topbar
      crumb={`Modules  /  ${meta.name}`}
      title={meta.name}
      iconSquare={<IconSquare name={MODULE_ICON[moduleId] || 'circle'} color={accent} large />}
      right={<><BacktestBadge data={data} />{right}</>}
    />
  );
}

/** Live pill ("Updated 3 mins ago"). */
export const LivePill = ({ children }) => <Badge variant="live">{children}</Badge>;

let audio = null;
/** Play/stop the Gemini TTS briefing. */
export function BriefingButton({ label = 'Play briefing', className = 'btn dark' }) {
  const [mode, setMode] = useState(() => (audio && !audio.paused ? 'playing' : 'idle'));
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const onClick = useCallback(async () => {
    if (audio && !audio.paused) { audio.pause(); audio.currentTime = 0; setMode('idle'); return; }
    setMode('loading');
    try {
      audio = audio || new Audio('/api/briefing');
      audio.onended = () => alive.current && setMode('idle');
      audio.onerror = () => { console.warn('[briefing] unavailable'); if (alive.current) setMode('error'); audio = null; };
      await audio.play();
      setMode('playing');
    } catch (e) { console.warn('[briefing]', e); setMode('idle'); }
  }, []);

  const face = {
    idle: [<Icon key="i" name="play" />, label],
    loading: [<Icon key="i" name="loader" className="spin" />, 'Loading briefing…'],
    playing: [<Icon key="i" name="square" />, 'Stop briefing'],
    error: [<Icon key="i" name="volume-x" />, 'Briefing unavailable'],
  }[mode];

  return <button className={className} onClick={onClick}>{face}</button>;
}
