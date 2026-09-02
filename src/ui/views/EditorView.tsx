/**
 * Noteneditor: vollstaendige Bearbeitung der Partitur.
 *
 * Bedienkonzept:
 *   - Werkzeug oben waehlen (Notenwert, Vorzeichen, Pause)
 *   - In das Notensystem klicken, um eine Note zu setzen
 *   - Auf eine Note klicken, um sie auszuwaehlen
 *   - Note vertikal ziehen, um die Tonhoehe zu aendern
 *   - Tastatur: Pfeiltasten, Entf, Strg+Z, Strg+C/V
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../app-state';
import { Card, Field, Modal, Notice, ToggleButton } from '../components/common';
import { ScoreView, diatonicStepToMidi } from '../components/ScoreView';
import { PianoKeyboard } from '../components/PianoKeyboard';
import { PlaybackControls, StaffMixer } from '../components/PlaybackControls';
import type {
  AccidentalType,
  ArticulationMark,
  ClefType,
  DurationValue,
  DynamicMark,
  ScorePosition,
} from '../../core/types';
import {
  addStaff,
  appendMeasure,
  createEmptyScore,
  effectiveClef,
  noteAt,
  removeLastMeasure,
  removeStaff,
  setClef,
  setKeySignature,
  setTempo,
  setTimeSignature,
} from '../../core/score-model';
import {
  changeDuration,
  confirmAllNotes,
  confirmNote,
  convertToRest,
  copyNotes,
  deleteNoteCompletely,
  deleteSelection,
  nextPosition,
  pasteNotes,
  previousPosition,
  setAccidental,
  setChordSymbol,
  setDynamic,
  setNoteAtPosition,
  setPitch,
  toggleArticulation,
  toggleTie,
  transposeSelection,
} from '../../engines/notation/editor-commands';
import {
  keySignatureName,
  midiToPitch,
  pitchToDisplayName,
  pitchToMidi,
} from '../../core/music-theory';

/** Auswaehlbare Notenwerte mit Symbol. */
const DURATIONS: Array<{ value: DurationValue; label: string; symbol: string }> = [
  { value: 'whole', label: 'Ganze', symbol: '𝅝' },
  { value: 'half', label: 'Halbe', symbol: '𝅗𝅥' },
  { value: 'quarter', label: 'Viertel', symbol: '♩' },
  { value: 'eighth', label: 'Achtel', symbol: '♪' },
  { value: '16th', label: 'Sechzehntel', symbol: '𝅘𝅥𝅯' },
  { value: '32nd', label: 'Zweiunddreissigstel', symbol: '𝅘𝅥𝅰' },
];

const ACCIDENTALS: Array<{ value: AccidentalType | null; label: string; symbol: string }> = [
  { value: null, label: 'Ohne Vorzeichen', symbol: '–' },
  { value: 'sharp', label: 'Kreuz', symbol: '♯' },
  { value: 'flat', label: 'B', symbol: '♭' },
  { value: 'natural', label: 'Aufloesungszeichen', symbol: '♮' },
  { value: 'double-sharp', label: 'Doppelkreuz', symbol: '𝄪' },
  { value: 'double-flat', label: 'Doppel-B', symbol: '𝄫' },
];

const ARTICULATIONS: Array<{ value: ArticulationMark; label: string; symbol: string }> = [
  { value: 'staccato', label: 'Staccato', symbol: '·' },
  { value: 'accent', label: 'Akzent', symbol: '>' },
  { value: 'tenuto', label: 'Tenuto', symbol: '–' },
  { value: 'marcato', label: 'Marcato', symbol: '^' },
  { value: 'fermata', label: 'Fermate', symbol: '𝄐' },
];

const DYNAMICS: DynamicMark[] = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];

