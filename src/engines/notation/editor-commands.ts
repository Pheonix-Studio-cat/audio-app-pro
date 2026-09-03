/**
 * Editor-Logik: Befehle, Verlauf (Undo/Redo) und Zwischenablage.
 *
 * Der Verlauf speichert vollstaendige Partitur-Zustaende. Bei der hier
 * ueblichen Groesse (einige hundert Takte) ist das unproblematisch und
 * deutlich weniger fehleranfaellig als invertierbare Einzelbefehle.
 */
import type {
  AccidentalType,
  ArticulationMark,
  ClefType,
  DurationValue,
  DynamicMark,
  Pitch,
  Score,
  ScoreNote,
  ScorePosition,
  TimeSignature,
} from '../../core/types';
import { ACCIDENTAL_ALTER } from '../../core/types';
import {
  cloneScore,
  createNote,
  createRest,
  deleteNote,
  effectiveClef,
  effectiveTimeSignature,
  insertNote,
  noteAt,
  normalizeMeasure,
  removeNote,
  replaceNote,
  transposeNote,
  updateNote,
} from '../../core/score-model';
import { createId, midiToPitch, pitchToMidi } from '../../core/music-theory';

/** Maximale Anzahl gespeicherter Schritte. */
const MAX_HISTORY = 100;

export interface EditorHistory {
  past: Score[];
  present: Score;
  future: Score[];
}

/** Legt einen neuen Verlauf an. */
export function createHistory(score: Score): EditorHistory {
  return { past: [], present: score, future: [] };
}

/** Uebernimmt einen neuen Zustand und legt den alten auf den Undo-Stapel. */
export function pushHistory(history: EditorHistory, next: Score): EditorHistory {
  if (next === history.present) return history;
  const past = [...history.past, history.present];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, present: next, future: [] };
}

/** Macht den letzten Schritt rueckgaengig. */
export function undo(history: EditorHistory): EditorHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, MAX_HISTORY),
  };
}

/** Stellt einen rueckgaengig gemachten Schritt wieder her. */
export function redo(history: EditorHistory): EditorHistory {
  if (history.future.length === 0) return history;
  const next = history.future[0];
  return {
    past: [...history.past, history.present].slice(-MAX_HISTORY),
    present: next,
    future: history.future.slice(1),
  };
}

export function canUndo(history: EditorHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: EditorHistory): boolean {
  return history.future.length > 0;
}

/**
 * Setzt eine Note an der angegebenen Position.
 * Eine vorhandene Pause wird ersetzt, eine vorhandene Note ueberschrieben.
 */
export function setNoteAtPosition(
  score: Score,
  position: ScorePosition,
  pitch: Pitch,
  duration: DurationValue,
  dots: number,
): Score {
  const existing = noteAt(score, position);
  if (!existing) return score;
  return replaceNote(score, position, {
    ...createNote([pitch], duration, dots),
    id: existing.id,
  });
}

/** Fuegt eine Tonhoehe zu einer bestehenden Note hinzu (Akkord bilden). */
export function addPitchToNote(score: Score, position: ScorePosition, pitch: Pitch): Score {
  return updateNote(score, position, (note) => {
    if (note.isRest) {
      return { ...note, pitches: [pitch], isRest: false };
    }
    const midi = pitchToMidi(pitch);
    if (note.pitches.some((p) => pitchToMidi(p) === midi)) return note;
    const pitches = [...note.pitches, pitch].sort((a, b) => pitchToMidi(a) - pitchToMidi(b));
    return { ...note, pitches };
  });
}

/** Entfernt eine Tonhoehe aus einem Akkord. */
export function removePitchFromNote(score: Score, position: ScorePosition, midi: number): Score {
  return updateNote(score, position, (note) => {
    const pitches = note.pitches.filter((p) => pitchToMidi(p) !== midi);
    return { ...note, pitches, isRest: pitches.length === 0 };
  });
}

/** Aendert die Tonhoehe einer Note um Halbtoene. */
export function changePitch(score: Score, position: ScorePosition, semitones: number): Score {
  return transposeNote(score, position, semitones);
}

/** Setzt eine Note auf eine absolute Tonhoehe. */
export function setPitch(score: Score, position: ScorePosition, midi: number): Score {
  return updateNote(score, position, (note) => ({
    ...note,
    pitches: [midiToPitch(midi, score.keySignature)],
    isRest: false,
  }));
}

