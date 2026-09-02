/**
 * Uebungs-Engine: Echtzeitanalyse des Mikrofonsignals.
 *
 * Datenschutz: Das Mikrofon wird ausschliesslich nach ausdruecklicher
 * Freigabe durch den Nutzer geoeffnet. Das Signal wird nur im Arbeitsspeicher
 * analysiert, nirgends gespeichert und nicht uebertragen. Wird der Zugriff
 * verweigert, bleibt die uebrige App uneingeschraenkt nutzbar.
 */
import { detectPitchYin } from '../analysis/pitch-detection';
import {
  centsBetween,
  frequencyToMidiFloat,
  midiToFrequency,
  midiToPitch,
  pitchToDisplayName,
} from '../../core/music-theory';
import { getAudioContext } from '../audio/audio-engine';

/** Zustand des Mikrofonzugriffs. */
export type MicrophoneStatus =
  | 'unsupported'
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'error';

/** Ein einzelnes Analyseergebnis aus dem Mikrofonsignal. */
export interface LivePitch {
  /** Erkannte Frequenz in Hz, 0 wenn nichts erkannt wurde. */
  frequency: number;
  /** Naechstgelegene MIDI-Nummer, -1 wenn nichts erkannt wurde. */
  midi: number;
  /** Notenname der erkannten Tonhoehe. */
  noteName: string;
  /** Abweichung zum temperierten Ton in Cent. */
  cents: number;
  /** Erkennungssicherheit 0..1. */
  confidence: number;
  /** Eingangspegel 0..1 fuer die Pegelanzeige. */
  level: number;
}

export const SILENT_PITCH: LivePitch = {
  frequency: 0,
  midi: -1,
  noteName: '-',
  cents: 0,
  confidence: 0,
  level: 0,
};

/** Bewertung im Vergleich zur Zielnote. */
export type PitchVerdict = 'correct' | 'too-high' | 'too-low' | 'silent';

export interface PitchFeedback {
  verdict: PitchVerdict;
  /** Abweichung zur Zielnote in Cent. */
  centsOffTarget: number;
  /** Abweichung in Halbtoenen (gerundet). */
  semitonesOff: number;
  live: LivePitch;
}

/**
 * Vergleicht eine erkannte Tonhoehe mit einer Zielnote.
 *
 * @param toleranceCents Ab welcher Abweichung gilt der Ton als richtig.
 */
export function evaluatePitch(
  live: LivePitch,
  targetMidi: number,
  toleranceCents = 35,
): PitchFeedback {
  if (live.midi < 0 || live.frequency <= 0) {
    return { verdict: 'silent', centsOffTarget: 0, semitonesOff: 0, live };
  }

  const targetFrequency = midiToFrequency(targetMidi);
  const cents = centsBetween(live.frequency, targetFrequency);
  const semitones = Math.round(cents / 100);

  let verdict: PitchVerdict;
  if (Math.abs(cents) <= toleranceCents) verdict = 'correct';
  else if (cents > 0) verdict = 'too-high';
  else verdict = 'too-low';

  return { verdict, centsOffTarget: cents, semitonesOff: semitones, live };
}

export interface MicrophoneOptions {
  /** Groesse des Analysefensters; groesser = genauer, aber traeger. */
  frameSize: number;
  /** Mindestpegel, unterhalb dessen als Stille gewertet wird. */
  noiseGate: number;
  minFrequency: number;
  maxFrequency: number;
}

export const DEFAULT_MICROPHONE_OPTIONS: MicrophoneOptions = {
  frameSize: 2048,
  noiseGate: 0.008,
  minFrequency: 70,
  maxFrequency: 1600,
};

/**
 * Verwaltet Mikrofonzugriff und liefert fortlaufend Tonhoehen.
 *
 * Die Analyse laeuft ueber `requestAnimationFrame`, damit sie im Takt der
 * Bildwiederholrate erfolgt und die Anzeige fluessig bleibt.
 */
export class MicrophoneAnalyzer {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private highPass: BiquadFilterNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private animationFrame: number | null = null;
  private options: MicrophoneOptions;
  private status: MicrophoneStatus = 'idle';
  private listener: ((pitch: LivePitch) => void) | null = null;
  /** Geglaettete Frequenz zur Beruhigung der Anzeige. */
  private smoothedFrequency = 0;

  constructor(options: Partial<MicrophoneOptions> = {}) {
    this.options = { ...DEFAULT_MICROPHONE_OPTIONS, ...options };
  }

