/**
 * Harmonische Analyse: Chroma-Vektoren, Tonart- und Akkorderkennung
 * sowie eine einfache mehrstimmige Tonhoehenschaetzung.
 */
import { applyHann, magnitudeSpectrum } from './dsp';
import { frequencyToMidiFloat, midiToFrequency } from '../../core/music-theory';
import type { DetectedChord } from '../../core/types';

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Berechnet einen 12-stelligen Chroma-Vektor fuer ein Signalfenster.
 * Jede Spektrallinie wird ihrer Halbtonklasse zugeordnet und gewichtet.
 */
export function computeChroma(
  frame: Float32Array,
  sampleRate: number,
  minMidi = 36,
  maxMidi = 96,
): Float32Array {
  const spectrum = magnitudeSpectrum(applyHann(frame));
  const binHz = sampleRate / (spectrum.length * 2);
  const chroma = new Float32Array(12);

  for (let bin = 1; bin < spectrum.length; bin++) {
    const frequency = bin * binHz;
    if (frequency < 20) continue;
    const midi = frequencyToMidiFloat(frequency);
    if (!Number.isFinite(midi) || midi < minMidi || midi > maxMidi) continue;
    const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
    // Amplitude statt Leistung: robuster gegen einzelne laute Partialtoene.
    chroma[pitchClass] += spectrum[bin];
  }

  let max = 0;
  for (let i = 0; i < 12; i++) if (chroma[i] > max) max = chroma[i];
  if (max > 0) for (let i = 0; i < 12; i++) chroma[i] /= max;
  return chroma;
}

/** Mittelt Chroma-Vektoren ueber ein ganzes Signal. */
export function averageChroma(
  samples: Float32Array,
  sampleRate: number,
  frameSize = 4096,
  hopSize = 2048,
): Float32Array {
  const total = new Float32Array(12);
  let count = 0;
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const chroma = computeChroma(samples.subarray(start, start + frameSize), sampleRate);
    for (let i = 0; i < 12; i++) total[i] += chroma[i];
    count++;
  }
  if (count > 0) for (let i = 0; i < 12; i++) total[i] /= count;
  return total;
}

/**
 * Krumhansl-Schmuckler-Profile fuer Dur und Moll.
 * Werden mit dem Chroma-Vektor korreliert, um die Tonart zu schaetzen.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Quintenzirkel-Position (fifths) je Dur-Grundton. */
const MAJOR_FIFTHS: Record<number, number> = {
  0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: 7,
  8: -4, 3: -3, 10: -2, 5: -1,
};

export interface KeyEstimate {
  fifths: number;
  name: string;
  confidence: number;
  isMinor: boolean;
}

/** Schaetzt die Tonart aus einem Chroma-Vektor. */
export function estimateKey(chroma: Float32Array): KeyEstimate {
  let best = { score: -Infinity, root: 0, isMinor: false };
  let second = -Infinity;

  for (let root = 0; root < 12; root++) {
    for (const isMinor of [false, true]) {
      const profile = isMinor ? MINOR_PROFILE : MAJOR_PROFILE;
      const score = correlate(chroma, profile, root);
      if (score > best.score) {
        second = best.score;
        best = { score, root, isMinor };
      } else if (score > second) {
        second = score;
      }
    }
  }

  const majorFifths = MAJOR_FIFTHS[best.root] ?? 0;
  // Moll-Tonart: gleiche Vorzeichen wie die Durparallele (kleine Terz hoeher).
  const fifths = best.isMinor
    ? (MAJOR_FIFTHS[(best.root + 3) % 12] ?? 0)
    : majorFifths;

  const margin = Number.isFinite(second) && best.score !== 0
    ? Math.max(0, (best.score - second) / Math.abs(best.score))
    : 0;

  return {
    fifths,
    name: `${PITCH_CLASS_NAMES[best.root]}${best.isMinor ? 'm' : ''}`,
    confidence: Math.max(0, Math.min(1, margin * 3)),
    isMinor: best.isMinor,
  };
}

