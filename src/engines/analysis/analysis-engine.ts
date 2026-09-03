/**
 * Analyse-Engine: fuehrt alle Teilschritte zu einem Gesamtergebnis zusammen.
 *
 * Ablauf:
 *   Audio -> Vorverarbeitung -> Onsets -> Tempo -> Tonhoehe -> Segmentierung
 *        -> Tonart -> Akkorde -> Instrument -> Ergebnis
 *
 * Die Funktion meldet ihren Fortschritt, damit die UI eine ehrliche
 * Statusanzeige zeigen kann statt eines Fake-Ladebalkens.
 */
import type { AnalysisOptions, AnalysisResult, DetectedNote } from '../../core/types';
import { DEFAULT_ANALYSIS_OPTIONS } from '../../core/types';
import { normalize, resampleLinear } from '../audio/audio-engine';
import { detectOnsets, estimateTempo, estimateTimeSignature, refineTempo } from './onset-tempo';
import { smoothPitchTrack, trackPitch } from './pitch-detection';
import { segmentNotes, segmentPolyphonicNotes } from './note-segmentation';
import {
  averageChroma,
  detectChords,
  detectPolyphonicPitches,
  estimateKey,
} from './harmony';
import { classifyInstrument, extractSpectralFeatures } from './instrument-classifier';
import { keySignatureName, midiToFrequency } from '../../core/music-theory';
import { DURATION_QUARTERS } from '../../core/types';

/** Abtastrate, auf die vor der Analyse heruntergerechnet wird. */
const ANALYSIS_SAMPLE_RATE = 22050;

export interface AnalysisProgress {
  /** 0..1 */
  progress: number;
  /** Beschreibung des aktuellen Schritts. */
  step: string;
}

export type ProgressCallback = (progress: AnalysisProgress) => void;

/**
 * Analysiert ein Monosignal und liefert Noten, Tempo, Tonart und Akkorde.
 *
 * @param samples Monosignal
 * @param sampleRate Abtastrate des Eingangssignals
 */
