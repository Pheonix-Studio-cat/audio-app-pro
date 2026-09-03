/**
 * Video-Engine: extrahiert die Audiospur aus Videodateien.
 *
 * Es gibt drei Wege, die in dieser Reihenfolge probiert werden. Alle drei
 * arbeiten ausschliesslich lokal im Browser - es wird nichts hochgeladen.
 *
 *   1. Browser-Dekodierung (`decodeAudioData` auf die Videodatei).
 *      Schnell und ohne Zusatzdownload, funktioniert je nach Browser fuer
 *      MP4, M4A und WEBM.
 *   2. ffmpeg.wasm (LGPL/GPL, hier als WebAssembly-Build eingebunden).
 *      Deckt zusaetzlich MKV, AVI und MOV sowie exotische Codecs ab.
 *      Der Kern ist rund 32 MB gross und wird nur bei Bedarf geladen -
 *      von der eigenen Herkunft, nicht von einem CDN.
 *   3. Echtzeit-Mitschnitt ueber ein verstecktes <video>-Element.
 *      Letzte Rueckfallebene: dauert so lange wie das Video selbst, greift
 *      aber immer dann, wenn der Browser die Datei abspielen kann.
 */
import type { DecodedAudio } from '../audio/audio-engine';
import {
  audioBufferToDecoded,
  decodeArrayBuffer,
  encodeWav,
  getAudioContext,
  mixToMono,
} from '../audio/audio-engine';

export type ExtractionMethod = 'browser' | 'ffmpeg' | 'realtime';

export interface ExtractionProgress {
  /** 0..1, oder -1 wenn der Fortschritt nicht bestimmbar ist. */
  progress: number;
  step: string;
  method: ExtractionMethod | null;
}

export interface ExtractionResult {
  audio: DecodedAudio;
  method: ExtractionMethod;
  /** Hinweise fuer den Nutzer, z.B. zur Qualitaet des gewaehlten Weges. */
  notes: string[];
}

export type ExtractionProgressCallback = (progress: ExtractionProgress) => void;

/** Metadaten einer Videodatei. */
export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Kann der Browser die Datei ueberhaupt abspielen? */
  playable: boolean;
}

/**
 * Liest Metadaten aus einer Videodatei.
 * Wird genutzt, um dem Nutzer vor der Extraktion zu zeigen, was ihn erwartet.
 */
export async function probeVideo(file: File): Promise<VideoInfo> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;

  try {
    const info = await new Promise<VideoInfo>((resolve) => {
      const timeout = window.setTimeout(() => {
        resolve({ duration: 0, width: 0, height: 0, hasAudio: false, playable: false });
      }, 8000);

      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        // Nicht alle Browser melden die Audiospur; wir pruefen, was verfuegbar ist.
        const withTracks = video as HTMLVideoElement & {
          mozHasAudio?: boolean;
          webkitAudioDecodedByteCount?: number;
          audioTracks?: { length: number };
        };
        const hasAudio =
          withTracks.mozHasAudio === true ||
          (withTracks.audioTracks?.length ?? 0) > 0 ||
          (withTracks.webkitAudioDecodedByteCount ?? 0) > 0 ||
          // Unbekannt: wir nehmen an, dass eine Spur vorhanden ist.
          true;
        resolve({
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          width: video.videoWidth,
          height: video.videoHeight,
          hasAudio,
          playable: true,
        });
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        resolve({ duration: 0, width: 0, height: 0, hasAudio: false, playable: false });
      };
      video.src = url;
    });
    return info;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
  }
}

/**
 * Extrahiert die Audiospur einer Videodatei.
 *
 * @param allowFfmpeg Darf der 32-MB-Kern nachgeladen werden? Die UI fragt
 *   den Nutzer vorher, damit der Download nicht ueberraschend passiert.
 */
