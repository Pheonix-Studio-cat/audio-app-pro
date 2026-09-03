/**
 * Globaler Anwendungszustand.
 *
 * Bewusst mit React-Context statt einer externen Zustandsbibliothek: der
 * Zustand ist ueberschaubar und so bleibt das Bundle klein.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AnalysisResult, Score, ScorePosition } from '../core/types';
import { createEmptyScore } from '../core/score-model';
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  type Clipboard,
  type EditorHistory,
} from '../engines/notation/editor-commands';
import type { DecodedAudio } from '../engines/audio/audio-engine';
import { ScorePlayer } from '../engines/playback/player';
import {
  createProject,
  listProjects,
  loadProject,
  saveProject,
  type Project,
  type ProjectSummary,
} from '../engines/projects/project-store';

/** Die Hauptbereiche der Anwendung. */
export type ViewName =
  | 'home'
  | 'audio-to-notes'
  | 'video-to-audio'
  | 'editor'
  | 'practice'
  | 'projects'
  | 'export'
  | 'settings';

/** Kurzlebige Nachricht in der Oberflaeche. */
export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'danger';
  message: string;
}

interface AppState {
  view: ViewName;
  setView: (view: ViewName) => void;

  /** Aktuelle Partitur samt Bearbeitungsverlauf. */
  score: Score;
  applyScoreChange: (next: Score) => void;
  replaceScore: (next: Score) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;

  selection: ScorePosition[];
  setSelection: (selection: ScorePosition[]) => void;
  clipboard: Clipboard;
  setClipboard: (clipboard: Clipboard) => void;

  /** Zuletzt importiertes bzw. extrahiertes Audio. */
  audio: DecodedAudio | null;
  audioBlob: Blob | null;
  setAudio: (audio: DecodedAudio | null, blob: Blob | null) => void;

  analysis: AnalysisResult | null;
  setAnalysis: (analysis: AnalysisResult | null) => void;

  player: ScorePlayer;

  /** Aktuell geoeffnetes Projekt (null = ungespeichert). */
  currentProjectId: string | null;
  projects: ProjectSummary[];
  refreshProjects: () => Promise<void>;
  saveCurrentProject: (name?: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  hasUnsavedChanges: boolean;

  theme: 'light' | 'dark';
  toggleTheme: () => void;

  toasts: Toast[];
  notify: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: string) => void;
}

const AppContext = createContext<AppState | null>(null);

