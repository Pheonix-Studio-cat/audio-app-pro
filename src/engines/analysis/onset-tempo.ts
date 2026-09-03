/**
 * Onset-Erkennung und Tempo-Schaetzung.
 *
 * Onsets werden ueber Spectral Flux mit adaptiver Schwelle bestimmt
 * (Dixon, 2006). Aus der Onset-Huellkurve wird per Autokorrelation das
 * Tempo geschaetzt und anschliessend die Phase (Position der Zaehlzeit 1)
 * bestimmt, damit die Taktstriche sinnvoll liegen.
 */
import { applyHann, autocorrelationFFT, magnitudeSpectrum, median } from './dsp';
import type { TimeSignature } from '../../core/types';

export interface OnsetResult {
  /** Zeitpunkte der erkannten Anschlaege in Sekunden. */
  onsets: number[];
  /** Onset-Staerkefunktion (Spectral Flux, geglaettet). */
  envelope: Float32Array;
  /** Zeitabstand zwischen zwei Huellkurvenwerten in Sekunden. */
  hopTime: number;
}

/**
 * Berechnet die Spectral-Flux-Onset-Huellkurve.
 * Nur positive Aenderungen werden gezaehlt (Halbwellengleichrichtung),
 * weil ein Anschlag Energie hinzufuegt.
 */
export function computeOnsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameSize = 2048,
  hopSize = 512,
): { envelope: Float32Array; hopTime: number; frameCenterOffset: number } {
  const frameCount = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const envelope = new Float32Array(Math.max(0, frameCount));
  let previous: Float32Array | null = null;

  for (let f = 0; f < frameCount; f++) {
    const start = f * hopSize;
    const frame = applyHann(samples.subarray(start, start + frameSize));
    const spectrum = magnitudeSpectrum(frame);
    // Logarithmische Kompression betont leise Anschlaege realistischer.
    for (let i = 0; i < spectrum.length; i++) {
      spectrum[i] = Math.log1p(spectrum[i] * 10);
    }
    if (previous) {
      let flux = 0;
      for (let i = 0; i < spectrum.length; i++) {
        const delta = spectrum[i] - previous[i];
        if (delta > 0) flux += delta;
      }
      envelope[f] = flux;
    }
    previous = spectrum;
  }
  return {
    envelope,
    hopTime: hopSize / sampleRate,
    // Ein Fenster beschreibt das Signal um seine Mitte herum. Wird der
    // Fensteranfang als Zeitpunkt genommen, liegen alle Anschlaege
    // systematisch ein halbes Fenster zu frueh - bei 2048 Abtastwerten
    // rund 46 ms, was sich ueber mehrere Takte zu falschen Notenwerten
    // aufsummiert.
    frameCenterOffset: frameSize / 2 / sampleRate,
  };
}

/**
 * Findet Onsets in der Huellkurve ueber eine adaptive Median-Schwelle.
 *
 * @param sensitivity Multiplikator der Schwelle; kleiner = mehr Onsets.
 */
export function detectOnsets(
  samples: Float32Array,
  sampleRate: number,
  sensitivity = 1.3,
  hopSize = 512,
): OnsetResult {
  const { envelope, hopTime, frameCenterOffset } = computeOnsetEnvelope(
    samples,
    sampleRate,
    2048,
    hopSize,
  );
  const onsets: number[] = [];
  if (envelope.length < 3) return { onsets, envelope, hopTime };

  // Adaptive Schwelle: gleitender Median plus konstanter Offset.
  const windowFrames = Math.max(3, Math.round(0.2 / hopTime));
  const threshold = new Float32Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) {
    const from = Math.max(0, i - windowFrames);
    const to = Math.min(envelope.length - 1, i + windowFrames);
    const slice: number[] = [];
    for (let j = from; j <= to; j++) slice.push(envelope[j]);
    threshold[i] = median(slice) * sensitivity;
  }

  let globalMax = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i] > globalMax) globalMax = envelope[i];
  const floor = globalMax * 0.05;

  // Mindestabstand zwischen Onsets: 50 ms (schneller ist musikalisch selten).
  const minGapFrames = Math.max(1, Math.round(0.05 / hopTime));
  let lastOnsetFrame = -minGapFrames;

  for (let i = 1; i < envelope.length - 1; i++) {
    const value = envelope[i];
    const isPeak = value > envelope[i - 1] && value >= envelope[i + 1];
    if (!isPeak) continue;
    if (value < threshold[i] || value < floor) continue;
    if (i - lastOnsetFrame < minGapFrames) continue;
    onsets.push(Math.max(0, i * hopTime + frameCenterOffset));
    lastOnsetFrame = i;
  }

  return { onsets, envelope, hopTime };
}

