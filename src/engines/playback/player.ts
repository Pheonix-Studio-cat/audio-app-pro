/**
 * Wiedergabe-Engine: spielt eine Partitur mit dem eingebauten Synthesizer.
 *
 * Der Scheduler arbeitet nach dem "lookahead"-Muster: ein Timer prueft
 * regelmaessig, welche Noten in den naechsten Sekunden faellig sind, und
 * plant sie exakt auf der Audio-Uhr ein. Das ergibt ein stabiles Timing,
 * unabhaengig von der Auslastung des Hauptthreads.
 */
import type { Score, ScorePosition } from '../../core/types';
import {
  durationInQuarters,
  measureCapacity,
  midiToFrequency,
  pitchToMidi,
} from '../../core/music-theory';
import { effectiveTempo, effectiveTimeSignature } from '../../core/score-model';
import { getAudioContext, resumeAudioContext } from '../audio/audio-engine';
import { playClick, playNote, voiceForProgram, type ActiveVoice } from './synth';

/** Ein zeitlich aufgeloestes Wiedergabeereignis. */
export interface PlaybackEvent {
  /** Startzeit in Sekunden ab Stueckbeginn. */
  time: number;
  /** Klingende Dauer in Sekunden. */
  duration: number;
  midis: number[];
  velocity: number;
  staffIndex: number;
  position: ScorePosition;
}

/** Metronom-Klick zu einem Zeitpunkt. */
export interface ClickEvent {
  time: number;
  accented: boolean;
}

/**
 * Rechnet eine Partitur in eine flache Ereignisliste um.
 * Ueberbundene Noten werden zu einem einzigen langen Ereignis verschmolzen.
 */
export function buildPlaybackEvents(score: Score): {
  events: PlaybackEvent[];
  clicks: ClickEvent[];
  duration: number;
} {
  const events: PlaybackEvent[] = [];
  const clicks: ClickEvent[] = [];
  const measureCount = Math.max(...score.staves.map((s) => s.measures.length), 0);

  // Startzeit jedes Taktes vorab bestimmen (Tempo kann sich aendern).
  const measureStartTimes: number[] = [];
  let cursor = 0;
  for (let m = 0; m < measureCount; m++) {
    measureStartTimes.push(cursor);
    const timeSignature = effectiveTimeSignature(score, 0, m);
    const tempo = effectiveTempo(score, m);
    const secondsPerQuarter = 60 / tempo;
    const beats = measureCapacity(timeSignature);
    cursor += beats * secondsPerQuarter;

    // Metronom-Klicks je Zaehlzeit.
    const beatLengthQuarters = 4 / timeSignature.beatType;
    for (let beat = 0; beat < timeSignature.beats; beat++) {
      clicks.push({
        time: measureStartTimes[m] + beat * beatLengthQuarters * secondsPerQuarter,
        accented: beat === 0,
      });
    }
  }
  const totalDuration = cursor;

  for (let staffIndex = 0; staffIndex < score.staves.length; staffIndex++) {
    const staff = score.staves[staffIndex];

    // Offene Ueberbindungen je Tonhoehe merken.
    const openTies = new Map<number, PlaybackEvent>();

    for (let m = 0; m < staff.measures.length; m++) {
      const measure = staff.measures[m];
      const tempo = effectiveTempo(score, m);
      const secondsPerQuarter = 60 / tempo;
      let offsetQuarters = 0;

      for (let noteIndex = 0; noteIndex < measure.notes.length; noteIndex++) {
        const note = measure.notes[noteIndex];
        const lengthQuarters = durationInQuarters(note.duration, note.dots);
        const startTime = measureStartTimes[m] + offsetQuarters * secondsPerQuarter;
        const durationSeconds = lengthQuarters * secondsPerQuarter;
        offsetQuarters += lengthQuarters;

        if (note.isRest || note.pitches.length === 0) continue;

        const midis = note.pitches.map(pitchToMidi);

        // Fortsetzung einer Ueberbindung: bestehendes Ereignis verlaengern.
        if (note.tieStop && midis.length === 1) {
          const open = openTies.get(midis[0]);
          if (open) {
            open.duration = startTime + durationSeconds - open.time;
            if (!note.tieStart) openTies.delete(midis[0]);
            continue;
          }
        }

        const event: PlaybackEvent = {
          time: startTime,
          duration: durationSeconds,
          midis,
          velocity: velocityForDynamic(note.dynamic) * articulationFactor(note),
          staffIndex,
          position: { staffIndex, measureIndex: m, noteIndex },
        };
        events.push(event);

        if (note.tieStart && midis.length === 1) openTies.set(midis[0], event);
      }
    }
  }

  events.sort((a, b) => a.time - b.time);
  return { events, clicks, duration: totalDuration };
}

/** Anschlagstaerke aus dem Dynamikzeichen. */
function velocityForDynamic(dynamic: string | undefined): number {
  const map: Record<string, number> = {
    ppp: 0.15, pp: 0.25, p: 0.4, mp: 0.55, mf: 0.68, f: 0.82, ff: 0.92, fff: 1,
  };
  return dynamic ? (map[dynamic] ?? 0.7) : 0.7;
}

