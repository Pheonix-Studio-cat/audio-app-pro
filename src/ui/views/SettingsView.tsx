/**
 * Einstellungen, Datenschutzhinweise und technische Auskunft ueber die App.
 */
import { useEffect, useState } from 'react';
import { useApp } from '../app-state';
import { Card, Notice, Stat, formatBytes } from '../components/common';
import { probeFormatSupport } from '../../engines/audio/audio-engine';
import { isFfmpegLoaded } from '../../engines/video/video-engine';
import { MicrophoneAnalyzer } from '../../engines/practice/practice-engine';
import { estimateStorageUsage, isStorageAvailable } from '../../engines/projects/project-store';

/** Verwendete Bibliotheken und ihre Lizenzen. */
const LIBRARIES = [
  { name: 'React', license: 'MIT', purpose: 'Benutzeroberflaeche' },
  { name: 'VexFlow', license: 'MIT', purpose: 'Notensatz und Notendarstellung' },
  { name: 'jsPDF', license: 'MIT', purpose: 'PDF-Erzeugung' },
  { name: 'idb', license: 'ISC', purpose: 'Zugriff auf IndexedDB' },
  { name: 'ffmpeg.wasm', license: 'MIT (Kern: LGPL/GPL)', purpose: 'Video- und Audiokonvertierung' },
  { name: 'Vite', license: 'MIT', purpose: 'Build-Werkzeug' },
];

/** Selbst implementierte Verfahren, damit klar ist, was woher kommt. */
const OWN_ALGORITHMS = [
  ['YIN-Tonhoehenerkennung', 'de Cheveigne und Kawahara, 2002'],
  ['Harmonic Product Spectrum', 'Oktavkorrektur der Tonhoehe'],
  ['Spectral Flux mit adaptiver Schwelle', 'Anschlagserkennung nach Dixon, 2006'],
  ['Autokorrelation der Onset-Huellkurve', 'Tempo- und Phasenschaetzung'],
  ['Krumhansl-Schmuckler-Profile', 'Tonartbestimmung'],
  ['Chroma-Vorlagenvergleich', 'Akkorderkennung'],
  ['Iterative Spektralsubtraktion', 'mehrstimmige Tonhoehenschaetzung'],
  ['Additive Synthese mit ADSR', 'Wiedergabe der Partitur'],
  ['Standard-MIDI-File-Writer', 'MIDI-Export'],
  ['MusicXML-4.0-Serialisierung', 'Austausch mit Notensatzprogrammen'],
];

