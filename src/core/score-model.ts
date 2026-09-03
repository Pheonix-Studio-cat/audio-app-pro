/**
 * Operationen auf dem Partitur-Modell.
 *
 * Alle Funktionen sind rein und geben eine neue Partitur zurueck. Dadurch
 * lassen sich Undo/Redo und React-State einfach abbilden.
 */
import type {
  ClefType,
  DurationValue,
  Measure,
  Pitch,
  Score,
  ScoreNote,
  ScorePosition,
  Staff,
  TimeSignature,
} from './types';
import {
  createId,
  durationInQuarters,
  measureCapacity,
  midiToPitch,
  pitchToMidi,
} from './music-theory';

/** Erzeugt eine leere Pause passender Laenge. */
export function createRest(duration: DurationValue = 'quarter', dots = 0): ScoreNote {
  return { id: createId('n'), pitches: [], duration, dots, isRest: true };
}

/** Erzeugt eine Note aus einer oder mehreren Tonhoehen. */
export function createNote(
  pitches: Pitch[],
  duration: DurationValue = 'quarter',
  dots = 0,
): ScoreNote {
  return { id: createId('n'), pitches, duration, dots, isRest: pitches.length === 0 };
}

/** Erzeugt einen leeren Takt, der mit Pausen gefuellt ist. */
export function createMeasure(timeSignature: TimeSignature): Measure {
  const capacity = measureCapacity(timeSignature);
  const notes: ScoreNote[] = [];
  let remaining = capacity;
  // Ganztaktpause, wenn moeglich; sonst mit Vierteln auffuellen.
  if (Math.abs(capacity - 4) < 1e-6) {
    notes.push(createRest('whole'));
  } else {
    while (remaining >= 1) {
      notes.push(createRest('quarter'));
      remaining -= 1;
    }
    while (remaining >= 0.5) {
      notes.push(createRest('eighth'));
      remaining -= 0.5;
    }
    if (remaining > 1e-6) notes.push(createRest('16th'));
  }
  return { id: createId('m'), notes };
}

/** Erzeugt ein leeres System. */
export function createStaff(
  name: string,
  clef: ClefType,
  timeSignature: TimeSignature,
  measureCount = 4,
  midiProgram = 0,
): Staff {
  return {
    id: createId('s'),
    name,
    clef,
    midiProgram,
    muted: false,
    volume: 0.8,
    measures: Array.from({ length: measureCount }, () => createMeasure(timeSignature)),
  };
}

/** Erzeugt eine neue, leere Partitur. */
export function createEmptyScore(options?: Partial<Score>): Score {
  const timeSignature = options?.timeSignature ?? { beats: 4, beatType: 4 };
  return {
    id: options?.id ?? createId('score'),
    title: options?.title ?? 'Unbenanntes Stueck',
    composer: options?.composer ?? '',
    keySignature: options?.keySignature ?? 0,
    timeSignature,
    tempo: options?.tempo ?? 120,
    staves: options?.staves ?? [createStaff('Klavier', 'treble', timeSignature, 4)],
  };
}

/** Tiefe Kopie einer Partitur (structuredClone mit Fallback). */
export function cloneScore(score: Score): Score {
  if (typeof structuredClone === 'function') return structuredClone(score);
  return JSON.parse(JSON.stringify(score)) as Score;
}

/** Gefuellte Laenge eines Taktes in Vierteln. */
export function measureFilledQuarters(measure: Measure): number {
  return measure.notes.reduce((sum, n) => sum + durationInQuarters(n.duration, n.dots), 0);
}

/** Aktive Taktart an einer bestimmten Taktposition. */
export function effectiveTimeSignature(
  score: Score,
  staffIndex: number,
  measureIndex: number,
): TimeSignature {
  let result = score.timeSignature;
  const staff = score.staves[staffIndex];
  if (!staff) return result;
  for (let i = 0; i <= measureIndex && i < staff.measures.length; i++) {
    const ts = staff.measures[i].timeSignature;
    if (ts) result = ts;
  }
  return result;
}

/** Aktiver Schluessel an einer bestimmten Taktposition. */
export function effectiveClef(score: Score, staffIndex: number, measureIndex: number): ClefType {
  const staff = score.staves[staffIndex];
  if (!staff) return 'treble';
  let clef = staff.clef;
  for (let i = 0; i <= measureIndex && i < staff.measures.length; i++) {
    const c = staff.measures[i].clef;
    if (c) clef = c;
  }
  return clef;
}

/** Aktives Tempo an einer bestimmten Taktposition. */
export function effectiveTempo(score: Score, measureIndex: number): number {
  let tempo = score.tempo;
  const staff = score.staves[0];
  if (!staff) return tempo;
  for (let i = 0; i <= measureIndex && i < staff.measures.length; i++) {
    const t = staff.measures[i].tempo;
    if (t) tempo = t;
  }
  return tempo;
}