/** Zugriff auf den Anwendungszustand. */
export function useApp(): AppState {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp muss innerhalb von <AppProvider> verwendet werden.');
  return context;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ViewName>('home');
  const [history, setHistory] = useState<EditorHistory>(() =>
    createHistory(createEmptyScore({ title: 'Neues Stueck' })),
  );
  const [selection, setSelection] = useState<ScorePosition[]>([]);
  const [clipboard, setClipboard] = useState<Clipboard>({ notes: [] });
  const [audio, setAudioState] = useState<DecodedAudio | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('audio-to-notes-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const playerRef = useRef<ScorePlayer | null>(null);
  if (!playerRef.current) playerRef.current = new ScorePlayer();
  const player = playerRef.current;

  // Design-Modus am Dokument setzen und merken.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('audio-to-notes-theme', theme);
  }, [theme]);

  // Wiedergabe bei jeder Partituraenderung aktualisieren.
  useEffect(() => {
    player.load(history.present);
  }, [history.present, player]);

  // Ressourcen freigeben, wenn die Anwendung endet.
  useEffect(() => () => player.dispose(), [player]);

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((current) => {
      // Gleiche Meldung nicht doppelt stapeln.
      const withoutDuplicate = current.filter((t) => t.message !== message);
      // Hoechstens drei Meldungen gleichzeitig, sonst verdecken sie den Inhalt.
      return [...withoutDuplicate, { id, kind, message }].slice(-3);
    });
    // Hinweise verschwinden von selbst, Fehler bleiben laenger stehen.
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, kind === 'danger' ? 9000 : 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const applyScoreChange = useCallback((next: Score) => {
    setHistory((current) => pushHistory(current, next));
    setHasUnsavedChanges(true);
  }, []);

  const replaceScore = useCallback((next: Score) => {
    setHistory(createHistory(next));
    setSelection([]);
    setHasUnsavedChanges(true);
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => undoHistory(current));
    setSelection([]);
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => redoHistory(current));
    setSelection([]);
  }, []);

  const setAudio = useCallback((next: DecodedAudio | null, blob: Blob | null) => {
    setAudioState(next);
    setAudioBlob(blob);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      notify('danger', `Projekte konnten nicht geladen werden: ${(error as Error).message}`);
    }
  }, [notify]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const saveCurrentProject = useCallback(
    async (name?: string) => {
      try {
        const score = history.present;
        let project: Project;

        if (currentProjectId) {
          const existing = await loadProject(currentProjectId);
          if (existing) {
            project = {
              ...existing,
              name: name ?? existing.name,
              score,
              analysis: analysis ?? existing.analysis,
              audioBlob: audioBlob ?? existing.audioBlob,
            };
          } else {
            project = createProject(name ?? score.title, score, sourceFor(analysis, audioBlob), {
              analysis,
              audioBlob,
            });
          }
        } else {
          project = createProject(
            name ?? (score.title || 'Unbenanntes Projekt'),
            score,
            sourceFor(analysis, audioBlob),
            { analysis, audioBlob, audioFileName: audio?.fileName ?? null },
          );
        }

        const saved = await saveProject(project);
        setCurrentProjectId(saved.id);
        setHasUnsavedChanges(false);
        await refreshProjects();
        notify('success', `Projekt "${saved.name}" gespeichert.`);
      } catch (error) {
        notify('danger', `Speichern fehlgeschlagen: ${(error as Error).message}`);
      }
    },
    [analysis, audio, audioBlob, currentProjectId, history, notify, refreshProjects],
  );

  const openProject = useCallback(
    async (id: string) => {
      try {
        const project = await loadProject(id);
        if (!project) {
          notify('warning', 'Das Projekt wurde nicht gefunden.');
          return;
        }
        setHistory(createHistory(project.score));
        setAnalysis(project.analysis);
        setAudioBlob(project.audioBlob);
        setAudioState(null); // Audio wird bei Bedarf neu dekodiert
        setCurrentProjectId(project.id);
        setSelection([]);
        setHasUnsavedChanges(false);
        setView('editor');
        notify('info', `Projekt "${project.name}" geoeffnet.`);
      } catch (error) {
        notify('danger', `Projekt konnte nicht geoeffnet werden: ${(error as Error).message}`);
      }
    },
    [notify],
  );

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'light' ? 'dark' : 'light'));
  }, []);

  const value = useMemo<AppState>(
    () => ({
      view,
      setView,
      score: history.present,
      applyScoreChange,
      replaceScore,
      undo,
      redo,
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      selection,
      setSelection,
      clipboard,
      setClipboard,
      audio,
      audioBlob,
      setAudio,
      analysis,
      setAnalysis,
      player,
      currentProjectId,
      projects,
      refreshProjects,
      saveCurrentProject,
      openProject,
      hasUnsavedChanges,
      theme,
      toggleTheme,
      toasts,
      notify,
      dismissToast,
    }),
    [
      view, history, applyScoreChange, replaceScore, undo, redo, selection, clipboard,
      audio, audioBlob, setAudio, analysis, player, currentProjectId, projects,
      refreshProjects, saveCurrentProject, openProject, hasUnsavedChanges, theme,
      toggleTheme, toasts, notify, dismissToast,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Leitet die Herkunft eines Projekts ab. */
function sourceFor(analysis: AnalysisResult | null, audioBlob: Blob | null): Project['source'] {
  if (analysis) return 'audio';
  if (audioBlob) return 'audio';
  return 'manual';
}