/** Aendert die Notenlaenge und normalisiert danach den Takt. */
export function changeDuration(
  score: Score,
  position: ScorePosition,
  duration: DurationValue,
  dots = 0,
): Score {
  const existing = noteAt(score, position);
  if (!existing) return score;
  const next = cloneScore(score);
  const measure = next.staves[position.staffIndex]?.measures[position.measureIndex];
  if (!measure) return score;
  measure.notes[position.noteIndex] = { ...existing, duration, dots };
  normalizeMeasure(measure, effectiveTimeSignature(next, position.staffIndex, position.measureIndex));
  return next;
}

/** Wandelt eine Note in eine Pause um. */
export function convertToRest(score: Score, position: ScorePosition): Score {
  return deleteNote(score, position);
}

/** Fuegt eine Pause vor der Position ein. */
export function insertRest(
  score: Score,
  position: ScorePosition,
  duration: DurationValue,
): Score {
  return insertNote(score, position, createRest(duration));
}

/** Entfernt eine Note vollstaendig aus dem Takt. */
export function deleteNoteCompletely(score: Score, position: ScorePosition): Score {
  return removeNote(score, position);
}

/** Setzt oder entfernt ein Vorzeichen. */
export function setAccidental(
  score: Score,
  position: ScorePosition,
  accidental: AccidentalType | null,
  pitchIndex = 0,
): Score {
  return updateNote(score, position, (note) => {
    if (note.isRest || !note.pitches[pitchIndex]) return note;
    const pitches = note.pitches.map((p, i) => {
      if (i !== pitchIndex) return p;
      if (accidental === null) {
        // Vorzeichen entfernen: auf den Stammton zuruecksetzen.
        return { ...p, alter: 0, accidental: undefined };
      }
      return { ...p, alter: ACCIDENTAL_ALTER[accidental], accidental };
    });
    return { ...note, pitches };
  });
}

/** Setzt eine Artikulation oder entfernt sie, wenn sie schon vorhanden ist. */
export function toggleArticulation(
  score: Score,
  position: ScorePosition,
  articulation: ArticulationMark,
): Score {
  return updateNote(score, position, (note) => {
    const current = note.articulations ?? [];
    const articulations = current.includes(articulation)
      ? current.filter((a) => a !== articulation)
      : [...current, articulation];
    return { ...note, articulations: articulations.length > 0 ? articulations : undefined };
  });
}

/** Setzt ein Dynamikzeichen. */
export function setDynamic(
  score: Score,
  position: ScorePosition,
  dynamic: DynamicMark | null,
): Score {
  return updateNote(score, position, (note) => ({ ...note, dynamic: dynamic ?? undefined }));
}

/** Setzt ein Akkordsymbol ueber der Note. */
export function setChordSymbol(
  score: Score,
  position: ScorePosition,
  symbol: string | null,
): Score {
  return updateNote(score, position, (note) => ({
    ...note,
    chordSymbol: symbol && symbol.trim().length > 0 ? symbol.trim() : undefined,
  }));
}

/** Schaltet eine Ueberbindung zur naechsten Note. */
export function toggleTie(score: Score, position: ScorePosition): Score {
  return updateNote(score, position, (note) => ({ ...note, tieStart: !note.tieStart }));
}

/** Schaltet einen Bindebogen-Anfang. */
export function toggleSlur(score: Score, position: ScorePosition): Score {
  return updateNote(score, position, (note) => ({ ...note, slurStart: !note.slurStart }));
}

/** Bestaetigt eine automatisch erkannte Note als korrekt. */
export function confirmNote(score: Score, position: ScorePosition): Score {
  return updateNote(score, position, (note) => ({
    ...note,
    autoDetected: false,
    confidence: undefined,
  }));
}

/** Bestaetigt alle automatisch erkannten Noten der Partitur. */
export function confirmAllNotes(score: Score): Score {
  const next = cloneScore(score);
  for (const staff of next.staves) {
    for (const measure of staff.measures) {
      for (const note of measure.notes) {
        note.autoDetected = false;
        note.confidence = undefined;
      }
    }
  }
  return next;
}

/** Verschiebt eine Note innerhalb ihres Taktes an eine andere Stelle. */
export function moveNote(score: Score, from: ScorePosition, toNoteIndex: number): Score {
  if (from.noteIndex === toNoteIndex) return score;
  const next = cloneScore(score);
  const measure = next.staves[from.staffIndex]?.measures[from.measureIndex];
  if (!measure) return score;
  const [note] = measure.notes.splice(from.noteIndex, 1);
  if (!note) return score;
  const target = Math.max(0, Math.min(measure.notes.length, toNoteIndex));
  measure.notes.splice(target, 0, note);
  return next;
}

/** Inhalt der Zwischenablage. */
export interface Clipboard {
  notes: ScoreNote[];
}

