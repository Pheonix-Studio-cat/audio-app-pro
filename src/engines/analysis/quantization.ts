/**
 * Quantisierung: wandelt zeitlich kontinuierliche Notenereignisse in ein
 * musikalisches Raster (Notenwerte, Takte, Pausen) um.
 *
 * Das ist der Schritt, der aus "Frequenz bei Sekunde 1,237" echte
 * Notenschrift macht.
 */
import type {
  AnalysisResult,
  DetectedNote,
  DurationValue,
  Measure,
  Score,
  ScoreNote,
  TimeSignature,
} from '../../core/types';
import { DURATION_QUARTERS } from '../../core/types';
import {
  createId,
  durationInQuarters,
  measureCapacity,
  midiToPitch,
  splitDuration,
  suggestClef,
} from '../../core/music-theory';
import { createMeasure, createRest, normalizeMeasure } from '../../core/score-model';

export interface QuantizationOptions {
  /** Kleinster Notenwert im Raster. */
  grid: DurationValue;
  /** Zeitpunkt der ersten Zaehlzeit in Sekunden. */
  beatOffset: number;
  /** Punktierte Werte zulassen. */
  allowDots: boolean;
  /** Ueberbindungen ueber Taktgrenzen erzeugen. */
  allowTies: boolean;
}

export const DEFAULT_QUANTIZATION_OPTIONS: QuantizationOptions = {
  grid: '16th',
  beatOffset: 0,
  allowDots: true,
  allowTies: true,
};

/** Ein quantisiertes Ereignis auf dem Viertelraster. */
export interface QuantizedEvent {
  /** Startposition in Vierteln ab Stueckbeginn. */
  startQuarters: number;
  /** Laenge in Vierteln. */
  durationQuarters: number;
  /** Leeres Array = Pause. */
  midis: number[];
  confidence: number;
  velocity: number;
}

/**
 * Rastert erkannte Noten auf das Notenraster.
 *
 * @param notes Erkannte Notenereignisse (Sekunden)
 * @param tempo Tempo in Viertel pro Minute
 */
export function quantizeNotes(
  notes: DetectedNote[],
  tempo: number,
  options: Partial<QuantizationOptions> = {},
): QuantizedEvent[] {
  const opts = { ...DEFAULT_QUANTIZATION_OPTIONS, ...options };
  if (notes.length === 0) return [];

  const secondsPerQuarter = 60 / tempo;
  const gridQuarters = DURATION_QUARTERS[opts.grid];

  // Gleichzeitige Noten zu Akkorden gruppieren.
  const groups = groupSimultaneous(notes, secondsPerQuarter * gridQuarters * 0.5);

  const events: QuantizedEvent[] = [];
  for (const group of groups) {
    const startQuarters = (group.start - opts.beatOffset) / secondsPerQuarter;
    const durationQuarters = group.duration / secondsPerQuarter;

    const snappedStart = Math.max(0, Math.round(startQuarters / gridQuarters) * gridQuarters);
    let snappedDuration = Math.round(durationQuarters / gridQuarters) * gridQuarters;
    // Noten duerfen nicht auf Laenge 0 zusammenfallen.
    if (snappedDuration < gridQuarters) snappedDuration = gridQuarters;

    events.push({
      startQuarters: snappedStart,
      durationQuarters: snappedDuration,
      midis: group.midis,
      confidence: group.confidence,
      velocity: group.velocity,
    });
  }

  events.sort((a, b) => a.startQuarters - b.startQuarters);
  return resolveOverlaps(events, gridQuarters);
}

