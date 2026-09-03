# Audio-to-Notes Studio

Wandelt Audio- und Videoaufnahmen in echte Notenschrift um, bietet einen
vollstaendigen Noteneditor, exportiert nach PDF, PNG, JPG, MusicXML und MIDI
und laesst dich Noten mit dem Mikrofon ueben.

**Alles laeuft lokal im Browser.** Es gibt keinen Server, der deine Dateien
empfaengt, keinen Analysedienst und keine Verbindung zu einem CDN.

**Online ausprobieren:**
https://pheonix-studio-cat.github.io/audio-app-pro/

---

## Schnellstart

```bash
npm install
npm run dev          # Entwicklungsserver auf http://localhost:5173
```

Weitere Befehle:

```bash
npm run build        # Produktionsbuild nach dist/
npm run preview      # gebauten Stand lokal ausliefern
npm test             # 39 Unit-Tests (Signalverarbeitung, Export)
npm run test:e2e     # 25 Browser-Tests im echten Chromium
npm run typecheck    # TypeScript pruefen
```

Der Build kopiert vorher zwei Dinge aus `node_modules` nach `public/`:
den ffmpeg.wasm-Kern und die Notenschriftarten. Beide werden dadurch von
der eigenen Herkunft ausgeliefert statt von einem fremden Server.

### Veroeffentlichung

Ein Push auf `main` baut die App und veroeffentlicht sie ueber
`.github/workflows/deploy-pages.yml` auf GitHub Pages. Getestet wird
vorher: Typpruefung und Unit-Tests laufen im selben Job, ein defekter
Stand geht nicht online.

Damit das greift, muss im Repository einmalig
**Settings -> Pages -> Build and deployment -> Source** auf
**GitHub Actions** stehen.

Auf Pages liegt die App in einem Unterverzeichnis. Der Workflow setzt
deshalb `VITE_BASE` auf den Repository-Namen; Schriften und ffmpeg-Kern
werden ueber `import.meta.env.BASE_URL` entsprechend aufgeloest. Lokal
bleibt der Basis-Pfad `/`.

Da GitHub Pages keine eigenen HTTP-Kopfzeilen erlaubt, steht dort kein
`SharedArrayBuffer` zur Verfuegung. Die App nutzt deshalb den
einkernigen ffmpeg-Build, der ohne diese Voraussetzung auskommt.

---

## Was die App kann

### 1. Audio zu Noten

Import von MP3, WAV, M4A, FLAC, AAC und OGG. Die Analyse liefert:

| Merkmal | Verfahren |
| --- | --- |
| Tonhoehe | YIN mit kumulativer Mittelwertnormierung, Oktavkorrektur ueber das Harmonic Product Spectrum |
| Anschlaege | Spectral Flux mit adaptiver Median-Schwelle |
| Tempo | Autokorrelation der Onset-Huellkurve, danach Feinabgleich am Notenraster |
| Taktart | Vergleich der Betonungsmuster fuer 4/4, 3/4, 2/4 und 6/8 |
| Tonart | Krumhansl-Schmuckler-Profile auf dem Chroma-Vektor |
| Akkorde | Vorlagenvergleich ueber neun Akkordtypen |
| Mehrstimmigkeit | iterative Spektralsubtraktion nach Klapuri |
| Klangquelle | regelbasiert ueber spektralen Schwerpunkt, Attack-Zeit und Harmonizitaet |

Das Ergebnis wird quantisiert und als richtige Notenschrift dargestellt,
nicht als Frequenzliste. Jede erkannte Note traegt einen Sicherheitswert.
Unsichere Noten sind im Editor farbig markiert (orange ab 70 Prozent,
rot unter 45 Prozent) und lassen sich einzeln korrigieren und bestaetigen.

### 2. Video zu Audio

Import von MP4, MOV, MKV, AVI und WEBM. Die Tonspur wird ueber drei Wege
extrahiert, in dieser Reihenfolge:

1. **Browser-Dekodierung** — schnell, ohne Zusatzdownload
2. **ffmpeg.wasm** — volle Containerunterstuetzung, Kern wird bei Bedarf
   lokal nachgeladen (einmalig rund 32 MB)
3. **Echtzeit-Mitschnitt** — letzte Rueckfallebene, dauert so lange wie das Video

Die Tonspur laesst sich als WAV, MP3, OGG, FLAC oder M4A speichern oder
direkt zur Notenanalyse weiterreichen.

