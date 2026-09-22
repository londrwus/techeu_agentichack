// The fixed left rail. Same markup as the vanilla shell; NavLink now drives the active state.
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Icon } from '@/lib/icons.jsx';
import { api } from '@/lib/api.js';
import { useScan } from '@/lib/scan.jsx';

const NAV = [
  { label: 'Workspace' },
  { to: '/earth', icon: 'globe', text: 'Earth' },
  { to: '/overview', icon: 'layout-dashboard', text: 'Overview' },
  { label: 'Modules' },
  { to: '/groceries', icon: 'shopping-basket', text: 'Groceries', dot: 'var(--m-groceries)' },
  { to: '/latte', icon: 'coffee', text: 'Latte Index', dot: 'var(--m-latte)' },
  { to: '/beer_wine', icon: 'wine', text: 'Beer & Wine', dot: 'var(--m-beer)' },
  { to: '/gpu', icon: 'cpu', text: 'GPU & Gadgets', dot: 'var(--m-gpu)' },
  { to: '/rent', icon: 'building-2', text: 'Rent Radar', dot: 'var(--m-rent)' },
  { label: 'Agents' },
  { to: '/ask', icon: 'sparkles', text: 'Ask Orbit' },
  { to: '/news', icon: 'newspaper', text: 'News hub' },
  { to: '/mission', icon: 'radar', text: 'Mission Control', live: true },
  { to: '/track', icon: 'target', text: 'Track record' },
];

export default function Sidebar() {
  const { running } = useScan();
  const [regions, setRegions] = useState(16);

  useEffect(() => {
    let alive = true;
    Promise.all(['groceries', 'latte', 'beer_wine', 'gpu'].map(m => api(`/api/modules/${m}`).catch(() => null)))
      .then(ms => {
        const ids = new Set(ms.flatMap(m => (m?.regions || []).map(r => r.region_id)));
        if (alive && ids.size) setRegions(ids.size);
      });
    return () => { alive = false; };
  }, []);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-tile"><Icon name="orbit" /></div>
        <div>
          <div className="brand-name">Orbit</div>
          <div className="brand-sub">Commodity intelligence</div>
        </div>
      </div>
      <nav>
        {NAV.map((n, i) => n.label
          ? <div className="nav-label" key={`l${i}`}>{n.label}</div>
          : (
            <NavLink
              key={n.to}
              to={n.to}
              title={n.text}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon name={n.icon} />
              <span>{n.text}</span>
              {n.dot ? <b className="dot" style={{ background: n.dot }} /> : null}
              {n.live && running ? <b className="dot live-dot" /> : null}
            </NavLink>
          ))}
      </nav>
      <div className="side-foot">
        <div className="side-foot-title">Gemini sees · Jev judges · Modal scales</div>
        <div className="side-foot-sub">{regions} satellite regions watched</div>
      </div>
    </aside>
  );
}
