/**
 * Projektverwaltung auf Basis von IndexedDB.
 *
 * Alle Projektdaten - auch die importierten Audiodateien - bleiben im
 * Browser des Nutzers. Es gibt keinen Server und keine Synchronisation.
 * IndexedDB wird gegenueber localStorage bevorzugt, weil dort auch grosse
 * Binaerdaten (Audio) gespeichert werden koennen.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AnalysisResult, Score } from '../../core/types';
import { createId } from '../../core/music-theory';

/** Gespeicherter Uebungsfortschritt eines Projekts. */
export interface StoredPracticeProgress {
  /** Anzahl abgeschlossener Uebungsdurchgaenge. */
  sessions: number;
  /** Beste erreichte Trefferquote 0..1. */
  bestAccuracy: number;
  /** Durchschnittliche Cent-Abweichung des besten Durchgangs. */
  bestAverageCents: number;
  /** Zeitpunkt der letzten Uebung. */
  lastPracticed: number | null;
}

/** Ein vollstaendiges Projekt. */
export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Die Partitur des Projekts. */
  score: Score;
  /** Ergebnis der Audioanalyse, falls das Projekt aus Audio entstand. */
  analysis: AnalysisResult | null;
  /** Originaldatei (Audio oder extrahierte Videospur). */
  audioBlob: Blob | null;
  audioFileName: string | null;
  /** Herkunft des Projekts. */
  source: 'audio' | 'video' | 'manual';
  practice: StoredPracticeProgress;
  /** Freitext-Notizen des Nutzers. */
  notes: string;
}

/** Kurzinfo fuer die Projektliste, ohne die grossen Binaerdaten. */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  source: Project['source'];
  measureCount: number;
  noteCount: number;
  tempo: number;
  hasAudio: boolean;
  audioFileName: string | null;
  practice: StoredPracticeProgress;
}

interface AudioToNotesDb extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-updated': number };
  };
}

const DB_NAME = 'audio-to-notes';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<AudioToNotesDb>> | null = null;

/** Oeffnet die Datenbank (einmalig). */
function getDb(): Promise<IDBPDatabase<AudioToNotesDb>> {
  if (!dbPromise) {
    dbPromise = openDB<AudioToNotesDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('projects', { keyPath: 'id' });
        store.createIndex('by-updated', 'updatedAt');
      },
    });
  }
  return dbPromise;
}

/** Ist eine dauerhafte Speicherung in diesem Browser moeglich? */
export function isStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function createEmptyPracticeProgress(): StoredPracticeProgress {
  return { sessions: 0, bestAccuracy: 0, bestAverageCents: 0, lastPracticed: null };
}

/** Erzeugt ein neues Projekt aus einer Partitur. */
export function createProject(
  name: string,
  score: Score,
  source: Project['source'],
  options: Partial<Pick<Project, 'analysis' | 'audioBlob' | 'audioFileName' | 'notes'>> = {},
): Project {
  const now = Date.now();
  return {
    id: createId('project'),
    name,
    createdAt: now,
    updatedAt: now,
    score,
    analysis: options.analysis ?? null,
    audioBlob: options.audioBlob ?? null,
    audioFileName: options.audioFileName ?? null,
    source,
    practice: createEmptyPracticeProgress(),
    notes: options.notes ?? '',
  };
}

/** Speichert ein Projekt (legt es an oder aktualisiert es). */
export async function saveProject(project: Project): Promise<Project> {
  const db = await getDb();
  const updated: Project = { ...project, updatedAt: Date.now() };
  await db.put('projects', updated);
  return updated;
}

/** Laedt ein Projekt vollstaendig. */
export async function loadProject(id: string): Promise<Project | null> {
  const db = await getDb();
  return (await db.get('projects', id)) ?? null;
}

/** Listet alle Projekte, neueste zuerst. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await getDb();
  const projects = await db.getAllFromIndex('projects', 'by-updated');
  return projects
    .map(toSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Loescht ein Projekt endgueltig. */
export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('projects', id);
}

/** Benennt ein Projekt um. */
export async function renameProject(id: string, name: string): Promise<Project | null> {
  const project = await loadProject(id);
  if (!project) return null;
  return saveProject({ ...project, name });
}

/** Aktualisiert den Uebungsfortschritt eines Projekts. */
export async function updatePracticeProgress(
  id: string,
  accuracy: number,
  averageCents: number,
): Promise<Project | null> {
  const project = await loadProject(id);
  if (!project) return null;

  const previous = project.practice;
  const improved = accuracy > previous.bestAccuracy;
  return saveProject({
    ...project,
    practice: {
      sessions: previous.sessions + 1,
      bestAccuracy: Math.max(previous.bestAccuracy, accuracy),
      bestAverageCents: improved ? averageCents : previous.bestAverageCents,
      lastPracticed: Date.now(),
    },
  });
}

/** Reduziert ein Projekt auf die Listendarstellung. */
function toSummary(project: Project): ProjectSummary {
  const measureCount = Math.max(...project.score.staves.map((s) => s.measures.length), 0);
  let noteCount = 0;
  for (const staff of project.score.staves) {
    for (const measure of staff.measures) {
      for (const note of measure.notes) {
        if (!note.isRest) noteCount++;
      }
    }
  }
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    source: project.source,
    measureCount,
    noteCount,
    tempo: project.score.tempo,
    hasAudio: project.audioBlob !== null,
    audioFileName: project.audioFileName,
    practice: project.practice,
  };
}

/** Geschaetzter Speicherverbrauch in Byte. */
export async function estimateStorageUsage(): Promise<{ used: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

/**
 * Exportiert ein Projekt als JSON-Datei zur Sicherung.
 * Audiodaten werden als Base64 eingebettet, damit die Datei
 * eigenstaendig ist.
 */
export async function exportProjectJson(project: Project): Promise<Blob> {
  const audioBase64 = project.audioBlob ? await blobToBase64(project.audioBlob) : null;
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: {
      ...project,
      audioBlob: undefined,
      audioBase64,
      audioMimeType: project.audioBlob?.type ?? null,
    },
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

/** Liest ein zuvor exportiertes Projekt wieder ein. */
export async function importProjectJson(file: File): Promise<Project> {
  const text = await file.text();
  const payload = JSON.parse(text) as {
    version?: number;
    project?: Record<string, unknown>;
  };
  if (!payload.project) throw new Error('Die Datei enthaelt kein gueltiges Projekt.');

  const raw = payload.project as unknown as Project & {
    audioBase64?: string | null;
    audioMimeType?: string | null;
  };
  const audioBlob = raw.audioBase64
    ? base64ToBlob(raw.audioBase64, raw.audioMimeType ?? 'audio/wav')
    : null;

  return {
    ...raw,
    // Neue ID vergeben, damit ein bestehendes Projekt nicht ueberschrieben wird.
    id: createId('project'),
    audioBlob,
    practice: raw.practice ?? createEmptyPracticeProgress(),
    updatedAt: Date.now(),
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  // In Bloecken umwandeln, damit der Aufrufstapel bei grossen Dateien haelt.
  for (let i = 0; i < buffer.length; i += chunkSize) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
