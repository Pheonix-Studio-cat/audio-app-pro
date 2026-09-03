/**
 * Tests der Tonhoehenerkennung mit synthetisch erzeugten Signalen.
 * So laesst sich objektiv pruefen, ob die Erkennung wirklich funktioniert.
 */
import { describe, expect, it } from 'vitest';
import { detectPitch, detectPitchYin, trackPitch } from '../engines/analysis/pitch-detection';
import { segmentNotes } from '../engines/analysis/note-segmentation';
import { frequencyToMidiFloat, midiToFrequency } from '../core/music-theory';

const SAMPLE_RATE = 22050;

/** Erzeugt einen Sinuston. */
function sine(frequency: number, seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  const samples = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return samples;
}

/** Erzeugt einen Klang mit Obertoenen (realistischer als ein reiner Sinus). */
function harmonicTone(
  frequency: number,
  seconds: number,
  harmonics = 6,
  sampleRate = SAMPLE_RATE,
): Float32Array {
  const samples = new Float32Array(Math.floor(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    let value = 0;
    for (let h = 1; h <= harmonics; h++) {
      value += Math.sin((2 * Math.PI * frequency * h * i) / sampleRate) / h;
    }
    // Abklingende Huellkurve wie bei einem angeschlagenen Instrument
    const envelope = Math.exp((-3 * i) / samples.length);
    samples[i] = (value / harmonics) * envelope;
  }
  return samples;
}

describe('YIN-Tonhoehenerkennung', () => {
  const testFrequencies = [110, 220, 261.63, 440, 880, 1318.51];

  for (const frequency of testFrequencies) {
    it(`erkennt einen Sinus bei ${frequency} Hz`, () => {
      const signal = sine(frequency, 0.2);
      const frame = signal.subarray(0, 2048);
      const result = detectPitchYin(frame, SAMPLE_RATE);
      const errorCents = Math.abs(1200 * Math.log2(result.frequency / frequency));
      expect(errorCents).toBeLessThan(15);
      expect(result.confidence).toBeGreaterThan(0.7);
    });
  }

  for (const frequency of [130.81, 246.94, 440, 659.26]) {
    it(`erkennt einen Klang mit Obertoenen bei ${frequency} Hz`, () => {
      const signal = harmonicTone(frequency, 0.3);
      const frame = signal.subarray(0, 2048);
      const result = detectPitch(frame, SAMPLE_RATE);
      const errorCents = Math.abs(1200 * Math.log2(result.frequency / frequency));
      expect(errorCents).toBeLessThan(25);
    });
  }

  it('meldet keine Tonhoehe bei Stille', () => {
    const silence = new Float32Array(2048);
    const result = detectPitchYin(silence, SAMPLE_RATE);
    expect(result.frequency).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it('meldet bei weissem Rauschen eine geringe Sicherheit', () => {
    const noise = new Float32Array(2048);
    let seed = 12345;
    for (let i = 0; i < noise.length; i++) {
      // Deterministischer Pseudozufall, damit der Test reproduzierbar ist
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const result = detectPitchYin(noise, SAMPLE_RATE);
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('Tonhoehenverfolgung und Segmentierung', () => {
  it('erkennt eine Tonfolge als einzelne Noten', () => {
    // C4 - E4 - G4, je 0,4 Sekunden
    const midis = [60, 64, 67];
    const noteDuration = 0.4;
    const total = new Float32Array(Math.floor(midis.length * noteDuration * SAMPLE_RATE));
    let offset = 0;
    for (const midi of midis) {
      const tone = harmonicTone(midiToFrequency(midi), noteDuration, 5);
      total.set(tone, offset);
      offset += tone.length;
    }

    const track = trackPitch(total, SAMPLE_RATE, 2048, 256);
    const notes = segmentNotes(track, [], { minConfidence: 0.4 });

    expect(notes.length).toBeGreaterThanOrEqual(3);
    // Die drei laengsten Noten muessen den erwarteten Tonhoehen entsprechen
    const longest = [...notes].sort((a, b) => b.duration - a.duration).slice(0, 3);
    longest.sort((a, b) => a.start - b.start);
    expect(longest.map((n) => n.midi)).toEqual(midis);
  });

  it('liefert plausible Cent-Abweichungen', () => {
    // 20 Cent ueber A4
    const detuned = 440 * Math.pow(2, 20 / 1200);
    const signal = sine(detuned, 0.2);
    const result = detectPitchYin(signal.subarray(0, 2048), SAMPLE_RATE);
    const exactMidi = frequencyToMidiFloat(result.frequency);
    const cents = (exactMidi - Math.round(exactMidi)) * 100;
    expect(cents).toBeGreaterThan(10);
    expect(cents).toBeLessThan(30);
  });
});
