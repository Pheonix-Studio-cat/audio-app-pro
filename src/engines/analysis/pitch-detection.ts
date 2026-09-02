/**
 * Monophone Tonhoehenerkennung.
 *
 * Implementiert ist der YIN-Algorithmus (de Cheveigne & Kawahara, 2002) mit
 * kumulativer Mittelwertnormierung und parabolischer Interpolation. YIN ist
 * fuer Einzelstimmen (Gesang, Blas- und Streichinstrumente) deutlich
 * robuster als eine reine Autokorrelation, weil er Oktavfehler unterdrueckt.
 *
 * Zusaetzlich steht eine spektrale Variante (Harmonic Product Spectrum)
 * bereit, die bei polyphonem Material als Stuetze dient.
 */
import { applyHann, magnitudeSpectrum, parabolicInterpolation } from './dsp';

export interface PitchResult {
  /** Grundfrequenz in Hz, 0 wenn nichts erkannt wurde. */
  frequency: number;
  /** Sicherheit 0..1 (aus der YIN-Kostenfunktion abgeleitet). */
  confidence: number;
  /** RMS-Lautstaerke des Fensters. */
  energy: number;
}

export interface YinOptions {
  /** Schwellwert der YIN-Kostenfunktion (Standard 0.15). */
  threshold: number;
  minFrequency: number;
  maxFrequency: number;
}

export const DEFAULT_YIN_OPTIONS: YinOptions = {
  threshold: 0.15,
  minFrequency: 55, // A1
  maxFrequency: 2100, // ca. C7
};

/**
 * YIN-Tonhoehenerkennung fuer ein einzelnes Fenster.
 *
 * @param frame Zeitsignal (ohne Fensterfunktion, YIN braucht keine)
 * @param sampleRate Abtastrate in Hz
 */
export function detectPitchYin(
  frame: Float32Array,
  sampleRate: number,
  options: Partial<YinOptions> = {},
): PitchResult {
  const opts = { ...DEFAULT_YIN_OPTIONS, ...options };
  const bufferSize = frame.length;
  const halfSize = Math.floor(bufferSize / 2);

  // Energie zuerst pruefen: bei Stille lohnt sich die Analyse nicht.
  let energySum = 0;
  for (let i = 0; i < bufferSize; i++) energySum += frame[i] * frame[i];
  const energy = Math.sqrt(energySum / bufferSize);
  if (energy < 1e-4) return { frequency: 0, confidence: 0, energy };

  const maxTau = Math.min(halfSize, Math.floor(sampleRate / opts.minFrequency));
  const minTau = Math.max(2, Math.floor(sampleRate / opts.maxFrequency));
  if (maxTau <= minTau) return { frequency: 0, confidence: 0, energy };

  // Schritt 1+2: Differenzfunktion d(tau)
  const diff = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    const limit = bufferSize - tau;
    for (let i = 0; i < limit; i++) {
      const delta = frame[i] - frame[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Schritt 3: kumulative Mittelwertnormierung d'(tau)
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = runningSum > 0 ? (diff[tau] * tau) / runningSum : 1;
  }

  // Schritt 4: absolute Schwelle - erstes lokales Minimum unter threshold
  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmnd[tau] < opts.threshold) {
      // bis zum tatsaechlichen lokalen Minimum weiterlaufen
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  // Fallback: globales Minimum, wenn die Schwelle nie unterschritten wurde
  if (tauEstimate === -1) {
    let minValue = Number.POSITIVE_INFINITY;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (cmnd[tau] < minValue) {
        minValue = cmnd[tau];
        tauEstimate = tau;
      }
    }
    // Ohne klares Minimum ist die Aussage wertlos.
    if (tauEstimate === -1 || minValue > 0.6) {
      return { frequency: 0, confidence: 0, energy };
    }
  }

  // Schritt 5: parabolische Interpolation fuer Sub-Sample-Genauigkeit
  const refined = parabolicInterpolation(cmnd, tauEstimate);
  const period = refined.index;
  if (period <= 0) return { frequency: 0, confidence: 0, energy };

  const frequency = sampleRate / period;
  if (frequency < opts.minFrequency || frequency > opts.maxFrequency) {
    return { frequency: 0, confidence: 0, energy };
  }

  // cmnd nahe 0 = sehr periodisch = hohe Sicherheit.
  const confidence = Math.max(0, Math.min(1, 1 - cmnd[tauEstimate]));
  return { frequency, confidence, energy };
}

/**
 * Spektrale Tonhoehenschaetzung ueber das Harmonic Product Spectrum.
 * Robuster bei Klaengen mit schwacher Grundwelle (z.B. Klavier tiefe Lage),
 * daher als Zweitmeinung fuer die Oktavkorrektur eingesetzt.
 */