/** Staccato verkuerzt, Akzent verstaerkt. */
function articulationFactor(note: { articulations?: string[] }): number {
  if (!note.articulations) return 1;
  let factor = 1;
  if (note.articulations.includes('accent')) factor *= 1.25;
  if (note.articulations.includes('marcato')) factor *= 1.35;
  return Math.min(1, factor);
}

export interface PlayerState {
  isPlaying: boolean;
  isPaused: boolean;
  /** Aktuelle Position in Sekunden. */
  currentTime: number;
  duration: number;
  currentPosition: ScorePosition | null;
}

export interface PlayerOptions {
  /** Wiedergabegeschwindigkeit, 1 = Originaltempo. */
  playbackRate: number;
  metronome: boolean;
  /** Gesamtlautstaerke 0..1. */
  volume: number;
  /** Nur diesen Takt und die folgenden spielen. */
  startMeasure: number;
}

/**
 * Steuert die Wiedergabe einer Partitur.
 * Eine Instanz kann mehrfach gestartet und gestoppt werden.
 */
export class ScorePlayer {
  private context: AudioContext;
  private masterGain: GainNode;
  private staffGains = new Map<number, GainNode>();
  private events: PlaybackEvent[] = [];
  private clicks: ClickEvent[] = [];
  private activeVoices: ActiveVoice[] = [];
  private schedulerTimer: number | null = null;

  /** Kontextzeit, die dem Stueckbeginn entspricht. */
  private startContextTime = 0;
  /** Position, an der zuletzt pausiert wurde. */
  private pausedAt = 0;
  private nextEventIndex = 0;
  private nextClickIndex = 0;

  private state: PlayerState = {
    isPlaying: false,
    isPaused: false,
    currentTime: 0,
    duration: 0,
    currentPosition: null,
  };

  private options: PlayerOptions = {
    playbackRate: 1,
    metronome: false,
    volume: 0.8,
    startMeasure: 0,
  };

  private onStateChange: ((state: PlayerState) => void) | null = null;

  /** Vorausplanung in Sekunden. */
  private static readonly LOOKAHEAD = 0.2;
  /** Timer-Intervall in Millisekunden. */
  private static readonly TICK_MS = 40;

  constructor() {
    this.context = getAudioContext();
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.options.volume;
    this.masterGain.connect(this.context.destination);
  }

  /** Registriert einen Zustands-Callback fuer die UI. */
  setStateListener(listener: ((state: PlayerState) => void) | null): void {
    this.onStateChange = listener;
  }

  getState(): PlayerState {
    return { ...this.state };
  }

  setOptions(options: Partial<PlayerOptions>): void {
    this.options = { ...this.options, ...options };
    this.masterGain.gain.value = this.options.volume;
  }

  /** Laedt eine Partitur und bereitet die Ereignisliste vor. */
  load(score: Score): void {
    const wasPlaying = this.state.isPlaying;
    this.stop();

    const built = buildPlaybackEvents(score);
    this.events = built.events;
    this.clicks = built.clicks;
    this.state.duration = built.duration;

    // Kanalpegel je System einrichten.
    for (const gain of this.staffGains.values()) gain.disconnect();
    this.staffGains.clear();
    for (let i = 0; i < score.staves.length; i++) {
      const staff = score.staves[i];
      const gain = this.context.createGain();
      gain.gain.value = staff.muted ? 0 : staff.volume;
      gain.connect(this.masterGain);
      this.staffGains.set(i, gain);
    }
    this.voiceByStaff = score.staves.map((s) => voiceForProgram(s.midiProgram));

    this.emit();
    if (wasPlaying) void this.play();
  }

  private voiceByStaff: ReturnType<typeof voiceForProgram>[] = [];

  /** Aktualisiert Lautstaerke und Stummschaltung eines Systems. */
  setStaffMix(staffIndex: number, volume: number, muted: boolean): void {
    const gain = this.staffGains.get(staffIndex);
    if (gain) gain.gain.value = muted ? 0 : volume;
  }

  /** Startet oder setzt die Wiedergabe fort. */
  async play(): Promise<void> {
    if (this.state.isPlaying) return;
    await resumeAudioContext();

    const startOffset = this.state.isPaused ? this.pausedAt : this.seekTarget;
    this.startContextTime = this.context.currentTime - startOffset / this.options.playbackRate;

    // Ereigniszeiger auf die Startposition setzen.
    this.nextEventIndex = this.events.findIndex((e) => e.time >= startOffset - 1e-6);
    if (this.nextEventIndex === -1) this.nextEventIndex = this.events.length;
    this.nextClickIndex = this.clicks.findIndex((c) => c.time >= startOffset - 1e-6);
    if (this.nextClickIndex === -1) this.nextClickIndex = this.clicks.length;

    this.state.isPlaying = true;
    this.state.isPaused = false;
    this.emit();

    this.schedulerTimer = window.setInterval(() => this.tick(), ScorePlayer.TICK_MS);
    this.tick();
  }

  /** Position, an der beim naechsten Start begonnen wird. */
  private seekTarget = 0;

