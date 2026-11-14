import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/assets': server,
      '/ws': { target: server, ws: true },
    },
  },
  // The server serves the sample library at /assets, so the app bundle goes under /app.
  build: { outDir: '../dist', emptyOutDir: true, assetsDir: 'app' },
});
