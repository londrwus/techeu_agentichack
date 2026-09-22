import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Orbit React front-end. Built into ../frontend_react/ and served by FastAPI at "/".
// In dev (`npm run dev`) the API, tiles and shared image assets are proxied to the local backend.
const API = process.env.ORBIT_API || 'http://127.0.0.1:8010'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: { outDir: '../frontend_react', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/api', '/tiles', '/static'].map(p => [p, { target: API, changeOrigin: true }])),
  },
})
