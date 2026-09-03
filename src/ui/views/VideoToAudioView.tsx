/**
 * Ablauf "Video zu Audio": Videodatei waehlen, Tonspur extrahieren,
 * speichern oder direkt zur Notenanalyse weitergeben.
 */
import { useCallback, useState } from 'react';
import { useApp } from '../app-state';
import {
  Card,
  DropZone,
  Field,
  Notice,
  ProgressBar,
  Stat,
  formatBytes,
  formatDuration,
} from '../components/common';
import { Waveform } from '../components/Waveform';
import { VIDEO_FORMATS, type DecodedAudio } from '../../engines/audio/audio-engine';
import {
  captureVideoThumbnail,
  exportAudio,
  extractAudioFromVideo,
  isFfmpegLoaded,
  probeVideo,
  type AudioExportFormat,
  type ExtractionProgress,
  type ExtractionMethod,
} from '../../engines/video/video-engine';
import { downloadBlob, safeFileName } from '../../engines/export/score-export';

/** Klartext zu den drei Extraktionswegen. */
const METHOD_LABELS: Record<ExtractionMethod, string> = {
  browser: 'Browser-Dekodierung (schnell, ohne Zusatzdownload)',
  ffmpeg: 'ffmpeg.wasm (lokal, volle Containerunterstuetzung)',
  realtime: 'Echtzeit-Mitschnitt (dauert so lange wie das Video)',
};

