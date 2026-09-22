// Orbit landing (/landing): a 5–10 s demo opener. Headline on the left, the live Sentinel-2 globe
// on the right. Tailwind for layout, shadcn/ui for the CTA and stat pills.
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowRight } from 'lucide-react';
import Globe from './Globe.jsx';

// Cached numbers shown on the first frame; replaced by the live ones from the API.
const STATS = [
  { k: 'tiles', v: 1840, label: 'satellite tiles' },
  { k: 'jev', v: 142016, label: 'Jev judgments' },
  { k: 'dir', v: 65, label: 'direction right' },
];
const fmt = (v, k) => (k === 'dir' ? `${Math.round(v)}%` : v >= 100000 ? `${Math.round(v / 1000)}k` : Math.round(v).toLocaleString('en-GB'));

function useLiveStats(refs) {
  useEffect(() => {
    let alive = true;
    const get = u => fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null);
    Promise.all([get('/api/summary'), get('/api/leaderboard')]).then(([s, lb]) => {
      if (!alive) return;
      const st = s?.stats || {};
      const best = lb?.final?.name || 'orbit_v2';
      const test = (lb?.rows || []).find(r => r.method === best)?.test?.h6 || {};
      const dir = typeof test.dir_acc === 'number' ? test.dir_acc : lb?.improvement_vs_v1?.dir_acc?.[1];
      const live = { tiles: st.tiles_processed, jev: st.jev_judgments, dir: typeof dir === 'number' ? dir * 100 : null };
      STATS.forEach(({ k }, i) => {
        const el = refs.current[i], to = live[k];
        if (!el || typeof to !== 'number' || !(to > 0)) return;
        const t0 = performance.now(), d = 1300;
        const step = now => {
          const p = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - p, 3);
          el.textContent = fmt(to * e, k);
          if (p < 1 && alive) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    });
    return () => { alive = false; };
  }, [refs]);
}

export default function Landing() {
  const statRefs = useRef([]);
  useLiveStats(statRefs);

  return (
    <div className="ld relative h-dvh overflow-hidden text-slate-50">
      <div className="ld-stars" aria-hidden="true" />
      <Globe />

      <main className="ld-copy fixed top-1/2 left-[max(24px,7vw)] z-10 w-[min(46vw,640px)] -translate-y-1/2 max-md:top-[38%] max-md:right-6 max-md:w-auto">
        <div className="flex items-center gap-3 text-[22px] font-bold tracking-[-0.01em]">
          <span className="grid size-[34px] place-items-center rounded-[9px] bg-primary shadow-[0_6px_24px_-4px_#F9731688]">
            <svg viewBox="0 0 32 32" className="size-[22px]" aria-hidden="true">
              <g fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
                <circle cx="16" cy="16" r="3.4" />
                <path d="M22.8 9.2a9.6 9.6 0 0 1 0 13.6M9.2 22.8a9.6 9.6 0 0 1 0-13.6" />
              </g>
            </svg>
          </span>
          Orbit
        </div>

        <h1 className="mt-[clamp(28px,5vh,48px)] text-[clamp(40px,4.4vw,80px)] leading-none font-extrabold tracking-[-0.035em]">
          Satellite intelligence<br />
          <span className="bg-linear-to-r from-orange-300 via-primary to-orange-400 bg-clip-text text-transparent">for commodities.</span>
        </h1>

        <p className="mt-[clamp(16px,2.6vh,24px)] max-w-[30em] text-[clamp(16px,1.35vw,20px)] leading-[1.45] text-slate-400">
          Fully agentic: AI agents watch farms, reservoirs and data centres from orbit and forecast prices before markets move.
        </p>

        <div className="mt-[clamp(24px,4vh,36px)] flex flex-wrap gap-2.5">
          {STATS.map((s, i) => (
            <Badge
              key={s.k}
              variant="outline"
              className="gap-[7px] rounded-full border-white/10 bg-white/[0.04] px-[15px] py-[9px] text-sm font-normal text-slate-400 backdrop-blur-md"
            >
              <b ref={el => { statRefs.current[i] = el; }} className="text-[15px] font-bold text-white tabular-nums">{fmt(s.v, s.k)}</b>
              {s.label}
            </Badge>
          ))}
        </div>

        <div className="mt-[clamp(28px,4.6vh,44px)] flex flex-wrap items-center gap-6">
          <Button
            asChild
            size="lg"
            className="group h-auto gap-2.5 rounded-xl px-[26px] py-4 text-[17px] font-semibold shadow-[0_10px_30px_-8px_#F97316AA,inset_0_1px_0_#FFFFFF40] transition-[transform,box-shadow,background-color] hover:-translate-y-px hover:bg-[#FB8A3C] hover:shadow-[0_14px_36px_-8px_#F97316CC,inset_0_1px_0_#FFFFFF40]"
          >
            <a href="/earth">
              Open Orbit
              <ArrowRight size={18} strokeWidth={2.2} className="size-[18px] transition-transform group-hover:translate-x-[3px]" />
            </a>
          </Button>
          <div className="flex items-center gap-2.5 text-sm font-semibold text-slate-500">
            <span className="text-[#93B4F5]">Gemini</span>
            <i className="size-[3px] rounded-full bg-slate-600" />
            <span className="text-[#B9A3F5]">Jev</span>
            <i className="size-[3px] rounded-full bg-slate-600" />
            <span className="text-[#86D9A5]">Modal</span>
          </div>
        </div>
      </main>

      <p className="fixed right-4 bottom-3 z-10 text-[10px] text-slate-600">
        Sentinel-2 cloudless 2020 by EOX IT Services GmbH · CC BY-NC-SA 4.0
      </p>
    </div>
  );
}
