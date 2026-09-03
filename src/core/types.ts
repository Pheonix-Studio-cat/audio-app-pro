/**
 * Zentrale Datentypen der Anwendung.
 *
 * Das Partitur-Modell ist bewusst renderer-unabhaengig gehalten: VexFlow,
 * MusicXML- und MIDI-Export lesen alle aus denselben Strukturen.
 */

/** Notenlaengen als Bruchteil einer ganzen Note. */
export type DurationValue =
  | 'whole'
  | 'half'
  | 'quarter'
  | 'eighth'
  | '16th'
  | '32nd';

/** Basis-Notenwerte in Vierteln (quarter length). */
export const DURATION_QUARTERS: Record<DurationValue, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
};

/** Notenschluessel. */
export type ClefType = 'treble' | 'bass' | 'alto' | 'tenor';

/** Vorzeichen an einer einzelnen Note. */
export type AccidentalType = 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'double-flat';

export const ACCIDENTAL_ALTER: Record<AccidentalType, number> = {
  'double-flat': -2,
  flat: -1,
  natural: 0,
  sharp: 1,
  'double-sharp': 2,
};

/** Dynamikzeichen. */
export type DynamicMark = 'ppp' | 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'fff';

/** Artikulationszeichen. */
export type ArticulationMark = 'staccato' | 'accent' | 'tenuto' | 'marcato' | 'fermata';

/**
 * Eine einzelne Tonhoehe innerhalb eines Notenkopfes bzw. Akkords.
 * `step` ist der Stammton (C..B), `octave` die wissenschaftliche Oktave
 * (C4 = mittleres C, MIDI 60).
 */
export interface Pitch {
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
  octave: number;
  /** Chromatische Alteration in Halbtoenen (-2..+2). */
  alter: number;
  /**
   * Explizit gesetztes Vorzeichen. Ist es `undefined`, entscheidet der
   * Renderer anhand der Tonart, ob ein Vorzeichen noetig ist.
   */
  accidental?: AccidentalType;
}

/** Ein Notenereignis: Note, Akkord oder Pause. */
export interface ScoreNote {
  id: string;
  /** Leeres Array bedeutet Pause. */
  pitches: Pitch[];
  duration: DurationValue;
  /** Anzahl Punktierungen (0..2). */
  dots: number;
  isRest: boolean;
  /** Ueberbindung zur naechsten Note gleicher Tonhoehe. */
  tieStart?: boolean;
  tieStop?: boolean;
  /** Bindebogen (Legato) ueber mehrere Noten. */
  slurStart?: boolean;
  slurStop?: boolean;
  articulations?: ArticulationMark[];
  dynamic?: DynamicMark;
  /** Akkordsymbol ueber dem System, z.B. "Cmaj7". */
  chordSymbol?: string;
  /**
   * Erkennungssicherheit 0..1 bei automatisch analysierten Noten.
   * `undefined` = manuell gesetzt, also sicher.
   */
  confidence?: number;
  /** Kennzeichnet automatisch erkannte, noch nicht bestaetigte Noten. */
  autoDetected?: boolean;
}

/** Ein Takt innerhalb eines Systems. */
export interface Measure {
  id: string;
  notes: ScoreNote[];
  /** Nur gesetzt, wenn sich die Angabe in diesem Takt aendert. */
  timeSignature?: TimeSignature;
  keySignature?: number;
  clef?: ClefType;
  /** Tempoangabe (Viertel pro Minute), nur bei Aenderung gesetzt. */
  tempo?: number;
  /** Taktstrich am Ende des Taktes. */
  barline?: 'single' | 'double' | 'end' | 'repeat-end';
}

export interface TimeSignature {
  beats: number;
  beatType: number;
}

/** Ein Notensystem (eine Stimme/ein Instrument) ueber die gesamte Partitur. */
export interface Staff {
  id: string;
  name: string;
  clef: ClefType;
  /** General-MIDI-Programmnummer (0-127) fuer Wiedergabe und MIDI-Export. */
  midiProgram: number;
  measures: Measure[];
  muted: boolean;
  volume: number;
}

/** Die vollstaendige Partitur. */
export interface Score {
  id: string;
  title: string;
  composer: string;
  /** Vorzeichen der Tonart: negativ = b, positiv = Kreuze. */
  keySignature: number;
  timeSignature: TimeSignature;
  /** Grundtempo in Viertel pro Minute. */
  tempo: number;
  staves: Staff[];
}

/** Position eines Notenereignisses innerhalb der Partitur. */
export interface ScorePosition {
  staffIndex: number;
  measureIndex: number;
  noteIndex: number;
}

/** Ergebnis der Audioanalyse, bevor es in Notation umgesetzt wird. */
export interface DetectedNote {
  /** Startzeit in Sekunden. */
  start: number;
  /** Dauer in Sekunden. */
  duration: number;
  /** MIDI-Notennummer (gerundet). */
  midi: number;
  /** Exakte Frequenz in Hz (Mittelwert ueber das Ereignis). */
  frequency: number;
  /** Abweichung vom temperierten Ton in Cent. */
  cents: number;
  /** Erkennungssicherheit 0..1. */
  confidence: number;
  /** Lautstaerke (RMS) des Ereignisses. */
  velocity: number;
}

/** Erkannter Akkord ueber ein Zeitfenster. */
export interface DetectedChord {
  start: number;
  duration: number;
  /** Anzeigename, z.B. "Am7". */
  symbol: string;
  root: number;
  quality: string;
  confidence: number;
}

/** Gesamtergebnis der Analyse einer Audiodatei. */
export interface AnalysisResult {
  notes: DetectedNote[];
  chords: DetectedChord[];
  tempo: number;
  /**
   * Zeitlicher Versatz der ersten Zaehlzeit in Sekunden. Wird beim
   * Quantisieren abgezogen, damit das Notenraster zu den Anschlaegen passt.
   */
  beatOffset: number;
  tempoConfidence: number;
  timeSignature: TimeSignature;
  timeSignatureConfidence: number;
  keySignature: number;
  keyName: string;
  keyConfidence: number;
  /** Geschaetzte Klangquelle mit Sicherheit. */
  instrument: { name: string; confidence: number };
  duration: number;
  sampleRate: number;
  /** Warnungen und Hinweise fuer den Nutzer. */
  warnings: string[];
}

/** Analyse-Einstellungen, die der Nutzer beeinflussen kann. */
export interface AnalysisOptions {
  /** Erwarteter Tonhoehenbereich in MIDI-Nummern. */
  minMidi: number;
  maxMidi: number;
  /** Mindest-Erkennungssicherheit, unterhalb wird verworfen. */
  minConfidence: number;
  /** Kleinste zu quantisierende Notenlaenge. */
  quantizeGrid: DurationValue;
  /** Feste BPM statt automatischer Schaetzung. */
  fixedTempo?: number;
  /** Mehrstimmige Analyse aktivieren. */
  polyphonic: boolean;
  /** Akkorderkennung aktivieren. */
  detectChords: boolean;
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  minMidi: 36,
  maxMidi: 96,
  minConfidence: 0.5,
  quantizeGrid: '16th',
  polyphonic: false,
  detectChords: true,
};
