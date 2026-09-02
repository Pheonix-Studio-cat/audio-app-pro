/**
 * Musiktheoretische Hilfsfunktionen: Umrechnung zwischen Frequenz, MIDI-Nummer
 * und notierter Tonhoehe, Tonarten, Vorzeichen und Notenlaengen.
 */
import type {
  AccidentalType,
  ClefType,
  DurationValue,
  Pitch,
  TimeSignature,
} from './types';
import { DURATION_QUARTERS } from './types';

export const A4_FREQUENCY = 440;
export const A4_MIDI = 69;

const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
/** Halbtonabstand des Stammtons vom C. */
const STEP_SEMITONES: Record<(typeof STEPS)[number], number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Frequenz in Hz -> exakte (gebrochene) MIDI-Nummer. */
export function frequencyToMidiFloat(frequency: number): number {
  if (frequency <= 0) return Number.NaN;
  return A4_MIDI + 12 * Math.log2(frequency / A4_FREQUENCY);
}

/** MIDI-Nummer -> Frequenz in Hz. */
export function midiToFrequency(midi: number): number {
  return A4_FREQUENCY * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Abweichung einer Frequenz vom naechstgelegenen temperierten Ton in Cent. */
export function centsFromNearestSemitone(frequency: number): number {
  const exact = frequencyToMidiFloat(frequency);
  if (Number.isNaN(exact)) return 0;
  return (exact - Math.round(exact)) * 100;
}

/** Cent-Abstand zwischen zwei Frequenzen. */
export function centsBetween(frequency: number, reference: number): number {
  if (frequency <= 0 || reference <= 0) return 0;
  return 1200 * Math.log2(frequency / reference);
}

/**
 * Kreuz-/B-Vorzeichen pro Tonart.
 * Index: Anzahl Vorzeichen (negativ = b). Werte: alterierte Stammtoene.
 */
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'] as const;

/** Liefert die Stammtoene, die in dieser Tonart alteriert sind. */
export function keySignatureAlterations(fifths: number): Map<string, number> {
  const map = new Map<string, number>();
  if (fifths > 0) {
    for (let i = 0; i < Math.min(fifths, 7); i++) map.set(SHARP_ORDER[i], 1);
  } else if (fifths < 0) {
    for (let i = 0; i < Math.min(-fifths, 7); i++) map.set(FLAT_ORDER[i], -1);
  }
  return map;
}

/** Anzeigename einer Tonart, z.B. 2 -> "D-Dur / h-Moll". */
export function keySignatureName(fifths: number): string {
  const major = ['Ces', 'Ges', 'Des', 'As', 'Es', 'B', 'F', 'C', 'G', 'D', 'A', 'E', 'H', 'Fis', 'Cis'];
  const minor = ['as', 'es', 'b', 'f', 'c', 'g', 'd', 'a', 'e', 'h', 'fis', 'cis', 'gis', 'dis', 'ais'];
  const index = fifths + 7;
  if (index < 0 || index >= major.length) return 'C-Dur';
  return `${major[index]}-Dur / ${minor[index]}-Moll`;
}

/**
 * Wandelt eine MIDI-Nummer in eine notierte Tonhoehe um und beruecksichtigt
 * dabei die Tonart, damit z.B. in Es-Dur "Es" statt "Dis" geschrieben wird.
 */
export function midiToPitch(midi: number, fifths = 0): Pitch {
  const rounded = Math.round(midi);
  const pitchClass = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  const useFlats = fifths < 0;

  // Bevorzugte Schreibweise pro Halbtonklasse.
  const sharpSpelling: Array<[(typeof STEPS)[number], number]> = [
    ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
    ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
  ];
  const flatSpelling: Array<[(typeof STEPS)[number], number]> = [
    ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0],
    ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
  ];

  const [step, alter] = useFlats ? flatSpelling[pitchClass] : sharpSpelling[pitchClass];
  return { step, octave, alter };
}

/** Notierte Tonhoehe -> MIDI-Nummer. */
export function pitchToMidi(pitch: Pitch): number {
  return (pitch.octave + 1) * 12 + STEP_SEMITONES[pitch.step] + pitch.alter;
}

/** Diatonische Stufennummer (fuer die vertikale Position im System). */
export function diatonicIndex(pitch: Pitch): number {
  return pitch.octave * 7 + STEPS.indexOf(pitch.step);
}

