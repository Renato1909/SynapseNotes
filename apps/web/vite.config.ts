import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy para o Worker em desenvolvimento.
// Padrão: wrangler dev local na porta 8787 (requer o workerd local).
// Para desenvolver contra o Worker publicado — util em maquinas afetadas
// pelo bug cloudflare/workerd#4668 — aponte o proxy para a URL publicada:
//   $env:SYNAPSE_PROXY_TARGET='https://<worker>.workers.dev'
//   npm run dev:web
const target = process.env.SYNAPSE_PROXY_TARGET || 'http://127.0.0.1:8787';
const wsTarget = target.replace(/^http/, 'ws');
const remote = target.startsWith('https');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // changeOrigin em https: o Host precisa bater com o dominio do Worker.
      '/api': {
        target,
        changeOrigin: remote
      },
      '/collab': {
        target: wsTarget,
        ws: true,
        changeOrigin: remote
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});
