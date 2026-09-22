import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';
import { installMotion } from './lib/motion.js';
import { installLightbox } from './lib/lightbox.js';
import App from './App.jsx';

// Old hash links (/#/news, bookmarks, the pitch deck) -> clean paths, before the router's first render
// (otherwise the "/" -> "/earth" redirect would win and drop the hash).
if (window.location.hash.startsWith('#/')) {
  window.history.replaceState(null, '', decodeURIComponent(window.location.hash.slice(1)) + window.location.search);
}

installMotion();
installLightbox();

// No <StrictMode>: the map/chart views own imperative instances, and the dev-only
// double-invoked effects would initialise MapLibre and the ECharts instances twice.
createRoot(document.getElementById('root')).render(<App />);
