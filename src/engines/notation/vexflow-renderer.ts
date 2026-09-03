/**
 * Notation-Engine: zeichnet das Partitur-Modell mit VexFlow.
 *
 * VexFlow (MIT-Lizenz) ist die etablierte Open-Source-Bibliothek fuer
 * Notensatz im Browser und rendert echte Notenschrift als SVG.
 *
 * Der Renderer liefert zusaetzlich eine Trefferflaechen-Karte zurueck,
 * damit der Editor weiss, welche Note an welcher Bildschirmposition liegt.
 */
import {
  Accidental,
  Annotation,
  Articulation,
  Barline,
  Beam,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  Voice,
} from 'vexflow';
import type {
  ArticulationMark,
  ClefType,
  Measure,
  Score,
  ScoreNote,
  ScorePosition,
} from '../../core/types';
import { pitchToVexKey, requiredAccidental } from '../../core/music-theory';
import { effectiveClef, effectiveTimeSignature } from '../../core/score-model';

/** Bildschirmbereich eines Notenkopfes fuer Mausinteraktion. */
export interface NoteHitBox {
  position: ScorePosition;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Vertikale Grenzen des zugehoerigen Notensystems. */
  staveTop: number;
  staveBottom: number;
}

export interface RenderOptions {
  /** Gesamtbreite der Zeichenflaeche in Pixeln. */
  width: number;
  /** Takte pro Zeile; 0 = automatisch nach Breite. */
  measuresPerLine: number;
  /** Unsichere Noten farblich hervorheben. */
  highlightUncertain: boolean;
  /** Ausgewaehlte Noten hervorheben. */
  selection: ScorePosition[];
  /** Aktuell klingende Note bei der Wiedergabe. */
  playbackPosition: ScorePosition | null;
  /** Nur schwarz zeichnen (fuer Druck und Export). */
  printMode: boolean;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  width: 900,
  measuresPerLine: 0,
  highlightUncertain: true,
  selection: [],
  playbackPosition: null,
  printMode: false,
};

export interface RenderResult {
  /** Gesamthoehe des gezeichneten Notenbildes. */
  height: number;
  hitBoxes: NoteHitBox[];
}

const STAVE_HEIGHT = 110;
const SYSTEM_GAP = 34;
const TOP_MARGIN = 60;
const LEFT_MARGIN = 14;
const RIGHT_MARGIN = 14;

/** Farben fuer die Zustandsanzeige im Editor. */
const COLORS = {
  uncertain: '#d97706',
  veryUncertain: '#dc2626',
  selection: '#2563eb',
  playback: '#16a34a',
};

/**
 * Zeichnet die Partitur als SVG in ein Container-Element.
 *
 * @param container Ziel-Element; wird vor dem Zeichnen geleert
 */
export function renderScore(
  container: HTMLDivElement,
  score: Score,
  options: Partial<RenderOptions> = {},
): RenderResult {
  const opts = { ...DEFAULT_RENDER_OPTIONS, ...options };
  container.innerHTML = '';

  const hitBoxes: NoteHitBox[] = [];
  const staffCount = score.staves.length;
  const totalMeasures = Math.max(...score.staves.map((s) => s.measures.length), 1);

  const usableWidth = opts.width - LEFT_MARGIN - RIGHT_MARGIN;
  const measuresPerLine =
    opts.measuresPerLine > 0
      ? opts.measuresPerLine
      : Math.max(1, Math.min(6, Math.floor(usableWidth / 230)));
  const lineCount = Math.ceil(totalMeasures / measuresPerLine);

  const systemHeight = staffCount * STAVE_HEIGHT + SYSTEM_GAP;
  const height = TOP_MARGIN + lineCount * systemHeight + 40;

  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(opts.width, height);
  const context = renderer.getContext();

  for (let line = 0; line < lineCount; line++) {
    const firstMeasure = line * measuresPerLine;
    const lastMeasure = Math.min(firstMeasure + measuresPerLine, totalMeasures);
    if (lastMeasure <= firstMeasure) continue;

    const lineY = TOP_MARGIN + line * systemHeight;

    for (let staffIndex = 0; staffIndex < staffCount; staffIndex++) {
      const staff = score.staves[staffIndex];
      const staveY = lineY + staffIndex * STAVE_HEIGHT;

      // Taktbreiten nach Notenanzahl gewichten, damit volle Takte mehr Platz bekommen.
      const weights: number[] = [];
      for (let m = firstMeasure; m < lastMeasure; m++) {
        weights.push(Math.max(1.5, staff.measures[m]?.notes.length ?? 1));
      }
      const weightSum = weights.reduce((a, b) => a + b, 0);

      let x = LEFT_MARGIN;
      for (let m = firstMeasure; m < lastMeasure; m++) {
        const measure = staff.measures[m];
        if (!measure) continue;
        const isFirstInLine = m === firstMeasure;
        const isLastInLine = m === lastMeasure - 1;

        let measureWidth = (usableWidth * weights[m - firstMeasure]) / weightSum;
        if (isLastInLine) measureWidth = opts.width - RIGHT_MARGIN - x;
        measureWidth = Math.max(110, measureWidth);

        drawMeasure({
          context,
          score,
          staffIndex,
          measureIndex: m,
          measure,
          x,
          y: staveY,
          width: measureWidth,
          isFirstInLine,
          options: opts,
          hitBoxes,
        });

        x += measureWidth;
      }
    }
  }

  drawHeadings(context, score, opts.width);
  return { height, hitBoxes };
}

