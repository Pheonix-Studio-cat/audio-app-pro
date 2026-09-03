import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  /**
   * Basis-Pfad der Auslieferung.
   *
   * Lokal laeuft die App unter "/". Auf GitHub Pages liegt sie in einem
   * Unterverzeichnis mit dem Namen des Repositories, deshalb setzt der
   * Deploy-Workflow VITE_BASE entsprechend.
   */
  base: process.env.VITE_BASE || '/',
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
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // VexFlow bringt die Notenschriftarten mit und ist deshalb gross.
        // Als eigener Chunk kann der Browser es unabhaengig zwischenspeichern.
        manualChunks: {
          vexflow: ['vexflow'],
          react: ['react', 'react-dom', 'react-dom/client'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
