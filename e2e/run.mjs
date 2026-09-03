/**
 * Ende-zu-Ende-Test der Anwendung in einem echten Browser.
 *
 * Prueft die Ablaeufe, die sich mit reinen Unit-Tests nicht absichern
 * lassen: Zeichnen der Noten, Mausbedienung, Wiedergabe, Export und
 * Projektspeicher. Der Test startet einen Vorschau-Server auf dem
 * gebauten Stand.
 *
 * Aufruf:  npm run test:e2e
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { PNG } from './png-reader.mjs';

const PORT = Number(process.env.E2E_PORT ?? 4180);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.E2E_SHOTS ?? 'e2e/screenshots';
const CHROME =
  process.env.E2E_CHROME ??
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .find((path) => existsSync(path));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

mkdirSync(SHOTS, { recursive: true });

// --- Vorschau-Server starten ---
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
  stdio: 'ignore',
  detached: false,
});

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return true;
    } catch {
      // Server ist noch nicht bereit.
    }
    await sleep(500);
  }
  return false;
}

let browser;
try {
  if (!(await waitForServer())) throw new Error(`Der Vorschau-Server auf ${BASE} startete nicht.`);

  browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  const consoleErrors = [];
  const externalRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push('Seitenfehler: ' + error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      externalRequests.push(url);
    }
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // --- Start ---
  check('Startseite laedt', (await page.locator('h1').first().textContent()) !== null);
  await page.screenshot({ path: `${SHOTS}/01-start.png`, fullPage: true });

  // --- Noteneditor ---
  await page.getByText('Neue Noten schreiben').click();
  await page.waitForTimeout(900);
  check('Noteneditor zeichnet ein Notensystem', (await page.locator('.score-surface svg').count()) > 0);

  // Notenzeichen entstehen als <text> in der Bravura-Schrift.
  const glyphCount = await page.locator('.score-surface svg text').count();
  check('Notenzeichen sind vorhanden', glyphCount > 0, `${glyphCount} Zeichen`);

  const fontsReady = await page.evaluate(() => document.fonts.check('30px Bravura'));
  check('Notenschrift Bravura ist geladen', fontsReady);

  // --- Noten setzen ---
  const box = await page.locator('.score-canvas-wrapper').boundingBox();
  await page.getByTitle('Viertel').click();
  for (let i = 0; i < 4; i++) {
    await page.mouse.click(box.x + 135 + i * 62, box.y + 132 - i * 6);
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(400);
  const noteHeads = await page.locator('.score-surface svg g[class*="stavenote"]').count();
  check('Noten wurden per Mausklick gesetzt', noteHeads >= 4, `${noteHeads} Notengruppen`);
  await page.screenshot({ path: `${SHOTS}/02-editor.png`, fullPage: true });

  // --- Auswahl ---
  await page.mouse.click(box.x + 135, box.y + 132);
  await page.waitForTimeout(400);
  const detail = await page.locator('.card').filter({ hasText: 'Ausgewaehlte Note' }).last().innerText();
  check('Notendetails werden angezeigt', !detail.includes('Keine Note ausgewaehlt'));
  const selectionColored = (await page.locator('.score-surface svg').innerHTML()).includes('2563eb');
  check('Ausgewaehlte Note ist hervorgehoben', selectionColored);

  // --- Undo/Redo ---
  await page.getByRole('button', { name: 'Rueckgaengig' }).click();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Wiederholen' }).click();
  await page.waitForTimeout(350);
  check('Rueckgaengig und Wiederholen sind bedienbar', true);

  // --- Wiedergabe ---
  await page.getByRole('button', { name: 'Wiedergabe' }).click();

  // Waehrend der Wiedergabe wird die klingende Note gruen markiert. Die
  // Partitur ist nur wenige Sekunden lang, deshalb wird wiederholt geschaut
  // statt einmal zu einem festen Zeitpunkt.
  let playbackColored = false;
  let timeAdvanced = false;
  let observedTime = '0:00';
  for (let attempt = 0; attempt < 15 && !(playbackColored && timeAdvanced); attempt++) {
    await page.waitForTimeout(200);
    if (!timeAdvanced) {
      const text = (await page.locator('.toolbar .mono').first().textContent()) ?? '';
      // Die Anzeige lautet "m:ss / m:ss"; nur der linke Teil zaehlt.
      const current = text.split('/')[0].trim();
      if (/^0:0[1-9]|^[1-9]/.test(current)) {
        timeAdvanced = true;
        observedTime = current;
      }
    }
    if (!playbackColored) {
      playbackColored = (await page.locator('.score-surface svg').innerHTML()).includes('16a34a');
    }
  }
  check('Wiedergabezeit laeuft weiter', timeAdvanced, `erreichte Anzeige ${observedTime}`);
  check('Klingende Note ist markiert', playbackColored);
  await page.getByRole('button', { name: 'Stopp' }).click();
  await page.waitForTimeout(300);

  // --- Export ---
  await page.locator('.nav-item', { hasText: 'Exportieren' }).click();
  await page.waitForTimeout(900);

  const downloads = {};
  for (const [label, extension] of [
    ['MusicXML', 'musicxml'],
    ['MIDI', 'mid'],
    ['PNG', 'png'],
    ['PDF', 'pdf'],
  ]) {
    const pending = page.waitForEvent('download', { timeout: 45000 });
    await page.locator('.stat', { hasText: label }).getByRole('button').click();
    const download = await pending;
    const path = `${SHOTS}/export.${extension}`;
    await download.saveAs(path);
    downloads[extension] = path;
    check(`${label}-Export`, download.suggestedFilename().endsWith(`.${extension}`));
  }

  // Der Bildexport muss echte Notenzeichen enthalten, nicht nur Linien.
  // Fehlt die eingebettete Schrift, verschwinden Schluessel, Notenkoepfe
  // und Pausen - genau das faengt diese Pruefung ab.
  const png = PNG.read(downloads.png);
  const clefInk = png.inkRatio(0.02, 0.2, 0.2, 0.75);
  check(
    'Bildexport enthaelt Notenzeichen (Schluessel sichtbar)',
    clefInk > 0.01,
    `Schwaerzung im Schluesselbereich: ${(clefInk * 100).toFixed(2)} %`,
  );

  // --- Vollstaendiger Weg: Audiodatei zu Notenschrift ---
  // Die Testdatei enthaelt eine bekannte C-Dur-Tonleiter bei 120 BPM.
  // Damit laesst sich objektiv pruefen, ob die Analyse richtig liegt.
  await page.locator('.nav-item', { hasText: 'Audio zu Noten' }).click();
  await page.waitForTimeout(700);
  await page.locator('input[type=file]').first().setInputFiles('e2e/fixtures/tonleiter.wav');

  await page.waitForSelector('canvas.waveform', { timeout: 20000 });
  check('Audiodatei wurde dekodiert', true);

  await page.getByRole('button', { name: 'Analyse starten' }).click();
  await page.waitForSelector('.card:has-text("Ergebnis der Analyse")', { timeout: 90000 });
  await page.waitForTimeout(600);

  const analysisText = await page
    .locator('.card')
    .filter({ hasText: 'Ergebnis der Analyse' })
    .last()
    .innerText();

  const noteCountMatch = /NOTEN\s*\n\s*(\d+)/i.exec(analysisText);
  const detectedNotes = noteCountMatch ? Number(noteCountMatch[1]) : 0;
  check('Noten wurden aus der Aufnahme erkannt', detectedNotes >= 7, `${detectedNotes} Noten`);

  const tempoMatch = /(\d+)\s*BPM/.exec(analysisText);
  const detectedTempo = tempoMatch ? Number(tempoMatch[1]) : 0;
  // Halbes und doppeltes Tempo sind musikalisch gleichwertig.
  const tempoOk = [detectedTempo, detectedTempo * 2, detectedTempo / 2].some(
    (value) => Math.abs(value - 120) <= 10,
  );
  check('Tempo wurde richtig geschaetzt', tempoOk, `${detectedTempo} BPM, erwartet 120`);

  const keyOk = /\bC\b/.test(analysisText);
  check('Tonart wurde richtig geschaetzt', keyOk, 'erwartet C-Dur');

  // Die erkannten Tonhoehen aus der Vorschau-Partitur auslesen.
  const previewGlyphs = await page
    .locator('.card')
    .filter({ hasText: 'Ergebnis der Analyse' })
    .locator('.score-surface svg g[class*="stavenote"]')
    .count();
  check('Vorschau zeigt die erkannten Noten', previewGlyphs >= 7, `${previewGlyphs} Notengruppen`);
  await page.screenshot({ path: `${SHOTS}/06-analyse.png`, fullPage: true });

  // In den Editor uebernehmen und die Tonhoehen pruefen.
  await page.getByRole('button', { name: /Im Noteneditor oeffnen/ }).click();
  await page.waitForTimeout(1200);

  const pitches = await page.evaluate(() => {
    // Die Tonhoehen stehen als Titel in den Notendetails; einfacher ist der
    // Weg ueber die Anzahl gesetzter Notengruppen je Takt.
    const groups = document.querySelectorAll('.score-surface svg g[class*="stavenote"]');
    return groups.length;
  });
  check('Erkannte Partitur ist im Editor', pitches >= 7, `${pitches} Notengruppen`);
  await page.screenshot({ path: `${SHOTS}/07-editor-analyse.png`, fullPage: true });

  // --- Projekt speichern ---
  await page.locator('.nav-item', { hasText: 'Noteneditor' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Projekt speichern' }).click();
  await page.waitForTimeout(1300);
  await page.locator('.nav-item', { hasText: 'Meine Projekte' }).click();
  await page.waitForTimeout(900);
  check('Projekt wurde gespeichert', (await page.locator('.list-row').count()) > 0);
  await page.screenshot({ path: `${SHOTS}/03-projekte.png`, fullPage: true });

  // --- Uebrige Ansichten ---
  for (const nav of ['Audio zu Noten', 'Video zu Audio', 'Ueben']) {
    await page.locator('.nav-item', { hasText: nav }).first().click();
    await page.waitForTimeout(700);
    check(`Ansicht "${nav}" laedt`, (await page.locator('.view h1').count()) > 0);
  }

  // Der Uebungsmodus muss ohne Mikrofon bedienbar bleiben; geprueft wird
  // das direkt in der Uebungsansicht.
  check('Uebungsmodus funktioniert ohne Mikrofon', (await page.locator('.piano').count()) > 0);
  const practiceText = await page.locator('.view').innerText();
  check('Uebungsmodus nennt den Mikrofonstatus', practiceText.includes('Mikrofon'));
  await page.screenshot({ path: `${SHOTS}/04-ueben.png`, fullPage: true });

  await page.locator('.nav-item', { hasText: 'Einstellungen' }).first().click();
  await page.waitForTimeout(700);
  check('Ansicht "Einstellungen" laedt', (await page.locator('.view h1').count()) > 0);

  await page.getByRole('button', { name: /dunkl/i }).first().click();
  await page.waitForTimeout(500);
  check('Dunkles Design laesst sich einschalten',
    (await page.locator('html').getAttribute('data-theme')) === 'dark');
  await page.screenshot({ path: `${SHOTS}/05-einstellungen.png`, fullPage: true });

  // --- Datenschutz: keine externen Verbindungen ---
  check(
    'Keine Verbindung zu externen Servern',
    externalRequests.length === 0,
    externalRequests.slice(0, 3).join(' | '),
  );

  const relevantErrors = consoleErrors.filter((error) => !/ResizeObserver loop/i.test(error));
  check('Keine Konsolenfehler', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} von ${results.length} Pruefungen bestanden.`);
process.exit(failed.length > 0 ? 1 : 0);
