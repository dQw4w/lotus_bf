import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: `npm run dev` proxies /api (and /docs) to the FastAPI backend on :8000.
// Prod: the Dockerfile builds dist/ and FastAPI serves it at /.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_TARGET || 'http://localhost:8000',
      '/docs': process.env.API_TARGET || 'http://localhost:8000',
      '/openapi.json': process.env.API_TARGET || 'http://localhost:8000',
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
})
