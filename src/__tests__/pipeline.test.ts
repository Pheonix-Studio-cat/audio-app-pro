/**
 * Test der gesamten Kette: synthetisches Audio -> Analyse -> Partitur.
 *
 * Die Eingabe ist eine C-Dur-Tonleiter mit bekanntem Tempo und bekannten
 * Notenwerten. Damit laesst sich objektiv pruefen, ob am Ende tatsaechlich
 * die richtigen Noten in der richtigen Rhythmik stehen.
 */
import { describe, expect, it } from 'vitest';
import { analyzeAudio } from '../engines/analysis/analysis-engine';
import { eventsToScore, quantizeNotes } from '../engines/analysis/quantization';
import { midiToFrequency, pitchToMidi, durationInQuarters } from '../core/music-theory';
import type { Score } from '../core/types';

const SAMPLE_RATE = 44100;

/**
 * Erzeugt eine Melodie aus angeschlagenen Toenen.
 *
 * @param midis Tonhoehen in der Reihenfolge des Spiels
 * @param bpm Tempo in Viertel pro Minute
 * @param decay Abklingfaktor; hoehere Werte lassen den Ton frueher verstummen
 * @param lengthsInQuarters Notenlaengen in Vierteln, sonst je eine Viertel
 */
function synthesizeMelody(
  midis: number[],
  bpm: number,
  decay = 2.2,
  lengthsInQuarters?: number[],
): Float32Array {
  const secondsPerQuarter = 60 / bpm;
  const lengths = lengthsInQuarters ?? midis.map(() => 1);
  const noteLengths = lengths.map((q) => Math.round(q * secondsPerQuarter * SAMPLE_RATE));
  const total = noteLengths.reduce((sum, value) => sum + value, 0);
  const samples = new Float32Array(total);

  let start = 0;
  midis.forEach((midi, index) => {
    const f0 = midiToFrequency(midi);
    const noteLength = noteLengths[index];
    for (let i = 0; i < noteLength; i++) {
      const t = i / SAMPLE_RATE;
      let value = 0;
      for (let h = 1; h <= 6; h++) value += Math.sin(2 * Math.PI * f0 * h * t) / h;
      value /= 2.5;

      const progress = i / noteLength;
      const attack = Math.min(1, progress / 0.02);
      const envelope = Math.exp(-decay * progress);
      const release = progress > 0.85 ? (1 - progress) / 0.15 : 1;
      samples[start + i] = value * attack * envelope * release * 0.7;
    }
    start += noteLength;
  });

  return samples;
}

/** Liest alle Noten einer Partitur der Reihe nach aus. */
function flattenScore(score: Score): Array<{ midi: number | null; quarters: number }> {
  const result: Array<{ midi: number | null; quarters: number }> = [];
  for (const measure of score.staves[0].measures) {
    for (const note of measure.notes) {
      result.push({
        midi: note.isRest ? null : pitchToMidi(note.pitches[0]),
        quarters: durationInQuarters(note.duration, note.dots),
      });
    }
  }
  return result;
}