export function EditorView() {
  const {
    score,
    applyScoreChange,
    replaceScore,
    undo,
    redo,
    canUndo,
    canRedo,
    selection,
    setSelection,
    clipboard,
    setClipboard,
    player,
    saveCurrentProject,
    hasUnsavedChanges,
    setView,
    notify,
  } = useApp();

  const [duration, setDuration] = useState<DurationValue>('quarter');
  const [dots, setDots] = useState(0);
  const [accidental, setAccidentalTool] = useState<AccidentalType | null>(null);
  const [restMode, setRestMode] = useState(false);
  const [chordMode, setChordMode] = useState(false);
  const [showMixer, setShowMixer] = useState(false);
  const [showScoreSettings, setShowScoreSettings] = useState(false);
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState<ScorePosition | null>(null);

  const primarySelection = selection[0] ?? null;
  const selectedNote = primarySelection ? noteAt(score, primarySelection) : null;

  // Abspielposition fuer die farbige Markierung mitfuehren.
  useEffect(
    () => player.addStateListener((state) => setPlaybackPosition(state.currentPosition)),
    [player],
  );

  /** Setzt eine Note oder Pause an der angeklickten Position. */
  const handlePitchClick = useCallback(
    (position: ScorePosition, diatonicStep: number, clef: ClefType) => {
      void clef;
      if (restMode) {
        applyScoreChange(convertToRest(score, position));
        setSelection([position]);
        return;
      }

      const baseMidi = diatonicStepToMidi(diatonicStep);
      const alter =
        accidental === 'sharp' ? 1 :
        accidental === 'flat' ? -1 :
        accidental === 'double-sharp' ? 2 :
        accidental === 'double-flat' ? -2 : 0;
      const midi = Math.max(12, Math.min(108, baseMidi + alter));
      const pitch = { ...midiToPitch(midi, score.keySignature), accidental: accidental ?? undefined };

      applyScoreChange(setNoteAtPosition(score, position, pitch, duration, dots));
      setSelection([position]);
      void player.previewNote(midi, 0.4, score.staves[position.staffIndex]?.midiProgram ?? 0);
    },
    [accidental, applyScoreChange, dots, duration, player, restMode, score, setSelection],
  );

  /** Klick auf eine bestehende Note: auswaehlen oder Auswahl erweitern. */
  const handleNoteClick = useCallback(
    (position: ScorePosition, event: React.MouseEvent) => {
      if (event.shiftKey && primarySelection) {
        // Bereich vom ersten Klick bis hierher auswaehlen.
        const positions: ScorePosition[] = [];
        let current: ScorePosition | null = primarySelection;
        let guard = 0;
        while (current && guard++ < 500) {
          positions.push(current);
          if (
            current.measureIndex === position.measureIndex &&
            current.noteIndex === position.noteIndex
          ) {
            break;
          }
          current = nextPosition(score, current);
        }
        setSelection(positions.length > 0 ? positions : [position]);
        return;
      }

      setSelection([position]);
      const note = noteAt(score, position);
      if (note && !note.isRest && note.pitches.length > 0) {
        void player.previewNote(
          pitchToMidi(note.pitches[0]),
          0.4,
          score.staves[position.staffIndex]?.midiProgram ?? 0,
        );
      }
    },
    [player, primarySelection, score, setSelection],
  );

  /** Ziehen einer Note veraendert die Tonhoehe. */
  const handleNoteDrag = useCallback(
    (position: ScorePosition, diatonicStep: number) => {
      const midi = diatonicStepToMidi(diatonicStep);
      if (midi < 12 || midi > 108) return;
      const note = noteAt(score, position);
      if (!note || note.isRest) return;
      if (note.pitches.length > 0 && pitchToMidi(note.pitches[0]) === midi) return;
      applyScoreChange(setPitch(score, position, midi));
    },
    [applyScoreChange, score],
  );

  /** Note ueber die Klaviatur setzen oder zu einem Akkord ergaenzen. */
  const handleKeyboardPress = useCallback(
    (midi: number) => {
      void player.previewNote(midi, 0.5, score.staves[0]?.midiProgram ?? 0);
      if (!primarySelection) {
        notify('info', 'Waehle zuerst eine Position in den Noten aus.');
        return;
      }
      const note = noteAt(score, primarySelection);
      if (chordMode && note && !note.isRest) {
        const pitches = [...note.pitches];
        if (!pitches.some((p) => pitchToMidi(p) === midi)) {
          pitches.push(midiToPitch(midi, score.keySignature));
          pitches.sort((a, b) => pitchToMidi(a) - pitchToMidi(b));
        }
        applyScoreChange({
          ...score,
          staves: score.staves.map((staff, staffIndex) =>
            staffIndex !== primarySelection.staffIndex
              ? staff
              : {
                  ...staff,
                  measures: staff.measures.map((measure, measureIndex) =>
                    measureIndex !== primarySelection.measureIndex
                      ? measure
                      : {
                          ...measure,
                          notes: measure.notes.map((n, noteIndex) =>
                            noteIndex !== primarySelection.noteIndex ? n : { ...n, pitches },
                          ),
                        },
                  ),
                },
          ),
        });
        return;
      }
      applyScoreChange(
        setNoteAtPosition(
          score,
          primarySelection,
          midiToPitch(midi, score.keySignature),
          duration,
          dots,
        ),
      );
    },
    [applyScoreChange, chordMode, dots, duration, notify, player, primarySelection, score],
  );

  // Tastaturkuerzel
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      // In Eingabefeldern nicht eingreifen.
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      const ctrl = event.ctrlKey || event.metaKey;

      if (ctrl && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if (ctrl && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) {
        event.preventDefault();
        redo();
        return;
      }
      if (ctrl && event.key.toLowerCase() === 'c' && selection.length > 0) {
        event.preventDefault();
        setClipboard(copyNotes(score, selection));
        notify('info', `${selection.length} Note(n) kopiert.`);
        return;
      }
      if (ctrl && event.key.toLowerCase() === 'v' && primarySelection) {
        event.preventDefault();
        if (clipboard.notes.length === 0) return;
        applyScoreChange(pasteNotes(score, primarySelection, clipboard));
        notify('info', `${clipboard.notes.length} Note(n) eingefuegt.`);
        return;
      }
      if (ctrl && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveCurrentProject();
        return;
      }

      if (!primarySelection) return;

      switch (event.key) {
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          applyScoreChange(
            event.shiftKey
              ? deleteNoteCompletely(score, primarySelection)
              : deleteSelection(score, selection),
          );
          break;
        case 'ArrowRight': {
          event.preventDefault();
          const next = nextPosition(score, primarySelection);
          if (next) setSelection([next]);
          break;
        }
        case 'ArrowLeft': {
          event.preventDefault();
          const previous = previousPosition(score, primarySelection);
          if (previous) setSelection([previous]);
          break;
        }
        case 'ArrowUp':
          event.preventDefault();
          applyScoreChange(transposeSelection(score, selection, event.shiftKey ? 12 : 1));
          break;
        case 'ArrowDown':
          event.preventDefault();
          applyScoreChange(transposeSelection(score, selection, event.shiftKey ? -12 : -1));
          break;
        case '1': setDuration('whole'); break;
        case '2': setDuration('half'); break;
        case '3': setDuration('quarter'); break;
        case '4': setDuration('eighth'); break;
        case '5': setDuration('16th'); break;
        case '6': setDuration('32nd'); break;
        case '.':
          event.preventDefault();
          setDots((current) => (current + 1) % 3);
          break;
        case 'r':
          setRestMode((current) => !current);
          break;
        case 't':
          applyScoreChange(toggleTie(score, primarySelection));
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    applyScoreChange, clipboard, notify, primarySelection, redo, saveCurrentProject,
    score, selection, setClipboard, setSelection, undo,
  ]);

  const uncertainCount = score.staves.reduce(
    (sum, staff) =>
      sum +
      staff.measures.reduce(
        (measureSum, measure) =>
          measureSum + measure.notes.filter((n) => n.autoDetected && (n.confidence ?? 1) < 0.7).length,
        0,
      ),
    0,
  );

  return (
    <div className="view">
      <header className="view-header">
        <div className="row-between">
          <div>
            <h1>Noteneditor</h1>
            <p style={{ marginBottom: 0 }}>
              Klicke in das Notensystem, um Noten zu setzen. Ziehe eine Note nach oben oder
              unten, um ihre Tonhoehe zu aendern.
            </p>
          </div>
          <div className="row">
            {hasUnsavedChanges && <span className="badge badge-warning">Nicht gespeichert</span>}
            <button className="btn" onClick={() => setShowKeyboardHelp(true)}>
              Tastenkuerzel
            </button>
            <button className="btn btn-primary" onClick={() => void saveCurrentProject()}>
              Projekt speichern
            </button>
          </div>
        </div>
      </header>

      {uncertainCount > 0 && (
        <Notice kind="warning">
          {uncertainCount} Note(n) wurden automatisch erkannt und sind unsicher. Sie sind
          farbig markiert: orange bedeutet mittlere, rot geringe Sicherheit. Pruefe sie und
          bestaetige sie anschliessend.{' '}
          <button
            className="btn btn-sm mt-1"
            onClick={() => {
              applyScoreChange(confirmAllNotes(score));
              notify('success', 'Alle Noten wurden als geprueft markiert.');
            }}
          >
            Alle als geprueft markieren
          </button>
        </Notice>
      )}

      <PlaybackControls player={player} score={score} />

      <div className="toolbar">
        <div className="toolbar-group">
          <span className="toolbar-label">Bearbeiten</span>
          <button className="btn btn-sm" onClick={undo} disabled={!canUndo} title="Rueckgaengig (Strg+Z)">
            Rueckgaengig
          </button>
          <button className="btn btn-sm" onClick={redo} disabled={!canRedo} title="Wiederholen (Strg+Y)">
            Wiederholen
          </button>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Notenwert</span>
          {DURATIONS.map((item) => (
            <ToggleButton
              key={item.value}
              small
              active={duration === item.value && !restMode}
              onClick={() => {
                setDuration(item.value);
                setRestMode(false);
              }}
              title={item.label}
            >
              {item.symbol}
            </ToggleButton>
          ))}
          <ToggleButton
            small
            active={dots > 0}
            onClick={() => setDots((current) => (current + 1) % 3)}
            title="Punktierung (Taste .)"
          >
            {dots === 0 ? '.' : dots === 1 ? '·' : '··'}
          </ToggleButton>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Vorzeichen</span>
          {ACCIDENTALS.map((item) => (
            <ToggleButton
              key={item.label}
              small
              active={accidental === item.value}
              onClick={() => setAccidentalTool(item.value)}
              title={item.label}
            >
              {item.symbol}
            </ToggleButton>
          ))}
        </div>

        <div className="toolbar-group">
          <ToggleButton
            small
            active={restMode}
            onClick={() => setRestMode((current) => !current)}
            title="Pausen setzen (Taste r)"
          >
            Pause
          </ToggleButton>
          <ToggleButton
            small
            active={chordMode}
            onClick={() => setChordMode((current) => !current)}
            title="Ueber die Klaviatur Toene zum Akkord hinzufuegen"
          >
            Akkord
          </ToggleButton>
        </div>

        <div className="toolbar-group">
          <span className="toolbar-label">Takte</span>
          <button className="btn btn-sm" onClick={() => applyScoreChange(appendMeasure(score))}>
            + Takt
          </button>
          <button
            className="btn btn-sm"
            onClick={() => applyScoreChange(removeLastMeasure(score))}
            disabled={(score.staves[0]?.measures.length ?? 0) <= 1}
          >
            – Takt
          </button>
        </div>

        <div className="toolbar-group">
          <button className="btn btn-sm" onClick={() => setShowScoreSettings(true)}>
            Partitur-Einstellungen
          </button>
          <button className="btn btn-sm" onClick={() => setShowMixer((current) => !current)}>
            Mischpult
          </button>
        </div>

        <div className="spacer" />

        <div className="toolbar-group">
          <button className="btn btn-sm" onClick={() => setView('export')}>
            Exportieren
          </button>
        </div>
      </div>

      {showMixer && (
        <Card title="Mischpult" subtitle="Lautstaerke und Stummschaltung je Notensystem.">
          <StaffMixer player={player} score={score} onScoreChange={applyScoreChange} />
          <div className="row mt-2">
            <button
              className="btn btn-sm"
              onClick={() => applyScoreChange(addStaff(score, `Stimme ${score.staves.length + 1}`, 'treble'))}
            >
              System hinzufuegen (Violinschluessel)
            </button>
            <button
              className="btn btn-sm"
              onClick={() => applyScoreChange(addStaff(score, `Bass ${score.staves.length + 1}`, 'bass'))}
            >
              System hinzufuegen (Bassschluessel)
            </button>
            {score.staves.length > 1 && (
              <button
                className="btn btn-sm btn-danger"
                onClick={() => applyScoreChange(removeStaff(score, score.staves.length - 1))}
              >
                Letztes System entfernen
              </button>
            )}
          </div>
        </Card>
      )}

      <ScoreView
        score={score}
        selection={selection}
        playbackPosition={playbackPosition}
        onNoteClick={handleNoteClick}
        onPitchClick={handlePitchClick}
        onNoteDrag={handleNoteDrag}
      />

      <div className="grid grid-2 mt-2">
        <Card title="Klaviatur" subtitle="Klicke eine Taste, um die ausgewaehlte Stelle zu fuellen.">
          <PianoKeyboard
            activeMidis={selectedNote?.pitches.map(pitchToMidi) ?? []}
            onKeyPress={handleKeyboardPress}
          />
          <div className="tiny muted mt-1">
            {chordMode
              ? 'Akkordmodus aktiv: Tasten fuegen Toene zur ausgewaehlten Note hinzu.'
              : 'Ein Klick ersetzt die ausgewaehlte Note.'}
          </div>
        </Card>

        <Card
          title="Ausgewaehlte Note"
          subtitle={
            primarySelection
              ? `Takt ${primarySelection.measureIndex + 1}, Position ${primarySelection.noteIndex + 1}`
              : 'Keine Note ausgewaehlt'
          }
        >
          {!selectedNote ? (
            <p className="small muted">
              Klicke im Notenbild auf eine Note, um sie hier zu bearbeiten.
            </p>
          ) : (
            <>
              <div className="row mb-2">
                <strong style={{ fontSize: 18 }}>
                  {selectedNote.isRest
                    ? 'Pause'
                    : selectedNote.pitches.map((p) => pitchToDisplayName(p)).join(' + ')}
                </strong>
                {selectedNote.autoDetected && selectedNote.confidence !== undefined && (
                  <span
                    className={`badge badge-${
                      selectedNote.confidence >= 0.7
                        ? 'success'
                        : selectedNote.confidence >= 0.45
                          ? 'warning'
                          : 'danger'
                    }`}
                  >
                    automatisch erkannt, {Math.round(selectedNote.confidence * 100)} % sicher
                  </span>
                )}
              </div>

              <div className="field-row mb-2">
                <Field label="Notenwert">
                  <select
                    value={selectedNote.duration}
                    onChange={(event) =>
                      applyScoreChange(
                        changeDuration(
                          score,
                          primarySelection!,
                          event.target.value as DurationValue,
                          selectedNote.dots,
                        ),
                      )
                    }
                    style={{ width: 165 }}
                  >
                    {DURATIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Punktierungen">
                  <select
                    value={selectedNote.dots}
                    onChange={(event) =>
                      applyScoreChange(
                        changeDuration(
                          score,
                          primarySelection!,
                          selectedNote.duration,
                          Number(event.target.value),
                        ),
                      )
                    }
                    style={{ width: 80 }}
                  >
                    <option value={0}>keine</option>
                    <option value={1}>einfach</option>
                    <option value={2}>doppelt</option>
                  </select>
                </Field>
              </div>

              {!selectedNote.isRest && (
                <>
                  <div className="mb-2">
                    <label>Vorzeichen</label>
                    <div className="btn-group mt-1">
                      {ACCIDENTALS.map((item) => (
                        <button
                          key={item.label}
                          className="btn btn-sm"
                          title={item.label}
                          onClick={() =>
                            applyScoreChange(setAccidental(score, primarySelection!, item.value))
                          }
                        >
                          {item.symbol}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mb-2">
                    <label>Artikulation</label>
                    <div className="btn-group mt-1">
                      {ARTICULATIONS.map((item) => (
                        <ToggleButton
                          key={item.value}
                          small
                          active={selectedNote.articulations?.includes(item.value) ?? false}
                          onClick={() =>
                            applyScoreChange(toggleArticulation(score, primarySelection!, item.value))
                          }
                          title={item.label}
                        >
                          {item.symbol}
                        </ToggleButton>
                      ))}
                      <ToggleButton
                        small
                        active={selectedNote.tieStart ?? false}
                        onClick={() => applyScoreChange(toggleTie(score, primarySelection!))}
                        title="Ueberbindung zur naechsten Note (Taste t)"
                      >
                        Bindung
                      </ToggleButton>
                    </div>
                  </div>

                  <div className="field-row mb-2">
                    <Field label="Dynamik">
                      <select
                        value={selectedNote.dynamic ?? ''}
                        onChange={(event) =>
                          applyScoreChange(
                            setDynamic(
                              score,
                              primarySelection!,
                              event.target.value ? (event.target.value as DynamicMark) : null,
                            ),
                          )
                        }
                        style={{ width: 100 }}
                      >
                        <option value="">keine</option>
                        {DYNAMICS.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Akkordsymbol">
                      <input
                        type="text"
                        placeholder="z.B. Am7"
                        value={selectedNote.chordSymbol ?? ''}
                        onChange={(event) =>
                          applyScoreChange(
                            setChordSymbol(score, primarySelection!, event.target.value),
                          )
                        }
                        style={{ width: 130 }}
                      />
                    </Field>
                  </div>
                </>
              )}

              <div className="row">
                <button
                  className="btn btn-sm"
                  onClick={() => applyScoreChange(convertToRest(score, primarySelection!))}
                >
                  In Pause umwandeln
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => applyScoreChange(deleteNoteCompletely(score, primarySelection!))}
                >
                  Loeschen
                </button>
                {selectedNote.autoDetected && (
                  <button
                    className="btn btn-sm"
                    onClick={() => applyScoreChange(confirmNote(score, primarySelection!))}
                  >
                    Als geprueft markieren
                  </button>
                )}
              </div>
            </>
          )}
        </Card>
      </div>

      {showScoreSettings && (
        <Modal
          title="Partitur-Einstellungen"
          onClose={() => setShowScoreSettings(false)}
          footer={
            <button className="btn btn-primary" onClick={() => setShowScoreSettings(false)}>
              Fertig
            </button>
          }
        >
          <div className="grid" style={{ gap: 14 }}>
            <Field label="Titel">
              <input
                type="text"
                value={score.title}
                onChange={(event) => applyScoreChange({ ...score, title: event.target.value })}
              />
            </Field>
            <Field label="Komponist">
              <input
                type="text"
                value={score.composer}
                onChange={(event) => applyScoreChange({ ...score, composer: event.target.value })}
              />
            </Field>
            <Field label="Tempo in Viertel pro Minute">
              <input
                type="number"
                min={20}
                max={300}
                value={score.tempo}
                onChange={(event) =>
                  applyScoreChange(setTempo(score, 0, Math.max(20, Number(event.target.value))))
                }
              />
            </Field>
            <div className="field-row">
              <Field label="Taktart">
                <div className="row">
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={score.timeSignature.beats}
                    onChange={(event) =>
                      applyScoreChange(
                        setTimeSignature(score, 0, {
                          ...score.timeSignature,
                          beats: Math.max(1, Number(event.target.value)),
                        }),
                      )
                    }
                    style={{ width: 70 }}
                  />
                  <span>/</span>
                  <select
                    value={score.timeSignature.beatType}
                    onChange={(event) =>
                      applyScoreChange(
                        setTimeSignature(score, 0, {
                          ...score.timeSignature,
                          beatType: Number(event.target.value),
                        }),
                      )
                    }
                    style={{ width: 78 }}
                  >
                    <option value={2}>2</option>
                    <option value={4}>4</option>
                    <option value={8}>8</option>
                    <option value={16}>16</option>
                  </select>
                </div>
              </Field>
            </div>
            <Field label="Tonart" hint={keySignatureName(score.keySignature)}>
              <select
                value={score.keySignature}
                onChange={(event) =>
                  applyScoreChange(setKeySignature(score, Number(event.target.value)))
                }
              >
                {Array.from({ length: 15 }, (_, i) => i - 7).map((fifths) => (
                  <option key={fifths} value={fifths}>
                    {keySignatureName(fifths)}{' '}
                    {fifths === 0 ? '' : `(${Math.abs(fifths)} ${fifths > 0 ? 'Kreuz' : 'b'})`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Schluessel des ersten Systems">
              <select
                value={effectiveClef(score, 0, 0)}
                onChange={(event) =>
                  applyScoreChange(setClef(score, 0, 0, event.target.value as ClefType))
                }
              >
                <option value="treble">Violinschluessel</option>
                <option value="bass">Bassschluessel</option>
                <option value="alto">Altschluessel</option>
                <option value="tenor">Tenorschluessel</option>
              </select>
            </Field>

            <button
              className="btn btn-danger"
              onClick={() => {
                replaceScore(createEmptyScore({ title: 'Neues Stueck' }));
                setShowScoreSettings(false);
                notify('info', 'Eine neue, leere Partitur wurde angelegt.');
              }}
            >
              Neue leere Partitur beginnen
            </button>
          </div>
        </Modal>
      )}

      {showKeyboardHelp && (
        <Modal title="Tastenkuerzel" onClose={() => setShowKeyboardHelp(false)}>
          <div className="list">
            {[
              ['1 bis 6', 'Notenwert waehlen (ganze bis 32stel)'],
              ['.', 'Punktierung durchschalten'],
              ['r', 'Pausenmodus umschalten'],
              ['t', 'Ueberbindung zur naechsten Note'],
              ['Pfeil links / rechts', 'Zur vorherigen oder naechsten Note'],
              ['Pfeil hoch / runter', 'Tonhoehe um einen Halbton aendern'],
              ['Umschalt + Pfeil hoch / runter', 'Tonhoehe um eine Oktave aendern'],
              ['Entf', 'Note in eine Pause umwandeln'],
              ['Umschalt + Entf', 'Note vollstaendig entfernen'],
              ['Strg + Z', 'Rueckgaengig'],
              ['Strg + Y', 'Wiederholen'],
              ['Strg + C', 'Auswahl kopieren'],
              ['Strg + V', 'Einfuegen'],
              ['Strg + S', 'Projekt speichern'],
              ['Umschalt + Klick', 'Bereich auswaehlen'],
            ].map(([key, description]) => (
              <div key={key} className="list-row" style={{ padding: '8px 12px' }}>
                <code className="mono badge" style={{ minWidth: 170 }}>
                  {key}
                </code>
                <span className="small">{description}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