  /** Haelt die Wiedergabe an; die Position bleibt erhalten. */
  pause(): void {
    if (!this.state.isPlaying) return;
    this.pausedAt = this.currentPlaybackTime();
    this.stopScheduler();
    this.stopAllVoices();
    this.state.isPlaying = false;
    this.state.isPaused = true;
    this.emit();
  }

  /** Beendet die Wiedergabe und springt an den Anfang. */
  stop(): void {
    this.stopScheduler();
    this.stopAllVoices();
    this.pausedAt = 0;
    this.seekTarget = 0;
    this.state.isPlaying = false;
    this.state.isPaused = false;
    this.state.currentTime = 0;
    this.state.currentPosition = null;
    this.emit();
  }

  /** Springt an eine Position in Sekunden. */
  seek(seconds: number): void {
    const target = Math.max(0, Math.min(this.state.duration, seconds));
    const wasPlaying = this.state.isPlaying;
    if (wasPlaying) {
      this.stopScheduler();
      this.stopAllVoices();
      this.state.isPlaying = false;
    }
    this.seekTarget = target;
    this.pausedAt = target;
    this.state.isPaused = target > 0;
    this.state.currentTime = target;
    this.emit();
    if (wasPlaying) void this.play();
  }

  /** Springt einen Takt zurueck. */
  seekToMeasure(score: Score, measureIndex: number): void {
    let time = 0;
    for (let m = 0; m < measureIndex; m++) {
      const timeSignature = effectiveTimeSignature(score, 0, m);
      const tempo = effectiveTempo(score, m);
      time += (measureCapacity(timeSignature) * 60) / tempo;
    }
    this.seek(time);
  }

  /** Aktuelle Wiedergabezeit in Sekunden. */
  private currentPlaybackTime(): number {
    if (!this.state.isPlaying) return this.pausedAt;
    return (this.context.currentTime - this.startContextTime) * this.options.playbackRate;
  }

  /** Plant alle Ereignisse ein, die im Vorausschau-Fenster liegen. */
  private tick(): void {
    const now = this.currentPlaybackTime();
    const horizon = now + ScorePlayer.LOOKAHEAD * this.options.playbackRate;

    while (this.nextEventIndex < this.events.length && this.events[this.nextEventIndex].time < horizon) {
      const event = this.events[this.nextEventIndex++];
      const contextTime = this.startContextTime + event.time / this.options.playbackRate;
      if (contextTime < this.context.currentTime) continue;

      const destination = this.staffGains.get(event.staffIndex) ?? this.masterGain;
      const voice = this.voiceByStaff[event.staffIndex] ?? voiceForProgram(0);
      for (const midi of event.midis) {
        const active = playNote(
          this.context,
          destination,
          midiToFrequency(midi),
          contextTime,
          event.duration / this.options.playbackRate,
          event.velocity,
          voice,
        );
        this.activeVoices.push(active);
      }
    }

    if (this.options.metronome) {
      while (this.nextClickIndex < this.clicks.length && this.clicks[this.nextClickIndex].time < horizon) {
        const click = this.clicks[this.nextClickIndex++];
        const contextTime = this.startContextTime + click.time / this.options.playbackRate;
        if (contextTime >= this.context.currentTime) {
          playClick(this.context, this.masterGain, contextTime, click.accented);
        }
      }
    } else {
      // Zeiger mitfuehren, damit ein spaeteres Einschalten nicht nachholt.
      while (this.nextClickIndex < this.clicks.length && this.clicks[this.nextClickIndex].time < horizon) {
        this.nextClickIndex++;
      }
    }

    this.state.currentTime = Math.min(now, this.state.duration);
    this.state.currentPosition = this.positionAt(now);
    this.emit();

    if (now >= this.state.duration + 0.3) {
      this.stop();
    }

    // Nicht mehr benoetigte Stimmen aufraeumen.
    if (this.activeVoices.length > 256) {
      this.activeVoices = this.activeVoices.slice(-128);
    }
  }

  /** Findet die Note, die zu einem Zeitpunkt klingt. */
  private positionAt(time: number): ScorePosition | null {
    let result: ScorePosition | null = null;
    for (const event of this.events) {
      if (event.time > time) break;
      if (time < event.time + event.duration) result = event.position;
    }
    return result;
  }

  private stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private stopAllVoices(): void {
    const now = this.context.currentTime;
    for (const voice of this.activeVoices) voice.stop(now);
    this.activeVoices = [];
  }

  private emit(): void {
    this.onStateChange?.({ ...this.state });
  }

  /** Spielt einen einzelnen Ton sofort (fuer Vorhoeren im Editor). */
  async previewNote(midi: number, durationSeconds = 0.6, program = 0): Promise<void> {
    await resumeAudioContext();
    playNote(
      this.context,
      this.masterGain,
      midiToFrequency(midi),
      this.context.currentTime + 0.01,
      durationSeconds,
      0.7,
      voiceForProgram(program),
    );
  }

  /** Gibt alle Ressourcen frei. */
  dispose(): void {
    this.stop();
    this.masterGain.disconnect();
    for (const gain of this.staffGains.values()) gain.disconnect();
    this.staffGains.clear();
  }
}