describe('Gesamtkette Audio zu Notenschrift', () => {
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];

  it('erkennt eine C-Dur-Tonleiter bei 120 BPM vollstaendig', async () => {
    const samples = synthesizeMelody(scale, 120);
    const analysis = await analyzeAudio(samples, SAMPLE_RATE, { detectChords: true });

    expect(analysis.notes.length).toBe(scale.length);
    expect(analysis.notes.map((n) => n.midi)).toEqual(scale);

    // Halbes oder doppeltes Tempo waere musikalisch gleichwertig.
    const tempoCandidates = [analysis.tempo, analysis.tempo * 2, analysis.tempo / 2];
    expect(tempoCandidates.some((value) => Math.abs(value - 120) <= 6)).toBe(true);

    // Tonart C-Dur bedeutet null Vorzeichen.
    expect(analysis.keySignature).toBe(0);

    // Ueber einer einstimmigen Tonleiter darf kein Akkord stehen.
    expect(analysis.chords.length).toBe(0);
  }, 60000);

  it('setzt die Tonleiter in acht saubere Viertelnoten um', async () => {
    const samples = synthesizeMelody(scale, 120);
    const analysis = await analyzeAudio(samples, SAMPLE_RATE, { detectChords: false });
    const events = quantizeNotes(analysis.notes, analysis.tempo, {
      beatOffset: analysis.beatOffset,
    });
    const score = eventsToScore(events, analysis, 'Tonleiter');

    const flat = flattenScore(score);
    const notes = flat.filter((entry) => entry.midi !== null);

    expect(notes.map((n) => n.midi)).toEqual(scale);
    // Jede Note muss genau eine Viertel lang sein.
    for (const note of notes) {
      expect(note.quarters).toBeCloseTo(1, 5);
    }
    // Zwischen den Noten darf keine Pause stehen.
    let lastNoteIndex = -1;
    for (let i = 0; i < flat.length; i++) {
      if (flat[i].midi !== null) lastNoteIndex = i;
    }
    const restsBeforeLastNote = flat
      .slice(0, Math.max(0, lastNoteIndex))
      .filter((entry) => entry.midi === null);
    expect(restsBeforeLastNote).toHaveLength(0);
  }, 60000);

  it('erkennt eine Tonleiter auch bei 90 und bei 150 BPM', async () => {
    for (const bpm of [90, 150]) {
      const samples = synthesizeMelody(scale, bpm);
      const analysis = await analyzeAudio(samples, SAMPLE_RATE, { detectChords: false });
      const events = quantizeNotes(analysis.notes, analysis.tempo, {
        beatOffset: analysis.beatOffset,
      });
      const score = eventsToScore(events, analysis, 'Tonleiter');
      const notes = flattenScore(score).filter((entry) => entry.midi !== null);

      expect(notes.map((n) => n.midi), `Tonhoehen bei ${bpm} BPM`).toEqual(scale);
      for (const note of notes) {
        expect(note.quarters, `Notenwert bei ${bpm} BPM`).toBeCloseTo(1, 5);
      }
    }
  }, 90000);

  it('unterscheidet Viertel-, Halbe- und Achtelnoten', async () => {
    // Rhythmus: Viertel, Viertel, Halbe, Achtel, Achtel, Viertel, Halbe
    const midis = [60, 62, 64, 65, 67, 69, 71];
    const lengths = [1, 1, 2, 0.5, 0.5, 1, 2];
    const samples = synthesizeMelody(midis, 100, 1.4, lengths);

    const analysis = await analyzeAudio(samples, SAMPLE_RATE, { detectChords: false });
    const events = quantizeNotes(analysis.notes, analysis.tempo, {
      beatOffset: analysis.beatOffset,
    });

    expect(events.length).toBe(midis.length);
    expect(events.map((e) => e.midis[0])).toEqual(midis);

    // Halbes oder doppeltes Tempo ist musikalisch gleichwertig; entscheidend
    // sind die Laengenverhaeltnisse zueinander.
    const factor = events[0].durationQuarters / lengths[0];
    expect([0.5, 1, 2]).toContain(factor);
    for (let i = 0; i < lengths.length - 1; i++) {
      expect(events[i].durationQuarters, `Note ${i + 1}`).toBeCloseTo(lengths[i] * factor, 5);
    }
  }, 90000);

  it('erkennt kurz gespielte Noten als kurze Notenwerte', async () => {
    // Sehr schnelles Abklingen entspricht Staccato.
    const samples = synthesizeMelody([60, 62, 64, 65], 120, 30);
    const analysis = await analyzeAudio(samples, SAMPLE_RATE, { detectChords: false });
    const events = quantizeNotes(analysis.notes, analysis.tempo, {
      beatOffset: analysis.beatOffset,
    });

    expect(events.length).toBeGreaterThanOrEqual(3);
    // Deutlich kuerzer als eine Viertel.
    expect(events[0].durationQuarters).toBeLessThan(1);
  }, 60000);
});