/** Fasst zeitgleich beginnende Noten zu einem Akkord zusammen. */
function groupSimultaneous(
  notes: DetectedNote[],
  tolerance: number,
): Array<{ start: number; duration: number; midis: number[]; confidence: number; velocity: number }> {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const groups: Array<{
    start: number;
    duration: number;
    midis: number[];
    confidence: number;
    velocity: number;
  }> = [];

  for (const note of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(note.start - last.start) <= tolerance) {
      last.midis.push(note.midi);
      // Laenge des Akkords: laengste beteiligte Note.
      last.duration = Math.max(last.duration, note.duration);
      last.confidence = Math.min(last.confidence, note.confidence);
      last.velocity = Math.max(last.velocity, note.velocity);
      continue;
    }
    groups.push({
      start: note.start,
      duration: note.duration,
      midis: [note.midi],
      confidence: note.confidence,
      velocity: note.velocity,
    });
  }
  // Doppelte Tonhoehen im Akkord entfernen.
  for (const group of groups) {
    group.midis = [...new Set(group.midis)].sort((a, b) => a - b);
  }
  return groups;
}

/** Kuerzt Ereignisse, die in das naechste hineinragen. */
function resolveOverlaps(events: QuantizedEvent[], gridQuarters: number): QuantizedEvent[] {
  for (let i = 0; i < events.length - 1; i++) {
    const current = events[i];
    const next = events[i + 1];
    const end = current.startQuarters + current.durationQuarters;
    if (end > next.startQuarters) {
      const available = next.startQuarters - current.startQuarters;
      current.durationQuarters = Math.max(gridQuarters, available);
    }
  }
  return events.filter((e) => e.durationQuarters > 0);
}

/**
 * Baut aus quantisierten Ereignissen eine vollstaendige Partitur mit
 * Takten, Pausen und Ueberbindungen.
 */
export function eventsToScore(
  events: QuantizedEvent[],
  analysis: AnalysisResult,
  title: string,
  options: Partial<QuantizationOptions> = {},
): Score {
  const opts = { ...DEFAULT_QUANTIZATION_OPTIONS, ...options };
  const timeSignature = analysis.timeSignature;
  const capacity = measureCapacity(timeSignature);
  const fifths = analysis.keySignature;

  const allMidis = events.flatMap((e) => e.midis);
  const clef = suggestClef(allMidis);

  const measures: Measure[] = [];
  let position = 0; // aktuelle Position in Vierteln
  let measureIndex = 0;
  let currentMeasure: Measure = { id: createId('m'), notes: [] };

  /** Wechselt in den naechsten Takt. */
  const flushMeasure = () => {
    normalizeMeasure(currentMeasure, timeSignature);
    measures.push(currentMeasure);
    currentMeasure = { id: createId('m'), notes: [] };
    measureIndex++;
  };

  /** Fuegt ein Ereignis (Note oder Pause) taktueberschreitend ein. */
  const addEvent = (durationQuarters: number, midis: number[], confidence: number) => {
    let remaining = durationQuarters;
    let isContinuation = false;

    let guard = 0;
    while (remaining > 1e-6 && guard++ < 200) {
      const measureStart = measureIndex * capacity;
      const filled = position - measureStart;
      const spaceLeft = capacity - filled;

      if (spaceLeft <= 1e-6) {
        flushMeasure();
        continue;
      }

      const chunk = Math.min(remaining, spaceLeft);
      for (const part of splitDuration(chunk)) {
        const dots = opts.allowDots ? part.dots : 0;
        const partQuarters = durationInQuarters(part.duration, dots);
        if (partQuarters > chunk + 1e-6) continue;

        const note: ScoreNote = {
          id: createId('n'),
          pitches: midis.map((m) => midiToPitch(m, fifths)),
          duration: part.duration,
          dots,
          isRest: midis.length === 0,
          confidence: midis.length > 0 ? confidence : undefined,
          autoDetected: midis.length > 0,
        };
        if (midis.length > 0 && opts.allowTies) {
          if (isContinuation) note.tieStop = true;
          note.tieStart = true; // wird unten korrigiert, wenn es die letzte ist
        }
        currentMeasure.notes.push(note);
        position += partQuarters;
        isContinuation = true;
      }

      remaining -= chunk;
      // Letzte Note darf keine offene Ueberbindung haben.
      if (remaining <= 1e-6) {
        const last = currentMeasure.notes[currentMeasure.notes.length - 1];
        if (last && last.tieStart) last.tieStart = false;
      }
    }
  };

  for (const event of events) {
    // Pause bis zum Beginn des Ereignisses einfuegen.
    const gap = event.startQuarters - position;
    if (gap > 1e-6) addEvent(gap, [], 1);
    // Ereignis liegt vor der aktuellen Position: ueberspringen.
    if (event.startQuarters + event.durationQuarters <= position + 1e-6) continue;
    addEvent(event.durationQuarters, event.midis, event.confidence);
  }

  // Letzten Takt abschliessen.
  if (currentMeasure.notes.length > 0) flushMeasure();
  if (measures.length === 0) measures.push(createMeasure(timeSignature));

  // Letzten Takt mit Pausen fuellen und Schlussstrich setzen.
  const lastMeasure = measures[measures.length - 1];
  normalizeMeasure(lastMeasure, timeSignature);
  lastMeasure.barline = 'end';

  measures[0].timeSignature = timeSignature;
  measures[0].clef = clef;
  measures[0].tempo = Math.round(analysis.tempo);

  // Akkordsymbole auf den jeweils ersten Takt-Notenkopf legen.
  applyChordSymbols(measures, analysis, capacity);

  return {
    id: createId('score'),
    title,
    composer: '',
    keySignature: fifths,
    timeSignature,
    tempo: Math.round(analysis.tempo),
    staves: [
      {
        id: createId('s'),
        name: analysis.instrument.name,
        clef,
        midiProgram: guessMidiProgram(analysis.instrument.name),
        measures,
        muted: false,
        volume: 0.8,
      },
    ],
  };
}