export function detectPitchHPS(
  frame: Float32Array,
  sampleRate: number,
  options: Partial<YinOptions> = {},
): PitchResult {
  const opts = { ...DEFAULT_YIN_OPTIONS, ...options };
  const windowed = applyHann(frame);
  const spectrum = magnitudeSpectrum(windowed);
  const binHz = sampleRate / (spectrum.length * 2);

  const harmonics = 5;
  const hpsLength = Math.floor(spectrum.length / harmonics);
  const hps = new Float32Array(hpsLength);
  for (let i = 0; i < hpsLength; i++) {
    let product = spectrum[i];
    for (let h = 2; h <= harmonics; h++) product *= spectrum[i * h];
    hps[i] = product;
  }

  const minBin = Math.max(1, Math.floor(opts.minFrequency / binHz));
  const maxBin = Math.min(hpsLength - 2, Math.ceil(opts.maxFrequency / binHz));
  let peakBin = -1;
  let peakValue = 0;
  for (let i = minBin; i <= maxBin; i++) {
    if (hps[i] > peakValue) {
      peakValue = hps[i];
      peakBin = i;
    }
  }
  if (peakBin < 0 || peakValue <= 0) return { frequency: 0, confidence: 0, energy: 0 };

  const refined = parabolicInterpolation(hps, peakBin);
  const frequency = refined.index * binHz;

  // Sicherheit aus dem Verhaeltnis Peak zu mittlerer Energie ableiten.
  let sum = 0;
  for (let i = minBin; i <= maxBin; i++) sum += hps[i];
  const mean = sum / Math.max(1, maxBin - minBin + 1);
  const ratio = mean > 0 ? peakValue / mean : 0;
  const confidence = Math.max(0, Math.min(1, Math.log10(1 + ratio) / 2));

  let energySum = 0;
  for (let i = 0; i < frame.length; i++) energySum += frame[i] * frame[i];
  return { frequency, confidence, energy: Math.sqrt(energySum / frame.length) };
}

/**
 * Kombinierte Schaetzung: YIN als Hauptverfahren, HPS zur Korrektur von
 * Oktavfehlern. Weichen beide um genau eine Oktave ab, gewinnt HPS, weil
 * YIN in tiefen Lagen zu Oktavspruengen neigt.
 */
export function detectPitch(
  frame: Float32Array,
  sampleRate: number,
  options: Partial<YinOptions> = {},
): PitchResult {
  const yin = detectPitchYin(frame, sampleRate, options);
  if (yin.frequency === 0) return yin;
  if (yin.confidence > 0.9) return yin;

  const hps = detectPitchHPS(frame, sampleRate, options);
  if (hps.frequency === 0) return yin;

  const ratio = hps.frequency / yin.frequency;
  const isOctaveBelow = Math.abs(ratio - 0.5) < 0.05;
  const isOctaveAbove = Math.abs(ratio - 2) < 0.1;
  if ((isOctaveBelow || isOctaveAbove) && hps.confidence > yin.confidence) {
    return { frequency: hps.frequency, confidence: hps.confidence * 0.9, energy: yin.energy };
  }
  return yin;
}

/**
 * Verfolgt die Tonhoehe ueber ein ganzes Signal.
 *
 * @returns Zeitreihe aus Frequenz, Sicherheit und Energie je Analysefenster.
 */
export interface PitchTrackPoint extends PitchResult {
  time: number;
}

export function trackPitch(
  samples: Float32Array,
  sampleRate: number,
  frameSize = 2048,
  hopSize = 256,
  options: Partial<YinOptions> = {},
): PitchTrackPoint[] {
  const track: PitchTrackPoint[] = [];
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const frame = samples.subarray(start, start + frameSize);
    const result = detectPitchYin(frame, sampleRate, options);
    track.push({ ...result, time: start / sampleRate });
  }
  return track;
}

/**
 * Glaettet eine Tonhoehenspur mit einem Medianfilter auf Halbtonebene.
 * Entfernt einzelne Ausreisser, ohne echte Tonwechsel zu verschmieren.
 */
export function smoothPitchTrack(track: PitchTrackPoint[], windowSize = 5): PitchTrackPoint[] {
  if (track.length === 0) return track;
  const half = Math.floor(windowSize / 2);
  return track.map((point, index) => {
    if (point.frequency === 0) return point;
    const values: number[] = [];
    for (let i = Math.max(0, index - half); i <= Math.min(track.length - 1, index + half); i++) {
      if (track[i].frequency > 0) values.push(track[i].frequency);
    }
    if (values.length === 0) return point;
    values.sort((a, b) => a - b);
    const med = values[Math.floor(values.length / 2)];
    // Nur korrigieren, wenn der Ausreisser deutlich abweicht (> 1 Halbton).
    const deviation = Math.abs(1200 * Math.log2(point.frequency / med));
    return deviation > 100 ? { ...point, frequency: med } : point;
  });
}
