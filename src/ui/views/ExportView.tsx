/**
 * Exportansicht: Partitur als PDF, PNG, JPG, MusicXML oder MIDI speichern.
 */
import { useCallback, useState } from 'react';
import { useApp } from '../app-state';
import { Card, Field, Notice, Stat } from '../components/common';
import { ScoreView } from '../components/ScoreView';
import {
  DEFAULT_PDF_OPTIONS,
  downloadBlob,
  exportScoreImage,
  exportScorePdf,
  safeFileName,
} from '../../engines/export/score-export';
import { exportMusicXml } from '../../engines/export/musicxml-export';
import { exportMidi } from '../../engines/export/midi-export';
import { measureCount, scoreDurationSeconds } from '../../core/score-model';
import { formatDuration } from '../components/common';

export function ExportView() {
  const { score, notify } = useApp();

  const [busy, setBusy] = useState<string | null>(null);
  const [measuresPerLine, setMeasuresPerLine] = useState(4);
  const [scale, setScale] = useState(2.5);
  const [pageFormat, setPageFormat] = useState<'a4' | 'letter'>('a4');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');

  const baseName = score.title || 'partitur';

  const totalNotes = score.staves.reduce(
    (sum, staff) =>
      sum +
      staff.measures.reduce(
        (measureSum, measure) => measureSum + measure.notes.filter((n) => !n.isRest).length,
        0,
      ),
    0,
  );

  const exportImage = useCallback(
    async (format: 'png' | 'jpg') => {
      setBusy(format);
      try {
        const blob = await exportScoreImage(score, format, {
          scale,
          measuresPerLine,
          width: 1000,
        });
        downloadBlob(blob, safeFileName(baseName, format));
        notify('success', `Partitur als ${format.toUpperCase()} gespeichert.`);
      } catch (error) {
        notify('danger', `Export fehlgeschlagen: ${(error as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [baseName, measuresPerLine, notify, scale, score],
  );

  const exportPdf = useCallback(async () => {
    setBusy('pdf');
    try {
      const blob = await exportScorePdf(score, {
        ...DEFAULT_PDF_OPTIONS,
        scale,
        measuresPerLine,
        pageFormat,
        orientation,
      });
      downloadBlob(blob, safeFileName(baseName, 'pdf'));
      notify('success', 'Partitur als PDF gespeichert. Alle Takte sind enthalten.');
    } catch (error) {
      notify('danger', `PDF-Export fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [baseName, measuresPerLine, notify, orientation, pageFormat, scale, score]);

  const exportXml = useCallback(() => {
    setBusy('musicxml');
    try {
      const xml = exportMusicXml(score);
      downloadBlob(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }),
        safeFileName(baseName, 'musicxml'));
      notify('success', 'MusicXML gespeichert. Die Datei laesst sich in MuseScore oeffnen.');
    } catch (error) {
      notify('danger', `MusicXML-Export fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [baseName, notify, score]);

  const exportMidiFile = useCallback(() => {
    setBusy('midi');
    try {
      downloadBlob(exportMidi(score), safeFileName(baseName, 'mid'));
      notify('success', 'MIDI-Datei gespeichert.');
    } catch (error) {
      notify('danger', `MIDI-Export fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [baseName, notify, score]);

  const formats = [
    {
      id: 'pdf',
      title: 'PDF',
      description: 'Druckfertige Partitur, bei Bedarf ueber mehrere Seiten verteilt.',
      action: () => void exportPdf(),
    },
    {
      id: 'png',
      title: 'PNG',
      description: 'Rasterbild mit transparenzfaehigem Format, ideal fuer Bildschirme.',
      action: () => void exportImage('png'),
    },
    {
      id: 'jpg',
      title: 'JPG',
      description: 'Kompaktes Rasterbild auf weissem Grund.',
      action: () => void exportImage('jpg'),
    },
    {
      id: 'musicxml',
      title: 'MusicXML',
      description: 'Austauschformat fuer MuseScore, Sibelius, Finale und Dorico.',
      action: exportXml,
    },
    {
      id: 'midi',
      title: 'MIDI',
      description: 'Standard-MIDI-Datei mit Tempo, Taktart und allen Stimmen.',
      action: exportMidiFile,
    },
  ];

  return (
    <div className="view">
      <header className="view-header">
        <h1>Exportieren</h1>
        <p>
          Die gesamte Partitur wird exportiert, nicht nur der sichtbare Ausschnitt. Bild- und
          PDF-Export verwenden dieselbe Notenschrift wie der Editor.
        </p>
      </header>

      <div className="grid grid-4 mb-2">
        <Stat label="Titel" value={score.title || 'ohne Titel'} />
        <Stat label="Takte" value={measureCount(score)} />
        <Stat label="Noten" value={totalNotes} />
        <Stat label="Spieldauer" value={formatDuration(scoreDurationSeconds(score))} />
      </div>

      {totalNotes === 0 && (
        <Notice kind="warning">
          Die Partitur enthaelt noch keine Noten. Der Export erzeugt dann ein leeres
          Notenblatt.
        </Notice>
      )}

      <Card title="Darstellung" subtitle="Gilt fuer PDF, PNG und JPG.">
        <div className="grid grid-4">
          <Field label="Takte pro Zeile">
            <select
              value={measuresPerLine}
              onChange={(event) => setMeasuresPerLine(Number(event.target.value))}
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
              <option value={6}>6</option>
            </select>
          </Field>
          <Field label="Aufloesung" hint={`${Math.round(scale * 96)} dpi bei Standardgroesse`}>
            <select value={scale} onChange={(event) => setScale(Number(event.target.value))}>
              <option value={1}>einfach (Bildschirm)</option>
              <option value={2}>doppelt</option>
              <option value={2.5}>2,5-fach (Druck)</option>
              <option value={4}>vierfach (hohe Qualitaet)</option>
            </select>
          </Field>
          <Field label="Seitenformat (nur PDF)">
            <select
              value={pageFormat}
              onChange={(event) => setPageFormat(event.target.value as 'a4' | 'letter')}
            >
              <option value="a4">A4</option>
              <option value="letter">Letter</option>
            </select>
          </Field>
          <Field label="Ausrichtung (nur PDF)">
            <select
              value={orientation}
              onChange={(event) => setOrientation(event.target.value as 'portrait' | 'landscape')}
            >
              <option value="portrait">Hochformat</option>
              <option value="landscape">Querformat</option>
            </select>
          </Field>
        </div>
      </Card>

      <Card title="Format waehlen">
        <div className="grid grid-3">
          {formats.map((format) => (
            <div key={format.id} className="stat" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div className="stat-value" style={{ fontSize: 17 }}>
                  {format.title}
                </div>
                <div className="stat-hint">{format.description}</div>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={format.action}
                disabled={busy !== null}
              >
                {busy === format.id ? <span className="spinner" /> : null}
                {busy === format.id ? 'Wird erzeugt' : 'Speichern'}
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Vorschau" subtitle="So sieht der Export aus.">
        <ScoreView
          score={score}
          measuresPerLine={measuresPerLine}
          highlightUncertain={false}
        />
      </Card>
    </div>
  );
}
