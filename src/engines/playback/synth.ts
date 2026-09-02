/**
 * Software-Synthesizer auf Basis der Web Audio API.
 *
 * Bewusst ohne Sample-Bibliothek: Samples waeren mehrere hundert Megabyte
 * gross und muessten nachgeladen werden. Stattdessen werden Klaenge additiv
 * aus Obertoenen mit instrumententypischer Huellkurve und Filterung
 * erzeugt. Das klingt nicht wie ein Konzertfluegel, ist aber musikalisch
 * brauchbar, laeuft offline und startet ohne Wartezeit.
 */

/** Klangfarbe eines Instruments. */
export interface InstrumentVoice {
  name: string;
  /** General-MIDI-Programmnummer fuer den Export. */
  midiProgram: number;
  /** Relative Amplituden der Obertoene (Index 0 = Grundton). */
  harmonics: number[];
  /** Huellkurve in Sekunden bzw. relativen Pegeln. */
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Grenzfrequenz des Tiefpasses relativ zur Grundfrequenz. */
  filterRatio: number;
  /** Leichte Verstimmung der Obertoene fuer natuerlichere Klaenge. */
  detune: number;
}

export const INSTRUMENTS: Record<string, InstrumentVoice> = {
  piano: {
    name: 'Klavier',
    midiProgram: 0,
    harmonics: [1, 0.55, 0.3, 0.18, 0.1, 0.06, 0.03],
    attack: 0.004,
    decay: 1.2,
    sustain: 0.18,
    release: 0.35,
    filterRatio: 9,
    detune: 1.5,
  },
  guitar: {
    name: 'Gitarre',
    midiProgram: 24,
    harmonics: [1, 0.7, 0.45, 0.3, 0.16, 0.09],
    attack: 0.003,
    decay: 0.9,
    sustain: 0.12,
    release: 0.4,
    filterRatio: 11,
    detune: 2.5,
  },
  strings: {
    name: 'Streicher',
    midiProgram: 48,
    harmonics: [1, 0.6, 0.45, 0.35, 0.25, 0.18, 0.12, 0.08],
    attack: 0.09,
    decay: 0.25,
    sustain: 0.75,
    release: 0.35,
    filterRatio: 7,
    detune: 4,
  },
  flute: {
    name: 'Floete',
    midiProgram: 73,
    harmonics: [1, 0.12, 0.06, 0.02],
    attack: 0.06,
    decay: 0.15,
    sustain: 0.8,
    release: 0.18,
    filterRatio: 6,
    detune: 1,
  },
  organ: {
    name: 'Orgel',
    midiProgram: 19,
    harmonics: [1, 0.5, 0.7, 0.35, 0.5, 0.2, 0.25],
    attack: 0.02,
    decay: 0.05,
    sustain: 0.95,
    release: 0.12,
    filterRatio: 12,
    detune: 0.5,
  },
  bass: {
    name: 'Bass',
    midiProgram: 33,
    harmonics: [1, 0.65, 0.28, 0.12, 0.05],
    attack: 0.008,
    decay: 0.7,
    sustain: 0.3,
    release: 0.25,
    filterRatio: 5,
    detune: 1,
  },
  sine: {
    name: 'Sinus (Referenzton)',
    midiProgram: 80,
    harmonics: [1],
    attack: 0.02,
    decay: 0.05,
    sustain: 0.9,
    release: 0.1,
    filterRatio: 20,
    detune: 0,
  },
};

/** Waehlt die Klangfarbe zu einer General-MIDI-Programmnummer. */
export function voiceForProgram(program: number): InstrumentVoice {
  if (program >= 0 && program <= 7) return INSTRUMENTS.piano;
  if (program >= 16 && program <= 23) return INSTRUMENTS.organ;
  if (program >= 24 && program <= 31) return INSTRUMENTS.guitar;
  if (program >= 32 && program <= 39) return INSTRUMENTS.bass;
  if (program >= 40 && program <= 55) return INSTRUMENTS.strings;
  if (program >= 56 && program <= 79) return INSTRUMENTS.flute;
  return INSTRUMENTS.piano;
}

/** Referenz auf eine klingende Note, damit sie vorzeitig beendet werden kann. */
export interface ActiveVoice {
  stop: (when: number) => void;
}

/**
 * Spielt eine einzelne Note.
 *
 * @param context AudioContext
 * @param destination Ziel-Knoten (z.B. Kanal-Gain)
 * @param frequency Grundfrequenz in Hz
 * @param startTime Startzeit in Kontextzeit
 * @param duration Klingende Dauer in Sekunden
 * @param velocity Anschlagstaerke 0..1
 */
export function playNote(
  context: AudioContext,
  destination: AudioNode,
  frequency: number,
  startTime: number,
  duration: number,
  velocity: number,
  voice: InstrumentVoice,
): ActiveVoice {
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(
    Math.min(context.sampleRate / 2 - 1000, frequency * voice.filterRatio),
    startTime,
  );
  filter.Q.value = 0.7;
  filter.connect(gain);
  gain.connect(destination);

  const oscillators: OscillatorNode[] = [];
  const totalHarmonicGain = voice.harmonics.reduce((a, b) => a + b, 0);

  for (let h = 0; h < voice.harmonics.length; h++) {
    const harmonicFrequency = frequency * (h + 1);
    // Obertoene ueber Nyquist wuerden Aliasing erzeugen.
    if (harmonicFrequency > context.sampleRate / 2 - 500) break;

    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(harmonicFrequency, startTime);
    if (voice.detune > 0) {
      // Leichte, aber deterministische Verstimmung je Oberton.
      oscillator.detune.setValueAtTime(voice.detune * (h % 2 === 0 ? 1 : -1) * (h / 2), startTime);
    }

    const harmonicGain = context.createGain();
    harmonicGain.gain.value = voice.harmonics[h] / totalHarmonicGain;
    oscillator.connect(harmonicGain);
    harmonicGain.connect(filter);
    oscillator.start(startTime);
    oscillators.push(oscillator);
  }

  // ADSR-Huellkurve
  const peak = Math.max(0.001, Math.min(1, velocity)) * 0.35;
  const sustainLevel = peak * voice.sustain;
  const attackEnd = startTime + voice.attack;
  const decayEnd = attackEnd + voice.decay;
  const releaseStart = Math.max(attackEnd, startTime + duration);
  const releaseEnd = releaseStart + voice.release;

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peak, attackEnd);
  if (decayEnd < releaseStart) {
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustainLevel), decayEnd);
    gain.gain.setValueAtTime(Math.max(0.0001, sustainLevel), releaseStart);
  } else {
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustainLevel), releaseStart);
  }
  gain.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

  for (const oscillator of oscillators) oscillator.stop(releaseEnd + 0.02);

  return {
    stop: (when: number) => {
      const stopTime = Math.max(when, context.currentTime);
      try {
        gain.gain.cancelScheduledValues(stopTime);
        gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), stopTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, stopTime + 0.05);
        for (const oscillator of oscillators) oscillator.stop(stopTime + 0.06);
      } catch {
        // Bereits gestoppte Oszillatoren werfen - das ist unkritisch.
      }
    },
  };
}

/**
 * Erzeugt einen Metronom-Klick.
 * Betonte Zaehlzeiten klingen hoeher, damit der Takt hoerbar wird.
 */
export function playClick(
  context: AudioContext,
  destination: AudioNode,
  time: number,
  accented: boolean,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(accented ? 1600 : 1000, time);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(accented ? 0.22 : 0.14, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(time);
  oscillator.stop(time + 0.06);
}
