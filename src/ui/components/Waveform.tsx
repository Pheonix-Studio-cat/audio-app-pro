/**
 * Wellenformanzeige mit Markierungen fuer erkannte Noten und Anschlaege.
 * Ein Klick springt an die entsprechende Stelle.
 */
import { useEffect, useRef } from 'react';
import { computeWaveformPeaks } from '../../engines/audio/audio-engine';
import type { DetectedNote } from '../../core/types';

export function Waveform({
  samples,
  sampleRate,
  currentTime,
  notes,
  onSeek,
  height = 84,
}: {
  samples: Float32Array;
  sampleRate: number;
  currentTime?: number;
  notes?: DetectedNote[];
  onSeek?: (seconds: number) => void;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));

    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);

    const width = rect.width;
    const middle = height / 2;
    const duration = samples.length / sampleRate;

    // Hintergrund
    const styles = getComputedStyle(document.documentElement);
    const background = styles.getPropertyValue('--bg-sunken').trim() || '#eee';
    const accent = styles.getPropertyValue('--accent').trim() || '#4338ca';
    const muted = styles.getPropertyValue('--text-faint').trim() || '#888';

    context.fillStyle = background;
    context.fillRect(0, 0, width, height);

    // Mittellinie
    context.strokeStyle = muted;
    context.globalAlpha = 0.3;
    context.beginPath();
    context.moveTo(0, middle);
    context.lineTo(width, middle);
    context.stroke();
    context.globalAlpha = 1;

    // Wellenform
    const buckets = Math.max(1, Math.floor(width));
    const peaks = computeWaveformPeaks(samples, buckets);
    context.fillStyle = accent;
    context.globalAlpha = 0.75;
    for (let i = 0; i < buckets; i++) {
      const amplitude = peaks[i] * (middle - 3);
      context.fillRect(i, middle - amplitude, 1, Math.max(1, amplitude * 2));
    }
    context.globalAlpha = 1;

    // Erkannte Noten als Markierungen unter der Wellenform
    if (notes && notes.length > 0 && duration > 0) {
      for (const note of notes) {
        const x = (note.start / duration) * width;
        const noteWidth = Math.max(1.5, (note.duration / duration) * width);
        // Farbe nach Erkennungssicherheit
        context.fillStyle =
          note.confidence >= 0.7 ? '#16a34a' : note.confidence >= 0.45 ? '#d97706' : '#dc2626';
        context.globalAlpha = 0.8;
        context.fillRect(x, height - 5, noteWidth, 4);
      }
      context.globalAlpha = 1;
    }

    // Abspielposition
    if (currentTime !== undefined && duration > 0) {
      const x = (currentTime / duration) * width;
      context.strokeStyle = '#dc2626';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
      context.lineWidth = 1;
    }
  }, [samples, sampleRate, currentTime, notes, height]);

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      style={{ height }}
      onClick={(event) => {
        if (!onSeek) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - rect.left) / rect.width;
        onSeek(Math.max(0, ratio) * (samples.length / sampleRate));
      }}
      title={onSeek ? 'Klicken, um an diese Stelle zu springen' : undefined}
    />
  );
}
