/**
 * Tests der Uebungslogik.
 *
 * Der Mikrofonzugriff selbst laesst sich nur mit echter Hardware pruefen.
 * Die Auswertung dahinter - Tonhoehe erkennen, mit der Zielnote vergleichen,
 * Haltezeit verlangen, Trefferquote fuehren - wird hier vollstaendig
 * getestet, indem dieselben Signale eingespeist werden, die auch aus dem
 * Mikrofon kaemen.
 */
import { describe, expect, it } from 'vitest';
import {
  PracticeSession,
  SILENT_PITCH,
  evaluatePitch,
  type LivePitch,
} from '../engines/practice/practice-engine';
import { detectPitchYin } from '../engines/analysis/pitch-detection';
import {
  frequencyToMidiFloat,
  midiToFrequency,
  midiToPitch,
  pitchToDisplayName,
} from '../core/music-theory';

const SAMPLE_RATE = 44100;

/** Erzeugt ein Analysefenster mit einem gesungenen bzw. gespielten Ton. */
function toneFrame(frequency: number, size = 2048): Float32Array {
  const frame = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    // Grundton plus zwei Obertoene, wie bei einer Stimme oder einem Instrument.
    const t = i / SAMPLE_RATE;
    frame[i] =
      (Math.sin(2 * Math.PI * frequency * t) +
        0.4 * Math.sin(2 * Math.PI * frequency * 2 * t) +
        0.2 * Math.sin(2 * Math.PI * frequency * 3 * t)) *
      0.3;
  }
  return frame;
}

/** Wandelt ein Signalfenster in dieselbe Struktur um, die das Mikrofon liefert. */
function analyzeFrame(frequency: number): LivePitch {
  const frame = toneFrame(frequency);
  const detection = detectPitchYin(frame, SAMPLE_RATE, { threshold: 0.2 });
  if (detection.frequency <= 0) return { ...SILENT_PITCH, level: detection.energy };

  const exactMidi = frequencyToMidiFloat(detection.frequency);
  const midi = Math.round(exactMidi);
  return {
    frequency: detection.frequency,
    midi,
    noteName: pitchToDisplayName(midiToPitch(midi)),
    cents: (exactMidi - midi) * 100,
    confidence: detection.confidence,
    level: detection.energy,
  };
}

describe('Bewertung einer gespielten Note', () => {
  it('erkennt eine exakt getroffene Note als richtig', () => {
    const live = analyzeFrame(midiToFrequency(60)); // C4
    const feedback = evaluatePitch(live, 60);
    expect(feedback.verdict).toBe('correct');
    expect(Math.abs(feedback.centsOffTarget)).toBeLessThan(10);
  });

  it('meldet einen zu hohen Ton', () => {
    // 60 Cent ueber C4 liegt ausserhalb der Standardtoleranz von 35 Cent.
    const live = analyzeFrame(midiToFrequency(60) * Math.pow(2, 60 / 1200));
    const feedback = evaluatePitch(live, 60);
    expect(feedback.verdict).toBe('too-high');
    expect(feedback.centsOffTarget).toBeGreaterThan(40);
  });

  it('meldet einen zu tiefen Ton', () => {
    const live = analyzeFrame(midiToFrequency(60) * Math.pow(2, -60 / 1200));
    const feedback = evaluatePitch(live, 60);
    expect(feedback.verdict).toBe('too-low');
    expect(feedback.centsOffTarget).toBeLessThan(-40);
  });

  it('erkennt eine um einen Halbton verfehlte Note', () => {
    const live = analyzeFrame(midiToFrequency(61)); // Cis4 statt C4
    const feedback = evaluatePitch(live, 60);
    expect(feedback.verdict).toBe('too-high');
    expect(feedback.semitonesOff).toBe(1);
  });

  it('meldet Stille als "kein Ton"', () => {
    const feedback = evaluatePitch(SILENT_PITCH, 60);
    expect(feedback.verdict).toBe('silent');
  });

  it('beachtet eine engere Toleranz', () => {
    // 25 Cent daneben: bei 35 Cent Toleranz richtig, bei 15 Cent zu hoch.
    const live = analyzeFrame(midiToFrequency(60) * Math.pow(2, 25 / 1200));
    expect(evaluatePitch(live, 60, 35).verdict).toBe('correct');
    expect(evaluatePitch(live, 60, 15).verdict).toBe('too-high');
  });
});

describe('Ablauf einer Uebung', () => {
  const task = { id: 'test', label: 'Dreiklang', targets: [60, 64, 67] };

  it('schaltet erst weiter, wenn der Ton lange genug gehalten wird', () => {
    const session = new PracticeSession(task, 5);
    const correct = analyzeFrame(midiToFrequency(60));

    expect(session.getCurrentTarget()).toBe(60);
    for (let i = 0; i < 4; i++) {
      session.update(correct);
      expect(session.getCurrentTarget(), `nach ${i + 1} Durchlaeufen`).toBe(60);
    }
    session.update(correct);
    expect(session.getCurrentTarget()).toBe(64);
  });

  it('schaltet bei falschem Ton nicht weiter', () => {
    const session = new PracticeSession(task, 5);
    const wrong = analyzeFrame(midiToFrequency(65));
    for (let i = 0; i < 20; i++) session.update(wrong);
    expect(session.getCurrentTarget()).toBe(60);
    expect(session.getProgress().completed).toBe(0);
  });

  it('spielt eine ganze Uebung durch und fuehrt die Trefferquote', () => {
    const session = new PracticeSession(task, 5);
    for (const target of task.targets) {
      const tone = analyzeFrame(midiToFrequency(target));
      for (let i = 0; i < 5; i++) session.update(tone);
    }

    const progress = session.getProgress();
    expect(progress.finished).toBe(true);
    expect(progress.completed).toBe(3);
    expect(progress.hits).toBe(3);
    expect(progress.accuracy).toBe(1);
    expect(progress.averageCents).toBeLessThan(15);
  });

  it('zaehlt Fehlversuche in die Trefferquote', () => {
    const session = new PracticeSession(task, 5);
    // Erste Note daneben, dann richtig.
    const wrong = analyzeFrame(midiToFrequency(65));
    for (let i = 0; i < 6; i++) session.update(wrong);
    session.skip();

    const right = analyzeFrame(midiToFrequency(64));
    for (let i = 0; i < 5; i++) session.update(right);

    const progress = session.getProgress();
    expect(progress.completed).toBe(2);
    expect(progress.hits).toBe(1);
    expect(progress.accuracy).toBeLessThan(1);
  });

  it('zeigt den Fortschritt beim Halten des Tons an', () => {
    const session = new PracticeSession(task, 10);
    const correct = analyzeFrame(midiToFrequency(60));
    expect(session.getHoldRatio()).toBe(0);
    for (let i = 0; i < 5; i++) session.update(correct);
    expect(session.getHoldRatio()).toBeCloseTo(0.5, 1);
  });

  it('laesst sich zuruecksetzen', () => {
    const session = new PracticeSession(task, 3);
    const correct = analyzeFrame(midiToFrequency(60));
    for (let i = 0; i < 3; i++) session.update(correct);
    expect(session.getProgress().completed).toBe(1);

    session.reset();
    expect(session.getProgress().completed).toBe(0);
    expect(session.getCurrentTarget()).toBe(60);
  });
});
