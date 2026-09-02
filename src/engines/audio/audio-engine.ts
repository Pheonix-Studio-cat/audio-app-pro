/**
 * Audio-Engine: Import, Dekodierung und Aufbereitung von Audiodaten.
 *
 * Die Dekodierung laeuft komplett lokal ueber die Web Audio API
 * (`decodeAudioData`). Welche Container/Codecs unterstuetzt werden, haengt
 * vom Browser ab; `probeFormatSupport` prueft das zur Laufzeit, damit die
 * UI ehrliche Aussagen machen kann statt Formate nur zu behaupten.
 */

export interface DecodedAudio {
  /** Mono-Mixdown, fuer die Analyse verwendet. */
  samples: Float32Array;
  /** Original-Kanaele, fuer Wiedergabe und WAV-Export. */
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  fileName: string;
}

/** Vom Browser gemeldete Format-Unterstuetzung. */
export interface FormatSupport {
  extension: string;
  mimeType: string;
  label: string;
  supported: boolean;
}

const AUDIO_FORMATS: Array<{ extension: string; mimeType: string; label: string }> = [
  { extension: 'mp3', mimeType: 'audio/mpeg', label: 'MP3' },
  { extension: 'wav', mimeType: 'audio/wav', label: 'WAV' },
  { extension: 'm4a', mimeType: 'audio/mp4', label: 'M4A' },
  { extension: 'flac', mimeType: 'audio/flac', label: 'FLAC' },
  { extension: 'aac', mimeType: 'audio/aac', label: 'AAC' },
  { extension: 'ogg', mimeType: 'audio/ogg; codecs=vorbis', label: 'OGG' },
];

const VIDEO_FORMATS: Array<{ extension: string; mimeType: string; label: string }> = [
  { extension: 'mp4', mimeType: 'video/mp4', label: 'MP4' },
  { extension: 'mov', mimeType: 'video/quicktime', label: 'MOV' },
  { extension: 'mkv', mimeType: 'video/x-matroska', label: 'MKV' },
  { extension: 'avi', mimeType: 'video/x-msvideo', label: 'AVI' },
  { extension: 'webm', mimeType: 'video/webm', label: 'WEBM' },
];

/**
 * Prueft mit `canPlayType`, welche Formate der aktuelle Browser dekodieren
 * kann. Das Ergebnis ist eine Schaetzung des Browsers, keine Garantie -
 * deshalb faengt der Importpfad Fehler zusaetzlich ab.
 */
export function probeFormatSupport(kind: 'audio' | 'video'): FormatSupport[] {
  const list = kind === 'audio' ? AUDIO_FORMATS : VIDEO_FORMATS;
  const probe = document.createElement(kind);
  return list.map((f) => {
    const verdict = probe.canPlayType(f.mimeType);
    return { ...f, supported: verdict === 'probably' || verdict === 'maybe' };
  });
}

let sharedContext: AudioContext | null = null;

/** Gemeinsamer AudioContext, wird erst bei Bedarf erzeugt. */
export function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

/** Setzt einen durch Autoplay-Policy angehaltenen Context fort. */
export async function resumeAudioContext(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
}

/**
 * Dekodiert eine Datei zu PCM-Daten.
 * Wirft einen Fehler mit verstaendlichem Text, wenn der Browser das
 * Format nicht unterstuetzt.
 */
export async function decodeAudioFile(file: File | Blob, fileName?: string): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  return decodeArrayBuffer(arrayBuffer, fileName ?? (file as File).name ?? 'audio');
}

