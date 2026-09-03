/**
 * Tests der Exportformate. Geprueft wird die tatsaechliche Byte- bzw.
 * XML-Struktur, nicht nur ob eine Funktion fehlerfrei zurueckkehrt.
 */
import { describe, expect, it } from 'vitest';
import { exportMusicXml } from '../engines/export/musicxml-export';
import { exportMidi } from '../engines/export/midi-export';
import { createEmptyScore, createStaff } from '../core/score-model';
import { createNote } from '../core/score-model';
import { midiToPitch } from '../core/music-theory';
import type { Score } from '../core/types';

/** Kleine Testpartitur: C-Dur-Dreiklang, Tonleiter und eine Pause. */
function buildTestScore(): Score {
  const score = createEmptyScore({ title: 'Testwerk', composer: 'Testautor', tempo: 96 });
  const staff = score.staves[0];

  staff.measures[0].notes = [
    createNote([midiToPitch(60)], 'quarter'),
    createNote([midiToPitch(62)], 'quarter'),
    createNote([midiToPitch(64)], 'eighth'),
    createNote([midiToPitch(65)], 'eighth'),
    createNote([midiToPitch(67)], 'quarter'),
  ];
  staff.measures[1].notes = [
    // Akkord
    createNote([midiToPitch(60), midiToPitch(64), midiToPitch(67)], 'half'),
    // Punktierte Viertel plus Achtel
    { ...createNote([midiToPitch(69)], 'quarter'), dots: 1 },
    createNote([], 'eighth'),
  ];
  staff.measures[1].notes[2].isRest = true;
  return score;
}

describe('MusicXML-Export', () => {
  const xml = exportMusicXml(buildTestScore());

  it('erzeugt ein gueltiges score-partwise-Dokument', () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<score-partwise version="4.0">');
    expect(xml).toContain('</score-partwise>');
  });

  it('laesst sich vom DOMParser ohne Fehler lesen', () => {
    const parser = new DOMParser();
    const document_ = parser.parseFromString(xml, 'application/xml');
    expect(document_.querySelector('parsererror')).toBeNull();
    expect(document_.documentElement.nodeName).toBe('score-partwise');
  });

  it('enthaelt Titel, Komponist und Tempo', () => {
    expect(xml).toContain('<work-title>Testwerk</work-title>');
    expect(xml).toContain('Testautor');
    expect(xml).toContain('<per-minute>96</per-minute>');
  });

  it('schreibt alle Takte und Noten', () => {
    const parser = new DOMParser();
    const document_ = parser.parseFromString(xml, 'application/xml');
    const measures = document_.querySelectorAll('measure');
    expect(measures.length).toBe(4);

    // Erster Takt: 5 Noten
    const firstMeasureNotes = measures[0].querySelectorAll('note');
    expect(firstMeasureNotes.length).toBe(5);
  });

  it('kennzeichnet Akkordtoene mit <chord/>', () => {
    const parser = new DOMParser();
    const document_ = parser.parseFromString(xml, 'application/xml');
    const chordElements = document_.querySelectorAll('chord');
    // Ein Dreiklang: die zweite und dritte Note tragen <chord/>
    expect(chordElements.length).toBe(2);
  });

  it('schreibt Punktierungen und Pausen', () => {
    const parser = new DOMParser();
    const document_ = parser.parseFromString(xml, 'application/xml');
    expect(document_.querySelectorAll('dot').length).toBeGreaterThanOrEqual(1);
    expect(document_.querySelectorAll('rest').length).toBeGreaterThanOrEqual(1);
  });

  it('setzt Taktart, Tonart und Schluessel im ersten Takt', () => {
    const parser = new DOMParser();
    const document_ = parser.parseFromString(xml, 'application/xml');
    const attributes = document_.querySelector('measure > attributes');
    expect(attributes?.querySelector('divisions')?.textContent).toBe('480');
    expect(attributes?.querySelector('beats')?.textContent).toBe('4');
    expect(attributes?.querySelector('sign')?.textContent).toBe('G');
  });

  it('maskiert XML-Sonderzeichen im Titel', () => {
    const score = createEmptyScore({ title: 'Rock & Roll <Test>' });
    const output = exportMusicXml(score);
    expect(output).toContain('Rock &amp; Roll &lt;Test&gt;');
    const document_ = new DOMParser().parseFromString(output, 'application/xml');
    expect(document_.querySelector('parsererror')).toBeNull();
  });
});

describe('MIDI-Export', () => {
  it('erzeugt einen gueltigen Dateikopf', async () => {
    const blob = exportMidi(buildTestScore());
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // MThd
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
    // Header-Laenge 6
    expect(bytes[7]).toBe(6);
    // Format 1
    expect(bytes[9]).toBe(1);
    // Zwei Spuren: Tempo-Spur plus ein System
    expect(bytes[11]).toBe(2);
    // Aufloesung 480
    expect((bytes[12] << 8) | bytes[13]).toBe(480);
  });

  it('enthaelt fuer jede Spur einen MTrk-Chunk', async () => {
    const blob = exportMidi(buildTestScore());
    const bytes = new Uint8Array(await blob.arrayBuffer());

    let trackCount = 0;
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0x4d && bytes[i + 1] === 0x54 && bytes[i + 2] === 0x72 && bytes[i + 3] === 0x6b) {
        trackCount++;
      }
    }
    expect(trackCount).toBe(2);
  });

  it('schreibt korrekte Chunk-Laengen', async () => {
    const blob = exportMidi(buildTestScore());
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);

    // Nach dem 14-Byte-Header folgt der erste MTrk
    let offset = 14;
    let chunks = 0;
    while (offset < bytes.length) {
      const tag = String.fromCharCode(...bytes.slice(offset, offset + 4));
      expect(tag).toBe('MTrk');
      const length = view.getUint32(offset + 4);
      offset += 8 + length;
      chunks++;
      expect(chunks).toBeLessThan(10);
    }
    // Die Chunks muessen die Datei exakt ausfuellen
    expect(offset).toBe(bytes.length);
  });

  it('enthaelt Note-On-Ereignisse fuer alle gesetzten Noten', async () => {
    const blob = exportMidi(buildTestScore());
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Note-On auf Kanal 0 ist 0x90; gezaehlt wird ueber die Tonhoehen
    const noteOnPitches: number[] = [];
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0x90 && bytes[i + 2] > 0) noteOnPitches.push(bytes[i + 1]);
    }
    // 5 Einzelnoten plus 3 Akkordtoene plus 1 Note = 9
    expect(noteOnPitches.length).toBeGreaterThanOrEqual(9);
    expect(noteOnPitches).toContain(60);
    expect(noteOnPitches).toContain(67);
  });

  it('setzt ein Tempo-Meta-Ereignis', async () => {
    const blob = exportMidi(buildTestScore());
    const bytes = new Uint8Array(await blob.arrayBuffer());

    let found = false;
    for (let i = 0; i < bytes.length - 5; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0x51 && bytes[i + 2] === 0x03) {
        const microseconds = (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5];
        const bpm = Math.round(60000000 / microseconds);
        expect(bpm).toBe(96);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('behandelt mehrere Systeme', async () => {
    const score = buildTestScore();
    score.staves.push(createStaff('Bass', 'bass', score.timeSignature, 4, 33));
    const blob = exportMidi(score);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Drei Spuren: Tempo plus zwei Systeme
    expect(bytes[11]).toBe(3);
  });
});