export async function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  options: Partial<AnalysisOptions> = {},
  onProgress?: ProgressCallback,
): Promise<AnalysisResult> {
  const opts = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  const warnings: string[] = [];
  const report = (progress: number, step: string) => onProgress?.({ progress, step });

  report(0.02, 'Signal wird vorbereitet');
  // Herunterrechnen spart Rechenzeit; 22,05 kHz reichen bis ca. 11 kHz,
  // deutlich mehr als der genutzte Tonhoehenbereich braucht.
  const resampled = resampleLinear(samples, sampleRate, ANALYSIS_SAMPLE_RATE);
  const signal = normalize(resampled);
  const duration = signal.length / ANALYSIS_SAMPLE_RATE;

  if (duration < 0.3) {
    warnings.push('Das Audiomaterial ist sehr kurz. Tempo- und Taktartschaetzung sind unzuverlaessig.');
  }
  if (duration > 600) {
    warnings.push('Sehr langes Material: Die Analyse kann einige Minuten dauern.');
  }

  await yieldToUi();
  report(0.1, 'Anschlaege werden gesucht');
  const onsetResult = detectOnsets(signal, ANALYSIS_SAMPLE_RATE);
  if (onsetResult.onsets.length === 0) {
    warnings.push('Es wurden keine klaren Anschlaege gefunden. Die Rhythmik ist moeglicherweise ungenau.');
  }

  await yieldToUi();
  report(0.22, 'Tempo wird geschaetzt');
  const tempoEstimate = estimateTempo(onsetResult.envelope, onsetResult.hopTime);
  const tempo = opts.fixedTempo ?? Math.round(tempoEstimate.bpm);
  if (!opts.fixedTempo && tempoEstimate.confidence < 0.35) {
    warnings.push(
      `Das Tempo (${Math.round(tempoEstimate.bpm)} BPM) konnte nur unsicher bestimmt werden. ` +
        'Du kannst es im Editor korrigieren.',
    );
  }

  await yieldToUi();
  report(0.3, 'Taktart wird geschaetzt');
  const timeSignatureEstimate = estimateTimeSignature(
    onsetResult.envelope,
    onsetResult.hopTime,
    tempo,
  );
  if (timeSignatureEstimate.confidence < 0.3) {
    warnings.push('Die Taktart konnte nicht zuverlaessig erkannt werden. Es wird 4/4 angenommen.');
  }
  const timeSignature =
    timeSignatureEstimate.confidence >= 0.3
      ? timeSignatureEstimate.timeSignature
      : { beats: 4, beatType: 4 };

  await yieldToUi();
  report(0.4, 'Tonhoehen werden verfolgt');

  let notes: DetectedNote[];
  if (opts.polyphonic) {
    notes = await analyzePolyphonic(signal, opts, report);
  } else {
    const track = smoothPitchTrack(
      trackPitch(signal, ANALYSIS_SAMPLE_RATE, 2048, 256, {
        minFrequency: midiToFrequency(opts.minMidi),
        maxFrequency: midiToFrequency(opts.maxMidi),
      }),
    );
    await yieldToUi();
    report(0.65, 'Noten werden gebildet');
    notes = segmentNotes(track, onsetResult.onsets, {
      minConfidence: opts.minConfidence,
      minMidi: opts.minMidi,
      maxMidi: opts.maxMidi,
    });
  }

  if (notes.length === 0) {
    warnings.push(
      'Es wurden keine Noten erkannt. Moegliche Ursachen: sehr leises Material, ' +
        'starke Verzerrung oder ein Tonhoehenbereich ausserhalb der Einstellung.',
    );
  }

  // Tempo anhand der erkannten Notenanfaenge nachjustieren. Ohne diesen
  // Schritt summiert sich schon eine kleine Abweichung ueber wenige Takte
  // so weit auf, dass Noten ueber den Taktstrich rutschen.
  let refinedTempo = tempo;
  let beatOffset = 0;
  if (!opts.fixedTempo && notes.length >= 3) {
    await yieldToUi();
    report(0.7, 'Tempo wird nachjustiert');
    // Fuer die Tempo-Justierung wird hoechstens ein Achtelraster benutzt,
    // auch wenn der Nutzer feiner quantisieren laesst.
    const refinementGrid = Math.max(0.5, DURATION_QUARTERS[opts.quantizeGrid]);
    const refinement = refineTempo(
      notes.map((note) => note.start),
      tempo,
      refinementGrid,
    );
    // Nur uebernehmen, wenn die Anschlaege danach spuerbar besser
    // auf dem Raster liegen.
    if (refinement.error < 0.18) {
      refinedTempo = refinement.bpm;
      beatOffset = refinement.offset;
    } else {
      warnings.push(
        'Die Anschlaege liegen nicht auf einem gleichmaessigen Raster. ' +
          'Die Notenwerte koennen daher ungenau sein.',
      );
    }
  }

  await yieldToUi();
  report(0.75, 'Tonart wird bestimmt');
  const chroma = averageChroma(signal, ANALYSIS_SAMPLE_RATE);
  const keyEstimate = estimateKey(chroma);
  if (keyEstimate.confidence < 0.3) {
    warnings.push('Die Tonart ist mehrdeutig. Vorzeichen bitte pruefen.');
  }

  await yieldToUi();
  report(0.85, 'Akkorde werden erkannt');
  let chords: AnalysisResult['chords'] = [];
  if (opts.detectChords) {
    // Segmentgrenzen: bevorzugt Taktschwerpunkte, sonst feste Fenster.
    const boundaries = buildChordBoundaries(tempoEstimate.beats, timeSignature.beats, duration);
    chords = detectChords(signal, ANALYSIS_SAMPLE_RATE, boundaries);
  }

  await yieldToUi();
  report(0.93, 'Klangquelle wird eingeschaetzt');
  const features = extractSpectralFeatures(signal, ANALYSIS_SAMPLE_RATE);
  const instrument = classifyInstrument(features);
  if (instrument.confidence < 0.4) {
    warnings.push(
      `Die Klangquelle wurde nur grob als "${instrument.name}" eingeschaetzt (${instrument.reason}).`,
    );
  }

  // Durchschnittliche Erkennungssicherheit als Gesamtaussage.
  const averageConfidence =
    notes.length > 0 ? notes.reduce((s, n) => s + n.confidence, 0) / notes.length : 0;
  if (notes.length > 0 && averageConfidence < 0.6) {
    warnings.push(
      'Viele Noten wurden nur mit geringer Sicherheit erkannt. ' +
        'Unsichere Noten sind im Editor farblich markiert.',
    );
  }

  report(1, 'Analyse abgeschlossen');

  return {
    notes,
    chords,
    tempo: Math.round(refinedTempo * 10) / 10,
    beatOffset,
    tempoConfidence: opts.fixedTempo ? 1 : tempoEstimate.confidence,
    timeSignature,
    timeSignatureConfidence: timeSignatureEstimate.confidence,
    keySignature: keyEstimate.fifths,
    keyName: `${keyEstimate.name} (${keySignatureName(keyEstimate.fifths)})`,
    keyConfidence: keyEstimate.confidence,
    instrument: { name: instrument.name, confidence: instrument.confidence },
    duration,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    warnings,
  };
}

