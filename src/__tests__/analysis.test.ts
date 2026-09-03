/**
 * Tests fuer Onset-Erkennung, Tempo-Schaetzung, Quantisierung und
 * Harmonieanalyse mit synthetischem Material.
 */
import { describe, expect, it } from 'vitest';
import { detectOnsets, estimateTempo } from '../engines/analysis/onset-tempo';
import { quantizeNotes, eventsToScore } from '../engines/analysis/quantization';
import { averageChroma, estimateKey, matchChord } from '../engines/analysis/harmony';
import { midiToFrequency } from '../core/music-theory';
import { measureFilledQuarters } from '../core/score-model';
import { measureCapacity } from '../core/music-theory';
import type { AnalysisResult, DetectedNote } from '../core/types';

const SAMPLE_RATE = 22050;

/** Erzeugt eine Folge angeschlagener Toene in festem Tempo. */
function clickTrack(bpm: number, beats: number, frequency = 440): Float32Array {
  const secondsPerBeat = 60 / bpm;
  const total = new Float32Array(Math.ceil(beats * secondsPerBeat * SAMPLE_RATE));
  const attackLength = Math.floor(0.12 * SAMPLE_RATE);
  for (let beat = 0; beat < beats; beat++) {
    const start = Math.floor(beat * secondsPerBeat * SAMPLE_RATE);
    for (let i = 0; i < attackLength && start + i < total.length; i++) {
      const envelope = Math.exp((-8 * i) / attackLength);
      let value = 0;
      for (let h = 1; h <= 4; h++) {
        value += Math.sin((2 * Math.PI * frequency * h * i) / SAMPLE_RATE) / h;
      }
      total[start + i] = value * envelope * 0.5;
    }
  }
  return total;
}

describe('Onset-Erkennung', () => {
  it('findet die Anschlaege eines gleichmaessigen Rhythmus', () => {
    const signal = clickTrack(120, 8);
    const { onsets } = detectOnsets(signal, SAMPLE_RATE);
    // 8 Anschlaege erwartet, kleine Abweichung durch Randeffekte erlaubt
    expect(onsets.length).toBeGreaterThanOrEqual(6);
    expect(onsets.length).toBeLessThanOrEqual(10);

    // Abstaende sollten etwa 0,5 s betragen
    const gaps: number[] = [];
    for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i] - onsets[i - 1]);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(avgGap).toBeGreaterThan(0.42);
    expect(avgGap).toBeLessThan(0.58);
  });
});

describe('Tempo-Schaetzung', () => {
  for (const bpm of [90, 120, 140]) {
    it(`erkennt ${bpm} BPM`, () => {
      const signal = clickTrack(bpm, 24);
      const { envelope, hopTime } = detectOnsets(signal, SAMPLE_RATE);
      const estimate = estimateTempo(envelope, hopTime);
      // Halb-/Doppeltempo ist musikalisch aequivalent und wird akzeptiert
      const ratios = [estimate.bpm / bpm, estimate.bpm / (bpm * 2), estimate.bpm / (bpm / 2)];
      const closest = ratios.reduce((best, r) => (Math.abs(r - 1) < Math.abs(best - 1) ? r : best));
      expect(Math.abs(closest - 1)).toBeLessThan(0.08);
    });
  }
});

describe('Quantisierung', () => {
  it('rastert leicht ungenaue Zeiten auf saubere Notenwerte', () => {
    const tempo = 120; // eine Viertel = 0,5 s
    const notes: DetectedNote[] = [
      { start: 0.01, duration: 0.49, midi: 60, frequency: 261.6, cents: 0, confidence: 0.9, velocity: 0.8 },
      { start: 0.52, duration: 0.24, midi: 62, frequency: 293.7, cents: 0, confidence: 0.9, velocity: 0.8 },
      { start: 0.76, duration: 0.26, midi: 64, frequency: 329.6, cents: 0, confidence: 0.9, velocity: 0.8 },
      { start: 1.01, duration: 0.98, midi: 65, frequency: 349.2, cents: 0, confidence: 0.9, velocity: 0.8 },
    ];
    const events = quantizeNotes(notes, tempo);

    expect(events).toHaveLength(4);
    expect(events[0].startQuarters).toBeCloseTo(0, 5);
    expect(events[0].durationQuarters).toBeCloseTo(1, 5);
    expect(events[1].startQuarters).toBeCloseTo(1, 5);
    expect(events[1].durationQuarters).toBeCloseTo(0.5, 5);
    expect(events[2].startQuarters).toBeCloseTo(1.5, 5);
    expect(events[3].startQuarters).toBeCloseTo(2, 5);
    expect(events[3].durationQuarters).toBeCloseTo(2, 5);
  });

  it('verlaengert kurz erkannte Noten bis zum naechsten Anschlag', () => {
    // Erkannte Dauer je 0,38 s statt 0,5 s, weil der Ton leiser ausklingt.
    // Erwartet werden trotzdem vier saubere Viertelnoten ohne Pausen.
    const notes: DetectedNote[] = [0, 0.5, 1.0, 1.5].map((start, index) => ({
      start,
      duration: 0.38,
      midi: 60 + index * 2,
      frequency: midiToFrequency(60 + index * 2),
      cents: 0,
      confidence: 0.9,
      velocity: 0.8,
    }));

    const events = quantizeNotes(notes, 120);
    expect(events).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      expect(events[i].durationQuarters).toBeCloseTo(1, 5);
    }
  });

  it('laesst deutlich kuerzere Noten kurz (Staccato)', () => {
    const notes: DetectedNote[] = [0, 0.5, 1.0].map((start, index) => ({
      start,
      duration: 0.12,
      midi: 60 + index,
      frequency: midiToFrequency(60 + index),
      cents: 0,
      confidence: 0.9,
      velocity: 0.8,
    }));

    const events = quantizeNotes(notes, 120);
    // 0,12 s sind bei 120 BPM knapp eine Sechzehntel und damit klar
    // kuerzer als der Abstand von einer Viertel.
    expect(events[0].durationQuarters).toBeLessThan(0.5);
  });

  it('fasst gleichzeitige Noten zu einem Akkord zusammen', () => {
    const notes: DetectedNote[] = [
      { start: 0, duration: 1, midi: 60, frequency: 261.6, cents: 0, confidence: 0.8, velocity: 0.8 },
      { start: 0.005, duration: 1, midi: 64, frequency: 329.6, cents: 0, confidence: 0.8, velocity: 0.8 },
      { start: 0.01, duration: 1, midi: 67, frequency: 392, cents: 0, confidence: 0.8, velocity: 0.8 },
    ];
    const events = quantizeNotes(notes, 120);
    expect(events).toHaveLength(1);
    expect(events[0].midis).toEqual([60, 64, 67]);
  });
});