export async function extractAudioFromVideo(
  file: File,
  onProgress?: ExtractionProgressCallback,
  allowFfmpeg = true,
): Promise<ExtractionResult> {
  const notes: string[] = [];
  const report = (progress: number, step: string, method: ExtractionMethod | null) =>
    onProgress?.({ progress, step, method });

  // Weg 1: Browser-Dekodierung.
  report(0.05, 'Browser-Dekodierung wird versucht', 'browser');
  try {
    const buffer = await file.arrayBuffer();
    const audio = await decodeArrayBuffer(buffer, file.name);
    if (audio.duration > 0.05) {
      report(1, 'Audiospur extrahiert', 'browser');
      return { audio, method: 'browser', notes };
    }
    notes.push('Die Browser-Dekodierung lieferte kein Audiomaterial.');
  } catch {
    notes.push('Der Browser konnte den Videocontainer nicht direkt dekodieren.');
  }

  // Weg 2: ffmpeg.wasm.
  if (allowFfmpeg) {
    report(0.1, 'ffmpeg wird vorbereitet', 'ffmpeg');
    try {
      const audio = await extractWithFfmpeg(file, (progress, step) =>
        report(0.1 + progress * 0.85, step, 'ffmpeg'),
      );
      report(1, 'Audiospur extrahiert', 'ffmpeg');
      notes.push('Die Audiospur wurde mit ffmpeg.wasm lokal extrahiert.');
      return { audio, method: 'ffmpeg', notes };
    } catch (error) {
      notes.push(`ffmpeg konnte nicht genutzt werden: ${(error as Error).message}`);
    }
  }

  // Weg 3: Echtzeit-Mitschnitt.
  report(0.1, 'Echtzeit-Mitschnitt wird gestartet', 'realtime');
  const audio = await extractRealtime(file, (progress, step) =>
    report(0.1 + progress * 0.9, step, 'realtime'),
  );
  notes.push(
    'Die Audiospur wurde in Echtzeit mitgeschnitten, weil kein schnellerer ' +
      'Weg verfuegbar war.',
  );
  return { audio, method: 'realtime', notes };
}

/** Zwischengespeicherte ffmpeg-Instanz, damit der Kern nur einmal laedt. */
let ffmpegInstance: import('@ffmpeg/ffmpeg').FFmpeg | null = null;