/** Mehrstimmige Analyse ueber iterative Spektralsubtraktion. */
async function analyzePolyphonic(
  signal: Float32Array,
  opts: AnalysisOptions,
  report: (progress: number, step: string) => void,
): Promise<DetectedNote[]> {
  const frameSize = 4096;
  const hopSize = 1024;
  const frameTime = hopSize / ANALYSIS_SAMPLE_RATE;
  const frames: Array<{ time: number; pitches: Array<{ midi: number; salience: number }> }> = [];

  const frameCount = Math.max(1, Math.floor((signal.length - frameSize) / hopSize) + 1);
  for (let f = 0; f < frameCount; f++) {
    const start = f * hopSize;
    const frame = signal.subarray(start, start + frameSize);
    const pitches = detectPolyphonicPitches(
      frame,
      ANALYSIS_SAMPLE_RATE,
      4,
      opts.minMidi,
      opts.maxMidi,
    );
    frames.push({ time: start / ANALYSIS_SAMPLE_RATE, pitches });

    if (f % 40 === 0) {
      report(0.4 + 0.25 * (f / frameCount), 'Mehrstimmige Analyse laeuft');
      await yieldToUi();
    }
  }

  return segmentPolyphonicNotes(frames, frameTime);
}

/**
 * Baut Segmentgrenzen fuer die Akkorderkennung.
 * Bevorzugt werden Taktanfaenge, weil Harmoniewechsel meist dort liegen.
 */
function buildChordBoundaries(beats: number[], beatsPerBar: number, duration: number): number[] {
  if (beats.length > beatsPerBar) {
    const boundaries: number[] = [];
    for (let i = 0; i < beats.length; i += Math.max(1, Math.floor(beatsPerBar / 2))) {
      boundaries.push(beats[i]);
    }
    if (boundaries[boundaries.length - 1] < duration) boundaries.push(duration);
    return boundaries;
  }
  // Kein brauchbares Beat-Raster: feste Fenster von 0,5 s.
  const boundaries: number[] = [];
  for (let t = 0; t < duration; t += 0.5) boundaries.push(t);
  boundaries.push(duration);
  return boundaries;
}

/**
 * Gibt die Kontrolle kurz an den Browser zurueck, damit die Oberflaeche
 * waehrend der Analyse reagierbar bleibt.
 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
