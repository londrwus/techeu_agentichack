// Orbit SPA shell: sidebar + router + the shared tooltip/toast layer.
// Routes: /earth (default) /overview /groceries /latte /beer_wine /gpu /rent /mission /ask /news /track
// Clean URLs (BrowserRouter); the backend serves index.html for them. Old /#/earth-style links and
// bookmarks, and legacy /module/{id} paths, redirect onto the same screens.
import { Component, Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import Sidebar from '@/components/orbit/Sidebar.jsx';
import { Toaster } from '@/components/ui/sonner';
import { hideTip } from '@/lib/dom.jsx';
import { routeTick } from '@/lib/motion.js';
import { closeLightbox } from '@/lib/lightbox.js';
import { setNavigate } from '@/lib/nav.js';

// Each screen is its own chunk, so the shell paints before ECharts / MapLibre are parsed.
const Earth = lazy(() => import('@/views/Earth.jsx'));
const Overview = lazy(() => import('@/views/Overview.jsx'));
const Groceries = lazy(() => import('@/views/Groceries.jsx'));
const Latte = lazy(() => import('@/views/Latte.jsx'));
const BeerWine = lazy(() => import('@/views/BeerWine.jsx'));
const Gpu = lazy(() => import('@/views/Gpu.jsx'));
const Rent = lazy(() => import('@/views/Rent.jsx'));
const Mission = lazy(() => import('@/views/Mission.jsx'));
const Ask = lazy(() => import('@/views/Ask.jsx'));
const News = lazy(() => import('@/views/News.jsx'));
const TrackRecord = lazy(() => import('@/views/TrackRecord.jsx'));

const VIEWS = {
  earth: Earth, overview: Overview, groceries: Groceries, latte: Latte, beer_wine: BeerWine,
  gpu: Gpu, rent: Rent, mission: Mission, ask: Ask, news: News, track: TrackRecord,
};
// Views whose content fills the whole content area edge-to-edge.
const FULL_BLEED = new Set(['earth']);

// Keyed by route, so a new screen always gets a fresh boundary.
class Boundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error('[render]', err); }
  render() {
    if (this.state.failed) return <div className="empty">This view hit a snag. Data may still be building.</div>;
    return this.props.children;
  }
}

/** One routed screen inside the shared `.page` wrapper (so the motion layer can animate it). */
function Page({ name }) {
  const View = VIEWS[name] || Earth;
  const full = FULL_BLEED.has(name);
  useEffect(() => {
    hideTip();
    closeLightbox();
    routeTick();
    document.body.classList.toggle('full-bleed', full);
    document.body.dataset.view = name;
    document.getElementById('view')?.scrollTo?.(0, 0);
  }, [name, full]);
  return (
    <div className={full ? 'page full' : 'page'} key={name}>
      <Boundary key={name}><Suspense fallback={null}><View /></Suspense></Boundary>
    </div>
  );
}

/** Legacy /module/{id} → /{id} */
function LegacyModule() {
  const { id } = useParams();
  return <Navigate to={`/${VIEWS[id] ? id : 'earth'}`} replace />;
}

/** Hands navigate() to code outside components, and turns any "#/x" (old links, bookmarks) into "/x". */
function RouterBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setNavigate(navigate);
    const fromHash = () => {
      const h = window.location.hash;
      if (h.startsWith('#/')) navigate(decodeURIComponent(h.slice(1)), { replace: true });
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [navigate]);
  return null;
}

function Shell() {
  const { pathname } = useLocation();
  useEffect(() => { hideTip(); }, [pathname]);
  return (
    <>
      <RouterBridge />
      <Sidebar />
      <main id="view" className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/earth" replace />} />
          <Route path="/module/:id" element={<LegacyModule />} />
          {Object.keys(VIEWS).map(name => (
            <Route key={name} path={`/${name}`} element={<Page name={name} />} />
          ))}
          {/* /mission/scan starts a scan on arrival; /ask/<question> asks it straight away. */}
          <Route path="/mission/:arg" element={<Page name="mission" />} />
          <Route path="/ask/:arg" element={<Page name="ask" />} />
          <Route path="*" element={<Navigate to="/earth" replace />} />
        </Routes>
      </main>
      <Toaster position="bottom-center" toastOptions={{ unstyled: true, classNames: { toast: 'toast' } }} />
      <div id="tooltip" className="tooltip" hidden />
    </>
  );
}

export default function App() {
  return <BrowserRouter><Shell /></BrowserRouter>;
}