export interface TempoEstimate {
  bpm: number;
  confidence: number;
  /** Zeitpunkt der ersten Zaehlzeit in Sekunden. */
  beatPhase: number;
  /** Alle geschaetzten Beat-Positionen. */
  beats: number[];
}

/**
 * Schaetzt das Tempo aus der Onset-Huellkurve.
 * Sucht das Autokorrelationsmaximum im musikalisch sinnvollen Bereich
 * 40-220 BPM und korrigiert typische Halb-/Doppeltempo-Fehler.
 */
export function estimateTempo(
  envelope: Float32Array,
  hopTime: number,
  minBpm = 40,
  maxBpm = 220,
): TempoEstimate {
  if (envelope.length < 8) {
    return { bpm: 120, confidence: 0, beatPhase: 0, beats: [] };
  }

  // Mittelwertfrei machen, damit die Autokorrelation nicht vom Offset dominiert wird.
  let mean = 0;
  for (let i = 0; i < envelope.length; i++) mean += envelope[i];
  mean /= envelope.length;
  const centered = new Float32Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) centered[i] = Math.max(0, envelope[i] - mean);

  const acf = autocorrelationFFT(centered);
  const minLag = Math.max(1, Math.floor(60 / (maxBpm * hopTime)));
  const maxLag = Math.min(acf.length - 1, Math.ceil(60 / (minBpm * hopTime)));

  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // Perioden mit Vielfachen belohnen: echte Beat-Perioden wiederholen sich.
    let score = acf[lag];
    if (lag * 2 <= maxLag) score += acf[lag * 2] * 0.5;
    if (lag * 3 < acf.length) score += acf[lag * 3] * 0.25;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return { bpm: 120, confidence: 0, beatPhase: 0, beats: [] };

  let bpm = 60 / (bestLag * hopTime);
  // In den ueblichen Notationsbereich falten.
  while (bpm < 60) bpm *= 2;
  while (bpm > 200) bpm /= 2;

  const confidence = acf[0] > 0 ? Math.max(0, Math.min(1, bestScore / (acf[0] * 1.75))) : 0;

  // Phase bestimmen: Verschiebung, bei der die Beats auf viel Onset-Energie fallen.
  const periodFrames = 60 / (bpm * hopTime);
  let bestPhase = 0;
  let bestPhaseScore = -1;
  const phaseSteps = Math.max(1, Math.round(periodFrames));
  for (let phase = 0; phase < phaseSteps; phase++) {
    let sum = 0;
    for (let beat = 0; ; beat++) {
      const index = Math.round(phase + beat * periodFrames);
      if (index >= envelope.length) break;
      sum += envelope[index];
    }
    if (sum > bestPhaseScore) {
      bestPhaseScore = sum;
      bestPhase = phase;
    }
  }

  const beats: number[] = [];
  for (let beat = 0; ; beat++) {
    const index = bestPhase + beat * periodFrames;
    if (index >= envelope.length) break;
    beats.push(index * hopTime);
  }

  return { bpm, confidence, beatPhase: bestPhase * hopTime, beats };
}

/**
 * Schaetzt die Taktart aus der Betonungsstruktur.
 *
 * Vergleicht, ob die Onset-Energie eher im Zweier-/Vierer- oder im
 * Dreiermuster akzentuiert ist. Das ist ein heuristisches Verfahren; die
 * gemeldete Sicherheit sagt ehrlich, wie klar das Ergebnis ist.
 */
