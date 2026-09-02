/**
 * Klaviatur zum Auswaehlen und Vorhoeren von Tonhoehen.
 */
import { midiToPitch, pitchToDisplayName } from '../../core/music-theory';

const WHITE_PATTERN = [0, 2, 4, 5, 7, 9, 11];
const BLACK_OFFSETS: Record<number, number> = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };

export function PianoKeyboard({
  fromMidi = 48,
  toMidi = 84,
  activeMidis = [],
  onKeyPress,
}: {
  fromMidi?: number;
  toMidi?: number;
  activeMidis?: number[];
  onKeyPress: (midi: number) => void;
}) {
  // Weisse Tasten sammeln, schwarze werden absolut darueber positioniert.
  const whiteKeys: number[] = [];
  for (let midi = fromMidi; midi <= toMidi; midi++) {
    if (WHITE_PATTERN.includes(midi % 12)) whiteKeys.push(midi);
  }

  const blackKeys: Array<{ midi: number; whiteIndex: number }> = [];
  for (let midi = fromMidi; midi <= toMidi; midi++) {
    const pitchClass = midi % 12;
    if (!(pitchClass in BLACK_OFFSETS)) continue;
    // Position relativ zur naechsten weissen Taste links.
    const previousWhite = whiteKeys.findIndex((w) => w > midi);
    const index = previousWhite === -1 ? whiteKeys.length : previousWhite;
    blackKeys.push({ midi, whiteIndex: index });
  }

  const keyWidth = 30;

  return (
    <div className="piano" role="group" aria-label="Klaviatur">
      {whiteKeys.map((midi) => (
        <div
          key={midi}
          className={`piano-white${activeMidis.includes(midi) ? ' active' : ''}`}
          onMouseDown={() => onKeyPress(midi)}
          role="button"
          tabIndex={-1}
          title={pitchToDisplayName(midiToPitch(midi))}
        >
          {midi % 12 === 0 ? `C${Math.floor(midi / 12) - 1}` : ''}
        </div>
      ))}
      {blackKeys.map(({ midi, whiteIndex }) => (
        <div
          key={midi}
          className={`piano-black${activeMidis.includes(midi) ? ' active' : ''}`}
          style={{ left: 4 + whiteIndex * keyWidth }}
          onMouseDown={(event) => {
            event.stopPropagation();
            onKeyPress(midi);
          }}
          role="button"
          tabIndex={-1}
          title={pitchToDisplayName(midiToPitch(midi))}
        />
      ))}
    </div>
  );
}