/** Liefert die Note an einer Position oder null. */
export function noteAt(score: Score, pos: ScorePosition): ScoreNote | null {
  return score.staves[pos.staffIndex]?.measures[pos.measureIndex]?.notes[pos.noteIndex] ?? null;
}

/**
 * Wendet eine Aenderung auf eine einzelne Note an und gibt eine neue
 * Partitur zurueck.
 */
export function updateNote(
  score: Score,
  pos: ScorePosition,
  updater: (note: ScoreNote) => ScoreNote,
): Score {
  const next = cloneScore(score);
  const measure = next.staves[pos.staffIndex]?.measures[pos.measureIndex];
  if (!measure) return score;
  const note = measure.notes[pos.noteIndex];
  if (!note) return score;
  measure.notes[pos.noteIndex] = updater(note);
  return next;
}

/**
 * Ersetzt eine Note und passt danach die Taktfuellung an, damit der Takt
 * weder ueber- noch unterfuellt bleibt.
 */
export function replaceNote(score: Score, pos: ScorePosition, note: ScoreNote): Score {
  const next = cloneScore(score);
  const staff = next.staves[pos.staffIndex];
  const measure = staff?.measures[pos.measureIndex];
  if (!measure) return score;
  measure.notes[pos.noteIndex] = note;
  normalizeMeasure(measure, effectiveTimeSignature(next, pos.staffIndex, pos.measureIndex));
  return next;
}

/** Fuegt eine Note an einer Position ein. */
export function insertNote(score: Score, pos: ScorePosition, note: ScoreNote): Score {
  const next = cloneScore(score);
  const measure = next.staves[pos.staffIndex]?.measures[pos.measureIndex];
  if (!measure) return score;
  measure.notes.splice(Math.min(pos.noteIndex, measure.notes.length), 0, note);
  normalizeMeasure(measure, effectiveTimeSignature(next, pos.staffIndex, pos.measureIndex));
  return next;
}

/** Loescht eine Note; der frei werdende Platz wird zur Pause. */
export function deleteNote(score: Score, pos: ScorePosition): Score {
  const next = cloneScore(score);
  const measure = next.staves[pos.staffIndex]?.measures[pos.measureIndex];
  if (!measure) return score;
  const note = measure.notes[pos.noteIndex];
  if (!note) return score;
  measure.notes[pos.noteIndex] = {
    ...note,
    id: createId('n'),
    pitches: [],
    isRest: true,
    tieStart: false,
    tieStop: false,
    articulations: undefined,
    chordSymbol: undefined,
  };
  return next;
}

/** Entfernt eine Note vollstaendig und schliesst die Luecke mit einer Pause. */
export function removeNote(score: Score, pos: ScorePosition): Score {
  const next = cloneScore(score);
  const measure = next.staves[pos.staffIndex]?.measures[pos.measureIndex];
  if (!measure) return score;
  measure.notes.splice(pos.noteIndex, 1);
  normalizeMeasure(measure, effectiveTimeSignature(next, pos.staffIndex, pos.measureIndex));
  return next;
}

/** Transponiert eine Note um eine Anzahl Halbtoene. */
export function transposeNote(score: Score, pos: ScorePosition, semitones: number): Score {
  return updateNote(score, pos, (note) => {
    if (note.isRest) return note;
    return {
      ...note,
      pitches: note.pitches.map((p) => {
        const midi = pitchToMidi(p) + semitones;
        const clamped = Math.max(12, Math.min(108, midi));
        return { ...midiToPitch(clamped, score.keySignature), accidental: undefined };
      }),
    };
  });
}

/**
 * Sorgt dafuer, dass ein Takt exakt gefuellt ist: zu viel wird abgeschnitten,
 * zu wenig mit Pausen aufgefuellt.
 */
export function normalizeMeasure(measure: Measure, timeSignature: TimeSignature): void {
  const capacity = measureCapacity(timeSignature);
  let total = 0;
  const kept: ScoreNote[] = [];
  for (const note of measure.notes) {
    const q = durationInQuarters(note.duration, note.dots);
    if (total + q > capacity + 1e-6) {
      // Note passt nicht mehr vollstaendig: verkuerzen, wenn Restplatz da ist.
      const remaining = capacity - total;
      if (remaining > 1e-6) {
        const shortened = fitDuration(remaining);
        if (shortened) {
          kept.push({ ...note, duration: shortened.duration, dots: shortened.dots });
          total += durationInQuarters(shortened.duration, shortened.dots);
        }
      }
      break;
    }
    kept.push(note);
    total += q;
  }
  // Rest mit Pausen auffuellen.
  let remaining = capacity - total;
  let guard = 0;
  while (remaining > 1e-6 && guard++ < 32) {
    const fit = fitDuration(remaining);
    if (!fit) break;
    kept.push(createRest(fit.duration, fit.dots));
    remaining -= durationInQuarters(fit.duration, fit.dots);
  }
  measure.notes = kept;
}