  /** Ist eine Mikrofonaufnahme in diesem Browser grundsaetzlich moeglich? */
  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof AudioContext !== 'undefined'
    );
  }

  getStatus(): MicrophoneStatus {
    return this.status;
  }

  /**
   * Fragt den Mikrofonzugriff an und startet die Analyse.
   * Der Browser zeigt dabei seine eigene Berechtigungsabfrage.
   */
  async start(onPitch: (pitch: LivePitch) => void): Promise<MicrophoneStatus> {
    if (!MicrophoneAnalyzer.isSupported()) {
      this.status = 'unsupported';
      return this.status;
    }
    if (this.status === 'granted') {
      this.listener = onPitch;
      return this.status;
    }

    this.status = 'requesting';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Signalverarbeitung des Browsers abschalten: sie wuerde die
          // Tonhoehe verfaelschen.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    } catch (error) {
      const name = (error as DOMException).name;
      this.status = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error';
      return this.status;
    }

    this.context = getAudioContext();
    if (this.context.state === 'suspended') await this.context.resume();

    this.source = this.context.createMediaStreamSource(this.stream);

    // Hochpass gegen Trittschall und Netzbrummen.
    this.highPass = this.context.createBiquadFilter();
    this.highPass.type = 'highpass';
    this.highPass.frequency.value = 60;

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = this.options.frameSize;
    // Das Mikrofon darf nicht auf die Lautsprecher zurueckgeleitet werden.
    this.source.connect(this.highPass);
    this.highPass.connect(this.analyser);

    this.buffer = new Float32Array(this.analyser.fftSize);
    this.listener = onPitch;
    this.status = 'granted';
    this.loop();
    return this.status;
  }

  /** Analyseschleife im Takt der Bildwiederholrate. */
  private loop = (): void => {
    if (this.status !== 'granted' || !this.analyser || !this.buffer || !this.context) return;

    this.analyser.getFloatTimeDomainData(this.buffer);

    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
    const level = Math.sqrt(sum / this.buffer.length);

    let result: LivePitch;
    if (level < this.options.noiseGate) {
      this.smoothedFrequency = 0;
      result = { ...SILENT_PITCH, level };
    } else {
      const detection = detectPitchYin(this.buffer, this.context.sampleRate, {
        minFrequency: this.options.minFrequency,
        maxFrequency: this.options.maxFrequency,
        threshold: 0.2,
      });

      if (detection.frequency > 0 && detection.confidence > 0.6) {
        // Exponentielle Glaettung; bei Tonwechsel sofort springen.
        const jump =
          this.smoothedFrequency > 0
            ? Math.abs(centsBetween(detection.frequency, this.smoothedFrequency))
            : Infinity;
        this.smoothedFrequency =
          jump > 90 ? detection.frequency : this.smoothedFrequency * 0.7 + detection.frequency * 0.3;

        const exactMidi = frequencyToMidiFloat(this.smoothedFrequency);
        const midi = Math.round(exactMidi);
        result = {
          frequency: this.smoothedFrequency,
          midi,
          noteName: pitchToDisplayName(midiToPitch(midi)),
          cents: (exactMidi - midi) * 100,
          confidence: detection.confidence,
          level,
        };
      } else {
        result = { ...SILENT_PITCH, level };
      }
    }

    this.listener?.(result);
    this.animationFrame = requestAnimationFrame(this.loop);
  };

  /** Beendet die Analyse und gibt das Mikrofon frei. */
  stop(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.source?.disconnect();
    this.highPass?.disconnect();
    this.analyser?.disconnect();
    // Alle Spuren beenden, damit die Aufnahmeanzeige des Browsers erlischt.
    for (const track of this.stream?.getTracks() ?? []) track.stop();

    this.source = null;
    this.highPass = null;
    this.analyser = null;
    this.stream = null;
    this.buffer = null;
    this.listener = null;
    this.smoothedFrequency = 0;
    if (this.status === 'granted') this.status = 'idle';
  }
}

/** Eine Uebungsaufgabe: eine Note oder eine Folge von Noten. */
export interface PracticeTask {
  id: string;
  /** Zielnoten als MIDI-Nummern in der zu spielenden Reihenfolge. */
  targets: number[];
  label: string;
}

/** Fortschritt innerhalb einer Uebung. */
export interface PracticeProgress {
  /** Index der aktuell geforderten Note. */
  currentIndex: number;
  /** Anzahl beim ersten Versuch getroffener Noten. */
  hits: number;
  /** Anzahl aller Versuche. */
  attempts: number;
  /** Bereits abgeschlossene Noten. */
  completed: number;
  /** Ist die Uebung durchgespielt? */
  finished: boolean;
  /** Trefferquote 0..1. */
  accuracy: number;
  /** Durchschnittliche Abweichung der Treffer in Cent. */
  averageCents: number;
}

