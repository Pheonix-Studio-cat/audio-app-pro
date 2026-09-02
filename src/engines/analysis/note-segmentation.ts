/**
 * Wandelt eine Tonhoehenspur plus Onsets in diskrete Notenereignisse um.
 *
 * Vorgehen:
 * 1. Die Spur wird an Onsets und an Tonhoehenwechseln segmentiert.
 * 2. Je Segment wird der Median der stabilen Frequenzen genommen.
 * 3. Segmente ohne verlaessliche Tonhoehe werden zu Pausen.
 */
import type { DetectedNote } from '../../core/types';
import { centsFromNearestSemitone, frequencyToMidiFloat, midiToFrequency } from '../../core/music-theory';
import type { PitchTrackPoint } from './pitch-detection';
import { median } from './dsp';

export interface SegmentationOptions {
  /** Mindestdauer eines Notenereignisses in Sekunden. */
  minNoteDuration: number;
  /** Mindest-Erkennungssicherheit je Analysefenster. */
  minConfidence: number;
  /** Tonhoehenaenderung in Halbtoenen, die ein neues Segment ausloest. */
  pitchChangeThreshold: number;
  minMidi: number;
  maxMidi: number;
}

export const DEFAULT_SEGMENTATION_OPTIONS: SegmentationOptions = {
  minNoteDuration: 0.06,
  minConfidence: 0.5,
  pitchChangeThreshold: 0.6,
  minMidi: 36,
  maxMidi: 96,
};

/**
 * Segmentiert die Tonhoehenspur zu Noten.
 *
 * @param track Ergebnis von `trackPitch`
 * @param onsets Onset-Zeitpunkte in Sekunden (koennen leer sein)
 */
export function segmentNotes(
  track: PitchTrackPoint[],
  onsets: number[],
  options: Partial<SegmentationOptions> = {},
): DetectedNote[] {
  const opts = { ...DEFAULT_SEGMENTATION_OPTIONS, ...options };
  if (track.length === 0) return [];

  const frameTime = track.length > 1 ? track[1].time - track[0].time : 0.01;
  const onsetSet = new Set(onsets.map((t) => Math.round(t / frameTime)));

  interface Segment {
    startIndex: number;
    endIndex: number;
    points: PitchTrackPoint[];
  }

  const segments: Segment[] = [];
  let current: Segment | null = null;
  let currentMidiRef = 0;

  for (let i = 0; i < track.length; i++) {
    const point = track[i];
    const voiced = point.frequency > 0 && point.confidence >= opts.minConfidence;
    const midi = voiced ? frequencyToMidiFloat(point.frequency) : Number.NaN;
    const inRange = voiced && midi >= opts.minMidi && midi <= opts.maxMidi;

    if (!inRange) {
      // Stille oder unsicheres Fenster beendet das laufende Segment.
      if (current) {
        current.endIndex = i;
        segments.push(current);
        current = null;
      }
      continue;
    }

    const isOnset = onsetSet.has(i);
    const pitchJump = current ? Math.abs(midi - currentMidiRef) > opts.pitchChangeThreshold : false;

    if (!current || isOnset || pitchJump) {
      if (current) {
        current.endIndex = i;
        segments.push(current);
      }
      current = { startIndex: i, endIndex: i, points: [] };
      currentMidiRef = midi;
    }

    current.points.push(point);
    // Referenz gleitend nachfuehren, damit Vibrato kein neues Segment ausloest.
    currentMidiRef = currentMidiRef * 0.7 + midi * 0.3;
  }

  if (current) {
    current.endIndex = track.length;
    segments.push(current);
  }

  const notes: DetectedNote[] = [];
  for (const segment of segments) {
    if (segment.points.length === 0) continue;
    const start = track[segment.startIndex].time;
    const endTime =
      segment.endIndex < track.length ? track[segment.endIndex].time : track[track.length - 1].time + frameTime;
    const duration = endTime - start;
    if (duration < opts.minNoteDuration) continue;

    // Randfenster verwerfen: dort ist der Ton oft noch instabil.
    const stable = segment.points.length > 4 ? segment.points.slice(1, -1) : segment.points;
    const frequencies = stable.map((p) => p.frequency).filter((f) => f > 0);
    if (frequencies.length === 0) continue;

    const medianFrequency = median(frequencies);
    const exactMidi = frequencyToMidiFloat(medianFrequency);
    const midi = Math.round(exactMidi);
    if (midi < opts.minMidi || midi > opts.maxMidi) continue;

    const avgConfidence = stable.reduce((sum, p) => sum + p.confidence, 0) / stable.length;
    const avgEnergy = stable.reduce((sum, p) => sum + p.energy, 0) / stable.length;

    // Streuung der Tonhoehe senkt die Sicherheit (z.B. Glissando, Rauschen).
    const spreadCents = Math.abs(
      1200 * Math.log2(Math.max(...frequencies) / Math.min(...frequencies)),
    );
    const stabilityFactor = Math.max(0.3, 1 - spreadCents / 300);

    notes.push({
      start,
      duration,
      midi,
      frequency: medianFrequency,
      cents: centsFromNearestSemitone(medianFrequency),
      confidence: Math.max(0, Math.min(1, avgConfidence * stabilityFactor)),
      velocity: Math.max(0, Math.min(1, avgEnergy * 4)),
    });
  }

  return mergeAdjacentNotes(notes);
}