export function SettingsView() {
  const { theme, toggleTheme, notify } = useApp();
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);

  useEffect(() => {
    void estimateStorageUsage().then(setStorage);
  }, []);

  const audioFormats = probeFormatSupport('audio');
  const videoFormats = probeFormatSupport('video');
  const micSupported = MicrophoneAnalyzer.isSupported();
  const secureContext = typeof window !== 'undefined' && window.isSecureContext;

  return (
    <div className="view">
      <header className="view-header">
        <h1>Einstellungen</h1>
        <p>Darstellung, Datenschutz und technische Auskunft ueber diese Anwendung.</p>
      </header>

      <Card title="Darstellung">
        <div className="row">
          <button className="btn" onClick={toggleTheme}>
            {theme === 'dark' ? 'Zu hellem Design wechseln' : 'Zu dunklem Design wechseln'}
          </button>
          <span className="small muted">
            Das Notenblatt bleibt in beiden Modi hell, weil Notenschrift so am besten lesbar ist.
          </span>
        </div>
      </Card>

      <Card title="Datenschutz">
        <Notice kind="success">
          Diese Anwendung verarbeitet alle Daten ausschliesslich lokal in deinem Browser.
          Es gibt keinen Server, der deine Dateien empfaengt, keine Analysedienste und keine
          Uebertragung an Dritte.
        </Notice>

        <div className="list mt-2">
          {[
            ['Audiodateien', 'Werden im Arbeitsspeicher dekodiert und analysiert. Kein Upload.'],
            ['Videodateien', 'Die Tonspur wird lokal extrahiert, auch der ffmpeg-Kern laeuft im Browser.'],
            ['Mikrofon', 'Wird nur nach ausdruecklicher Freigabe geoeffnet, nichts wird aufgezeichnet oder gespeichert.'],
            ['Projekte', 'Liegen in der IndexedDB dieses Browsers und verlassen dein Geraet nicht.'],
            ['ffmpeg-Kern', 'Wird von dieser Anwendung selbst ausgeliefert, nicht von einem fremden CDN.'],
          ].map(([subject, detail]) => (
            <div key={subject} className="list-row">
              <div className="list-row-main">
                <div className="list-row-title">{subject}</div>
                <div className="small muted">{detail}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Was dein Geraet kann" subtitle="Zur Laufzeit ermittelt, nicht angenommen.">
        <div className="grid grid-4 mb-2">
          <Stat
            label="Mikrofon"
            value={micSupported ? 'verfuegbar' : 'nicht verfuegbar'}
            hint={secureContext ? 'sicherer Kontext' : 'unsicherer Kontext, Zugriff kann scheitern'}
          />
          <Stat
            label="Projektspeicher"
            value={isStorageAvailable() ? 'verfuegbar' : 'nicht verfuegbar'}
            hint={storage ? `${formatBytes(storage.used)} belegt` : undefined}
          />
          <Stat
            label="ffmpeg-Kern"
            value={isFfmpegLoaded() ? 'geladen' : 'nicht geladen'}
            hint="wird erst bei Bedarf geholt"
          />
          <Stat
            label="Kerne"
            value={navigator.hardwareConcurrency ?? '?'}
            hint="fuer die Analysegeschwindigkeit"
          />
        </div>

        <h4 className="mb-1">Audioformate</h4>
        <div className="row mb-2">
          {audioFormats.map((format) => (
            <span
              key={format.extension}
              className={`badge badge-${format.supported ? 'success' : 'warning'}`}
            >
              {format.label} {format.supported ? 'direkt' : 'ueber ffmpeg'}
            </span>
          ))}
        </div>

        <h4 className="mb-1">Videoformate</h4>
        <div className="row">
          {videoFormats.map((format) => (
            <span
              key={format.extension}
              className={`badge badge-${format.supported ? 'success' : 'warning'}`}
            >
              {format.label} {format.supported ? 'direkt' : 'ueber ffmpeg'}
            </span>
          ))}
        </div>
      </Card>

      <Card title="Verwendete Bibliotheken" subtitle="Alle quelloffen, Lizenzen sind angegeben.">
        <div className="list">
          {LIBRARIES.map((library) => (
            <div key={library.name} className="list-row" style={{ padding: '9px 13px' }}>
              <div className="list-row-main">
                <div className="list-row-title">{library.name}</div>
                <div className="small muted">{library.purpose}</div>
              </div>
              <span className="badge">{library.license}</span>
            </div>
          ))}
        </div>
        <p className="small muted mt-2">
          Hinweis zu ffmpeg: Die JavaScript-Schnittstelle steht unter MIT. Der WebAssembly-Kern
          enthaelt FFmpeg-Code unter LGPL beziehungsweise GPL, je nach einkompilierten Codecs.
          Wer diese App weitergibt, sollte diese Lizenzbedingungen beachten.
        </p>
      </Card>

      <Card
        title="Selbst implementierte Verfahren"
        subtitle="Die Signalverarbeitung stammt nicht aus einer fertigen Bibliothek."
      >
        <div className="list">
          {OWN_ALGORITHMS.map(([name, detail]) => (
            <div key={name} className="list-row" style={{ padding: '9px 13px' }}>
              <div className="list-row-main">
                <div className="list-row-title">{name}</div>
                <div className="small muted">{detail}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Bekannte Grenzen" subtitle="Ehrliche Einordnung dessen, was heute funktioniert.">
        <div className="list">
          {[
            [
              'Mehrstimmigkeit',
              'Klare Akkorde werden erkannt. Dichte Orchestersaetze oder ueberlagerte Instrumente ' +
                'liefern noch fehlerhafte Ergebnisse. Die einstimmige Analyse ist deutlich zuverlaessiger.',
            ],
            [
              'Instrumentenerkennung',
              'Regelbasiert ueber spektrale Merkmale, kein trainiertes Modell. Sie unterscheidet ' +
                'Klanggruppen, nicht einzelne Instrumente. Die Sicherheit wird bewusst niedrig angesetzt.',
            ],
            [
              'Taktarterkennung',
              'Funktioniert bei klar betontem Material. Bei freiem Rubato oder ungeraden Taktarten ' +
                'meldet die App eine geringe Sicherheit und nimmt 4/4 an.',
            ],
            [
              'Wiedergabeklang',
              'Additive Synthese statt echter Instrumentensamples. Musikalisch brauchbar, aber ' +
                'kein Ersatz fuer eine Sample-Bibliothek. Dafuer laeuft sie ohne Download und offline.',
            ],
            [
              'Bindebogen im Notenbild',
              'Ueberbindungen zwischen Noten gleicher Tonhoehe werden gezeichnet und exportiert. ' +
                'Bindebogen ueber mehrere verschiedene Noten sind im Modell und im MusicXML-Export ' +
                'enthalten, werden im Editor aber noch nicht gezeichnet.',
            ],
          ].map(([subject, detail]) => (
            <div key={subject} className="list-row">
              <div className="list-row-main">
                <div className="list-row-title">{subject}</div>
                <div className="small muted">{detail}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Daten zuruecksetzen">
        <p className="small muted">
          Loescht alle gespeicherten Projekte aus diesem Browser. Sicherungsdateien, die du
          heruntergeladen hast, bleiben erhalten.
        </p>
        <button
          className="btn btn-danger mt-1"
          onClick={() => {
            if (!window.confirm('Wirklich alle Projekte aus diesem Browser loeschen?')) return;
            indexedDB.deleteDatabase('audio-to-notes');
            notify('info', 'Die lokale Datenbank wurde geloescht. Lade die Seite neu.');
          }}
        >
          Alle Projekte loeschen
        </button>
      </Card>
    </div>
  );
}