/** Titel und Komponist ueber dem Notenbild. */
function drawHeadings(
  context: ReturnType<Renderer['getContext']>,
  score: Score,
  width: number,
): void {
  if (score.title) {
    context.save();
    context.setFont('Georgia, serif', 20, 'bold');
    const estimatedWidth = score.title.length * 10;
    context.fillText(score.title, Math.max(10, width / 2 - estimatedWidth / 2), 30);
    context.restore();
  }
  if (score.composer) {
    context.save();
    context.setFont('Georgia, serif', 12, 'italic');
    const estimatedWidth = score.composer.length * 6;
    context.fillText(score.composer, Math.max(10, width - RIGHT_MARGIN - estimatedWidth), 48);
    context.restore();
  }
}

interface DrawMeasureArgs {
  context: ReturnType<Renderer['getContext']>;
  score: Score;
  staffIndex: number;
  measureIndex: number;
  measure: Measure;
  x: number;
  y: number;
  width: number;
  isFirstInLine: boolean;
  options: RenderOptions;
  hitBoxes: NoteHitBox[];
}

/** Zeichnet einen einzelnen Takt inklusive Noten. */
function drawMeasure(args: DrawMeasureArgs): void {
  const {
    context, score, staffIndex, measureIndex, measure,
    x, y, width, isFirstInLine, options, hitBoxes,
  } = args;

  const stave = new Stave(x, y, width);
  const timeSignature = effectiveTimeSignature(score, staffIndex, measureIndex);
  const clef = effectiveClef(score, staffIndex, measureIndex);

  const showHeader = isFirstInLine || measureIndex === 0;
  if (showHeader) {
    stave.addClef(clef);
    if (score.keySignature !== 0) stave.addKeySignature(vexKeyName(score.keySignature));
  } else if (measure.clef) {
    stave.addClef(measure.clef);
  }

  const previous =
    measureIndex > 0 ? effectiveTimeSignature(score, staffIndex, measureIndex - 1) : null;
  const timeSignatureChanged =
    !previous ||
    previous.beats !== timeSignature.beats ||
    previous.beatType !== timeSignature.beatType;
  if (showHeader || timeSignatureChanged) {
    stave.addTimeSignature(`${timeSignature.beats}/${timeSignature.beatType}`);
  }

  if (measure.tempo) {
    stave.setTempo({ duration: 'q', bpm: measure.tempo }, -14);
  }

  if (measure.barline === 'double') stave.setEndBarType(Barline.type.DOUBLE);
  else if (measure.barline === 'end') stave.setEndBarType(Barline.type.END);
  else if (measure.barline === 'repeat-end') stave.setEndBarType(Barline.type.REPEAT_END);

  stave.setContext(context).draw();
  if (measure.notes.length === 0) return;

  const staveNotes: StaveNote[] = [];
  const noteIndexMap: number[] = [];

  for (let noteIndex = 0; noteIndex < measure.notes.length; noteIndex++) {
    const note = measure.notes[noteIndex];
    const staveNote = buildStaveNote(note, clef, score.keySignature);
    if (!staveNote) continue;
    applyNoteColor(staveNote, note, { staffIndex, measureIndex, noteIndex }, options);
    staveNotes.push(staveNote);
    noteIndexMap.push(noteIndex);
  }
  if (staveNotes.length === 0) return;

  const voice = new Voice({ numBeats: timeSignature.beats, beatValue: timeSignature.beatType });
  // SOFT toleriert Takte, die (noch) nicht exakt gefuellt sind.
  voice.setMode(Voice.Mode.SOFT);
  voice.addTickables(staveNotes);

  const beams = Beam.generateBeams(staveNotes.filter((n) => !n.isRest()));

  try {
    new Formatter()
      .joinVoices([voice])
      .format([voice], Math.max(60, width - (showHeader ? 95 : 28)));
    voice.draw(context, stave);
    for (const beam of beams) beam.setContext(context).draw();
    drawTies(context, measure, staveNotes, noteIndexMap);
  } catch (error) {
    // Ein einzelner nicht satzbarer Takt darf nicht die ganze Seite blockieren.
    console.warn(`Takt ${measureIndex + 1} konnte nicht gesetzt werden:`, error);
    return;
  }

  for (let i = 0; i < staveNotes.length; i++) {
    const box = staveNotes[i].getBoundingBox();
    if (!box) continue;
    hitBoxes.push({
      position: { staffIndex, measureIndex, noteIndex: noteIndexMap[i] },
      x: box.getX(),
      y: box.getY(),
      width: Math.max(16, box.getW()),
      height: Math.max(16, box.getH()),
      staveTop: stave.getYForLine(0),
      staveBottom: stave.getYForLine(4),
    });
  }
}

