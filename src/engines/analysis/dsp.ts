/**
 * Signalverarbeitungs-Grundbausteine.
 *
 * Bewusst ohne externe Abhaengigkeit implementiert, damit die Analyse
 * auch im Web Worker ohne zusaetzliche Bundle-Groesse laeuft.
 */

/**
 * Radix-2 FFT (in-place, iterativ).
 * `real` und `imag` muessen dieselbe Laenge haben und eine Zweierpotenz sein.
 */
export function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error('FFT-Laenge muss eine Zweierpotenz sein');

  // Bit-Reversal-Permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < len / 2; k++) {
        const aReal = real[i + k];
        const aImag = imag[i + k];
        const bReal = real[i + k + len / 2] * curReal - imag[i + k + len / 2] * curImag;
        const bImag = real[i + k + len / 2] * curImag + imag[i + k + len / 2] * curReal;
        real[i + k] = aReal + bReal;
        imag[i + k] = aImag + bImag;
        real[i + k + len / 2] = aReal - bReal;
        imag[i + k + len / 2] = aImag - bImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/** Betragsspektrum eines reellen Signalfensters. */
export function magnitudeSpectrum(frame: Float32Array): Float32Array {
  const n = nextPowerOfTwo(frame.length);
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  real.set(frame);
  fft(real, imag);
  const bins = n / 2;
  const magnitude = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    magnitude[i] = Math.hypot(real[i], imag[i]);
  }
  return magnitude;
}

/** Naechste Zweierpotenz >= n. */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Hann-Fenster der Laenge n (gecacht, da haeufig benutzt). */
const hannCache = new Map<number, Float32Array>();
export function hannWindow(n: number): Float32Array {
  const cached = hannCache.get(n);
  if (cached) return cached;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  hannCache.set(n, w);
  return w;
}

/** Wendet ein Hann-Fenster auf eine Kopie des Frames an. */
export function applyHann(frame: Float32Array): Float32Array {
  const w = hannWindow(frame.length);
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = frame[i] * w[i];
  return out;
}

/**
 * Parabolische Interpolation um ein lokales Extremum.
 * Liefert den verfeinerten Index und den interpolierten Wert.
 */
export function parabolicInterpolation(
  data: ArrayLike<number>,
  index: number,
): { index: number; value: number } {
  if (index <= 0 || index >= data.length - 1) {
    return { index, value: data[index] };
  }
  const y0 = data[index - 1];
  const y1 = data[index];
  const y2 = data[index + 1];
  const denominator = y0 - 2 * y1 + y2;
  if (Math.abs(denominator) < 1e-12) return { index, value: y1 };
  const delta = (0.5 * (y0 - y2)) / denominator;
  return { index: index + delta, value: y1 - 0.25 * (y0 - y2) * delta };
}

/** Gleitender Mittelwert mit gegebener Fensterbreite (Praefixsummen). */
export function movingAverage(data: Float32Array, windowSize: number): Float32Array {
  const out = new Float32Array(data.length);
  if (data.length === 0) return out;
  const half = Math.max(0, Math.floor(windowSize / 2));
  const prefix = new Float64Array(data.length + 1);
  for (let i = 0; i < data.length; i++) prefix[i + 1] = prefix[i] + data[i];
  for (let i = 0; i < data.length; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(data.length - 1, i + half);
    out[i] = (prefix[to + 1] - prefix[from]) / (to - from + 1);
  }
  return out;
}

/** Median eines Arrays (nicht destruktiv). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Autokorrelation ueber FFT (schnell fuer lange Signale). */
export function autocorrelationFFT(frame: Float32Array): Float32Array {
  const n = nextPowerOfTwo(frame.length * 2);
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  real.set(frame);
  fft(real, imag);
  // Leistungsspektrum
  for (let i = 0; i < n; i++) {
    const power = real[i] * real[i] + imag[i] * imag[i];
    real[i] = power;
    imag[i] = 0;
  }
  // Inverse FFT ueber Konjugation
  for (let i = 0; i < n; i++) imag[i] = -imag[i];
  fft(real, imag);
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = real[i] / n;
  return out;
}

/** Normalisiert ein Array auf den Maximalwert 1. */
export function normalizeArray(data: Float32Array): Float32Array {
  let max = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  if (max < 1e-12) return data;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / max;
  return out;
}