/** Pearson-Korrelation zwischen Chroma und rotiertem Profil. */
function correlate(chroma: Float32Array, profile: number[], rotation: number): number {
  let chromaSum = 0;
  let profileSum = 0;
  for (let i = 0; i < 12; i++) {
    chromaSum += chroma[i];
    profileSum += profile[i];
  }
  const chromaMean = chromaSum / 12;
  const profileMean = profileSum / 12;

  let numerator = 0;
  let chromaVar = 0;
  let profileVar = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[(i + rotation) % 12] - chromaMean;
    const p = profile[i] - profileMean;
    numerator += c * p;
    chromaVar += c * c;
    profileVar += p * p;
  }
  const denominator = Math.sqrt(chromaVar * profileVar);
  return denominator > 0 ? numerator / denominator : 0;
}

/** Akkordvorlagen als Halbtonabstaende vom Grundton. */
const CHORD_TEMPLATES: Array<{ quality: string; suffix: string; intervals: number[] }> = [
  { quality: 'major', suffix: '', intervals: [0, 4, 7] },
  { quality: 'minor', suffix: 'm', intervals: [0, 3, 7] },
  { quality: 'diminished', suffix: 'dim', intervals: [0, 3, 6] },
  { quality: 'augmented', suffix: 'aug', intervals: [0, 4, 8] },
  { quality: 'dominant7', suffix: '7', intervals: [0, 4, 7, 10] },
  { quality: 'major7', suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { quality: 'minor7', suffix: 'm7', intervals: [0, 3, 7, 10] },
  { quality: 'sus4', suffix: 'sus4', intervals: [0, 5, 7] },
  { quality: 'sus2', suffix: 'sus2', intervals: [0, 2, 7] },
];

/**
 * Erkennt den wahrscheinlichsten Akkord in einem Chroma-Vektor.
 *
 * Wichtig ist die Vorpruefung auf Mehrstimmigkeit: ein einzelner Ton mit
 * seinen Obertoenen erzeugt ebenfalls ein Chroma-Muster, das rein
 * rechnerisch zu einer Akkordvorlage passt. Ohne diese Pruefung wuerde die
 * App ueber eine schlichte Tonleiter Akkordsymbole wie "Csus4" schreiben.
 */
export function matchChord(chroma: Float32Array): { symbol: string; root: number; quality: string; confidence: number } | null {
  let energy = 0;
  for (let i = 0; i < 12; i++) energy += chroma[i];
  if (energy < 0.5) return null;

  // Mindestens drei deutlich vertretene Halbtonklassen verlangen.
  const strongClasses = Array.from(chroma).filter((value) => value >= 0.45).length;
  if (strongClasses < 3) return null;

  let best = { score: -Infinity, root: 0, template: CHORD_TEMPLATES[0] };
  let second = -Infinity;

  for (let root = 0; root < 12; root++) {
    for (const template of CHORD_TEMPLATES) {
      const vector = new Float32Array(12);
      for (const interval of template.intervals) vector[(root + interval) % 12] = 1;
      const score = cosineSimilarity(chroma, vector);
      if (score > best.score) {
        second = best.score;
        best = { score, root, template };
      } else if (score > second) {
        second = score;
      }
    }
  }

  if (best.score < 0.72) return null;
  const margin = Number.isFinite(second) ? Math.max(0, best.score - second) : 0;
  // Ein knapper Vorsprung vor der zweitbesten Vorlage heisst: mehrdeutig.
  if (margin < 0.04) return null;
  const confidence = Math.max(0, Math.min(1, best.score * 0.6 + margin * 2));
  return {
    symbol: `${PITCH_CLASS_NAMES[best.root]}${best.template.suffix}`,
    root: best.root,
    quality: best.template.quality,
    confidence,
  };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA * normB);
  return denominator > 0 ? dot / denominator : 0;
}