/** Lesbarer Name, z.B. "Cis4". Deutsche Notation mit H statt B. */
export function pitchToDisplayName(pitch: Pitch): string {
  const german: Record<string, string> = { B: 'H' };
  const base = german[pitch.step] ?? pitch.step;
  const suffix =
    pitch.alter === 1 ? 'is' :
    pitch.alter === 2 ? 'isis' :
    pitch.alter === -1 ? (pitch.step === 'B' ? '' : 'es') :
    pitch.alter === -2 ? 'eses' : '';
  const name = pitch.alter === -1 && pitch.step === 'B' ? 'B' : base + suffix;
  return `${name}${pitch.octave}`;
}

/** Internationaler Name, z.B. "C#4" - wird fuer VexFlow und MIDI benutzt. */
export function pitchToScientificName(pitch: Pitch): string {
  const acc = pitch.alter > 0 ? '#'.repeat(pitch.alter) : 'b'.repeat(-pitch.alter);
  return `${pitch.step}${acc}${pitch.octave}`;
}

/** VexFlow-Schluessel: "c/4" Notation. */
export function pitchToVexKey(pitch: Pitch): string {
  const acc = pitch.alter > 0 ? '#'.repeat(pitch.alter) : 'b'.repeat(-pitch.alter);
  return `${pitch.step.toLowerCase()}${acc}/${pitch.octave}`;
}

/**
 * Bestimmt, ob fuer eine Note ein Vorzeichen gezeichnet werden muss.
 * Beruecksichtigt die Tonart, aber (bewusst vereinfacht) keine
 * taktbezogene Vorzeichen-Erinnerung.
 */
export function requiredAccidental(pitch: Pitch, fifths: number): AccidentalType | null {
  if (pitch.accidental) return pitch.accidental;
  const keyAlters = keySignatureAlterations(fifths);
  const expected = keyAlters.get(pitch.step) ?? 0;
  if (pitch.alter === expected) return null;
  if (pitch.alter === 0) return 'natural';
  if (pitch.alter === 1) return 'sharp';
  if (pitch.alter === -1) return 'flat';
  if (pitch.alter === 2) return 'double-sharp';
  if (pitch.alter === -2) return 'double-flat';
  return null;
}

/** Dauer inklusive Punktierung in Vierteln. */
export function durationInQuarters(duration: DurationValue, dots: number): number {
  const base = DURATION_QUARTERS[duration];
  let total = base;
  let add = base;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    total += add;
  }
  return total;
}

/** Laenge eines Taktes in Vierteln. */
export function measureCapacity(timeSignature: TimeSignature): number {
  return (timeSignature.beats * 4) / timeSignature.beatType;
}

/**
 * Zerlegt eine Dauer in Vierteln in darstellbare Notenwerte.
 * Wird bei der Quantisierung genutzt, wenn eine erkannte Dauer nicht
 * exakt einem Notenwert entspricht.
 */
export function splitDuration(quarters: number): Array<{ duration: DurationValue; dots: number }> {
  const candidates: Array<{ duration: DurationValue; dots: number; q: number }> = [];
  const values: DurationValue[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
  for (const v of values) {
    for (let d = 0; d <= 2; d++) {
      candidates.push({ duration: v, dots: d, q: durationInQuarters(v, d) });
    }
  }
  candidates.sort((a, b) => b.q - a.q);

  const result: Array<{ duration: DurationValue; dots: number }> = [];
  let remaining = quarters;
  const epsilon = 1e-6;
  let guard = 0;
  while (remaining > epsilon && guard++ < 32) {
    const fit = candidates.find((c) => c.q <= remaining + epsilon);
    if (!fit) break;
    result.push({ duration: fit.duration, dots: fit.dots });
    remaining -= fit.q;
  }
  if (result.length === 0) result.push({ duration: '32nd', dots: 0 });
  return result;
}

/** Tonumfang, in dem ein Schluessel sinnvoll ist (mittlere Linie als MIDI). */
export const CLEF_MIDDLE_MIDI: Record<ClefType, number> = {
  treble: 71, // H4
  bass: 50, // D3
  alto: 60, // C4
  tenor: 57, // A3
};

/** Waehlt den passenden Schluessel fuer einen Tonhoehenbereich. */
export function suggestClef(midiValues: number[]): ClefType {
  if (midiValues.length === 0) return 'treble';
  const avg = midiValues.reduce((a, b) => a + b, 0) / midiValues.length;
  return avg < 58 ? 'bass' : 'treble';
}

/** Erzeugt eine eindeutige ID fuer Modellobjekte. */
export function createId(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
