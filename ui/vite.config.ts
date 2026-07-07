import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is served by the admin server under <basePath>/ (default /_morpheus/).
// A relative base keeps asset URLs working regardless of the configured prefix.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // during `vite dev`, forward API calls to a locally running proxy admin server
      '/_morpheus/api': 'http://127.0.0.1:18081',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