export function createProgress(): PracticeProgress {
  return {
    currentIndex: 0,
    hits: 0,
    attempts: 0,
    completed: 0,
    finished: false,
    accuracy: 0,
    averageCents: 0,
  };
}

/**
 * Verfolgt, ob eine Zielnote lange genug sauber gehalten wurde.
 *
 * Ein kurzer Streifschuss soll nicht als Treffer zaehlen; deshalb muss die
 * Note ueber mehrere aufeinanderfolgende Analysen stabil bleiben.
 */
export class PracticeSession {
  private task: PracticeTask;
  private progress: PracticeProgress = createProgress();
  private holdFrames = 0;
  private centsSamples: number[] = [];
  private attemptCounted = false;
  /** Anzahl Analysen, die der Ton gehalten werden muss (ca. 0,3 s). */
  private readonly requiredHoldFrames: number;
  private readonly toleranceCents: number;

  constructor(task: PracticeTask, requiredHoldFrames = 18, toleranceCents = 35) {
    this.task = task;
    this.requiredHoldFrames = requiredHoldFrames;
    this.toleranceCents = toleranceCents;
  }

  getTask(): PracticeTask {
    return this.task;
  }

  getProgress(): PracticeProgress {
    return { ...this.progress };
  }

  /** Aktuell geforderte Zielnote, oder -1 wenn die Uebung fertig ist. */
  getCurrentTarget(): number {
    return this.progress.finished ? -1 : (this.task.targets[this.progress.currentIndex] ?? -1);
  }

  /** Anteil der bereits gehaltenen Zeit an der geforderten Haltezeit (0..1). */
  getHoldRatio(): number {
    return Math.min(1, this.holdFrames / this.requiredHoldFrames);
  }

  /**
   * Verarbeitet ein Analyseergebnis und schaltet bei Erfolg weiter.
   *
   * @returns Rueckmeldung zur aktuellen Zielnote
   */
  update(live: LivePitch): PitchFeedback {
    const target = this.getCurrentTarget();
    if (target < 0) {
      return { verdict: 'silent', centsOffTarget: 0, semitonesOff: 0, live };
    }

    const feedback = evaluatePitch(live, target, this.toleranceCents);

    if (feedback.verdict === 'silent') {
      // Kurze Aussetzer nicht sofort bestrafen.
      this.holdFrames = Math.max(0, this.holdFrames - 1);
      return feedback;
    }

    // Der erste hoerbare Ton je Zielnote zaehlt als Versuch.
    if (!this.attemptCounted) {
      this.progress.attempts++;
      this.attemptCounted = true;
    }

    if (feedback.verdict === 'correct') {
      this.holdFrames++;
      this.centsSamples.push(Math.abs(feedback.centsOffTarget));
      if (this.holdFrames >= this.requiredHoldFrames) this.advance();
    } else {
      this.holdFrames = Math.max(0, this.holdFrames - 2);
    }

    return feedback;
  }

  /** Schaltet zur naechsten Zielnote weiter. */
  private advance(): void {
    this.progress.hits++;
    this.progress.completed++;
    this.holdFrames = 0;
    this.attemptCounted = false;

    if (this.centsSamples.length > 0) {
      const sum = this.centsSamples.reduce((a, b) => a + b, 0);
      this.progress.averageCents = sum / this.centsSamples.length;
    }
    this.progress.accuracy =
      this.progress.attempts > 0 ? this.progress.hits / this.progress.attempts : 0;

    if (this.progress.currentIndex + 1 >= this.task.targets.length) {
      this.progress.finished = true;
    } else {
      this.progress.currentIndex++;
    }
  }

  /** Ueberspringt die aktuelle Note (zaehlt als Fehlversuch). */
  skip(): void {
    if (this.progress.finished) return;
    if (!this.attemptCounted) this.progress.attempts++;
    this.attemptCounted = false;
    this.holdFrames = 0;
    this.progress.completed++;
    this.progress.accuracy =
      this.progress.attempts > 0 ? this.progress.hits / this.progress.attempts : 0;
    if (this.progress.currentIndex + 1 >= this.task.targets.length) {
      this.progress.finished = true;
    } else {
      this.progress.currentIndex++;
    }
  }

  /** Setzt die Uebung zurueck. */
  reset(): void {
    this.progress = createProgress();
    this.holdFrames = 0;
    this.centsSamples = [];
    this.attemptCounted = false;
  }
}