/** Dekodiert rohe Bytes zu PCM-Daten. */
export async function decodeArrayBuffer(
  arrayBuffer: ArrayBuffer,
  fileName = 'audio',
): Promise<DecodedAudio> {
  const ctx = getAudioContext();
  let buffer: AudioBuffer;
  try {
    // decodeAudioData konsumiert den Buffer, deshalb eine Kopie uebergeben.
    buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (error) {
    throw new Error(
      `Die Datei "${fileName}" konnte nicht dekodiert werden. ` +
        'Der Browser unterstuetzt dieses Format oder diesen Codec nicht. ' +
        `(${(error as Error).message || 'unbekannter Dekodierfehler'})`,
    );
  }
  return audioBufferToDecoded(buffer, fileName);
}

/** Wandelt einen AudioBuffer in unsere interne Struktur um. */
export function audioBufferToDecoded(buffer: AudioBuffer, fileName: string): DecodedAudio {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }
  return {
    samples: mixToMono(channels, buffer.length),
    channels,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    fileName,
  };
}

/** Mischt alle Kanaele zu einem Monosignal. */
export function mixToMono(channels: Float32Array[], length: number): Float32Array {
  if (channels.length === 1) return new Float32Array(channels[0]);
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) mono[i] *= scale;
  return mono;
}

/**
 * Resampled ein Signal per linearer Interpolation.
 * Fuer die Analyse ist das ausreichend; fuer den Audio-Export wird
 * `resampleHighQuality` verwendet.
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (Math.abs(fromRate - toRate) < 1) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    output[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return output;
}

/**
 * Hochwertiges Resampling ueber einen OfflineAudioContext.
 * Wird fuer Audio-Export genutzt, damit keine Aliasing-Artefakte entstehen.
 */
export async function resampleHighQuality(
  audio: DecodedAudio,
  targetRate: number,
): Promise<DecodedAudio> {
  if (Math.abs(audio.sampleRate - targetRate) < 1) return audio;
  const frames = Math.ceil((audio.duration * targetRate));
  const offline = new OfflineAudioContext(audio.channels.length, frames, targetRate);
  const source = offline.createBufferSource();
  const buffer = offline.createBuffer(
    audio.channels.length,
    audio.channels[0].length,
    audio.sampleRate,
  );
  for (let c = 0; c < audio.channels.length; c++) buffer.getChannelData(c).set(audio.channels[c]);
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return audioBufferToDecoded(rendered, audio.fileName);
}

/** Schneidet einen Zeitbereich aus (Sekunden). */
export function sliceAudio(audio: DecodedAudio, startSec: number, endSec: number): DecodedAudio {
  const start = Math.max(0, Math.floor(startSec * audio.sampleRate));
  const end = Math.min(audio.channels[0].length, Math.ceil(endSec * audio.sampleRate));
  const channels = audio.channels.map((c) => c.slice(start, end));
  const length = Math.max(0, end - start);
  return {
    channels,
    samples: mixToMono(channels, length),
    sampleRate: audio.sampleRate,
    duration: length / audio.sampleRate,
    fileName: audio.fileName,
  };
}

/** Normalisiert das Signal auf einen Spitzenwert (Standard: -1 dBFS). */
export function normalize(samples: Float32Array, peak = 0.891): Float32Array {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > max) max = v;
  }
  if (max < 1e-8) return samples;
  const gain = peak / max;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

/** RMS-Lautstaerke eines Fensters. */
export function rms(samples: Float32Array, start = 0, length = samples.length): number {
  let sum = 0;
  const end = Math.min(start + length, samples.length);
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  const count = Math.max(1, end - start);
  return Math.sqrt(sum / count);
}

/**
 * Kodiert PCM-Daten als 16-Bit-WAV-Datei.
 * Wird fuer den Audio-Export aus Videos verwendet.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = channels.length;
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Chunk-Groesse
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Erzeugt eine Wellenform-Uebersicht fuer die Darstellung. */
export function computeWaveformPeaks(samples: Float32Array, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets);
  const bucketSize = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, samples.length);
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}

/** Prueft, ob eine Datei anhand ihrer Endung als Video gilt. */
export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_FORMATS.some((f) => f.extension === ext);
}

/** Prueft, ob eine Datei anhand ihrer Endung als Audio gilt. */
export function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_FORMATS.some((f) => f.extension === ext);
}

export { AUDIO_FORMATS, VIDEO_FORMATS };
