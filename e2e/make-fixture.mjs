/**
 * Erzeugt eine Test-Audiodatei mit bekannter Melodie.
 *
 * Damit laesst sich der gesamte Weg von der Datei bis zur Notenschrift
 * pruefen: die erwarteten Noten sind bekannt, also ist objektiv messbar,
 * ob die Analyse richtig liegt.
 *
 * Melodie: C4 D4 E4 F4 G4 A4 H4 C5, je eine Viertelnote bei 120 BPM.
 */
import { writeFileSync } from 'node:fs';

const SAMPLE_RATE = 44100;
const BPM = 120;
const NOTE_SECONDS = 60 / BPM; // eine Viertel
const MELODY = [60, 62, 64, 65, 67, 69, 71, 72];

/** MIDI-Nummer zu Frequenz. */
const frequency = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

const totalSamples = Math.round(MELODY.length * NOTE_SECONDS * SAMPLE_RATE);
const samples = new Float32Array(totalSamples);

MELODY.forEach((midi, index) => {
  const f0 = frequency(midi);
  const start = Math.round(index * NOTE_SECONDS * SAMPLE_RATE);
  const length = Math.round(NOTE_SECONDS * SAMPLE_RATE);

  for (let i = 0; i < length && start + i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    // Klang mit Obertoenen, damit es einem echten Instrument aehnelt.
    let value = 0;
    for (let h = 1; h <= 6; h++) value += Math.sin(2 * Math.PI * f0 * h * t) / h;
    value /= 2.5;

    // Huellkurve: schneller Anschlag, langsames Abklingen, sauberes Ende.
    const progress = i / length;
    const attack = Math.min(1, progress / 0.02);
    const decay = Math.exp(-2.2 * progress);
    const release = progress > 0.85 ? (1 - progress) / 0.15 : 1;
    samples[start + i] = value * attack * decay * release * 0.7;
  }
});

/** Schreibt 16-Bit-Mono-WAV. */
function encodeWav(data, sampleRate) {
  const buffer = Buffer.alloc(44 + data.length * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + data.length * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) {
    const clamped = Math.max(-1, Math.min(1, data[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

const outputPath = new URL('./fixtures/tonleiter.wav', import.meta.url);
writeFileSync(outputPath, encodeWav(samples, SAMPLE_RATE));
console.log(
  `Testdatei geschrieben: ${MELODY.length} Noten, ${BPM} BPM, ` +
    `${(totalSamples / SAMPLE_RATE).toFixed(2)} Sekunden.`,
);