export function VideoToAudioView() {
  const { setAudio, setView, notify } = useApp();

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<Awaited<ReturnType<typeof probeVideo>> | null>(null);
  const [extracted, setExtracted] = useState<DecodedAudio | null>(null);
  const [method, setMethod] = useState<ExtractionMethod | null>(null);
  const [allowFfmpeg, setAllowFfmpeg] = useState(true);
  const [exportFormat, setExportFormat] = useState<AudioExportFormat>('wav');
  const [bitrate, setBitrate] = useState('192k');

  /** Video auswaehlen und Metadaten lesen. */
  const handleFiles = useCallback(
    async (files: File[]) => {
      const selected = files[0];
      if (!selected) return;

      setFile(selected);
      setExtracted(null);
      setMethod(null);
      setThumbnail(null);

      const [info, preview] = await Promise.all([
        probeVideo(selected),
        captureVideoThumbnail(selected),
      ]);
      setVideoInfo(info);
      setThumbnail(preview);

      if (!info.playable) {
        notify(
          'warning',
          'Der Browser kann dieses Video nicht direkt abspielen. Die Extraktion laeuft dann ' +
            'ueber ffmpeg.',
        );
      }
    },
    [notify],
  );

  /** Tonspur extrahieren. */
  const extract = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setProgress({ progress: 0, step: 'Start', method: null });

    try {
      const result = await extractAudioFromVideo(file, setProgress, allowFfmpeg);
      setExtracted(result.audio);
      setMethod(result.method);
      for (const note of result.notes) notify('info', note);
      notify(
        'success',
        `Tonspur extrahiert: ${formatDuration(result.audio.duration)}, ` +
          `${result.audio.sampleRate} Hz.`,
      );
    } catch (error) {
      notify('danger', `Die Extraktion ist fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [allowFfmpeg, file, notify]);

  /** Extrahiertes Audio als Datei speichern. */
  const saveAudio = useCallback(async () => {
    if (!extracted || !file) return;
    setBusy(true);
    try {
      const blob = await exportAudio(extracted, { format: exportFormat, bitrate }, (value, step) =>
        setProgress({ progress: value, step, method: 'ffmpeg' }),
      );
      const baseName = file.name.replace(/\.[^.]+$/, '');
      downloadBlob(blob, safeFileName(baseName, exportFormat));
      notify('success', `Audiodatei als ${exportFormat.toUpperCase()} gespeichert.`);
    } catch (error) {
      notify('danger', `Speichern fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [bitrate, exportFormat, extracted, file, notify]);

  /** Weiter zur Notenanalyse. */
  const continueToNotes = useCallback(() => {
    if (!extracted) return;
    setAudio(extracted, null);
    setView('audio-to-notes');
    notify('info', 'Die extrahierte Tonspur steht jetzt fuer die Notenanalyse bereit.');
  }, [extracted, notify, setAudio, setView]);

  const acceptedTypes = VIDEO_FORMATS.map((f) => `.${f.extension}`).join(',');

  return (
    <div className="view">
      <header className="view-header">
        <h1>Video zu Audio</h1>
        <p>
          Extrahiere die Tonspur aus einer Videodatei. Du kannst sie anschliessend als
          Audiodatei speichern oder direkt in Noten umwandeln lassen.
        </p>
      </header>

      <Card title="1. Videodatei waehlen">
        <DropZone
          accept={`${acceptedTypes},video/*`}
          icon="▶"
          title="Videodatei hier ablegen oder klicken"
          hint={`Unterstuetzt: ${VIDEO_FORMATS.map((f) => f.label).join(', ')}`}
          disabled={busy}
          onFiles={(files) => void handleFiles(files)}
        />

        {file && videoInfo && (
          <div className="row mt-2" style={{ alignItems: 'flex-start', gap: 16 }}>
            {thumbnail && (
              <img
                src={thumbnail}
                alt="Vorschaubild des Videos"
                style={{
                  width: 180,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                }}
              />
            )}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="list-row-title">{file.name}</div>
              <div className="list-row-meta mt-1">
                <span>{formatBytes(file.size)}</span>
                {videoInfo.duration > 0 && <span>{formatDuration(videoInfo.duration)}</span>}
                {videoInfo.width > 0 && (
                  <span>
                    {videoInfo.width} x {videoInfo.height}
                  </span>
                )}
                <span>{videoInfo.playable ? 'vom Browser abspielbar' : 'nur ueber ffmpeg'}</span>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card
        title="2. Tonspur extrahieren"
        subtitle="Alle drei Wege arbeiten lokal. Es wird nichts hochgeladen."
      >
        <label className="checkbox mb-2">
          <input
            type="checkbox"
            checked={allowFfmpeg}
            onChange={(event) => setAllowFfmpeg(event.target.checked)}
          />
          ffmpeg verwenden, wenn der Browser die Datei nicht direkt lesen kann
        </label>

        {allowFfmpeg && !isFfmpegLoaded() && (
          <Notice kind="info">
            ffmpeg wird nur bei Bedarf geladen. Der Kern ist rund 32 MB gross und wird von
            dieser Anwendung selbst ausgeliefert, nicht von einem fremden Server. Danach
            bleibt er fuer die Sitzung im Speicher.
          </Notice>
        )}
        {!allowFfmpeg && (
          <Notice kind="warning">
            Ohne ffmpeg bleibt als Rueckfallebene nur der Echtzeit-Mitschnitt. Er dauert
            genauso lange wie das Video selbst.
          </Notice>
        )}

        <div className="row mt-2">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => void extract()}
            disabled={!file || busy}
          >
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Extraktion laeuft' : 'Tonspur extrahieren'}
          </button>
        </div>

        {progress && (
          <div className="mt-2">
            <ProgressBar
              value={progress.progress < 0 ? 0 : progress.progress}
              label={
                progress.method
                  ? `${progress.step} - ${METHOD_LABELS[progress.method]}`
                  : progress.step
              }
            />
          </div>
        )}
      </Card>

      {extracted && (
        <Card title="3. Ergebnis">
          <div className="grid grid-4 mb-2">
            <Stat label="Dauer" value={formatDuration(extracted.duration)} />
            <Stat label="Abtastrate" value={`${extracted.sampleRate} Hz`} />
            <Stat
              label="Kanaele"
              value={extracted.channels.length === 1 ? 'Mono' : `${extracted.channels.length}`}
            />
            <Stat
              label="Weg"
              value={method === 'browser' ? 'Browser' : method === 'ffmpeg' ? 'ffmpeg' : 'Echtzeit'}
              hint={method ? METHOD_LABELS[method] : undefined}
            />
          </div>

          <Waveform samples={extracted.samples} sampleRate={extracted.sampleRate} />

          <div className="field-row mt-2">
            <Field label="Zielformat">
              <select
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value as AudioExportFormat)}
                style={{ width: 150 }}
              >
                <option value="wav">WAV (verlustfrei)</option>
                <option value="mp3">MP3</option>
                <option value="ogg">OGG Vorbis</option>
                <option value="flac">FLAC (verlustfrei)</option>
                <option value="m4a">M4A (AAC)</option>
              </select>
            </Field>
            {exportFormat !== 'wav' && exportFormat !== 'flac' && (
              <Field label="Bitrate">
                <select
                  value={bitrate}
                  onChange={(event) => setBitrate(event.target.value)}
                  style={{ width: 110 }}
                >
                  <option value="128k">128 kbit/s</option>
                  <option value="192k">192 kbit/s</option>
                  <option value="256k">256 kbit/s</option>
                  <option value="320k">320 kbit/s</option>
                </select>
              </Field>
            )}
            <button className="btn" onClick={() => void saveAudio()} disabled={busy}>
              Audiodatei speichern
            </button>
            <button className="btn btn-primary" onClick={continueToNotes} disabled={busy}>
              Weiter zu Noten
            </button>
          </div>

          {exportFormat !== 'wav' && (
            <div className="tiny muted mt-1">
              Formate ausser WAV werden mit ffmpeg umgewandelt; der Kern wird dafuer geladen,
              falls das noch nicht geschehen ist.
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
