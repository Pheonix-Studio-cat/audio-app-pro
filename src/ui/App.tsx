/**
 * Anwendungsrahmen: Navigation, Ansichtswechsel und Statusmeldungen.
 */
import { useEffect } from 'react';
import { useApp, type ViewName } from './app-state';
import { HomeView } from './views/HomeView';
import { AudioToNotesView } from './views/AudioToNotesView';
import { VideoToAudioView } from './views/VideoToAudioView';
import { EditorView } from './views/EditorView';
import { PracticeView } from './views/PracticeView';
import { ProjectsView } from './views/ProjectsView';
import { ExportView } from './views/ExportView';
import { SettingsView } from './views/SettingsView';

interface NavEntry {
  view: ViewName;
  label: string;
  icon: string;
  section: string;
}

const NAV_ENTRIES: NavEntry[] = [
  { view: 'home', label: 'Start', icon: '⌂', section: 'Uebersicht' },
  { view: 'projects', label: 'Meine Projekte', icon: '▤', section: 'Uebersicht' },
  { view: 'audio-to-notes', label: 'Audio zu Noten', icon: '♫', section: 'Umwandeln' },
  { view: 'video-to-audio', label: 'Video zu Audio', icon: '▶', section: 'Umwandeln' },
  { view: 'editor', label: 'Noteneditor', icon: '♬', section: 'Arbeiten' },
  { view: 'practice', label: 'Ueben', icon: '●', section: 'Arbeiten' },
  { view: 'export', label: 'Exportieren', icon: '⤓', section: 'Arbeiten' },
  { view: 'settings', label: 'Einstellungen', icon: '⚙', section: 'System' },
];

export function App() {
  const { view, setView, theme, toggleTheme, toasts, dismissToast, hasUnsavedChanges } = useApp();

  // Warnung beim Verlassen, wenn ungespeicherte Aenderungen bestehen.
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  const sections = [...new Set(NAV_ENTRIES.map((entry) => entry.section))];

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Hauptnavigation">
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark" aria-hidden="true">
            &#9835;
          </div>
          <div className="sidebar-brand-text">
            <strong>Audio-to-Notes</strong>
            <span>Studio</span>
          </div>
        </div>

        <div className="sidebar-nav">
          {sections.map((section) => (
            <div key={section}>
              <div className="sidebar-section-label">{section}</div>
              {NAV_ENTRIES.filter((entry) => entry.section === section).map((entry) => (
                <button
                  key={entry.view}
                  className={`nav-item${view === entry.view ? ' active' : ''}`}
                  onClick={() => setView(entry.view)}
                  aria-current={view === entry.view ? 'page' : undefined}
                >
                  <span className="nav-item-icon" aria-hidden="true">
                    {entry.icon}
                  </span>
                  {entry.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <button className="btn btn-sm btn-ghost" onClick={toggleTheme} style={{ width: '100%' }}>
            {theme === 'dark' ? 'Helles Design' : 'Dunkles Design'}
          </button>
          <div className="mt-1 tiny">
            Alle Analysen laufen lokal in deinem Browser.
          </div>
        </div>
      </nav>

      <main className="main">
        {view === 'home' && <HomeView />}
        {view === 'audio-to-notes' && <AudioToNotesView />}
        {view === 'video-to-audio' && <VideoToAudioView />}
        {view === 'editor' && <EditorView />}
        {view === 'practice' && <PracticeView />}
        {view === 'projects' && <ProjectsView />}
        {view === 'export' && <ExportView />}
        {view === 'settings' && <SettingsView />}
      </main>

      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            bottom: 20,
            right: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            zIndex: 200,
            maxWidth: 420,
          }}
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`notice notice-${toast.kind}`}
              style={{ boxShadow: 'var(--shadow-lg)', background: 'var(--bg-elevated)' }}
              role="status"
            >
              <div style={{ flex: 1 }}>{toast.message}</div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => dismissToast(toast.id)}
                aria-label="Meldung schliessen"
              >
                X
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