/**
 * Fasst direkt benachbarte Segmente gleicher Tonhoehe zusammen.
 * Verhindert, dass ein gehaltener Ton in viele Kurznoten zerfaellt.
 */
function mergeAdjacentNotes(notes: DetectedNote[], gapTolerance = 0.04): DetectedNote[] {
  if (notes.length < 2) return notes;
  const merged: DetectedNote[] = [notes[0]];
  for (let i = 1; i < notes.length; i++) {
    const previous = merged[merged.length - 1];
    const note = notes[i];
    const gap = note.start - (previous.start + previous.duration);
    if (note.midi === previous.midi && gap >= 0 && gap <= gapTolerance) {
      const totalDuration = note.start + note.duration - previous.start;
      const weightPrevious = previous.duration / totalDuration;
      const weightNote = note.duration / totalDuration;
      previous.duration = totalDuration;
      previous.frequency = previous.frequency * weightPrevious + note.frequency * weightNote;
      previous.confidence = previous.confidence * weightPrevious + note.confidence * weightNote;
      previous.velocity = Math.max(previous.velocity, note.velocity);
      continue;
    }
    merged.push(note);
  }
  return merged;
}

/**
 * Wandelt polyphone Rahmenanalysen in Notenereignisse um, indem pro
 * Halbtonklasse die zusammenhaengenden aktiven Bereiche gesucht werden.
 */
export function segmentPolyphonicNotes(
  frames: Array<{ time: number; pitches: Array<{ midi: number; salience: number }> }>,
  frameTime: number,
  minDuration = 0.08,
): DetectedNote[] {
  interface Active {
    midi: number;
    start: number;
    lastSeen: number;
    salienceSum: number;
    frameCount: number;
  }

  const active = new Map<number, Active>();
  const notes: DetectedNote[] = [];
  // Kurze Luecken ueberbrucken, damit Noten nicht zerhackt werden.
  const holdTime = frameTime * 3;

  const closeNote = (entry: Active, endTime: number, maxSalience: number) => {
    const duration = endTime - entry.start;
    if (duration < minDuration) return;
    const avgSalience = entry.salienceSum / entry.frameCount;
    notes.push({
      start: entry.start,
      duration,
      midi: entry.midi,
      frequency: midiToFrequency(entry.midi),
      cents: 0,
      confidence: Math.max(0.3, Math.min(0.85, maxSalience > 0 ? avgSalience / maxSalience : 0.5)),
      velocity: Math.max(0.2, Math.min(1, avgSalience)),
    });
  };

  let globalMaxSalience = 0;
  for (const frame of frames) {
    for (const p of frame.pitches) {
      if (p.salience > globalMaxSalience) globalMaxSalience = p.salience;
    }
  }

  for (const frame of frames) {
    const seen = new Set<number>();
    for (const pitch of frame.pitches) {
      seen.add(pitch.midi);
      const entry = active.get(pitch.midi);
      if (entry) {
        entry.lastSeen = frame.time;
        entry.salienceSum += pitch.salience;
        entry.frameCount++;
      } else {
        active.set(pitch.midi, {
          midi: pitch.midi,
          start: frame.time,
          lastSeen: frame.time,
          salienceSum: pitch.salience,
          frameCount: 1,
        });
      }
    }
    // Nicht mehr gesehene Stimmen nach Ablauf der Haltezeit schliessen.
    for (const [midi, entry] of active) {
      if (!seen.has(midi) && frame.time - entry.lastSeen > holdTime) {
        closeNote(entry, entry.lastSeen + frameTime, globalMaxSalience);
        active.delete(midi);
      }
    }
  }

  const lastTime = frames.length > 0 ? frames[frames.length - 1].time + frameTime : 0;
  for (const entry of active.values()) closeNote(entry, lastTime, globalMaxSalience);

  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return notes;
}
