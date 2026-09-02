/** Einstiegspunkt der Anwendung. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './ui/app-state';
import { App } from './ui/App';
import { loadNotationFonts } from './engines/notation/fonts';
import './ui/styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Das Wurzelelement #root wurde nicht gefunden.');

/**
 * Die Notenschriften werden vor dem ersten Rendern geladen. Ohne sie waeren
 * Notenkoepfe, Schluessel und Pausen unsichtbar. Sie kommen von der eigenen
 * Herkunft, nicht von einem CDN.
 */
void loadNotationFonts().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </StrictMode>,
  );
});
