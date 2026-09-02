/**
 * Kopiert die grossen Laufzeitdateien aus node_modules nach public/.
 *
 * 1. Den ffmpeg.wasm-Kern nach public/ffmpeg.
 * 2. Die Notenschriftarten Bravura und Academico nach public/fonts.
 *
 * Damit wird der Kern von der eigenen Herkunft (Origin) ausgeliefert und
 * nicht von einem CDN. Das ist wichtig fuer den Datenschutz: die Mediendatei
 * des Nutzers verlaesst den Rechner nie, und es wird keine Verbindung zu
 * einem Drittanbieter aufgebaut.
 *
 * Die Dateien sind zusammen rund 32 MB gross und liegen deshalb nicht im
 * Repository, sondern werden vor jedem Build erzeugt.
 */
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
const target = join(root, 'public', 'ffmpeg');

const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

if (!existsSync(source)) {
  console.warn(
    '[ffmpeg] @ffmpeg/core wurde nicht gefunden. Die Videokonvertierung ueber ' +
      'ffmpeg.wasm steht dann nicht zur Verfuegung; die App nutzt die ' +
      'Browser-Dekodierung als Alternative.',
  );
} else {
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    const from = join(source, file);
    if (!existsSync(from)) {
      console.warn(`[ffmpeg] ${file} fehlt in @ffmpeg/core.`);
      continue;
    }
    copyFileSync(from, join(target, file));
    console.log(`[ffmpeg] ${file} nach public/ffmpeg kopiert.`);
  }
}

// --- Notenschriftarten ---

/**
 * VexFlow wuerde seine Schriften sonst von einem oeffentlichen CDN laden.
 * Damit die App offline funktioniert und keine externe Verbindung aufbaut,
 * werden sie mit ausgeliefert.
 */
const fontTarget = join(root, 'public', 'fonts');
const fontSources = [
  ['@vexflow-fonts/bravura', 'bravura.woff2'],
  ['@vexflow-fonts/academico', 'academico.woff2'],
  ['@vexflow-fonts/academico', 'academico-bold.woff2'],
];

mkdirSync(fontTarget, { recursive: true });
for (const [packageName, file] of fontSources) {
  const from = join(root, 'node_modules', packageName, file);
  if (!existsSync(from)) {
    console.warn(`[fonts] ${file} fehlt in ${packageName}.`);
    continue;
  }
  copyFileSync(from, join(fontTarget, file));
  console.log(`[fonts] ${file} nach public/fonts kopiert.`);
}