/** Traegt erkannte Akkordsymbole in die Partitur ein. */
function applyChordSymbols(measures: Measure[], analysis: AnalysisResult, capacity: number): void {
  if (analysis.chords.length === 0) return;
  const secondsPerQuarter = 60 / analysis.tempo;

  for (const chord of analysis.chords) {
    if (chord.confidence < 0.45) continue;
    const quarters = chord.start / secondsPerQuarter;
    const measureIndex = Math.floor(quarters / capacity);
    const measure = measures[measureIndex];
    if (!measure) continue;

    const offsetInMeasure = quarters - measureIndex * capacity;
    let cursor = 0;
    for (const note of measure.notes) {
      const noteLength = durationInQuarters(note.duration, note.dots);
      if (offsetInMeasure < cursor + noteLength - 1e-6) {
        if (!note.chordSymbol) note.chordSymbol = chord.symbol;
        break;
      }
      cursor += noteLength;
    }
  }
}

/** Ordnet einem erkannten Instrumentennamen eine General-MIDI-Nummer zu. */
export function guessMidiProgram(instrumentName: string): number {
  const name = instrumentName.toLowerCase();
  if (name.includes('klavier') || name.includes('piano')) return 0;
  if (name.includes('gitarre') || name.includes('guitar')) return 24;
  if (name.includes('geige') || name.includes('violin') || name.includes('streich')) return 40;
  if (name.includes('floete') || name.includes('flöte') || name.includes('flute')) return 73;
  if (name.includes('gesang') || name.includes('stimme') || name.includes('voice')) return 52;
  if (name.includes('blas') || name.includes('trompete')) return 56;
  if (name.includes('bass')) return 33;
  if (name.includes('orgel') || name.includes('organ')) return 19;
  return 0;
}

/**
 * Erzeugt eine leere Partitur mit einer festen Anzahl Takte.
 * Wird genutzt, wenn die Analyse keine Noten gefunden hat.
 */
export function emptyScoreWithMeasures(
  timeSignature: TimeSignature,
  tempo: number,
  measureCount: number,
  title: string,
): Score {
  const measures = Array.from({ length: measureCount }, () => createMeasure(timeSignature));
  measures[0].timeSignature = timeSignature;
  measures[0].tempo = tempo;
  if (measures.length === 0) measures.push({ id: createId('m'), notes: [createRest('whole')] });
  return {
    id: createId('score'),
    title,
    composer: '',
    keySignature: 0,
    timeSignature,
    tempo,
    staves: [
      {
        id: createId('s'),
        name: 'Stimme 1',
        clef: 'treble',
        midiProgram: 0,
        measures,
        muted: false,
        volume: 0.8,
      },
    ],
  };
}
