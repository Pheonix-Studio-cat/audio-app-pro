/**
 * Grobe Klassifikation der Klangquelle anhand spektraler Merkmale.
 *
 * WICHTIG - ehrliche Einordnung: Dies ist kein trainiertes neuronales Netz,
 * sondern ein regelbasierter Klassifikator ueber vier Merkmale
 * (spektraler Schwerpunkt, Attack-Zeit, Harmonizitaet, Bandbreite).
 * Er unterscheidet Klanggruppen zuverlaessig genug, um eine sinnvolle
 * Voreinstellung fuer Schluessel und Wiedergabeklang zu treffen, ersetzt
 * aber keine echte Instrumentenerkennung. Die gemeldete Sicherheit ist
 * entsprechend konservativ.
 */
import { applyHann, magnitudeSpectrum } from './dsp';

export interface SpectralFeatures {
  /** Spektraler Schwerpunkt in Hz - Mass fuer Helligkeit. */
  centroid: number;
  /** Frequenzbereich, der 85 % der Energie enthaelt. */
  rolloff: number;
  /** Anteil harmonischer Energie 0..1. */
  harmonicity: number;
  /** Anstiegszeit bis zum Lautstaerkemaximum in Sekunden. */
  attackTime: number;
  /** Schwankung des Schwerpunkts ueber die Zeit. */
  centroidVariation: number;
}

/** Berechnet spektrale Merkmale ueber das gesamte Signal. */
export function extractSpectralFeatures(
  samples: Float32Array,
  sampleRate: number,
): SpectralFeatures {
  const frameSize = 2048;
  const hopSize = 1024;
  const centroids: number[] = [];
  const rolloffs: number[] = [];
  const harmonicities: number[] = [];

  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const spectrum = magnitudeSpectrum(applyHann(samples.subarray(start, start + frameSize)));
    const binHz = sampleRate / (spectrum.length * 2);

    let totalEnergy = 0;
    let weightedSum = 0;
    for (let i = 1; i < spectrum.length; i++) {
      totalEnergy += spectrum[i];
      weightedSum += spectrum[i] * i * binHz;
    }
    if (totalEnergy < 1e-6) continue;

    centroids.push(weightedSum / totalEnergy);

    // Rolloff: Frequenz, unter der 85 % der Energie liegen.
    let cumulative = 0;
    const target = totalEnergy * 0.85;
    for (let i = 1; i < spectrum.length; i++) {
      cumulative += spectrum[i];
      if (cumulative >= target) {
        rolloffs.push(i * binHz);
        break;
      }
    }

    harmonicities.push(estimateHarmonicity(spectrum, binHz));
  }

  const average = (values: number[]) =>
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  const centroidMean = average(centroids);
  const centroidVariation =
    centroids.length > 1
      ? Math.sqrt(average(centroids.map((c) => (c - centroidMean) ** 2))) / Math.max(1, centroidMean)
      : 0;

  return {
    centroid: centroidMean,
    rolloff: average(rolloffs),
    harmonicity: average(harmonicities),
    attackTime: estimateAttackTime(samples, sampleRate),
    centroidVariation,
  };
}

/**
 * Schaetzt, wie harmonisch ein Spektrum ist: Anteil der Energie in
 * Peaks, die auf einem ganzzahligen Vielfachen des staerksten Peaks liegen.
 */
function estimateHarmonicity(spectrum: Float32Array, binHz: number): number {
  let peakBin = 1;
  let peakValue = 0;
  const maxBin = Math.min(spectrum.length, Math.floor(2000 / binHz));
  for (let i = 2; i < maxBin; i++) {
    if (spectrum[i] > peakValue) {
      peakValue = spectrum[i];
      peakBin = i;
    }
  }
  if (peakValue <= 0) return 0;

  let harmonicEnergy = 0;
  let totalEnergy = 0;
  for (let i = 1; i < spectrum.length; i++) totalEnergy += spectrum[i];
  if (totalEnergy <= 0) return 0;

  for (let h = 1; h <= 10; h++) {
    const center = peakBin * h;
    if (center >= spectrum.length) break;
    const width = Math.max(1, Math.round(center * 0.02));
    for (let bin = center - width; bin <= center + width; bin++) {
      if (bin > 0 && bin < spectrum.length) harmonicEnergy += spectrum[bin];
    }
  }
  return Math.min(1, harmonicEnergy / totalEnergy);
}

