/**
 * Export als Standard-MIDI-File (Format 1).
 *
 * Der Writer ist vollstaendig selbst implementiert, weil die
 * Spezifikation kompakt ist und so keine weitere Abhaengigkeit noetig
 * wird. Erzeugt wird eine Tempo-Spur plus je eine Spur pro System.
 */
import type { Score } from '../../core/types';
import { durationInQuarters, measureCapacity, pitchToMidi } from '../../core/music-theory';
import { effectiveTempo, effectiveTimeSignature } from '../../core/score-model';

/** Ticks pro Viertelnote. */
const TICKS_PER_QUARTER = 480;

/** Ein einzelnes MIDI-Ereignis mit absoluter Tick-Position. */
interface MidiEvent {
  tick: number;
  data: number[];
  /** Sortierhilfe: Note-Off vor Note-On bei gleicher Position. */
  order: number;
}

/** Erzeugt eine Standard-MIDI-Datei als Blob. */
export function exportMidi(score: Score): Blob {
  const trackChunks: Uint8Array[] = [];

  trackChunks.push(buildTempoTrack(score));
  for (let staffIndex = 0; staffIndex < score.staves.length; staffIndex++) {
    trackChunks.push(buildStaffTrack(score, staffIndex));
  }

  // Header-Chunk: Format 1, Anzahl Spuren, Aufloesung
  const header = new Uint8Array(14);
  writeAscii(header, 0, 'MThd');
  writeUint32(header, 4, 6);
  writeUint16(header, 8, 1);
  writeUint16(header, 10, trackChunks.length);
  writeUint16(header, 12, TICKS_PER_QUARTER);

  const totalLength = header.length + trackChunks.reduce((sum, c) => sum + c.length, 0);
  const output = new Uint8Array(totalLength);
  output.set(header, 0);
  let offset = header.length;
  for (const chunk of trackChunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new Blob([output], { type: 'audio/midi' });
}

/** Spur 0: Titel, Tempo- und Taktartwechsel. */
function buildTempoTrack(score: Score): Uint8Array {
  const events: MidiEvent[] = [];

  events.push({ tick: 0, order: 0, data: metaEvent(0x03, textBytes(score.title)) });

  const measureCount = Math.max(...score.staves.map((s) => s.measures.length), 0);
  let tick = 0;
  let lastTempo = -1;
  let lastTimeSignature = '';

  for (let m = 0; m < measureCount; m++) {
    const tempo = effectiveTempo(score, m);
    if (tempo !== lastTempo) {
      // Mikrosekunden pro Viertelnote
      const microseconds = Math.round(60000000 / tempo);
      events.push({
        tick,
        order: 0,
        data: metaEvent(0x51, [
          (microseconds >> 16) & 0xff,
          (microseconds >> 8) & 0xff,
          microseconds & 0xff,
        ]),
      });
      lastTempo = tempo;
    }

    const timeSignature = effectiveTimeSignature(score, 0, m);
    const key = `${timeSignature.beats}/${timeSignature.beatType}`;
    if (key !== lastTimeSignature) {
      // Nenner wird als Zweierpotenz-Exponent gespeichert.
      const denominatorPower = Math.round(Math.log2(timeSignature.beatType));
      events.push({
        tick,
        order: 0,
        data: metaEvent(0x58, [timeSignature.beats, denominatorPower, 24, 8]),
      });
      lastTimeSignature = key;
    }

    tick += Math.round(measureCapacity(timeSignature) * TICKS_PER_QUARTER);
  }

  events.push({ tick, order: 2, data: metaEvent(0x2f, []) });
  return buildTrackChunk(events);
}

/** Eine Spur je Notensystem. */
function buildStaffTrack(score: Score, staffIndex: number): Uint8Array {
  const staff = score.staves[staffIndex];
  const channel = Math.min(15, staffIndex >= 9 ? staffIndex + 1 : staffIndex); // Kanal 10 ist Schlagzeug
  const events: MidiEvent[] = [];

  events.push({ tick: 0, order: 0, data: metaEvent(0x03, textBytes(staff.name)) });
  events.push({ tick: 0, order: 0, data: [0xc0 | channel, staff.midiProgram & 0x7f] });

  // Offene Ueberbindungen: Note-Off wird verschoben.
  const openTies = new Map<number, { offEventIndex: number }>();

  let tick = 0;
  for (let m = 0; m < staff.measures.length; m++) {
    const measure = staff.measures[m];
    const measureStartTick = tick;
    let offsetQuarters = 0;

    for (const note of measure.notes) {
      const lengthQuarters = durationInQuarters(note.duration, note.dots);
      const startTick = measureStartTick + Math.round(offsetQuarters * TICKS_PER_QUARTER);
      const lengthTicks = Math.round(lengthQuarters * TICKS_PER_QUARTER);
      offsetQuarters += lengthQuarters;

      if (note.isRest || note.pitches.length === 0) continue;

      const velocity = velocityFor(note.dynamic);
      // Leichte Verkuerzung, damit aufeinanderfolgende Toene nicht verschmelzen.
      const gate = note.articulations?.includes('staccato') ? 0.5 : 0.92;

      for (const pitch of note.pitches) {
        const midi = Math.max(0, Math.min(127, pitchToMidi(pitch)));

        if (note.tieStop && openTies.has(midi)) {
          // Bestehendes Note-Off nach hinten schieben.
          const open = openTies.get(midi)!;
          events[open.offEventIndex].tick = startTick + Math.round(lengthTicks * gate);
          if (!note.tieStart) openTies.delete(midi);
          continue;
        }

        events.push({ tick: startTick, order: 1, data: [0x90 | channel, midi, velocity] });
        const offEvent: MidiEvent = {
          tick: startTick + Math.round(lengthTicks * gate),
          order: 0,
          data: [0x80 | channel, midi, 0],
        };
        events.push(offEvent);

        if (note.tieStart) {
          openTies.set(midi, { offEventIndex: events.length - 1 });
        }
      }
    }

    const timeSignature = effectiveTimeSignature(score, staffIndex, m);
    tick = measureStartTick + Math.round(measureCapacity(timeSignature) * TICKS_PER_QUARTER);
  }

  events.push({ tick: tick + TICKS_PER_QUARTER, order: 2, data: metaEvent(0x2f, []) });
  return buildTrackChunk(events);
}

/** Anschlagstaerke aus dem Dynamikzeichen. */
function velocityFor(dynamic: string | undefined): number {
  const map: Record<string, number> = {
    ppp: 16, pp: 33, p: 49, mp: 64, mf: 80, f: 96, ff: 112, fff: 126,
  };
  return dynamic ? (map[dynamic] ?? 80) : 80;
}

/** Baut einen MTrk-Chunk aus absoluten Ereignissen. */
function buildTrackChunk(events: MidiEvent[]): Uint8Array {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const bytes: number[] = [];
  let lastTick = 0;
  for (const event of events) {
    const delta = Math.max(0, event.tick - lastTick);
    bytes.push(...encodeVariableLength(delta));
    bytes.push(...event.data);
    lastTick = event.tick;
  }

  const chunk = new Uint8Array(8 + bytes.length);
  writeAscii(chunk, 0, 'MTrk');
  writeUint32(chunk, 4, bytes.length);
  chunk.set(bytes, 8);
  return chunk;
}

/** Meta-Ereignis (FF type length data). */
function metaEvent(type: number, data: number[]): number[] {
  return [0xff, type, ...encodeVariableLength(data.length), ...data];
}

/** MIDI-Variable-Length-Quantity. */
function encodeVariableLength(value: number): number[] {
  const lastByte = value & 0x7f;
  let remaining = value >>> 7;
  const leading: number[] = [];
  while (remaining > 0) {
    leading.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  return [...leading, lastByte];
}

function textBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    // MIDI-Textfelder sind ASCII; alles andere wird ersetzt.
    bytes.push(code < 128 ? code : 63);
  }
  return bytes;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i);
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >> 24) & 0xff;
  target[offset + 1] = (value >> 16) & 0xff;
  target[offset + 2] = (value >> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}
