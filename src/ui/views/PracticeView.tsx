/**
 * Uebungsmodus: Noten mit dem Mikrofon nachspielen.
 *
 * Der Mikrofonzugriff erfolgt erst nach ausdruecklichem Klick. Ohne
 * Mikrofon bleibt die Ansicht nutzbar, der Uebungsteil wird dann
 * deaktiviert und der Grund genannt.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app-state';
import { Card, Field, Notice, ProgressBar, Stat } from '../components/common';
import { PianoKeyboard } from '../components/PianoKeyboard';
import { ScoreView } from '../components/ScoreView';
import {
  MicrophoneAnalyzer,
  PracticeSession,
  SILENT_PITCH,
  evaluatePitch,
  type LivePitch,
  type MicrophoneStatus,
  type PitchFeedback,
  type PracticeTask,
} from '../../engines/practice/practice-engine';
import {
  midiToPitch,
  pitchToDisplayName,
  pitchToMidi,
} from '../../core/music-theory';
import { updatePracticeProgress } from '../../engines/projects/project-store';

/** Anzeigebereich der Cent-Skala. */
const CENT_RANGE = 50;

export function PracticeView() {
  const { score, player, currentProjectId, notify, refreshProjects } = useApp();

  const analyzerRef = useRef<MicrophoneAnalyzer | null>(null);
  if (!analyzerRef.current) analyzerRef.current = new MicrophoneAnalyzer();
  const analyzer = analyzerRef.current;

  const [status, setStatus] = useState<MicrophoneStatus>(() =>
    MicrophoneAnalyzer.isSupported() ? 'idle' : 'unsupported',
  );
  const [live, setLive] = useState<LivePitch>(SILENT_PITCH);
  const [feedback, setFeedback] = useState<PitchFeedback | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [progressVersion, setProgressVersion] = useState(0);
  const [tolerance, setTolerance] = useState(35);
  const [mode, setMode] = useState<'free' | 'score' | 'scale'>('free');
  const [freeTarget, setFreeTarget] = useState(60);
  const [savedForSession, setSavedForSession] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [micFallback, setMicFallback] = useState(false);

  const sessionRef = useRef<PracticeSession | null>(null);
  sessionRef.current = session;
  const toleranceRef = useRef(tolerance);
  toleranceRef.current = tolerance;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const freeTargetRef = useRef(freeTarget);
  freeTargetRef.current = freeTarget;

  /** Alle Tonhoehen der aktuellen Partitur in Reihenfolge. */
  const scoreTargets = useMemo(() => {
    const targets: number[] = [];
    for (const staff of score.staves) {
      for (const measure of staff.measures) {
        for (const note of measure.notes) {
          if (note.isRest || note.pitches.length === 0) continue;
          // Bei Akkorden die tiefste Note als Ziel nehmen.
          targets.push(Math.min(...note.pitches.map(pitchToMidi)));
        }
      }
      // Nur das erste System ueben.
      break;
    }
    return targets;
  }, [score]);

  /** Verarbeitet jedes Analyseergebnis des Mikrofons. */
  const handlePitch = useCallback((pitch: LivePitch) => {
    setLive(pitch);

    const currentSession = sessionRef.current;
    if (currentSession) {
      const result = currentSession.update(pitch);
      setFeedback(result);
      setProgressVersion((v) => v + 1);
      return;
    }

    if (modeRef.current === 'free') {
      setFeedback(evaluatePitch(pitch, freeTargetRef.current, toleranceRef.current));
    }
  }, []);

  /** Mikrofon anfordern. */
  const requestMicrophone = useCallback(async () => {
    const result = await analyzer.start(handlePitch);
    setStatus(result);
    setMicError(analyzer.getLastError());
    setMicFallback(analyzer.usedFallback());
    if (result === 'granted') {
      notify('success', 'Mikrofon aktiv. Das Signal wird nur lokal analysiert.');
    } else if (result === 'denied') {
      notify(
        'warning',
        'Der Mikrofonzugriff wurde abgelehnt. Der Uebungsmodus bleibt deaktiviert, ' +
          'alle anderen Funktionen kannst du weiterhin nutzen.',
      );
    } else if (result === 'unsupported') {
      notify('warning', 'Dieser Browser bietet keinen Mikrofonzugriff an.');
    } else if (result === 'error') {
      notify('danger', 'Das Mikrofon konnte nicht geoeffnet werden.');
    }
  }, [analyzer, handlePitch, notify]);

  /** Mikrofon freigeben. */
  const stopMicrophone = useCallback(() => {
    analyzer.stop();
    setStatus(MicrophoneAnalyzer.isSupported() ? 'idle' : 'unsupported');
    setLive(SILENT_PITCH);
    setFeedback(null);
  }, [analyzer]);

  // Mikrofon beim Verlassen der Ansicht sicher schliessen.
  useEffect(() => () => analyzer.stop(), [analyzer]);

  /** Startet eine Uebung mit der angegebenen Aufgabe. */
  const startSession = useCallback(
    (task: PracticeTask) => {
      if (task.targets.length === 0) {
        notify('warning', 'Diese Uebung enthaelt keine Noten.');
        return;
      }
      const newSession = new PracticeSession(task, 18, toleranceRef.current);
      setSession(newSession);
      setSavedForSession(false);
      setProgressVersion((v) => v + 1);
      notify('info', `Uebung "${task.label}" gestartet: ${task.targets.length} Noten.`);
    },
    [notify],
  );

  const progress = session?.getProgress();
  const currentTarget = session ? session.getCurrentTarget() : freeTarget;

  // Ergebnis speichern, wenn die Uebung abgeschlossen ist.
  useEffect(() => {
    if (!progress?.finished || savedForSession) return;
    setSavedForSession(true);
    notify(
      'success',
      `Uebung beendet: ${Math.round(progress.accuracy * 100)} % Trefferquote bei ` +
        `${progress.averageCents.toFixed(1)} Cent durchschnittlicher Abweichung.`,
    );
    if (currentProjectId) {
      void updatePracticeProgress(currentProjectId, progress.accuracy, progress.averageCents).then(
        () => void refreshProjects(),
      );
    }
  }, [currentProjectId, notify, progress, refreshProjects, savedForSession]);

  const micActive = status === 'granted';
  const verdictText =
    feedback?.verdict === 'correct'
      ? 'Richtige Note'
      : feedback?.verdict === 'too-high'
        ? 'Zu hoch'
        : feedback?.verdict === 'too-low'
          ? 'Zu tief'
          : 'Warte auf Ton';
  const verdictClass =
    feedback?.verdict === 'correct'
      ? 'verdict-correct'
      : feedback?.verdict === 'too-high'
        ? 'verdict-high'
        : feedback?.verdict === 'too-low'
          ? 'verdict-low'
          : 'verdict-silent';

  // Position der Nadel auf der Cent-Skala.
  const needleOffset = feedback
    ? Math.max(-CENT_RANGE, Math.min(CENT_RANGE, feedback.centsOffTarget))
    : 0;
  const needlePercent = 50 + (needleOffset / CENT_RANGE) * 50;

  return (
    <div className="view">
      <header className="view-header">
        <h1>Ueben</h1>
        <p>
          Spiele oder singe die angezeigte Note. Die App erkennt die Tonhoehe in Echtzeit und
          zeigt dir sofort, ob du zu hoch, zu tief oder richtig liegst.
        </p>
      </header>

      {status === 'unsupported' && (
        <Notice kind="danger">
          Dieser Browser unterstuetzt keinen Mikrofonzugriff. Der Uebungsmodus steht daher
          nicht zur Verfuegung. Alle anderen Funktionen der App kannst du normal nutzen.
        </Notice>
      )}
      {status === 'denied' && (
        <Notice kind="warning">
          Der Mikrofonzugriff wurde abgelehnt. Du kannst ihn in den Website-Einstellungen
          deines Browsers wieder erlauben und es dann erneut versuchen.
        </Notice>
      )}
      {status === 'error' && (
        <Notice kind="danger">
          Das Mikrofon konnte nicht geoeffnet werden. Pruefe, ob ein Geraet angeschlossen ist
          und keine andere Anwendung es belegt.
          {micError && (
            <div className="tiny mono mt-1">Meldung des Browsers: {micError}</div>
          )}
        </Notice>
      )}
      {micActive && micFallback && (
        <Notice kind="warning">
          Dein Geraet erlaubt es nicht, die Signalaufbereitung des Browsers abzuschalten.
          Echounterdrueckung und automatische Aussteuerung koennen die gemessene Tonhoehe
          leicht verfaelschen. Der Uebungsmodus funktioniert trotzdem.
        </Notice>
      )}

      <Card
        title="Mikrofon"
        subtitle="Das Signal wird ausschliesslich auf diesem Geraet ausgewertet und nirgends gespeichert."
        actions={
          micActive ? (
            <button className="btn btn-danger" onClick={stopMicrophone}>
              Mikrofon freigeben
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => void requestMicrophone()}
              disabled={status === 'unsupported' || status === 'requesting'}
            >
              {status === 'requesting' ? 'Warte auf Freigabe' : 'Mikrofon aktivieren'}
            </button>
          )
        }
      >
        {micActive ? (
          <>
            <div className="row-between mb-1">
              <span className="small">Eingangspegel</span>
              <span className="mono tiny">
                {live.level > 0 ? `${(20 * Math.log10(Math.max(1e-6, live.level))).toFixed(0)} dB` : 'still'}
              </span>
            </div>
            <div className="level-meter">
              <div
                className="level-meter-fill"
                style={{ width: `${Math.min(100, live.level * 350)}%` }}
              />
            </div>
          </>
        ) : (
          <p className="small muted">
            Der Uebungsmodus braucht Zugriff auf dein Mikrofon. Dein Browser fragt dich beim
            Klick um Erlaubnis. Die Aufnahme verlaesst dein Geraet nicht.
          </p>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Tonhoehenanzeige">
          <div className="tuner">
            <div className="tuner-note">
              {live.midi >= 0 ? live.noteName : '–'}
            </div>
            <div className="tuner-target">
              {currentTarget >= 0
                ? `Zielnote: ${pitchToDisplayName(midiToPitch(currentTarget))}`
                : 'Keine Zielnote'}
            </div>

            <div className="tuner-meter">
              <div
                className="tuner-tolerance"
                style={{ width: `${(tolerance / CENT_RANGE) * 100}%` }}
              />
              <div className="tuner-center-line" />
              {feedback && feedback.verdict !== 'silent' && (
                <div
                  className="tuner-needle"
                  style={{
                    left: `${needlePercent}%`,
                    background:
                      feedback.verdict === 'correct' ? 'var(--success)' : 'var(--warning)',
                  }}
                />
              )}
            </div>
            <div className="tuner-scale">
              <span>-{CENT_RANGE} Cent</span>
              <span>0</span>
              <span>+{CENT_RANGE} Cent</span>
            </div>

            <div className={`tuner-verdict ${verdictClass}`}>
              {micActive ? verdictText : 'Mikrofon nicht aktiv'}
            </div>

            {feedback && feedback.verdict !== 'silent' && (
              <div className="mono small muted">
                {feedback.centsOffTarget > 0 ? '+' : ''}
                {feedback.centsOffTarget.toFixed(1)} Cent
                {feedback.live.frequency > 0 && ` · ${feedback.live.frequency.toFixed(1)} Hz`}
              </div>
            )}

            {session && !progress?.finished && (
              <div className="mt-2">
                <ProgressBar
                  value={session.getHoldRatio()}
                  label="Ton halten"
                  variant="success"
                />
              </div>
            )}
          </div>
        </Card>

        <Card title="Uebung">
          <Field label="Modus">
            <select
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as typeof mode);
                setSession(null);
                setFeedback(null);
              }}
            >
              <option value="free">Freies Stimmen (eine Zielnote)</option>
              <option value="scale">Tonleiter ueben</option>
              <option value="score">Aktuelle Partitur ueben</option>
            </select>
          </Field>

          {mode === 'free' && (
            <div className="mt-2">
              <label className="mb-1" style={{ display: 'block' }}>
                Zielnote waehlen
              </label>
              <PianoKeyboard
                fromMidi={48}
                toMidi={84}
                activeMidis={[freeTarget]}
                onKeyPress={(midi) => {
                  setFreeTarget(midi);
                  setSession(null);
                  void player.previewNote(midi, 0.7);
                }}
              />
              <div className="row mt-2">
                <button className="btn btn-sm" onClick={() => void player.previewNote(freeTarget, 1)}>
                  Zielnote vorspielen
                </button>
              </div>
            </div>
          )}

          {mode === 'scale' && (
            <div className="mt-2">
              <p className="small muted">
                Uebe eine Dur-Tonleiter aufwaerts. Halte jede Note kurz sauber, dann schaltet
                die App zur naechsten weiter.
              </p>
              <div className="row mt-1">
                <Field label="Grundton">
                  <select
                    value={freeTarget}
                    onChange={(event) => setFreeTarget(Number(event.target.value))}
                    style={{ width: 110 }}
                  >
                    {Array.from({ length: 13 }, (_, i) => 55 + i).map((midi) => (
                      <option key={midi} value={midi}>
                        {pitchToDisplayName(midiToPitch(midi))}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  className="btn btn-primary"
                  disabled={!micActive}
                  onClick={() =>
                    startSession({
                      id: 'scale',
                      label: `Dur-Tonleiter ab ${pitchToDisplayName(midiToPitch(freeTarget))}`,
                      // Dur-Tonleiter: 2-2-1-2-2-2-1 Halbtoene
                      targets: [0, 2, 4, 5, 7, 9, 11, 12].map((step) => freeTarget + step),
                    })
                  }
                >
                  Tonleiter starten
                </button>
              </div>
            </div>
          )}

          {mode === 'score' && (
            <div className="mt-2">
              <p className="small muted">
                Spiele die Noten deiner aktuellen Partitur der Reihe nach. Pausen werden
                uebersprungen; bei Akkorden zaehlt der tiefste Ton.
              </p>
              <div className="row mt-1">
                <button
                  className="btn btn-primary"
                  disabled={!micActive || scoreTargets.length === 0}
                  onClick={() =>
                    startSession({
                      id: 'score',
                      label: score.title || 'Partitur',
                      targets: scoreTargets,
                    })
                  }
                >
                  Partitur ueben ({scoreTargets.length} Noten)
                </button>
              </div>
              {scoreTargets.length === 0 && (
                <Notice kind="info">
                  Die aktuelle Partitur enthaelt noch keine Noten. Erstelle zuerst welche im
                  Noteneditor oder analysiere eine Audiodatei.
                </Notice>
              )}
            </div>
          )}

          <Field label={`Toleranz: ${tolerance} Cent`} hint="Kleinere Werte fordern genaueres Spiel.">
            <input
              type="range"
              min={10}
              max={60}
              step={5}
              value={tolerance}
              onChange={(event) => setTolerance(Number(event.target.value))}
            />
          </Field>

          {session && progress && (
            <>
              <div className="grid grid-3 mt-2" key={progressVersion}>
                <Stat
                  label="Fortschritt"
                  value={`${progress.completed} / ${session.getTask().targets.length}`}
                />
                <Stat label="Trefferquote" value={`${Math.round(progress.accuracy * 100)} %`} />
                <Stat
                  label="Genauigkeit"
                  value={
                    progress.averageCents > 0 ? `${progress.averageCents.toFixed(1)} ct` : '–'
                  }
                  hint="mittlere Abweichung"
                />
              </div>
              <div className="mt-2">
                <ProgressBar
                  value={progress.completed / Math.max(1, session.getTask().targets.length)}
                  label="Durchgang"
                />
              </div>
              <div className="row mt-2">
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    session.skip();
                    setProgressVersion((v) => v + 1);
                  }}
                  disabled={progress.finished}
                >
                  Note ueberspringen
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    session.reset();
                    setSavedForSession(false);
                    setProgressVersion((v) => v + 1);
                  }}
                >
                  Neu beginnen
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setSession(null)}>
                  Uebung beenden
                </button>
                {currentTarget >= 0 && (
                  <button
                    className="btn btn-sm"
                    onClick={() => void player.previewNote(currentTarget, 1)}
                  >
                    Zielnote vorspielen
                  </button>
                )}
              </div>
            </>
          )}
        </Card>
      </div>

      {mode === 'score' && (
        <Card title="Partitur" subtitle="Zur Orientierung waehrend der Uebung.">
          <ScoreView score={score} measuresPerLine={4} highlightUncertain={false} />
        </Card>
      )}
    </div>
  );
}