/** Kopiert die Noten der angegebenen Positionen. */
export function copyNotes(score: Score, positions: ScorePosition[]): Clipboard {
  const notes: ScoreNote[] = [];
  const sorted = [...positions].sort(
    (a, b) => a.measureIndex - b.measureIndex || a.noteIndex - b.noteIndex,
  );
  for (const position of sorted) {
    const note = noteAt(score, position);
    if (note) notes.push({ ...note, id: createId('n') });
  }
  return { notes };
}

/**
 * Fuegt die Zwischenablage ab einer Position ein.
 * Bestehende Noten werden ueberschrieben, der Takt danach normalisiert.
 */
export function pasteNotes(
  score: Score,
  position: ScorePosition,
  clipboard: Clipboard,
): Score {
  if (clipboard.notes.length === 0) return score;
  const next = cloneScore(score);
  const staff = next.staves[position.staffIndex];
  if (!staff) return score;

  let measureIndex = position.measureIndex;
  let noteIndex = position.noteIndex;

  for (const source of clipboard.notes) {
    let measure = staff.measures[measureIndex];
    if (!measure) break;
    if (noteIndex >= measure.notes.length) {
      // In den naechsten Takt wechseln.
      measureIndex++;
      noteIndex = 0;
      measure = staff.measures[measureIndex];
      if (!measure) break;
    }
    measure.notes[noteIndex] = { ...source, id: createId('n') };
    noteIndex++;
  }

  for (let m = position.measureIndex; m <= measureIndex && m < staff.measures.length; m++) {
    normalizeMeasure(staff.measures[m], effectiveTimeSignature(next, position.staffIndex, m));
  }
  return next;
}

/** Loescht alle Noten der angegebenen Positionen (sie werden zu Pausen). */
export function deleteSelection(score: Score, positions: ScorePosition[]): Score {
  let result = score;
  for (const position of positions) {
    result = deleteNote(result, position);
  }
  return result;
}

/** Transponiert alle Noten der Auswahl. */
export function transposeSelection(
  score: Score,
  positions: ScorePosition[],
  semitones: number,
): Score {
  let result = score;
  for (const position of positions) {
    result = transposeNote(result, position, semitones);
  }
  return result;
}

/** Naechste Notenposition (fuer Tastaturnavigation). */
export function nextPosition(score: Score, position: ScorePosition): ScorePosition | null {
  const staff = score.staves[position.staffIndex];
  if (!staff) return null;
  const measure = staff.measures[position.measureIndex];
  if (!measure) return null;
  if (position.noteIndex + 1 < measure.notes.length) {
    return { ...position, noteIndex: position.noteIndex + 1 };
  }
  if (position.measureIndex + 1 < staff.measures.length) {
    return { ...position, measureIndex: position.measureIndex + 1, noteIndex: 0 };
  }
  return null;
}

/** Vorherige Notenposition. */
export function previousPosition(score: Score, position: ScorePosition): ScorePosition | null {
  if (position.noteIndex > 0) return { ...position, noteIndex: position.noteIndex - 1 };
  if (position.measureIndex > 0) {
    const staff = score.staves[position.staffIndex];
    const previousMeasure = staff?.measures[position.measureIndex - 1];
    if (!previousMeasure) return null;
    return {
      ...position,
      measureIndex: position.measureIndex - 1,
      noteIndex: Math.max(0, previousMeasure.notes.length - 1),
    };
  }
  return null;
}

/** Alle Positionen zwischen zwei Punkten (fuer Bereichsauswahl). */
export function positionsBetween(
  score: Score,
  from: ScorePosition,
  to: ScorePosition,
): ScorePosition[] {
  const staff = score.staves[from.staffIndex];
  if (!staff || from.staffIndex !== to.staffIndex) return [from];

  const start = from.measureIndex < to.measureIndex ||
    (from.measureIndex === to.measureIndex && from.noteIndex <= to.noteIndex) ? from : to;
  const end = start === from ? to : from;

  const positions: ScorePosition[] = [];
  let current: ScorePosition | null = start;
  let guard = 0;
  while (current && guard++ < 2000) {
    positions.push(current);
    if (current.measureIndex === end.measureIndex && current.noteIndex === end.noteIndex) break;
    current = nextPosition(score, current);
  }
  return positions;
}

/** Aktuell wirksamer Schluessel an einer Position (Hilfsfunktion fuer die UI). */
export function clefAt(score: Score, position: ScorePosition): ClefType {
  return effectiveClef(score, position.staffIndex, position.measureIndex);
}

/** Aktuell wirksame Taktart an einer Position. */
export function timeSignatureAt(score: Score, position: ScorePosition): TimeSignature {
  return effectiveTimeSignature(score, position.staffIndex, position.measureIndex);
}