/** Laedt ffmpeg.wasm von der eigenen Herkunft. */
async function loadFfmpeg(
  onProgress?: (progress: number, step: string) => void,
): Promise<import('@ffmpeg/ffmpeg').FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;

  onProgress?.(0.02, 'ffmpeg-Kern wird geladen (einmalig ca. 32 MB, rein lokal)');
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const ffmpeg = new FFmpeg();

  // BASE_URL beruecksichtigt eine Auslieferung in einem Unterverzeichnis,
  // etwa auf GitHub Pages unter "/audio-app-pro/".
  const baseUrl = import.meta.env.BASE_URL || '/';
  const base = `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}ffmpeg`;
  await ffmpeg.load({
    coreURL: `${base}/ffmpeg-core.js`,
    wasmURL: `${base}/ffmpeg-core.wasm`,
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

/** Ist der ffmpeg-Kern bereits geladen? */
export function isFfmpegLoaded(): boolean {
  return ffmpegInstance?.loaded === true;
}

/** Extrahiert die Audiospur mit ffmpeg.wasm als WAV und dekodiert sie. */
async function extractWithFfmpeg(
  file: File,
  onProgress?: (progress: number, step: string) => void,
): Promise<DecodedAudio> {
  const ffmpeg = await loadFfmpeg(onProgress);

  const inputName = `input.${(file.name.split('.').pop() ?? 'bin').toLowerCase()}`;
  const outputName = 'output.wav';

  const progressHandler = ({ progress }: { progress: number }) => {
    if (Number.isFinite(progress) && progress >= 0 && progress <= 1) {
      onProgress?.(0.1 + progress * 0.8, 'Audiospur wird extrahiert');
    }
  };
  ffmpeg.on('progress', progressHandler);

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

    // -vn: kein Video, PCM 16 Bit, 48 kHz Stereo als verlustfreies Zwischenformat.
    const exitCode = await ffmpeg.exec([
      '-i', inputName,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      outputName,
    ]);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg brach mit Code ${exitCode} ab. Enthaelt die Datei eine Audiospur?`);
    }

    onProgress?.(0.95, 'Extrahierte Audiospur wird gelesen');
    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
    if (bytes.byteLength < 64) throw new Error('ffmpeg lieferte eine leere Audiodatei.');

    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return await decodeArrayBuffer(buffer, file.name);
  } finally {
    ffmpeg.off('progress', progressHandler);
    // Aufraeumen, damit das virtuelle Dateisystem nicht vollaeuft.
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
}

/**
 * Schneidet die Audiospur in Echtzeit ueber die Web Audio API mit.
 *
 * Das Video wird stumm im Hintergrund abgespielt und sein Ausgang ueber
 * einen MediaStreamDestination und einen MediaRecorder aufgezeichnet.
 * Die Dauer entspricht der Laufzeit des Videos.
 */
async function extractRealtime(
  file: File,
  onProgress?: (progress: number, step: string) => void,
): Promise<DecodedAudio> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.preload = 'auto';
  // Nicht stumm schalten: sonst liefert MediaElementSource kein Signal.
  video.volume = 1;
  video.style.position = 'fixed';
  video.style.left = '-99999px';
  document.body.appendChild(video);

  const context = getAudioContext();
  if (context.state === 'suspended') await context.resume();

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () =>
        reject(new Error('Der Browser kann diese Videodatei nicht abspielen.'));
      window.setTimeout(() => reject(new Error('Zeitueberschreitung beim Laden des Videos.')), 15000);
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) throw new Error('Die Laenge des Videos konnte nicht bestimmt werden.');

    const source = context.createMediaElementSource(video);
    const destination = context.createMediaStreamDestination();
    // Nur in den Recorder leiten, nicht in die Lautsprecher.
    source.connect(destination);

    const recorder = new MediaRecorder(destination.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    recorder.start();
    await video.play();

    const progressTimer = window.setInterval(() => {
      onProgress?.(
        Math.min(0.95, video.currentTime / duration),
        `Mitschnitt laeuft (${Math.round(video.currentTime)} von ${Math.round(duration)} Sekunden)`,
      );
    }, 250);

    await new Promise<void>((resolve) => {
      video.onended = () => resolve();
      // Sicherheitsnetz: etwas laenger als das Video warten.
      window.setTimeout(() => resolve(), (duration + 5) * 1000);
    });

    window.clearInterval(progressTimer);
    recorder.stop();
    await finished;

    onProgress?.(0.97, 'Mitschnitt wird dekodiert');
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    const buffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(buffer);
    return audioBufferToDecoded(audioBuffer, file.name);
  } finally {
    video.pause();
    video.removeAttribute('src');
    if (video.parentElement) document.body.removeChild(video);
    URL.revokeObjectURL(url);
  }
}

/**
 * Konvertiert extrahiertes Audio in eine herunterladbare Datei.
 *
 * WAV wird immer selbst erzeugt (verlustfrei, keine Abhaengigkeit).
 * MP3 und weitere komprimierte Formate laufen ueber ffmpeg.wasm.
 */
export type AudioExportFormat = 'wav' | 'mp3' | 'ogg' | 'flac' | 'm4a';

export interface AudioExportOptions {
  format: AudioExportFormat;
  /** Bitrate fuer verlustbehaftete Formate, z.B. "192k". */
  bitrate: string;
}

/** Erzeugt eine Audiodatei aus dekodiertem Material. */
export async function exportAudio(
  audio: DecodedAudio,
  options: AudioExportOptions,
  onProgress?: (progress: number, step: string) => void,
): Promise<Blob> {
  const wav = encodeWav(audio.channels, audio.sampleRate);
  if (options.format === 'wav') return wav;

  onProgress?.(0.1, `Umwandlung nach ${options.format.toUpperCase()} mit ffmpeg`);
  const ffmpeg = await loadFfmpeg(onProgress);

  const inputName = 'export-input.wav';
  const outputName = `export-output.${options.format}`;

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(await wav.arrayBuffer()));

    const codecArgs = audioCodecArgs(options);
    const exitCode = await ffmpeg.exec(['-i', inputName, ...codecArgs, outputName]);
    if (exitCode !== 0) {
      throw new Error(`Die Umwandlung nach ${options.format.toUpperCase()} schlug fehl.`);
    }

    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
    onProgress?.(1, 'Fertig');
    return new Blob([bytes as BlobPart], { type: mimeForFormat(options.format) });
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
}

/** ffmpeg-Argumente je Zielformat. */
function audioCodecArgs(options: AudioExportOptions): string[] {
  switch (options.format) {
    case 'mp3':
      return ['-codec:a', 'libmp3lame', '-b:a', options.bitrate];
    case 'ogg':
      return ['-codec:a', 'libvorbis', '-b:a', options.bitrate];
    case 'flac':
      return ['-codec:a', 'flac'];
    case 'm4a':
      return ['-codec:a', 'aac', '-b:a', options.bitrate];
    default:
      return [];
  }
}

function mimeForFormat(format: AudioExportFormat): string {
  const map: Record<AudioExportFormat, string> = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
  };
  return map[format];
}

/** Erzeugt aus einem Videostandbild eine Vorschau (Datei-URL). */
export async function captureVideoThumbnail(file: File, atSecond = 1): Promise<string | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.preload = 'metadata';

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Vorschau nicht moeglich'));
      window.setTimeout(() => reject(new Error('Zeitueberschreitung')), 6000);
    });

    video.currentTime = Math.min(atSecond, Math.max(0, video.duration - 0.1));
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      window.setTimeout(resolve, 3000);
    });

    const canvas = document.createElement('canvas');
    const maxWidth = 320;
    const scale = Math.min(1, maxWidth / Math.max(1, video.videoWidth));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context || canvas.width === 0) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

/** Erzeugt ein Monosignal fuer die Analyse aus extrahiertem Audio. */
export function toMonoForAnalysis(audio: DecodedAudio): Float32Array {
  return audio.samples.length > 0
    ? audio.samples
    : mixToMono(audio.channels, audio.channels[0]?.length ?? 0);
}