### 3. Noteneditor

- Noten setzen, loeschen, verschieben, Tonhoehe per Ziehen aendern
- Notenwerte von der Ganzen bis zur 32stel, bis zu zwei Punktierungen
- Pausen, Vorzeichen bis Doppelkreuz und Doppel-B
- Violin-, Bass-, Alt- und Tenorschluessel
- Taktart, Tonart und Tempo, auch mit Wechseln mitten im Stueck
- mehrere Takte und mehrere Systeme
- Akkorde ueber die eingebaute Klaviatur
- Artikulation, Dynamik, Ueberbindungen, Akkordsymbole
- Kopieren und Einfuegen, Rueckgaengig und Wiederholen (100 Schritte)

### 4. Export

PDF (mehrseitig), PNG, JPG, MusicXML 4.0 und Standard-MIDI-File Format 1.
Es wird immer die komplette Partitur exportiert. Die Bildformate nutzen
dieselbe Notenschrift wie der Editor; die Schriftart wird dafuer in das
SVG eingebettet.

### 5. Uebungsmodus

Zielnote anzeigen, Mikrofonsignal in Echtzeit analysieren, Rueckmeldung
geben: richtig, zu hoch oder zu tief. Dazu Cent-Anzeige, Pegelanzeige,
Trefferquote und Fortschritt. Drei Modi: freies Stimmen, Tonleiter und
die eigene Partitur.

Ohne Mikrofon oder bei verweigertem Zugriff bleibt die App voll nutzbar;
nur der Uebungsteil wird deaktiviert und der Grund genannt.

### 6. Projekte

Projekte enthalten Partitur, Analyseergebnis, Originalton und
Uebungsfortschritt. Sie liegen in der IndexedDB des Browsers und lassen
sich umbenennen, oeffnen, loeschen sowie als JSON sichern und einlesen.

---

## Architektur

Web-App auf Basis von React 19, TypeScript und Vite. Der Browser wurde als
Zielplattform gewaehlt, weil er alles mitbringt, was gebraucht wird —
Web Audio API, WebAssembly, Canvas, IndexedDB, `getUserMedia` — und weil
lokale Verarbeitung damit ohne Installation moeglich ist.

```
src/
  core/                     Datenmodell und Musiktheorie
    types.ts                Partitur, Noten, Analyseergebnisse
    music-theory.ts         Frequenz/MIDI/Notenname, Tonarten, Notenwerte
    score-model.ts          reine Bearbeitungsoperationen auf der Partitur

  engines/
    audio/                  Dekodierung, Resampling, WAV-Encoder
    video/                  Audiospur-Extraktion, Audio-Export
    analysis/               dsp, pitch-detection, onset-tempo, harmony,
                            note-segmentation, quantization,
                            instrument-classifier, analysis-engine
    notation/               VexFlow-Renderer, Editor-Befehle, Schriftladung
    playback/               Synthesizer und Scheduler
    practice/               Mikrofonanalyse und Uebungssitzung
    export/                 MusicXML, MIDI, PNG/JPG/PDF
    projects/               IndexedDB-Projektspeicher

  ui/
    app-state.tsx           globaler Zustand
    App.tsx                 Rahmen und Navigation
    components/             Notenanzeige, Wellenform, Klaviatur, Steuerung
    views/                  die acht Hauptansichten
```

Die Engines kennen React nicht und sind einzeln testbar. Die
Partiturbearbeitung besteht aus reinen Funktionen, wodurch Undo und Redo
ohne Sonderbehandlung funktionieren.

---

## Bibliotheken und Lizenzen

| Bibliothek | Lizenz | Zweck |
| --- | --- | --- |
| React | MIT | Benutzeroberflaeche |
| VexFlow | MIT | Notensatz |
| Bravura, Academico | SIL OFL 1.1 | Notenschriftarten |
| jsPDF | MIT | PDF-Erzeugung |
| idb | ISC | IndexedDB-Zugriff |
| ffmpeg.wasm | MIT (Kern: LGPL/GPL) | Video- und Audiokonvertierung |
| Vite, TypeScript, Vitest, Playwright | MIT / Apache-2.0 | Entwicklung |

