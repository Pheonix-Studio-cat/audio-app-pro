/**
 * Erzeugt eine Test-Videodatei mit Bild- und Tonspur.
 *
 * Auf dem Rechner ist kein vollstaendiges ffmpeg verfuegbar, deshalb wird
 * das Video im Browser aufgezeichnet: eine gezeichnete Bildspur plus die
 * bekannte Tonleiter als Tonspur. Damit laesst sich der Weg
 * "Video zu Audio zu Noten" mit einer echten Datei pruefen.
 *
 * Aufruf: node e2e/make-video-fixture.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CHROME =
  process.env.E2E_CHROME ??
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .find((path) => existsSync(path));

const wavBase64 = readFileSync('e2e/fixtures/tonleiter.wav').toString('base64');

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.goto('about:blank');

const base64Video = await page.evaluate(async (wav) => {
  // Tonspur aus der bekannten Tonleiter aufbauen.
  const bytes = Uint8Array.from(atob(wav), (character) => character.charCodeAt(0));
  const context = new AudioContext();
  const audioBuffer = await context.decodeAudioData(bytes.buffer);

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  const audioDestination = context.createMediaStreamDestination();
  source.connect(audioDestination);

  // Bildspur: ein einfaches, sich bewegendes Muster.
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const canvasContext = canvas.getContext('2d');
  const videoStream = canvas.captureStream(15);

  const combined = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...audioDestination.stream.getAudioTracks(),
  ]);

  const recorder = new MediaRecorder(combined, { mimeType: 'video/webm' });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });

  let frame = 0;
  const drawTimer = setInterval(() => {
    canvasContext.fillStyle = `hsl(${(frame * 4) % 360} 60% 30%)`;
    canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    canvasContext.fillStyle = '#fff';
    canvasContext.font = '24px sans-serif';
    canvasContext.fillText(`Testvideo ${frame}`, 20, 100);
    frame++;
  }, 66);

  recorder.start();
  source.start();

  await new Promise((resolve) => setTimeout(resolve, audioBuffer.duration * 1000 + 400));
  clearInterval(drawTimer);
  recorder.stop();
  await finished;

  const blob = new Blob(chunks, { type: 'video/webm' });
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < buffer.length; i += step) {
    binary += String.fromCharCode(...buffer.subarray(i, i + step));
  }
  return btoa(binary);
}, wavBase64);

await browser.close();

const outputPath = 'e2e/fixtures/testvideo.webm';
writeFileSync(outputPath, Buffer.from(base64Video, 'base64'));
console.log(`Testvideo geschrieben: ${outputPath}`);