/** Erzeugt eine VexFlow-Note aus dem Modell. */
function buildStaveNote(note: ScoreNote, clef: ClefType, fifths: number): StaveNote | null {
  const durationCode = toVexDuration(note.duration, note.isRest);
  if (!durationCode) return null;

  const keys = note.isRest ? [restKeyForClef(clef)] : note.pitches.map(pitchToVexKey);
  if (keys.length === 0) return null;

  const staveNote = new StaveNote({ keys, duration: durationCode, clef, autoStem: true });

  if (!note.isRest) {
    for (let i = 0; i < note.pitches.length; i++) {
      const accidental = requiredAccidental(note.pitches[i], fifths);
      if (accidental) staveNote.addModifier(new Accidental(toVexAccidental(accidental)), i);
    }
  }

  if (note.dots > 0) {
    for (let d = 0; d < note.dots; d++) Dot.buildAndAttach([staveNote], { all: true });
  }

  if (note.articulations) {
    for (const articulation of note.articulations) {
      const code = toVexArticulation(articulation);
      if (code) staveNote.addModifier(new Articulation(code));
    }
  }

  if (note.dynamic) {
    staveNote.addModifier(
      new Annotation(note.dynamic).setVerticalJustification(Annotation.VerticalJustify.BOTTOM),
    );
  }

  if (note.chordSymbol) {
    staveNote.addModifier(
      new Annotation(note.chordSymbol).setVerticalJustification(Annotation.VerticalJustify.TOP),
    );
  }

  return staveNote;
}

/** Zeichnet Ueberbindungen innerhalb eines Taktes. */
function drawTies(
  context: ReturnType<Renderer['getContext']>,
  measure: Measure,
  staveNotes: StaveNote[],
  noteIndexMap: number[],
): void {
  for (let i = 0; i < staveNotes.length - 1; i++) {
    const modelNote = measure.notes[noteIndexMap[i]];
    const nextNote = measure.notes[noteIndexMap[i + 1]];
    if (!modelNote?.tieStart || !nextNote || nextNote.isRest) continue;
    try {
      new StaveTie({
        firstNote: staveNotes[i],
        lastNote: staveNotes[i + 1],
        firstIndexes: [0],
        lastIndexes: [0],
      })
        .setContext(context)
        .draw();
    } catch {
      // Eine nicht zeichenbare Bindung darf das Notenbild nicht verhindern.
    }
  }
}

/** Faerbt eine Note nach Auswahl, Wiedergabe und Erkennungssicherheit. */
function applyNoteColor(
  staveNote: StaveNote,
  note: ScoreNote,
  position: ScorePosition,
  options: RenderOptions,
): void {
  if (options.printMode) return;

  let color: string | null = null;
  if (options.highlightUncertain && note.autoDetected && note.confidence !== undefined) {
    if (note.confidence < 0.45) color = COLORS.veryUncertain;
    else if (note.confidence < 0.7) color = COLORS.uncertain;
  }
  if (samePosition(options.playbackPosition, position)) color = COLORS.playback;
  if (options.selection.some((s) => samePosition(s, position))) color = COLORS.selection;

  if (color) staveNote.setStyle({ fillStyle: color, strokeStyle: color });
}

function samePosition(a: ScorePosition | null, b: ScorePosition): boolean {
  return (
    a !== null &&
    a.staffIndex === b.staffIndex &&
    a.measureIndex === b.measureIndex &&
    a.noteIndex === b.noteIndex
  );
}

