import { defineConfig } from 'vite';

const crossOriginHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',

  server: {
    port: 5173,
    headers: crossOriginHeaders,
    allowedHosts: [
      'voxeland-production.up.railway.app',
      'voceland.greninja.xyz',
    ],
  },

  preview: {
    headers: crossOriginHeaders,
  },

  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },

  worker: {
    format: 'es',
  },
});