/** Groesster Notenwert, der in die verbleibende Laenge passt. */
function fitDuration(quarters: number): { duration: DurationValue; dots: number } | null {
  const values: DurationValue[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
  const candidates: Array<{ duration: DurationValue; dots: number; q: number }> = [];
  for (const v of values) {
    for (let d = 0; d <= 2; d++) {
      candidates.push({ duration: v, dots: d, q: durationInQuarters(v, d) });
    }
  }
  candidates.sort((a, b) => b.q - a.q);
  const fit = candidates.find((c) => c.q <= quarters + 1e-6);
  return fit ? { duration: fit.duration, dots: fit.dots } : null;
}

/** Haengt einen leeren Takt an alle Systeme an. */
export function appendMeasure(score: Score): Score {
  const next = cloneScore(score);
  for (let i = 0; i < next.staves.length; i++) {
    const staff = next.staves[i];
    const ts = effectiveTimeSignature(next, i, staff.measures.length - 1);
    staff.measures.push(createMeasure(ts));
  }
  return next;
}

/** Entfernt den letzten Takt aus allen Systemen (mindestens einer bleibt). */
export function removeLastMeasure(score: Score): Score {
  const next = cloneScore(score);
  for (const staff of next.staves) {
    if (staff.measures.length > 1) staff.measures.pop();
  }
  return next;
}

/** Fuegt ein weiteres System hinzu. */
export function addStaff(score: Score, name: string, clef: ClefType): Score {
  const next = cloneScore(score);
  const measureCount = next.staves[0]?.measures.length ?? 4;
  next.staves.push(createStaff(name, clef, next.timeSignature, measureCount));
  return next;
}

/** Entfernt ein System (mindestens eines bleibt erhalten). */
export function removeStaff(score: Score, staffIndex: number): Score {
  if (score.staves.length <= 1) return score;
  const next = cloneScore(score);
  next.staves.splice(staffIndex, 1);
  return next;
}

/** Setzt die Taktart ab einem bestimmten Takt. */
export function setTimeSignature(
  score: Score,
  measureIndex: number,
  timeSignature: TimeSignature,
): Score {
  const next = cloneScore(score);
  if (measureIndex === 0) next.timeSignature = timeSignature;
  for (let s = 0; s < next.staves.length; s++) {
    const measure = next.staves[s].measures[measureIndex];
    if (!measure) continue;
    measure.timeSignature = timeSignature;
    // Alle folgenden Takte bis zur naechsten Aenderung neu normalisieren.
    for (let m = measureIndex; m < next.staves[s].measures.length; m++) {
      const target = next.staves[s].measures[m];
      if (m > measureIndex && target.timeSignature) break;
      normalizeMeasure(target, timeSignature);
    }
  }
  return next;
}

/** Setzt den Schluessel eines Systems ab einem Takt. */
export function setClef(
  score: Score,
  staffIndex: number,
  measureIndex: number,
  clef: ClefType,
): Score {
  const next = cloneScore(score);
  const staff = next.staves[staffIndex];
  if (!staff) return score;
  if (measureIndex === 0) staff.clef = clef;
  const measure = staff.measures[measureIndex];
  if (measure) measure.clef = clef;
  return next;
}

/** Setzt eine Tempoangabe ab einem Takt. */
export function setTempo(score: Score, measureIndex: number, tempo: number): Score {
  const next = cloneScore(score);
  if (measureIndex === 0) next.tempo = tempo;
  const measure = next.staves[0]?.measures[measureIndex];
  if (measure) measure.tempo = tempo;
  return next;
}

/** Setzt die Tonart der gesamten Partitur. */
export function setKeySignature(score: Score, fifths: number): Score {
  const next = cloneScore(score);
  next.keySignature = fifths;
  return next;
}

/** Gesamtzahl der Takte. */
export function measureCount(score: Score): number {
  return score.staves.reduce((max, s) => Math.max(max, s.measures.length), 0);
}

/** Gesamtdauer der Partitur in Sekunden. */
export function scoreDurationSeconds(score: Score): number {
  let seconds = 0;
  const count = measureCount(score);
  for (let m = 0; m < count; m++) {
    const ts = effectiveTimeSignature(score, 0, m);
    const tempo = effectiveTempo(score, m);
    seconds += (measureCapacity(ts) * 60) / tempo;
  }
  return seconds;
}
