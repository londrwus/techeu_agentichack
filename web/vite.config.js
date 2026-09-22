import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Orbit React front-end: two pages, the dashboard (index.html -> "/") and the landing splash
// (landing.html -> "/landing"). Built into ../frontend_react/ and served by FastAPI.
// public/ (product photos under static/, the globe texture under globe/) is copied as-is.
// In dev (`npm run dev`) the API and satellite tiles are proxied to the local backend.
const API = process.env.ORBIT_API || 'http://127.0.0.1:8010'

// Dev only: serve the landing entry at /landing, like the backend does in production.
const landingRoute = {
  name: 'orbit-landing-route',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/landing' || req.url.startsWith('/landing?')) req.url = req.url.replace('/landing', '/landing.html');
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), landingRoute],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: {
    outDir: '../frontend_react',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        landing: path.resolve(import.meta.dirname, 'landing.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/api', '/tiles'].map(p => [p, { target: API, changeOrigin: true }])),
  },
})
