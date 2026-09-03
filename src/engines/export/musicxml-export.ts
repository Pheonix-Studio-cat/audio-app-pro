/**
 * Export nach MusicXML 4.0 (Partwise).
 *
 * MusicXML ist das Standardaustauschformat fuer Notensatz und wird von
 * MuseScore, Sibelius, Finale und Dorico gelesen. Der Export bildet die
 * gesamte Partitur ab: Systeme, Takte, Noten, Akkorde, Pausen, Vorzeichen,
 * Ueberbindungen, Artikulation, Dynamik, Akkordsymbole, Taktart-, Tonart-
 * und Tempowechsel.
 */
import type { DurationValue, Measure, Score, ScoreNote } from '../../core/types';
import { durationInQuarters } from '../../core/music-theory';
import { effectiveClef, effectiveTimeSignature } from '../../core/score-model';

/** Aufloesung: Ticks pro Viertelnote. */
const DIVISIONS = 480;

/** MusicXML-Notentyp je Notenwert. */
const TYPE_NAMES: Record<DurationValue, string> = {
  whole: 'whole',
  half: 'half',
  quarter: 'quarter',
  eighth: 'eighth',
  '16th': '16th',
  '32nd': '32nd',
};

/** Erzeugt das vollstaendige MusicXML-Dokument als Text. */
export function exportMusicXml(score: Score): string {
  const parts = score.staves
    .map((staff, staffIndex) => renderPart(score, staffIndex, staff.measures))
    .join('\n');

  const partList = score.staves
    .map(
      (staff, index) =>
        `    <score-part id="P${index + 1}">\n` +
        `      <part-name>${escapeXml(staff.name)}</part-name>\n` +
        `      <score-instrument id="P${index + 1}-I1">\n` +
        `        <instrument-name>${escapeXml(staff.name)}</instrument-name>\n` +
        `      </score-instrument>\n` +
        `      <midi-instrument id="P${index + 1}-I1">\n` +
        `        <midi-channel>${Math.min(16, index + 1)}</midi-channel>\n` +
        `        <midi-program>${staff.midiProgram + 1}</midi-program>\n` +
        `        <volume>${Math.round(staff.volume * 100)}</volume>\n` +
        `      </midi-instrument>\n` +
        `    </score-part>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>${escapeXml(score.title)}</work-title>
  </work>
  <identification>
    <creator type="composer">${escapeXml(score.composer)}</creator>
    <encoding>
      <software>Audio-to-Notes Studio</software>
      <encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date>
    </encoding>
  </identification>
  <part-list>
${partList}
  </part-list>
${parts}
</score-partwise>
`;
}

/** Rendert ein einzelnes System als <part>. */
function renderPart(score: Score, staffIndex: number, measures: Measure[]): string {
  const lines: string[] = [`  <part id="P${staffIndex + 1}">`];

  for (let measureIndex = 0; measureIndex < measures.length; measureIndex++) {
    const measure = measures[measureIndex];
    lines.push(`    <measure number="${measureIndex + 1}">`);

    const attributes = renderAttributes(score, staffIndex, measureIndex, measure);
    if (attributes) lines.push(attributes);

    const tempo = measureIndex === 0 ? score.tempo : measure.tempo;
    if (tempo) {
      lines.push(
        `      <direction placement="above">\n` +
          `        <direction-type>\n` +
          `          <metronome>\n` +
          `            <beat-unit>quarter</beat-unit>\n` +
          `            <per-minute>${Math.round(tempo)}</per-minute>\n` +
          `          </metronome>\n` +
          `        </direction-type>\n` +
          `        <sound tempo="${Math.round(tempo)}"/>\n` +
          `      </direction>`,
      );
    }

    for (const note of measure.notes) {
      lines.push(renderNote(note));
      if (note.dynamic) lines.push(renderDynamic(note.dynamic));
    }

    if (measure.barline && measure.barline !== 'single') {
      lines.push(renderBarline(measure.barline));
    }
    lines.push('    </measure>');
  }

  lines.push('  </part>');
  return lines.join('\n');
}

/** Schluessel, Tonart, Taktart - nur wenn sie sich aendern. */
function renderAttributes(
  score: Score,
  staffIndex: number,
  measureIndex: number,
  measure: Measure,
): string | null {
  const parts: string[] = [];
  const isFirst = measureIndex === 0;

  if (isFirst) parts.push(`        <divisions>${DIVISIONS}</divisions>`);

  if (isFirst || measure.keySignature !== undefined) {
    const fifths = measure.keySignature ?? score.keySignature;
    parts.push(`        <key>\n          <fifths>${fifths}</fifths>\n        </key>`);
  }

  const timeSignature = effectiveTimeSignature(score, staffIndex, measureIndex);
  const previous =
    measureIndex > 0 ? effectiveTimeSignature(score, staffIndex, measureIndex - 1) : null;
  if (
    isFirst ||
    !previous ||
    previous.beats !== timeSignature.beats ||
    previous.beatType !== timeSignature.beatType
  ) {
    parts.push(
      `        <time>\n          <beats>${timeSignature.beats}</beats>\n` +
        `          <beat-type>${timeSignature.beatType}</beat-type>\n        </time>`,
    );
  }

  const clef = effectiveClef(score, staffIndex, measureIndex);
  const previousClef =
    measureIndex > 0 ? effectiveClef(score, staffIndex, measureIndex - 1) : null;
  if (isFirst || clef !== previousClef) {
    const { sign, line } = clefToXml(clef);
    parts.push(`        <clef>\n          <sign>${sign}</sign>\n          <line>${line}</line>\n        </clef>`);
  }

  if (parts.length === 0) return null;
  return `      <attributes>\n${parts.join('\n')}\n      </attributes>`;
}

function clefToXml(clef: string): { sign: string; line: number } {
  switch (clef) {
    case 'bass': return { sign: 'F', line: 4 };
    case 'alto': return { sign: 'C', line: 3 };
    case 'tenor': return { sign: 'C', line: 4 };
    default: return { sign: 'G', line: 2 };
  }
}

/** Rendert eine Note, einen Akkord oder eine Pause. */
function renderNote(note: ScoreNote): string {
  const ticks = Math.round(durationInQuarters(note.duration, note.dots) * DIVISIONS);
  const type = TYPE_NAMES[note.duration];

  if (note.isRest || note.pitches.length === 0) {
    return (
      `      <note>\n` +
      `        <rest/>\n` +
      `        <duration>${ticks}</duration>\n` +
      `        <type>${type}</type>\n` +
      dotsXml(note.dots) +
      `      </note>`
    );
  }

  const chordSymbolXml = note.chordSymbol ? renderHarmony(note.chordSymbol) : '';

  // Ein Akkord ist in MusicXML eine Folge von <note>, ab der zweiten mit <chord/>.
  const noteXml = note.pitches
    .map((pitch, index) => {
      const alterXml = pitch.alter !== 0 ? `          <alter>${pitch.alter}</alter>\n` : '';
      const accidental = pitch.accidental ? `        <accidental>${pitch.accidental}</accidental>\n` : '';
      const tieXml =
        (note.tieStop ? '        <tie type="stop"/>\n' : '') +
        (note.tieStart ? '        <tie type="start"/>\n' : '');
      const notationsXml = renderNotations(note);

      return (
        `      <note>\n` +
        (index > 0 ? '        <chord/>\n' : '') +
        `        <pitch>\n` +
        `          <step>${pitch.step}</step>\n` +
        alterXml +
        `          <octave>${pitch.octave}</octave>\n` +
        `        </pitch>\n` +
        `        <duration>${ticks}</duration>\n` +
        tieXml +
        `        <type>${type}</type>\n` +
        dotsXml(note.dots) +
        accidental +
        notationsXml +
        `      </note>`
      );
    })
    .join('\n');

  return chordSymbolXml + noteXml;
}

function dotsXml(dots: number): string {
  return '        <dot/>\n'.repeat(Math.max(0, dots));
}

/** Bindungen und Artikulationen. */
function renderNotations(note: ScoreNote): string {
  const items: string[] = [];

  if (note.tieStop) items.push('          <tied type="stop"/>');
  if (note.tieStart) items.push('          <tied type="start"/>');
  if (note.slurStop) items.push('          <slur type="stop" number="1"/>');
  if (note.slurStart) items.push('          <slur type="start" number="1"/>');

  if (note.articulations && note.articulations.length > 0) {
    const marks = note.articulations
      .filter((a) => a !== 'fermata')
      .map((a) => `            <${articulationTag(a)}/>`)
      .join('\n');
    if (marks) items.push(`          <articulations>\n${marks}\n          </articulations>`);
    if (note.articulations.includes('fermata')) items.push('          <fermata/>');
  }

  if (items.length === 0) return '';
  return `        <notations>\n${items.join('\n')}\n        </notations>\n`;
}

function articulationTag(articulation: string): string {
  const map: Record<string, string> = {
    staccato: 'staccato',
    accent: 'accent',
    tenuto: 'tenuto',
    marcato: 'strong-accent',
  };
  return map[articulation] ?? 'accent';
}

/** Dynamikzeichen als <direction>. */
function renderDynamic(dynamic: string): string {
  return (
    `      <direction placement="below">\n` +
    `        <direction-type>\n` +
    `          <dynamics>\n            <${dynamic}/>\n          </dynamics>\n` +
    `        </direction-type>\n` +
    `      </direction>`
  );
}

/** Akkordsymbol als <harmony>. */
function renderHarmony(symbol: string): string {
  const match = /^([A-G])([#b]?)(.*)$/.exec(symbol);
  if (!match) return '';
  const [, root, accidental, quality] = match;
  const alter = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  const kind = qualityToKind(quality);

  return (
    `      <harmony>\n` +
    `        <root>\n` +
    `          <root-step>${root}</root-step>\n` +
    (alter !== 0 ? `          <root-alter>${alter}</root-alter>\n` : '') +
    `        </root>\n` +
    `        <kind text="${escapeXml(quality)}">${kind}</kind>\n` +
    `      </harmony>\n`
  );
}

function qualityToKind(quality: string): string {
  const map: Record<string, string> = {
    '': 'major',
    m: 'minor',
    dim: 'diminished',
    aug: 'augmented',
    '7': 'dominant',
    maj7: 'major-seventh',
    m7: 'minor-seventh',
    sus4: 'suspended-fourth',
    sus2: 'suspended-second',
  };
  return map[quality] ?? 'major';
}

function renderBarline(barline: string): string {
  const styles: Record<string, string> = {
    double: 'light-light',
    end: 'light-heavy',
    'repeat-end': 'light-heavy',
  };
  const style = styles[barline] ?? 'regular';
  const repeat = barline === 'repeat-end' ? '        <repeat direction="backward"/>\n' : '';
  return (
    `      <barline location="right">\n` +
    `        <bar-style>${style}</bar-style>\n` +
    repeat +
    `      </barline>`
  );
}

/** Maskiert XML-Sonderzeichen. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
