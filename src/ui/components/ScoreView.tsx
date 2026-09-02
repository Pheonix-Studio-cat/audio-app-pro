/**
 * Interaktive Anzeige der Partitur.
 *
 * Zeichnet ueber die Notation-Engine und uebersetzt Mausereignisse in
 * Positionen im Partitur-Modell. Die Komponente selbst veraendert nichts;
 * sie meldet nur, was angeklickt wurde.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClefType, Score, ScorePosition } from '../../core/types';
import {
  findNearestNote,
  findNoteAt,
  renderScore,
  diatonicToPitch,
  yToPitchStep,
  type NoteHitBox,
} from '../../engines/notation/vexflow-renderer';
import { effectiveClef } from '../../core/score-model';

export interface ScoreViewProps {
  score: Score;
  selection?: ScorePosition[];
  playbackPosition?: ScorePosition | null;
  highlightUncertain?: boolean;
  measuresPerLine?: number;
  /** Klick auf eine bestehende Note. */
  onNoteClick?: (position: ScorePosition, event: React.MouseEvent) => void;
  /**
   * Klick auf eine Position mit erkannter Tonhoehe aus der vertikalen Lage.
   * Wird fuer das Setzen neuer Noten benutzt.
   */
  onPitchClick?: (position: ScorePosition, diatonicStep: number, clef: ClefType) => void;
  /** Note wurde vertikal gezogen: neue diatonische Stufe. */
  onNoteDrag?: (position: ScorePosition, diatonicStep: number) => void;
}

export function ScoreView({
  score,
  selection = [],
  playbackPosition = null,
  highlightUncertain = true,
  measuresPerLine = 0,
  onNoteClick,
  onPitchClick,
  onNoteDrag,
}: ScoreViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hitBoxesRef = useRef<NoteHitBox[]>([]);
  const [width, setWidth] = useState(900);
  const [error, setError] = useState<string | null>(null);

  // Ziehvorgang: welche Note und ob sich der Zeiger schon bewegt hat.
  const dragRef = useRef<{ position: ScorePosition; startY: number; moved: boolean } | null>(null);

  // Breite an den Container anpassen.
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.max(400, Math.floor(entries[0].contentRect.width) - 4);
      setWidth((current) => (Math.abs(current - next) > 8 ? next : current));
    });
    observer.observe(element);
    setWidth(Math.max(400, element.clientWidth - 4));
    return () => observer.disconnect();
  }, []);

  // Neu zeichnen, wenn sich Partitur oder Darstellung aendern.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    try {
      const result = renderScore(container, score, {
        width,
        measuresPerLine,
        highlightUncertain,
        selection,
        playbackPosition,
      });
      hitBoxesRef.current = result.hitBoxes;
      setError(null);
    } catch (renderError) {
      setError((renderError as Error).message);
      hitBoxesRef.current = [];
    }
  }, [score, width, measuresPerLine, highlightUncertain, selection, playbackPosition]);

  /** Rechnet Mauskoordinaten in SVG-Koordinaten um. */
  const toLocalCoordinates = useCallback((event: React.MouseEvent): { x: number; y: number } => {
    const svg = containerRef.current?.querySelector('svg');
    const rect = (svg ?? containerRef.current)?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      const { x, y } = toLocalCoordinates(event);
      const hit = findNoteAt(hitBoxesRef.current, x, y);
      if (hit) {
        dragRef.current = { position: hit.position, startY: y, moved: false };
      }
    },
    [toLocalCoordinates],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || !onNoteDrag) return;
      const { y } = toLocalCoordinates(event);
      // Erst ab einer deutlichen Bewegung als Ziehen werten.
      if (!drag.moved && Math.abs(y - drag.startY) < 5) return;
      drag.moved = true;

      const box = hitBoxesRef.current.find(
        (b) =>
          b.position.staffIndex === drag.position.staffIndex &&
          b.position.measureIndex === drag.position.measureIndex &&
          b.position.noteIndex === drag.position.noteIndex,
      );
      if (!box) return;
      const clef = effectiveClef(score, drag.position.staffIndex, drag.position.measureIndex);
      const diatonic = yToPitchStep(y, box.staveTop, box.staveBottom, clef);
      onNoteDrag(drag.position, diatonic);
    },
    [onNoteDrag, score, toLocalCoordinates],
  );

  const handleMouseUp = useCallback(
    (event: React.MouseEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;

      // Ein Ziehen wurde bereits laufend verarbeitet.
      if (drag?.moved) return;

      const { x, y } = toLocalCoordinates(event);
      const exact = findNoteAt(hitBoxesRef.current, x, y);

      if (exact && onNoteClick) {
        onNoteClick(exact.position, event);
        return;
      }

      // Kein Notenkopf getroffen: naechstgelegene Position und Tonhoehe aus der Lage.
      const nearest = findNearestNote(hitBoxesRef.current, x, y);
      if (nearest && onPitchClick) {
        const clef = effectiveClef(score, nearest.position.staffIndex, nearest.position.measureIndex);
        const diatonic = yToPitchStep(y, nearest.staveTop, nearest.staveBottom, clef);
        onPitchClick(nearest.position, diatonic, clef);
      }
    },
    [onNoteClick, onPitchClick, score, toLocalCoordinates],
  );

  return (
    <div className="score-surface" ref={wrapperRef}>
      {error && (
        <div className="notice notice-danger" style={{ margin: 12 }}>
          Das Notenbild konnte nicht gezeichnet werden: {error}
        </div>
      )}
      <div
        className="score-canvas-wrapper"
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          dragRef.current = null;
        }}
      />
    </div>
  );
}

/** Wandelt eine diatonische Stufe in eine MIDI-Nummer (ohne Vorzeichen) um. */
export function diatonicStepToMidi(diatonic: number): number {
  const { step, octave } = diatonicToPitch(diatonic);
  const semitones: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (octave + 1) * 12 + semitones[step];
}
