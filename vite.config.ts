import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Cross-Origin-Isolation erlaubt SharedArrayBuffer (multithreaded ffmpeg.wasm).
    // Die App funktioniert auch ohne, dann wird der single-threaded Pfad genutzt.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
});