describe('Partiturerzeugung', () => {
  const baseAnalysis: AnalysisResult = {
    notes: [],
    chords: [],
    tempo: 120,
    beatOffset: 0,
    tempoConfidence: 0.9,
    timeSignature: { beats: 4, beatType: 4 },
    timeSignatureConfidence: 0.8,
    keySignature: 0,
    keyName: 'C',
    keyConfidence: 0.7,
    instrument: { name: 'Klavier', confidence: 0.6 },
    duration: 4,
    sampleRate: SAMPLE_RATE,
    warnings: [],
  };

  it('erzeugt vollstaendig gefuellte Takte', () => {
    const notes: DetectedNote[] = [60, 62, 64, 65, 67, 69, 71, 72].map((midi, index) => ({
      start: index * 0.5,
      duration: 0.5,
      midi,
      frequency: midiToFrequency(midi),
      cents: 0,
      confidence: 0.85,
      velocity: 0.8,
    }));

    const events = quantizeNotes(notes, 120);
    const score = eventsToScore(events, baseAnalysis, 'Test');
    const capacity = measureCapacity(baseAnalysis.timeSignature);

    expect(score.staves).toHaveLength(1);
    expect(score.staves[0].measures.length).toBeGreaterThanOrEqual(2);
    for (const measure of score.staves[0].measures) {
      expect(measureFilledQuarters(measure)).toBeCloseTo(capacity, 4);
    }
  });

  it('fuegt Pausen fuer Luecken ein', () => {
    const notes: DetectedNote[] = [
      { start: 0, duration: 0.5, midi: 60, frequency: 261.6, cents: 0, confidence: 0.9, velocity: 0.8 },
      // Luecke von einer Viertel
      { start: 1.0, duration: 0.5, midi: 62, frequency: 293.7, cents: 0, confidence: 0.9, velocity: 0.8 },
    ];
    const events = quantizeNotes(notes, 120);
    const score = eventsToScore(events, baseAnalysis, 'Test');
    const firstMeasure = score.staves[0].measures[0];
    const rests = firstMeasure.notes.filter((n) => n.isRest);
    expect(rests.length).toBeGreaterThan(0);
  });
});

describe('Harmonieanalyse', () => {
  /** Erzeugt einen Akkord aus mehreren Halbtoenen. */
  function chordSignal(midis: number[], seconds = 1): Float32Array {
    const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
    for (const midi of midis) {
      const frequency = midiToFrequency(midi);
      for (let i = 0; i < samples.length; i++) {
        for (let h = 1; h <= 4; h++) {
          samples[i] += Math.sin((2 * Math.PI * frequency * h * i) / SAMPLE_RATE) / (h * midis.length * 2);
        }
      }
    }
    return samples;
  }

  it('erkennt einen C-Dur-Dreiklang', () => {
    const chroma = averageChroma(chordSignal([60, 64, 67]), SAMPLE_RATE);
    const match = matchChord(chroma);
    expect(match).not.toBeNull();
    expect(match!.symbol).toBe('C');
  });

  it('erkennt einen a-Moll-Dreiklang', () => {
    const chroma = averageChroma(chordSignal([57, 60, 64]), SAMPLE_RATE);
    const match = matchChord(chroma);
    expect(match).not.toBeNull();
    expect(match!.symbol).toBe('Am');
  });

  it('meldet bei einem Einzelton keinen Akkord', () => {
    // Ein einzelner Ton erzeugt mit seinen Obertoenen ebenfalls ein
    // Chroma-Muster. Ohne Pruefung auf Mehrstimmigkeit wuerde die App
    // darueber faelschlich Akkordsymbole schreiben.
    for (const midi of [60, 64, 67, 69]) {
      const chroma = averageChroma(chordSignal([midi]), SAMPLE_RATE);
      expect(matchChord(chroma)).toBeNull();
    }
  });

  it('meldet bei einem Zweiklang keinen vollen Akkord', () => {
    const chroma = averageChroma(chordSignal([60, 67]), SAMPLE_RATE);
    expect(matchChord(chroma)).toBeNull();
  });

  it('bestimmt die Tonart einer C-Dur-Tonleiter', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72];
    const samples = new Float32Array(scale.length * 0.3 * SAMPLE_RATE);
    let offset = 0;
    for (const midi of scale) {
      const tone = chordSignal([midi], 0.3);
      samples.set(tone, offset);
      offset += tone.length;
    }
    const chroma = averageChroma(samples, SAMPLE_RATE);
    const key = estimateKey(chroma);
    // C-Dur oder die Mollparallele a-Moll gelten als richtig
    expect([0]).toContain(key.fifths);
  });
});