Die gesamte Signalverarbeitung ist selbst implementiert, ohne DSP-Bibliothek:
FFT, YIN, Harmonic Product Spectrum, Spectral Flux, Autokorrelation,
Chroma-Analyse, Quantisierung, Synthese, MIDI-Writer und MusicXML-Serializer.

**Hinweis zu ffmpeg:** Die JavaScript-Schnittstelle steht unter MIT, der
WebAssembly-Kern enthaelt FFmpeg-Code unter LGPL beziehungsweise GPL, je
nach einkompilierten Codecs. Bei Weitergabe der App sind diese Bedingungen
zu beachten.

---

## Datenschutz

- Audio- und Videodateien werden nur im Arbeitsspeicher verarbeitet.
- Das Mikrofon wird ausschliesslich nach ausdruecklicher Freigabe geoeffnet
  und nichts davon wird gespeichert oder uebertragen.
- Projekte liegen in der lokalen Datenbank des Browsers.
- ffmpeg-Kern und Notenschriften werden von der eigenen Herkunft
  ausgeliefert, nicht von einem CDN.

Der Ende-zu-Ende-Test prueft ausdruecklich, dass die App im Betrieb
**keine einzige Anfrage an einen fremden Server** stellt.

---

## Bekannte Grenzen

Ehrliche Einordnung dessen, was heute funktioniert:

- **Mehrstimmigkeit.** Klare Akkorde werden erkannt, dichte Orchestersaetze
  noch nicht zuverlaessig. Die einstimmige Analyse ist deutlich besser.
- **Instrumentenerkennung.** Regelbasiert, kein trainiertes Modell. Sie
  unterscheidet Klanggruppen, nicht einzelne Instrumente, und meldet
  entsprechend niedrige Sicherheiten.
- **Taktarterkennung.** Zuverlaessig bei klar betontem Material, sonst wird
  4/4 angenommen und die geringe Sicherheit angezeigt.
- **Wiedergabeklang.** Additive Synthese statt Instrumentensamples.
  Musikalisch brauchbar, aber kein Ersatz fuer eine Sample-Bibliothek.
  Dafuer ohne Download und offline.
- **Bindebogen.** Ueberbindungen werden gezeichnet und exportiert.
  Bindebogen ueber verschiedene Tonhoehen sind im Modell und im
  MusicXML-Export enthalten, im Editor aber noch nicht gezeichnet.

Diese Punkte stehen auch in der App selbst unter Einstellungen.

---

## Tests

- **60 Unit-Tests** (`npm test`): Tonhoehenerkennung gegen synthetische
  Signale mit bekannter Frequenz, Tempo- und Onset-Erkennung, Quantisierung,
  Akkord- und Tonarterkennung, die Byte- und XML-Struktur der Exporte sowie
  die vollstaendige Uebungslogik.
  Darunter fuenf Tests der **gesamten Kette**: aus synthetischem Audio mit
  bekannter Melodie muss am Ende die richtige Notenschrift entstehen -
  richtige Tonhoehen, richtige Notenwerte, keine erfundenen Akkorde,
  geprueft bei 90, 120 und 150 BPM sowie bei gemischten Notenwerten.
- **36 Browser-Tests** (`npm run test:e2e`): Notensatz, Mausbedienung,
  Wiedergabe, alle fuenf Exportformate, Projektspeicher, der komplette Weg
  von der Audiodatei bis zur Partitur, die Extraktion der Tonspur aus einem
  echten Video und die Zusicherung, dass keine externen Verbindungen
  entstehen. Der Bildexport wird pixelweise geprueft, damit fehlende
  Notenzeichen nicht unbemerkt bleiben.

Die Testdateien erzeugen sich selbst:

```bash
node e2e/make-fixture.mjs        # Audio mit bekannter Melodie
node e2e/make-video-fixture.mjs  # Video mit derselben Tonspur
```

**Zum Mikrofon:** Der eigentliche Geraetezugriff laesst sich nur mit
echter Hardware pruefen. Fehlt ein Audio-Eingang, ueberspringt der
Browsertest diesen Punkt ausdruecklich und prueft stattdessen, dass die
App den Ausfall verstaendlich meldet und bedienbar bleibt. Die Auswertung
dahinter - Tonhoehe erkennen, mit der Zielnote vergleichen, Haltezeit
verlangen, Trefferquote fuehren - deckt `src/__tests__/practice.test.ts`
mit zwoelf Tests vollstaendig ab.

## Lizenz

MIT, siehe `LICENSE`.
