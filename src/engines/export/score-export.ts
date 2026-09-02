/**
 * Export der Partitur als PNG, JPG und PDF.
 *
 * Grundlage ist dasselbe VexFlow-SVG, das auch der Editor zeigt - der
 * Export nutzt also echte Notenschrift und nicht etwa einen Screenshot.
 * Das SVG wird in ein Canvas gerastert (PNG/JPG) beziehungsweise als
 * Bild in ein jsPDF-Dokument eingebettet (PDF).
 */
import { jsPDF } from 'jspdf';
import type { Score } from '../../core/types';
import { renderScore } from '../notation/vexflow-renderer';

export type ImageFormat = 'png' | 'jpg';

export interface ScoreExportOptions {
  /** Aufloesung: 2 = doppelte Pixeldichte, sinnvoll fuer den Druck. */
  scale: number;
  /** Breite des Notenbildes in Punkten vor der Skalierung. */
  width: number;
  /** Takte pro Zeile; 0 = automatisch. */
  measuresPerLine: number;
  /** Hintergrundfarbe (JPG kennt keine Transparenz). */
  background: string;
}

export const DEFAULT_EXPORT_OPTIONS: ScoreExportOptions = {
  scale: 2,
  width: 1000,
  measuresPerLine: 4,
  background: '#ffffff',
};

/**
 * Rendert die gesamte Partitur in ein unsichtbares Element und liefert
 * das SVG als Text zurueck.
 */
export function renderScoreToSvg(
  score: Score,
  options: Partial<ScoreExportOptions> = {},
): { svg: string; width: number; height: number } {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options };

  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-99999px';
  container.style.top = '0';
  container.style.width = `${opts.width}px`;
  document.body.appendChild(container);

  try {
    const result = renderScore(container, score, {
      width: opts.width,
      measuresPerLine: opts.measuresPerLine,
      printMode: true,
      highlightUncertain: false,
      selection: [],
      playbackPosition: null,
    });

    const svgElement = container.querySelector('svg');
    if (!svgElement) throw new Error('Das Notenbild konnte nicht erzeugt werden.');

    // Attribute setzen, damit das SVG eigenstaendig darstellbar ist.
    svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgElement.setAttribute('width', String(opts.width));
    svgElement.setAttribute('height', String(result.height));
    svgElement.setAttribute('viewBox', `0 0 ${opts.width} ${result.height}`);

    // Weisser Hintergrund, damit der Export nicht transparent wirkt.
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('x', '0');
    background.setAttribute('y', '0');
    background.setAttribute('width', String(opts.width));
    background.setAttribute('height', String(result.height));
    background.setAttribute('fill', opts.background);
    svgElement.insertBefore(background, svgElement.firstChild);

    return {
      svg: new XMLSerializer().serializeToString(svgElement),
      width: opts.width,
      height: result.height,
    };
  } finally {
    document.body.removeChild(container);
  }
}

/** Zeichnet ein SVG in ein Canvas. */
async function svgToCanvas(
  svg: string,
  width: number,
  height: number,
  scale: number,
  background: string,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas wird von diesem Browser nicht unterstuetzt.');

  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  // Als Data-URL laden: vermeidet Probleme mit dem Canvas-Sicherheitsmodell.
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Das Notenbild konnte nicht geladen werden.'));
    image.src = encoded;
  });

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Exportiert die Partitur als PNG oder JPG. */
export async function exportScoreImage(
  score: Score,
  format: ImageFormat,
  options: Partial<ScoreExportOptions> = {},
): Promise<Blob> {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options };
  const { svg, width, height } = renderScoreToSvg(score, opts);
  const canvas = await svgToCanvas(svg, width, height, opts.scale, opts.background);

  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = format === 'jpg' ? 0.92 : undefined;

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Das Bild konnte nicht erzeugt werden.'));
      },
      mimeType,
      quality,
    );
  });
}

export interface PdfExportOptions extends ScoreExportOptions {
  /** Seitenformat. */
  pageFormat: 'a4' | 'letter';
  orientation: 'portrait' | 'landscape';
  /** Seitenrand in Millimetern. */
  margin: number;
}

export const DEFAULT_PDF_OPTIONS: PdfExportOptions = {
  ...DEFAULT_EXPORT_OPTIONS,
  scale: 2.5,
  pageFormat: 'a4',
  orientation: 'portrait',
  margin: 15,
};

/**
 * Exportiert die komplette Partitur als PDF.
 *
 * Ist das Notenbild hoeher als eine Seite, wird es ueber mehrere Seiten
 * verteilt. Dadurch geht kein Takt verloren.
 */
export async function exportScorePdf(
  score: Score,
  options: Partial<PdfExportOptions> = {},
): Promise<Blob> {
  const opts = { ...DEFAULT_PDF_OPTIONS, ...options };

  const pdf = new jsPDF({
    orientation: opts.orientation,
    unit: 'mm',
    format: opts.pageFormat,
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - opts.margin * 2;
  const contentHeight = pageHeight - opts.margin * 2;

  const { svg, width, height } = renderScoreToSvg(score, opts);
  const canvas = await svgToCanvas(svg, width, height, opts.scale, opts.background);

  // Millimeter pro Bildpixel, damit die Breite genau passt.
  const mmPerPixel = contentWidth / canvas.width;
  const totalHeightMm = canvas.height * mmPerPixel;
  const pageCount = Math.max(1, Math.ceil(totalHeightMm / contentHeight));
  // Pixelhoehe eines Seitenausschnitts.
  const sliceHeightPx = Math.floor(contentHeight / mmPerPixel);

  for (let page = 0; page < pageCount; page++) {
    if (page > 0) pdf.addPage();

    const sourceY = page * sliceHeightPx;
    const remainingPx = canvas.height - sourceY;
    if (remainingPx <= 0) break;
    const currentSliceHeight = Math.min(sliceHeightPx, remainingPx);

    // Ausschnitt in ein eigenes Canvas kopieren.
    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = currentSliceHeight;
    const sliceContext = sliceCanvas.getContext('2d');
    if (!sliceContext) throw new Error('Canvas wird von diesem Browser nicht unterstuetzt.');
    sliceContext.fillStyle = opts.background;
    sliceContext.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
    sliceContext.drawImage(
      canvas,
      0, sourceY, canvas.width, currentSliceHeight,
      0, 0, canvas.width, currentSliceHeight,
    );

    pdf.addImage(
      sliceCanvas.toDataURL('image/png'),
      'PNG',
      opts.margin,
      opts.margin,
      contentWidth,
      currentSliceHeight * mmPerPixel,
    );
  }

  return pdf.output('blob');
}

/** Loest den Download einer Datei im Browser aus. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Freigabe verzoegern, damit der Download sicher gestartet ist.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Erzeugt einen dateisystemfreundlichen Namen. */
export function safeFileName(name: string, extension: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N}\s._-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${cleaned || 'partitur'}.${extension}`;
}