export function estimateTimeSignature(
  envelope: Float32Array,
  hopTime: number,
  bpm: number,
): { timeSignature: TimeSignature; confidence: number } {
  const periodFrames = 60 / (bpm * hopTime);
  if (envelope.length < periodFrames * 8) {
    return { timeSignature: { beats: 4, beatType: 4 }, confidence: 0 };
  }

  const candidates: Array<{ ts: TimeSignature; beatsPerBar: number }> = [
    { ts: { beats: 4, beatType: 4 }, beatsPerBar: 4 },
    { ts: { beats: 3, beatType: 4 }, beatsPerBar: 3 },
    { ts: { beats: 2, beatType: 4 }, beatsPerBar: 2 },
    { ts: { beats: 6, beatType: 8 }, beatsPerBar: 6 },
  ];

  const scores = candidates.map(({ ts, beatsPerBar }) => {
    // Fuer 6/8 zaehlen wir Achtel, also halbe Beat-Periode.
    const step = ts.beatType === 8 ? periodFrames / 2 : periodFrames;
    let downbeatSum = 0;
    let otherSum = 0;
    let downbeatCount = 0;
    let otherCount = 0;
    for (let i = 0; ; i++) {
      const index = Math.round(i * step);
      if (index >= envelope.length) break;
      if (i % beatsPerBar === 0) {
        downbeatSum += envelope[index];
        downbeatCount++;
      } else {
        otherSum += envelope[index];
        otherCount++;
      }
    }
    const downbeatAvg = downbeatCount > 0 ? downbeatSum / downbeatCount : 0;
    const otherAvg = otherCount > 0 ? otherSum / otherCount : 1;
    return { ts, ratio: otherAvg > 0 ? downbeatAvg / otherAvg : 0 };
  });

  scores.sort((a, b) => b.ratio - a.ratio);
  const best = scores[0];
  const runnerUp = scores[1];
  // Sicherheit aus dem Abstand zum Zweitplatzierten.
  const margin = runnerUp && runnerUp.ratio > 0 ? (best.ratio - runnerUp.ratio) / best.ratio : 0;
  const confidence = Math.max(0, Math.min(1, margin * 2.5));
  return { timeSignature: best.ts, confidence };
}


export interface TempoRefinement {
  bpm: number;
  /** Zeitlicher Versatz der ersten Zaehlzeit in Sekunden. */
  offset: number;
  /** Mittlere Abweichung der Anschlaege vom Raster, in Anteilen eines Rasterschritts. */
  error: number;
}

/**
 * Verfeinert die Tempo-Schaetzung anhand der tatsaechlich erkannten
 * Notenanfaenge.
 *
 * Die Autokorrelation liefert das Tempo nur so genau, wie es die
 * Fensterbreite zulaesst. Schon zwei Prozent Abweichung summieren sich
 * ueber acht Zaehlzeiten zu einem Sechzehntel und lassen Noten ueber den
 * Taktstrich rutschen. Hier wird deshalb das Paar aus Tempo und Versatz
 * gesucht, bei dem die Anschlaege am besten auf dem Notenraster liegen.
 *
 * Bewusst wird ein grobes Raster benutzt (standardmaessig Achtel). Ein
 * feines Raster wuerde jede einzelne Ungenauigkeit der Anschlagserkennung
 * mitbewerten und koennte ein leicht falsches Tempo mit passendem Versatz
 * bevorzugen. Anschlaege liegen in der Praxis fast immer auf Achteln oder
 * groeber.
 *
 * @param onsetTimes Startzeiten der erkannten Noten in Sekunden
 * @param initialBpm Ausgangsschaetzung
 * @param gridQuarters Rasterweite in Vierteln (Standard: Achtel)
 */
export function refineTempo(
  onsetTimes: number[],
  initialBpm: number,
  gridQuarters = 0.5,
): TempoRefinement {
  if (onsetTimes.length < 3 || initialBpm <= 0) {
    return { bpm: initialBpm, offset: 0, error: 1 };
  }

  const sorted = [...onsetTimes].sort((a, b) => a - b);
  const searchRange = 0.14; // plus/minus 14 Prozent
  const bpmSteps = 140;
  const offsetSteps = 24;

  let best: TempoRefinement = { bpm: initialBpm, offset: 0, error: Number.POSITIVE_INFINITY };

  for (let i = 0; i <= bpmSteps; i++) {
    const bpm = initialBpm * (1 - searchRange + (2 * searchRange * i) / bpmSteps);
    if (bpm <= 20 || bpm > 320) continue;
    const gridSeconds = (60 / bpm) * gridQuarters;

    for (let j = 0; j < offsetSteps; j++) {
      const offset = (gridSeconds * j) / offsetSteps;

      let squaredError = 0;
      for (const time of sorted) {
        const position = (time - offset) / gridSeconds;
        const distance = Math.abs(position - Math.round(position));
        squaredError += distance * distance;
      }
      const error = Math.sqrt(squaredError / sorted.length);

      if (error < best.error) best = { bpm, offset, error };
    }
  }

  // Ohne echte Verbesserung bleibt die Ausgangsschaetzung stehen.
  if (!Number.isFinite(best.error)) return { bpm: initialBpm, offset: 0, error: 1 };
  return best;
}
