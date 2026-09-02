/**
 * Wiedergabesteuerung fuer die Partitur.
 * Zeigt den echten Zustand des Players; alle Schaltflaechen sind wirksam.
 */
import { useEffect, useState } from 'react';
import type { Score } from '../../core/types';
import type { PlayerState, ScorePlayer } from '../../engines/playback/player';
import { formatDuration } from './common';

export function PlaybackControls({
  player,
  score,
  compact = false,
}: {
  player: ScorePlayer;
  score: Score;
  compact?: boolean;
}) {
  const [state, setState] = useState<PlayerState>(() => player.getState());
  const [rate, setRate] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [volume, setVolume] = useState(0.8);

  useEffect(() => player.addStateListener(setState), [player]);

  useEffect(() => {
    player.setOptions({ playbackRate: rate, metronome, volume });
  }, [player, rate, metronome, volume]);

  /** Aktueller Takt fuer die Sprungtasten. */
  const currentMeasure = state.currentPosition?.measureIndex ?? 0;
  const measureCount = Math.max(...score.staves.map((s) => s.measures.length), 1);

  return (
    <div className="toolbar" style={{ marginBottom: compact ? 0 : 12 }}>
      <div className="toolbar-group">
        <button
          className="btn btn-icon"
          onClick={() => player.seekToMeasure(score, Math.max(0, currentMeasure - 1))}
          title="Einen Takt zurueck"
          aria-label="Einen Takt zurueck"
        >
          &#9198;
        </button>
        {state.isPlaying ? (
          <button
            className="btn btn-icon btn-primary"
            onClick={() => player.pause()}
            title="Pause"
            aria-label="Pause"
          >
            &#9208;
          </button>
        ) : (
          <button
            className="btn btn-icon btn-primary"
            onClick={() => void player.play()}
            title="Wiedergabe"
            aria-label="Wiedergabe"
          >
            &#9654;
          </button>
        )}
        <button
          className="btn btn-icon"
          onClick={() => player.stop()}
          title="Stopp"
          aria-label="Stopp"
        >
          &#9209;
        </button>
        <button
          className="btn btn-icon"
          onClick={() =>
            player.seekToMeasure(score, Math.min(measureCount - 1, currentMeasure + 1))
          }
          title="Einen Takt weiter"
          aria-label="Einen Takt weiter"
        >
          &#9197;
        </button>
      </div>

      <div className="toolbar-group" style={{ minWidth: 150 }}>
        <span className="mono small" style={{ minWidth: 82 }}>
          {formatDuration(state.currentTime)} / {formatDuration(state.duration)}
        </span>
      </div>

      <div className="toolbar-group" style={{ flex: 1, minWidth: 160 }}>
        <input
          type="range"
          min={0}
          max={Math.max(0.1, state.duration)}
          step={0.05}
          value={state.currentTime}
          onChange={(event) => player.seek(Number(event.target.value))}
          aria-label="Abspielposition"
        />
      </div>

      <div className="toolbar-group">
        <span className="toolbar-label">Tempo</span>
        <select
          value={rate}
          onChange={(event) => setRate(Number(event.target.value))}
          style={{ width: 78 }}
          aria-label="Wiedergabegeschwindigkeit"
        >
          <option value={0.25}>25 %</option>
          <option value={0.5}>50 %</option>
          <option value={0.75}>75 %</option>
          <option value={1}>100 %</option>
          <option value={1.25}>125 %</option>
          <option value={1.5}>150 %</option>
          <option value={2}>200 %</option>
        </select>
      </div>

      <div className="toolbar-group">
        <button
          className={`btn btn-sm${metronome ? ' toggled' : ''}`}
          onClick={() => setMetronome((current) => !current)}
          aria-pressed={metronome}
          title="Metronom ein- oder ausschalten"
        >
          Metronom
        </button>
      </div>

      <div className="toolbar-group" style={{ minWidth: 120 }}>
        <span className="toolbar-label">Pegel</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={volume}
          onChange={(event) => setVolume(Number(event.target.value))}
          style={{ width: 74 }}
          aria-label="Lautstaerke"
        />
      </div>
    </div>
  );
}

/** Mischpult: Lautstaerke und Stummschaltung je System. */
export function StaffMixer({
  player,
  score,
  onScoreChange,
}: {
  player: ScorePlayer;
  score: Score;
  onScoreChange: (score: Score) => void;
}) {
  return (
    <div className="list">
      {score.staves.map((staff, index) => (
        <div key={staff.id} className="list-row">
          <div className="list-row-main">
            <div className="list-row-title">{staff.name}</div>
            <div className="list-row-meta">
              <span>{staff.clef === 'treble' ? 'Violinschluessel' : staff.clef === 'bass' ? 'Bassschluessel' : staff.clef}</span>
              <span>{staff.measures.length} Takte</span>
            </div>
          </div>
          <button
            className={`btn btn-sm${staff.muted ? ' toggled' : ''}`}
            onClick={() => {
              const next = structuredClone(score);
              next.staves[index].muted = !next.staves[index].muted;
              player.setStaffMix(index, next.staves[index].volume, next.staves[index].muted);
              onScoreChange(next);
            }}
            aria-pressed={staff.muted}
            title={staff.muted ? 'Stummschaltung aufheben' : 'Stummschalten'}
          >
            {staff.muted ? 'Stumm' : 'Aktiv'}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={staff.volume}
            style={{ width: 110 }}
            onChange={(event) => {
              const next = structuredClone(score);
              next.staves[index].volume = Number(event.target.value);
              player.setStaffMix(index, next.staves[index].volume, next.staves[index].muted);
              onScoreChange(next);
            }}
            aria-label={`Lautstaerke ${staff.name}`}
          />
        </div>
      ))}
    </div>
  );
}