/** Modell-Notenwert -> VexFlow-Code. */
function toVexDuration(duration: ScoreNote['duration'], isRest: boolean): string | null {
  const map: Record<string, string> = {
    whole: 'w', half: 'h', quarter: 'q', eighth: '8', '16th': '16', '32nd': '32',
  };
  const code = map[duration];
  if (!code) return null;
  return isRest ? `${code}r` : code;
}

function toVexAccidental(accidental: string): string {
  const map: Record<string, string> = {
    sharp: '#', flat: 'b', natural: 'n', 'double-sharp': '##', 'double-flat': 'bb',
  };
  return map[accidental] ?? 'n';
}

function toVexArticulation(articulation: ArticulationMark): string | null {
  const map: Record<ArticulationMark, string> = {
    staccato: 'a.', accent: 'a>', tenuto: 'a-', marcato: 'a^', fermata: 'a@a',
  };
  return map[articulation] ?? null;
}

/** Vertikale Lage der Pause je Schluessel. */
function restKeyForClef(clef: ClefType): string {
  switch (clef) {
    case 'bass': return 'd/3';
    case 'alto': return 'c/4';
    case 'tenor': return 'a/3';
    default: return 'b/4';
  }
}

/** VexFlow erwartet den Tonartnamen statt der Zahl der Vorzeichen. */
function vexKeyName(fifths: number): string {
  const names = ['Cb','Gb','Db','Ab','Eb','Bb','F','C','G','D','A','E','B','F#','C#'];
  return names[Math.max(0, Math.min(names.length - 1, fifths + 7))];
}

/**
 * Findet die Note, deren Trefferflaeche einem Punkt am naechsten liegt.
 * Wird fuer Klick- und Ziehinteraktionen im Editor genutzt.
 */
export function findNoteAt(hitBoxes: NoteHitBox[], x: number, y: number): NoteHitBox | null {
  let best: NoteHitBox | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const box of hitBoxes) {
    if (x < box.x - 8 || x > box.x + box.width + 8) continue;
    if (y < box.y - 14 || y > box.y + box.height + 14) continue;
    const distance = Math.hypot(x - (box.x + box.width / 2), y - (box.y + box.height / 2));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = box;
    }
  }
  return best;
}

/**
 * Findet die naechstgelegene Notenposition im selben System.
 * Erlaubt das Setzen von Noten auch neben einem Notenkopf.
 */
export function findNearestNote(hitBoxes: NoteHitBox[], x: number, y: number): NoteHitBox | null {
  const sameSystem = hitBoxes.filter((box) => y >= box.staveTop - 55 && y <= box.staveBottom + 55);
  const pool = sameSystem.length > 0 ? sameSystem : hitBoxes;
  if (pool.length === 0) return null;

  let best = pool[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const box of pool) {
    const distance = Math.abs(x - (box.x + box.width / 2));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = box;
    }
  }
  return best;
}

/**
 * Rechnet eine vertikale Bildschirmposition in eine Tonhoehe um.
 *
 * Die oberste Linie eines Systems entspricht je nach Schluessel einem
 * bestimmten Ton; von dort wird in diatonischen Schritten gezaehlt.
 */
export function yToPitchStep(y: number, staveTop: number, staveBottom: number, clef: ClefType): number {
  // Abstand zwischen zwei Notenlinien = ein Terzschritt (2 diatonische Stufen).
  const lineSpacing = (staveBottom - staveTop) / 4;
  if (lineSpacing <= 0) return 0;
  // Halbe Linienabstaende sind die einzelnen diatonischen Stufen.
  const stepsFromTopLine = Math.round((y - staveTop) / (lineSpacing / 2));

  // Diatonische Stufe der obersten Linie je Schluessel (C0 = 0).
  const topLineDiatonic: Record<ClefType, number> = {
    treble: 5 * 7 + 3, // F5
    bass: 3 * 7 + 5,   // A3
    alto: 4 * 7 + 4,   // G4
    tenor: 4 * 7 + 2,  // E4
  };
  return topLineDiatonic[clef] - stepsFromTopLine;
}

/** Diatonische Stufe -> Tonhoehe ohne Vorzeichen. */
export function diatonicToPitch(diatonic: number): { step: 'C'|'D'|'E'|'F'|'G'|'A'|'B'; octave: number } {
  const steps = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
  const octave = Math.floor(diatonic / 7);
  const index = ((diatonic % 7) + 7) % 7;
  return { step: steps[index], octave };
}
