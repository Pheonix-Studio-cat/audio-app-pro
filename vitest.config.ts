import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom stellt DOMParser, Blob und Canvas-Stubs bereit, die einige
    // Exportfunktionen brauchen. Die reinen DSP-Tests laufen ebenfalls darin.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