/**
 * Verfolgt Akkorde ueber das Signal, indem Chroma-Vektoren pro Segment
 * gemittelt und mit den Vorlagen verglichen werden.
 * Segmentgrenzen kommen aus den Beat-Positionen, sonst aus festen Fenstern.
 */
export function detectChords(
  samples: Float32Array,
  sampleRate: number,
  segmentBoundaries: number[],
): DetectedChord[] {
  const chords: DetectedChord[] = [];
  for (let i = 0; i < segmentBoundaries.length - 1; i++) {
    const start = segmentBoundaries[i];
    const end = segmentBoundaries[i + 1];
    const startSample = Math.floor(start * sampleRate);
    const endSample = Math.min(samples.length, Math.floor(end * sampleRate));
    if (endSample - startSample < 1024) continue;

    const segment = samples.subarray(startSample, endSample);
    const chroma = averageChroma(segment, sampleRate, 4096, 2048);
    const match = matchChord(chroma);
    if (!match) continue;

    const previous = chords[chords.length - 1];
    // Gleiche Akkorde zusammenfassen, damit die Anzeige ruhig bleibt.
    if (previous && previous.symbol === match.symbol && Math.abs(previous.start + previous.duration - start) < 0.05) {
      previous.duration = end - previous.start;
      previous.confidence = Math.max(previous.confidence, match.confidence);
      continue;
    }
    chords.push({
      start,
      duration: end - start,
      symbol: match.symbol,
      root: match.root,
      quality: match.quality,
      confidence: match.confidence,
    });
  }
  return chords;
}

/**
 * Einfache mehrstimmige Tonhoehenschaetzung.
 *
 * Verfahren: iterative Subtraktion (nach Klapuri). Es wird die staerkste
 * Grundfrequenz gesucht, deren Harmonische aus dem Spektrum entfernt und
 * der Vorgang wiederholt. Das reicht fuer klare Akkorde; dicht besetzte
 * Orchestersaetze bleiben eine offene Grenze des Verfahrens.
 *
 * @returns MIDI-Nummern mit Staerke, absteigend sortiert
 */
export function detectPolyphonicPitches(
  frame: Float32Array,
  sampleRate: number,
  maxVoices = 4,
  minMidi = 36,
  maxMidi = 96,
): Array<{ midi: number; salience: number }> {
  const spectrum = magnitudeSpectrum(applyHann(frame));
  const binHz = sampleRate / (spectrum.length * 2);
  const working = new Float32Array(spectrum);

  const results: Array<{ midi: number; salience: number }> = [];
  const harmonics = 8;

  for (let voice = 0; voice < maxVoices; voice++) {
    let bestMidi = -1;
    let bestSalience = 0;

    // Salienz je Kandidaten-Halbton: Summe der Harmonischen-Amplituden.
    for (let midi = minMidi; midi <= maxMidi; midi++) {
      const f0 = midiToFrequency(midi);
      let salience = 0;
      for (let h = 1; h <= harmonics; h++) {
        const bin = Math.round((f0 * h) / binHz);
        if (bin >= working.length) break;
        // Hoehere Harmonische schwaecher gewichten.
        salience += working[bin] / h;
      }
      if (salience > bestSalience) {
        bestSalience = salience;
        bestMidi = midi;
      }
    }

    if (bestMidi < 0) break;
    // Abbruch, wenn die Stimme deutlich schwaecher ist als die erste.
    if (results.length > 0 && bestSalience < results[0].salience * 0.25) break;

    results.push({ midi: bestMidi, salience: bestSalience });

    // Harmonische der gefundenen Stimme abziehen.
    const f0 = midiToFrequency(bestMidi);
    for (let h = 1; h <= harmonics; h++) {
      const centerBin = Math.round((f0 * h) / binHz);
      if (centerBin >= working.length) break;
      const width = Math.max(1, Math.round(centerBin * 0.03));
      for (let bin = centerBin - width; bin <= centerBin + width; bin++) {
        if (bin >= 0 && bin < working.length) working[bin] = 0;
      }
    }
  }

  return results;
}

export { PITCH_CLASS_NAMES };