/** Zeit vom Signalbeginn bis zum ersten Lautstaerkemaximum. */
function estimateAttackTime(samples: Float32Array, sampleRate: number): number {
  const windowSize = Math.max(1, Math.floor(sampleRate * 0.005));
  const envelope: number[] = [];
  for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
    let sum = 0;
    for (let i = start; i < start + windowSize; i++) sum += samples[i] * samples[i];
    envelope.push(Math.sqrt(sum / windowSize));
  }
  if (envelope.length === 0) return 0;

  // Erster nennenswerter Einsatz und das darauf folgende lokale Maximum.
  let peakValue = 0;
  for (const v of envelope) if (v > peakValue) peakValue = v;
  if (peakValue <= 0) return 0;

  const onsetThreshold = peakValue * 0.1;
  let onsetIndex = 0;
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] >= onsetThreshold) {
      onsetIndex = i;
      break;
    }
  }
  let peakIndex = onsetIndex;
  for (let i = onsetIndex; i < Math.min(envelope.length, onsetIndex + 200); i++) {
    if (envelope[i] > envelope[peakIndex]) peakIndex = i;
  }
  return ((peakIndex - onsetIndex) * windowSize) / sampleRate;
}

export interface InstrumentGuess {
  name: string;
  confidence: number;
  /** Kurze Begruendung, damit der Nutzer die Einschaetzung einordnen kann. */
  reason: string;
}

/**
 * Ordnet die Merkmale einer Klanggruppe zu.
 * Bewusst grobkoernig: Klanggruppe statt konkretem Instrument.
 */
export function classifyInstrument(features: SpectralFeatures): InstrumentGuess {
  const { centroid, harmonicity, attackTime, centroidVariation } = features;

  const candidates: InstrumentGuess[] = [];

  // Perkussiv: sehr kurzer Attack, wenig harmonisch.
  if (harmonicity < 0.35 && attackTime < 0.02) {
    candidates.push({
      name: 'Schlagzeug/Perkussion',
      confidence: 0.55 + (0.35 - harmonicity),
      reason: 'geraeuschhaftes Spektrum mit sehr schnellem Einschwingen',
    });
  }

  // Zupf-/Anschlagsinstrumente: schneller Attack, harmonisch.
  if (harmonicity >= 0.4 && attackTime < 0.035) {
    const isBright = centroid > 1400;
    candidates.push({
      name: isBright ? 'Gitarre/Zupfinstrument' : 'Klavier',
      confidence: 0.5 + harmonicity * 0.3,
      reason: 'harmonisches Spektrum mit perkussivem Anschlag',
    });
  }

  // Streicher/Blaeser: langsamer Attack, sehr harmonisch, stabiles Spektrum.
  if (harmonicity >= 0.45 && attackTime >= 0.035) {
    const isBright = centroid > 1800;
    candidates.push({
      name: isBright ? 'Blasinstrument' : 'Streichinstrument',
      confidence: 0.45 + harmonicity * 0.3,
      reason: 'gehaltener Klang mit weichem Einschwingen',
    });
  }

  // Gesang: mittlerer Schwerpunkt, hohe Harmonizitaet, starke Schwankung (Vibrato/Formanten).
  if (harmonicity >= 0.4 && centroidVariation > 0.35 && centroid < 2500) {
    candidates.push({
      name: 'Gesang/Stimme',
      confidence: 0.45 + centroidVariation * 0.2,
      reason: 'stark schwankendes Spektrum wie bei Vokalen und Vibrato',
    });
  }

  if (candidates.length === 0) {
    return {
      name: 'Unbekannte Klangquelle',
      confidence: 0.15,
      reason: 'Merkmale passen zu keiner bekannten Klanggruppe',
    };
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  // Sicherheit deckeln: das Verfahren ist heuristisch.
  return { ...best, confidence: Math.min(0.75, best.confidence) };
}
