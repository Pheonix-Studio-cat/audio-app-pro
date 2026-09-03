/**
 * Ablauf "Audio zu Noten": Datei waehlen, analysieren, Ergebnis pruefen
 * und in den Editor uebernehmen.
 */
import { useCallback, useRef, useState } from 'react';
import { useApp } from '../app-state';
import {
  Card,
  ConfidenceBadge,
  DropZone,
  Field,
  Notice,
  ProgressBar,
  Stat,
  formatBytes,
  formatDuration,
} from '../components/common';
import { Waveform } from '../components/Waveform';
import { ScoreView } from '../components/ScoreView';
import {
  AUDIO_FORMATS,
  decodeAudioFile,
  isVideoFile,
  type DecodedAudio,
} from '../../engines/audio/audio-engine';
import { extractAudioFromVideo } from '../../engines/video/video-engine';
import { analyzeAudio, type AnalysisProgress } from '../../engines/analysis/analysis-engine';
import { eventsToScore, quantizeNotes } from '../../engines/analysis/quantization';
import { DEFAULT_ANALYSIS_OPTIONS, type AnalysisOptions, type DurationValue } from '../../core/types';
import { midiToPitch, pitchToDisplayName } from '../../core/music-theory';

export function AudioToNotesView() {
  const { setView, replaceScore, setAudio, audio, analysis, setAnalysis, notify } = useApp();

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [options, setOptions] = useState<AnalysisOptions>(DEFAULT_ANALYSIS_OPTIONS);
  const [previewScore, setPreviewScore] = useState<ReturnType<typeof eventsToScore> | null>(null);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number } | null>(null);
  const cancelRef = useRef(false);

  /** Datei einlesen und dekodieren. */
  const handleFiles = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;

      setBusy(true);
      setPreviewScore(null);
      setAnalysis(null);
      setProgress({ progress: 0.02, step: 'Datei wird gelesen' });

      try {
        let decoded: DecodedAudio;

        if (isVideoFile(file)) {
          notify('info', 'Videodatei erkannt. Die Tonspur wird extrahiert.');
          const result = await extractAudioFromVideo(file, (extraction) => {
            setProgress({
              progress: Math.max(0, extraction.progress) * 0.4,
              step: extraction.step,
            });
          });
          decoded = result.audio;
          for (const note of result.notes) notify('info', note);
        } else {
          decoded = await decodeAudioFile(file);
        }

        setAudio(decoded, file);
        setFileInfo({ name: file.name, size: file.size });
        setProgress(null);
        notify(
          'success',
          `"${file.name}" geladen: ${formatDuration(decoded.duration)}, ` +
            `${decoded.sampleRate} Hz, ${decoded.channels.length} Kanal/Kanaele.`,
        );
      } catch (error) {
        setProgress(null);
        notify('danger', (error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [notify, setAnalysis, setAudio],
  );

  /** Analyse starten. */
  const runAnalysis = useCallback(async () => {
    if (!audio) return;
    setBusy(true);
    cancelRef.current = false;
    setPreviewScore(null);

    try {
      const result = await analyzeAudio(audio.samples, audio.sampleRate, options, (update) => {
        setProgress(update);
      });
      if (cancelRef.current) return;

      setAnalysis(result);

      const events = quantizeNotes(result.notes, result.tempo, {
        grid: options.quantizeGrid,
        beatOffset: result.beatOffset,
      });
      const score = eventsToScore(events, result, fileInfo?.name.replace(/\.[^.]+$/, '') ?? 'Analyse');
      setPreviewScore(score);

      notify(
        result.notes.length > 0 ? 'success' : 'warning',
        result.notes.length > 0
          ? `${result.notes.length} Noten erkannt bei ${Math.round(result.tempo)} BPM.`
          : 'Es wurden keine Noten erkannt. Passe die Einstellungen an und versuche es erneut.',
      );
    } catch (error) {
      notify('danger', `Die Analyse ist fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [audio, fileInfo, notify, options, setAnalysis]);

  /** Ergebnis in den Editor uebernehmen. */
  const openInEditor = useCallback(() => {
    if (!previewScore) return;
    replaceScore(previewScore);
    setView('editor');
    notify('info', 'Die erkannte Partitur ist jetzt im Editor. Unsichere Noten sind farbig markiert.');
  }, [notify, previewScore, replaceScore, setView]);

  const acceptedTypes = AUDIO_FORMATS.map((f) => `.${f.extension}`).join(',');

  return (
    <div className="view">
      <header className="view-header">
        <h1>Audio zu Noten</h1>
        <p>
          Importiere eine Aufnahme, lass sie analysieren und uebernimm das Ergebnis in den
          Noteneditor. Die Erkennung arbeitet am zuverlaessigsten bei einstimmigen, klar
          gespielten Aufnahmen.
        </p>
      </header>

      <Card
        title="1. Audiodatei waehlen"
        subtitle="Die Datei bleibt auf deinem Geraet und wird nicht hochgeladen."
      >
        <DropZone
          accept={`${acceptedTypes},audio/*,video/*`}
          icon="♫"
          title="Audiodatei hier ablegen oder klicken"
          hint={`Unterstuetzt: ${AUDIO_FORMATS.map((f) => f.label).join(', ')} sowie Videodateien`}
          disabled={busy}
          onFiles={(files) => void handleFiles(files)}
        />

        {fileInfo && audio && (
          <div className="mt-2">
            <div className="row-between mb-1">
              <strong className="small">{fileInfo.name}</strong>
              <span className="tiny muted">
                {formatBytes(fileInfo.size)} · {formatDuration(audio.duration)} ·{' '}
                {audio.sampleRate} Hz · {audio.channels.length === 1 ? 'Mono' : 'Stereo'}
              </span>
            </div>
            <Waveform
              samples={audio.samples}
              sampleRate={audio.sampleRate}
              notes={analysis?.notes}
            />
            {analysis && (
              <div className="tiny muted mt-1">
                Die farbigen Balken unter der Wellenform zeigen erkannte Noten. Gruen bedeutet
                hohe, orange mittlere und rot geringe Erkennungssicherheit.
              </div>
            )}
          </div>
        )}
      </Card>

      <Card
        title="2. Analyse-Einstellungen"
        subtitle="Je enger der Tonhoehenbereich, desto weniger Fehlerkennungen."
      >
        <div className="grid grid-3">
          <Field
            label="Tiefster erwarteter Ton"
            hint={pitchToDisplayName(midiToPitch(options.minMidi))}
          >
            <input
              type="range"
              min={24}
              max={72}
              value={options.minMidi}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  minMidi: Math.min(Number(event.target.value), current.maxMidi - 12),
                }))
              }
            />
          </Field>
          <Field
            label="Hoechster erwarteter Ton"
            hint={pitchToDisplayName(midiToPitch(options.maxMidi))}
          >
            <input
              type="range"
              min={48}
              max={108}
              value={options.maxMidi}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  maxMidi: Math.max(Number(event.target.value), current.minMidi + 12),
                }))
              }
            />
          </Field>
          <Field
            label="Mindestsicherheit"
            hint={`${Math.round(options.minConfidence * 100)} % - hoehere Werte verwerfen unsichere Noten`}
          >
            <input
              type="range"
              min={0.2}
              max={0.9}
              step={0.05}
              value={options.minConfidence}
              onChange={(event) =>
                setOptions((current) => ({ ...current, minConfidence: Number(event.target.value) }))
              }
            />
          </Field>
          <Field label="Feinstes Notenraster" hint="Kuerzere Werte erlauben schnellere Passagen.">
            <select
              value={options.quantizeGrid}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  quantizeGrid: event.target.value as DurationValue,
                }))
              }
            >
              <option value="quarter">Viertel</option>
              <option value="eighth">Achtel</option>
              <option value="16th">Sechzehntel</option>
              <option value="32nd">Zweiunddreissigstel</option>
            </select>
          </Field>
          <Field label="Tempo" hint="Leer lassen fuer automatische Erkennung.">
            <input
              type="number"
              min={30}
              max={280}
              placeholder="automatisch"
              value={options.fixedTempo ?? ''}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  fixedTempo: event.target.value ? Number(event.target.value) : undefined,
                }))
              }
            />
          </Field>
          <div className="field" style={{ justifyContent: 'flex-end', gap: 10 }}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={options.polyphonic}
                onChange={(event) =>
                  setOptions((current) => ({ ...current, polyphonic: event.target.checked }))
                }
              />
              Mehrstimmige Analyse
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={options.detectChords}
                onChange={(event) =>
                  setOptions((current) => ({ ...current, detectChords: event.target.checked }))
                }
              />
              Akkorde erkennen
            </label>
          </div>
        </div>

        {options.polyphonic && (
          <Notice kind="warning">
            Die mehrstimmige Analyse ist deutlich rechenintensiver und liefert bei dichtem
            Material noch ungenaue Ergebnisse. Fuer einstimmige Aufnahmen ist die einfache
            Analyse klar besser.
          </Notice>
        )}

        <div className="row mt-2">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => void runAnalysis()}
            disabled={!audio || busy}
          >
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Analyse laeuft' : 'Analyse starten'}
          </button>
          {busy && (
            <button
              className="btn"
              onClick={() => {
                cancelRef.current = true;
                notify('info', 'Die Analyse wird nach dem aktuellen Schritt beendet.');
              }}
            >
              Abbrechen
            </button>
          )}
        </div>

        {progress && (
          <div className="mt-2">
            <ProgressBar value={progress.progress} label={progress.step} />
          </div>
        )}
      </Card>

      {analysis && (
        <Card title="3. Ergebnis der Analyse">
          <div className="grid grid-4 mb-2">
            <Stat label="Noten" value={analysis.notes.length} hint="erkannte Ereignisse" />
            <Stat
              label="Tempo"
              value={`${Math.round(analysis.tempo)} BPM`}
              hint={<ConfidenceBadge value={analysis.tempoConfidence} />}
            />
            <Stat
              label="Taktart"
              value={`${analysis.timeSignature.beats}/${analysis.timeSignature.beatType}`}
              hint={<ConfidenceBadge value={analysis.timeSignatureConfidence} />}
            />
            <Stat
              label="Tonart"
              value={analysis.keyName.split(' ')[0]}
              hint={<ConfidenceBadge value={analysis.keyConfidence} />}
            />
          </div>

          <div className="grid grid-2 mb-2">
            <Stat
              label="Klangquelle"
              value={analysis.instrument.name}
              hint={<ConfidenceBadge value={analysis.instrument.confidence} />}
            />
            <Stat
              label="Akkorde"
              value={analysis.chords.length}
              hint={
                analysis.chords.length > 0
                  ? analysis.chords.slice(0, 6).map((c) => c.symbol).join(' - ')
                  : 'keine erkannt'
              }
            />
          </div>

          {analysis.warnings.length > 0 && (
            <div className="mb-2">
              {analysis.warnings.map((warning, index) => (
                <Notice key={index} kind="warning">
                  {warning}
                </Notice>
              ))}
            </div>
          )}

          {previewScore && (
            <>
              <h4 className="mb-1">Vorschau der Notenschrift</h4>
              <ScoreView score={previewScore} measuresPerLine={4} />
              <div className="row mt-2">
                <button className="btn btn-primary" onClick={openInEditor}>
                  Im Noteneditor oeffnen und korrigieren
                </button>
                <span className="small muted">
                  Farbig markierte Noten wurden mit geringer Sicherheit erkannt.
                </span>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
