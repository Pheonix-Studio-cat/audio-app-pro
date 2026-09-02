/**
 * Startseite: Einstiegspunkte in die vier Hauptablaeufe und die zuletzt
 * bearbeiteten Projekte.
 */
import { useApp } from '../app-state';
import { Card, EmptyState, formatDate } from '../components/common';
import { createEmptyScore } from '../../core/score-model';
import { probeFormatSupport } from '../../engines/audio/audio-engine';

export function HomeView() {
  const { setView, projects, openProject, replaceScore, notify } = useApp();

  const audioFormats = probeFormatSupport('audio');
  const videoFormats = probeFormatSupport('video');
  const supportedAudio = audioFormats.filter((f) => f.supported).map((f) => f.label);
  const unsupportedAudio = audioFormats.filter((f) => !f.supported).map((f) => f.label);

  const startNewScore = () => {
    replaceScore(createEmptyScore({ title: 'Neues Stueck' }));
    setView('editor');
    notify('info', 'Eine leere Partitur mit vier Takten wurde angelegt.');
  };

  const actions = [
    {
      icon: '♫',
      title: 'Audio importieren',
      description: 'Aus einer Tonaufnahme automatisch Noten erzeugen und danach korrigieren.',
      onClick: () => setView('audio-to-notes'),
      primary: true,
    },
    {
      icon: '▶',
      title: 'Video importieren',
      description: 'Die Tonspur eines Videos extrahieren, speichern oder direkt analysieren.',
      onClick: () => setView('video-to-audio'),
    },
    {
      icon: '♬',
      title: 'Neue Noten schreiben',
      description: 'Mit einer leeren Partitur beginnen und eigene Musik notieren.',
      onClick: startNewScore,
    },
    {
      icon: '●',
      title: 'Ueben',
      description: 'Noten mit dem Mikrofon nachspielen und sofortige Rueckmeldung erhalten.',
      onClick: () => setView('practice'),
    },
  ];

  const recentProjects = projects.slice(0, 5);

  return (
    <div className="view">
      <header className="view-header">
        <h1>Audio-to-Notes Studio</h1>
        <p>
          Wandle Aufnahmen in echte Notenschrift um, bearbeite sie in einem
          vollstaendigen Noteneditor, exportiere sie als PDF, Bild, MusicXML oder
          MIDI und uebe sie mit dem Mikrofon. Alles laeuft lokal in deinem Browser.
        </p>
      </header>

      <div className="grid grid-2">
        {actions.map((action) => (
          <button
            key={action.title}
            className="card"
            onClick={action.onClick}
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              font: 'inherit',
              color: 'inherit',
              borderColor: action.primary ? 'var(--accent)' : undefined,
            }}
          >
            <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
              <div
                aria-hidden="true"
                style={{
                  fontSize: 22,
                  width: 42,
                  height: 42,
                  borderRadius: 11,
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                {action.icon}
              </div>
              <div style={{ flex: 1 }}>
                <h3 style={{ marginBottom: 4 }}>{action.title}</h3>
                <div className="small muted">{action.description}</div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-2">
        <Card title="Zuletzt bearbeitet" subtitle="Projekte werden nur in diesem Browser gespeichert.">
          {recentProjects.length === 0 ? (
            <EmptyState icon="▤" title="Noch keine Projekte">
              <p className="small">
                Sobald du eine Partitur speicherst, erscheint sie hier.
              </p>
            </EmptyState>
          ) : (
            <div className="list">
              {recentProjects.map((project) => (
                <div key={project.id} className="list-row">
                  <div className="list-row-main">
                    <div className="list-row-title">{project.name}</div>
                    <div className="list-row-meta">
                      <span>{project.measureCount} Takte</span>
                      <span>{project.noteCount} Noten</span>
                      <span>{formatDate(project.updatedAt)}</span>
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={() => void openProject(project.id)}>
                    Oeffnen
                  </button>
                </div>
              ))}
              {projects.length > recentProjects.length && (
                <button className="btn btn-ghost btn-sm" onClick={() => setView('projects')}>
                  Alle {projects.length} Projekte anzeigen
                </button>
              )}
            </div>
          )}
        </Card>

        <Card
          title="Was dein Browser unterstuetzt"
          subtitle="Die Formatliste wird zur Laufzeit ermittelt, nicht geraten."
        >
          <div className="small">
            <strong>Audio direkt lesbar:</strong>{' '}
            {supportedAudio.length > 0 ? supportedAudio.join(', ') : 'keine'}
          </div>
          {unsupportedAudio.length > 0 && (
            <div className="small muted mt-1">
              <strong>Nicht direkt lesbar:</strong> {unsupportedAudio.join(', ')}. Diese Dateien
              werden beim Import ueber ffmpeg umgewandelt.
            </div>
          )}
          <div className="small mt-2">
            <strong>Video:</strong>{' '}
            {videoFormats
              .map((f) => `${f.label}${f.supported ? '' : ' (ueber ffmpeg)'}`)
              .join(', ')}
          </div>

          <div className="notice notice-info mt-2">
            <span className="notice-icon">i</span>
            <div>
              <strong>Datenschutz:</strong> Deine Dateien und Mikrofonaufnahmen werden
              ausschliesslich auf diesem Geraet verarbeitet. Es findet kein Upload statt,
              und es wird kein externer Dienst kontaktiert.
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
