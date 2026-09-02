/**
 * Lokales Laden der Notenschriftarten.
 *
 * WICHTIG: VexFlow laedt seine Schriften standardmaessig von einem
 * oeffentlichen CDN (jsdelivr). Das waere ein Verstoss gegen die Zusage,
 * dass die App keine externen Dienste kontaktiert - und die App wuerde
 * ohne Internetverbindung keine Noten anzeigen. Deshalb werden die
 * Schriftdateien mit ausgeliefert und von der eigenen Herkunft geladen.
 *
 * Die Schriften sind:
 *   - Bravura (SIL Open Font License 1.1) - die Notenzeichen
 *   - Academico (SIL Open Font License 1.1) - Text im Notenbild
 */
import { Font } from 'vexflow';

/** Basis-Pfad, unter dem die Schriften ausgeliefert werden. */
const FONT_BASE = `${import.meta.env.BASE_URL ?? '/'}fonts/`.replace(/\/+/g, '/');

const FONT_FILES: Array<{ name: string; file: string; weight?: string }> = [
  { name: 'Bravura', file: 'bravura.woff2' },
  { name: 'Academico', file: 'academico.woff2' },
  { name: 'Academico', file: 'academico-bold.woff2', weight: 'bold' },
];

let loadPromise: Promise<void> | null = null;

/**
 * Laedt die Notenschriften einmalig von der eigenen Herkunft.
 * Muss abgeschlossen sein, bevor Noten gezeichnet werden.
 */
export function loadNotationFonts(): Promise<void> {
  if (loadPromise) return loadPromise;

  // Den CDN-Pfad ueberschreiben, damit VexFlow keine externe Anfrage stellt.
  Font.HOST_URL = FONT_BASE;
  Font.FILES = {
    Bravura: 'bravura.woff2',
    Academico: 'academico.woff2',
    Petaluma: 'bravura.woff2',
    'Petaluma Script': 'academico.woff2',
    Gonville: 'bravura.woff2',
  } as typeof Font.FILES;

  loadPromise = (async () => {
    await Promise.all(
      FONT_FILES.map(({ name, file, weight }) =>
        Font.load(name, `${FONT_BASE}${file}`, weight ? { weight } : undefined).catch(
          (error: unknown) => {
            console.error(`Die Schriftart ${name} konnte nicht geladen werden:`, error);
          },
        ),
      ),
    );
    // Sicherstellen, dass der Browser die Schriften wirklich bereitstellt.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      await document.fonts.ready;
    }
  })();

  return loadPromise;
}

/** Sind die Notenschriften einsatzbereit? */
export function areNotationFontsReady(): boolean {
  if (typeof document === 'undefined' || !document.fonts?.check) return false;
  return document.fonts.check('30px Bravura');
}

/**
 * Liest die Schriftdateien als Data-URI ein.
 *
 * Wird fuer den Bildexport gebraucht: ein herausgeloestes SVG kann keine
 * Schrift ueber einen relativen Pfad nachladen, deshalb wird sie direkt
 * in das Dokument eingebettet.
 */
let embeddedCssPromise: Promise<string> | null = null;

export function getEmbeddedFontCss(): Promise<string> {
  if (embeddedCssPromise) return embeddedCssPromise;

  embeddedCssPromise = (async () => {
    const parts: string[] = [];
    for (const { name, file, weight } of FONT_FILES) {
      try {
        const response = await fetch(`${FONT_BASE}${file}`);
        if (!response.ok) continue;
        const buffer = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < buffer.length; i += chunk) {
          binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
        }
        const base64 = btoa(binary);
        parts.push(
          `@font-face{font-family:'${name}';` +
            `src:url(data:font/woff2;base64,${base64}) format('woff2');` +
            `font-weight:${weight ?? 'normal'};font-style:normal;}`,
        );
      } catch (error) {
        console.error(`Die Schriftart ${name} konnte nicht eingebettet werden:`, error);
      }
    }
    return parts.join('');
  })();

  return embeddedCssPromise;
}
