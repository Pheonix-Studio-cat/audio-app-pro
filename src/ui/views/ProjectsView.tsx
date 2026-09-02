/**
 * Projektverwaltung: Projekte oeffnen, umbenennen, loeschen, sichern
 * und wieder einlesen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../app-state';
import { Card, EmptyState, Modal, Notice, formatBytes, formatDate } from '../components/common';
import {
  deleteProject,
  estimateStorageUsage,
  exportProjectJson,
  importProjectJson,
  loadProject,
  renameProject,
  saveProject,
} from '../../engines/projects/project-store';
import { downloadBlob, safeFileName } from '../../engines/export/score-export';

export function ProjectsView() {
  const { projects, refreshProjects, openProject, currentProjectId, notify } = useApp();

  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void estimateStorageUsage().then(setStorage);
  }, [projects]);

  const handleRename = useCallback(async () => {
    if (!renameTarget) return;
    try {
      await renameProject(renameTarget.id, renameTarget.name.trim() || 'Unbenannt');
      await refreshProjects();
      notify('success', 'Projekt umbenannt.');
    } catch (error) {
      notify('danger', `Umbenennen fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setRenameTarget(null);
    }
  }, [notify, refreshProjects, renameTarget]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteProject(deleteTarget.id);
      await refreshProjects();
      notify('success', `Projekt "${deleteTarget.name}" geloescht.`);
    } catch (error) {
      notify('danger', `Loeschen fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, notify, refreshProjects]);

  const handleBackup = useCallback(
    async (id: string, name: string) => {
      try {
        const project = await loadProject(id);
        if (!project) return;
        const blob = await exportProjectJson(project);
        downloadBlob(blob, safeFileName(name, 'json'));
        notify('success', 'Projektsicherung gespeichert.');
      } catch (error) {
        notify('danger', `Sicherung fehlgeschlagen: ${(error as Error).message}`);
      }
    },
    [notify],
  );

  const handleImport = useCallback(
    async (file: File) => {
      try {
        const project = await importProjectJson(file);
        await saveProject(project);
        await refreshProjects();
        notify('success', `Projekt "${project.name}" eingelesen.`);
      } catch (error) {
        notify('danger', `Einlesen fehlgeschlagen: ${(error as Error).message}`);
      }
    },
    [notify, refreshProjects],
  );

  return (
    <div className="view">
      <header className="view-header">
        <div className="row-between">
          <div>
            <h1>Meine Projekte</h1>
            <p style={{ marginBottom: 0 }}>
              Projekte enthalten Partitur, Analyseergebnis, Originalton und Uebungsfortschritt.
            </p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => importInputRef.current?.click()}>
              Sicherung einlesen
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
                event.target.value = '';
              }}
            />
          </div>
        </div>
      </header>

      <Notice kind="info">
        Alle Projekte liegen ausschliesslich in der lokalen Datenbank dieses Browsers. Wenn du
        die Browserdaten loeschst, sind sie weg. Lege deshalb wichtige Arbeiten zusaetzlich als
        Sicherung ab.
        {storage && storage.quota > 0 && (
          <>
            {' '}
            Belegt: {formatBytes(storage.used)} von {formatBytes(storage.quota)}.
          </>
        )}
      </Notice>

      <Card title={`${projects.length} Projekt(e)`}>
        {projects.length === 0 ? (
          <EmptyState icon="▤" title="Noch keine Projekte gespeichert">
            <p className="small">
              Analysiere eine Audiodatei oder schreibe eigene Noten und speichere das Ergebnis
              im Editor.
            </p>
          </EmptyState>
        ) : (
          <div className="list">
            {projects.map((project) => (
              <div key={project.id} className="list-row">
                <div className="list-row-main">
                  <div className="list-row-title">
                    {project.name}
                    {project.id === currentProjectId && (
                      <span className="badge badge-accent" style={{ marginLeft: 8 }}>
                        geoeffnet
                      </span>
                    )}
                  </div>
                  <div className="list-row-meta">
                    <span>
                      {project.source === 'audio'
                        ? 'aus Audio'
                        : project.source === 'video'
                          ? 'aus Video'
                          : 'selbst geschrieben'}
                    </span>
                    <span>{project.measureCount} Takte</span>
                    <span>{project.noteCount} Noten</span>
                    <span>{project.tempo} BPM</span>
                    {project.hasAudio && <span>mit Originalton</span>}
                    {project.practice.sessions > 0 && (
                      <span>
                        {project.practice.sessions} Uebung(en), beste Quote{' '}
                        {Math.round(project.practice.bestAccuracy * 100)} %
                      </span>
                    )}
                    <span>Zuletzt: {formatDate(project.updatedAt)}</span>
                  </div>
                </div>
                <button className="btn btn-sm btn-primary" onClick={() => void openProject(project.id)}>
                  Oeffnen
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setRenameTarget({ id: project.id, name: project.name })}
                >
                  Umbenennen
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void handleBackup(project.id, project.name)}
                >
                  Sichern
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => setDeleteTarget({ id: project.id, name: project.name })}
                >
                  Loeschen
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {renameTarget && (
        <Modal
          title="Projekt umbenennen"
          onClose={() => setRenameTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRenameTarget(null)}>
                Abbrechen
              </button>
              <button className="btn btn-primary" onClick={() => void handleRename()}>
                Speichern
              </button>
            </>
          }
        >
          <input
            type="text"
            value={renameTarget.name}
            autoFocus
            onChange={(event) =>
              setRenameTarget((current) => (current ? { ...current, name: event.target.value } : null))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleRename();
            }}
          />
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title="Projekt loeschen"
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleteTarget(null)}>
                Abbrechen
              </button>
              <button className="btn btn-danger" onClick={() => void handleDelete()}>
                Endgueltig loeschen
              </button>
            </>
          }
        >
          <p>
            Soll das Projekt <strong>{deleteTarget.name}</strong> wirklich geloescht werden?
            Dieser Schritt kann nicht rueckgaengig gemacht werden.
          </p>
          <p className="small muted">
            Tipp: Lege vorher ueber "Sichern" eine Datei an, falls du das Projekt spaeter
            noch brauchst.
          </p>
        </Modal>
      )}
    </div>
  );
}
