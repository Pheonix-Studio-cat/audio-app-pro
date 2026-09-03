/**
 * Wiederverwendbare Bausteine der Oberflaeche.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** Karte mit Titel und optionaler Beschreibung. */
export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="row-between" style={{ marginBottom: subtitle ? 2 : 12 }}>
          {title && <h3 className="card-title">{title}</h3>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {subtitle && <div className="card-subtitle">{subtitle}</div>}
      {children}
    </section>
  );
}

/** Farbig hinterlegter Hinweis. */
export function Notice({
  kind = 'info',
  icon,
  children,
}: {
  kind?: 'info' | 'warning' | 'danger' | 'success';
  icon?: string;
  children: ReactNode;
}) {
  const defaultIcons = { info: 'i', warning: '!', danger: '!', success: '+' };
  return (
    <div className={`notice notice-${kind}`}>
      <span className="notice-icon" aria-hidden="true">
        {icon ?? defaultIcons[kind]}
      </span>
      <div>{children}</div>
    </div>
  );
}

/** Kennzahl-Kachel. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/** Fortschrittsbalken mit optionaler Beschriftung. */
export function ProgressBar({
  value,
  label,
  variant,
}: {
  value: number;
  label?: string;
  variant?: 'success' | 'warning';
}) {
  const percent = Math.max(0, Math.min(100, value * 100));
  return (
    <div>
      {label && (
        <div className="row-between tiny muted" style={{ marginBottom: 4 }}>
          <span>{label}</span>
          <span className="mono">{Math.round(percent)} %</span>
        </div>
      )}
      <div className="progress-track">
        <div
          className={`progress-fill${variant ? ` ${variant}` : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Datei-Ablagebereich mit Klick- und Drag-Unterstuetzung.
 */
export function DropZone({
  accept,
  title,
  hint,
  icon,
  multiple = false,
  disabled = false,
  onFiles,
}: {
  accept: string;
  title: string;
  hint: ReactNode;
  icon?: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      onFiles(Array.from(fileList));
    },
    [onFiles],
  );

  return (
    <div
      className={`dropzone${active ? ' active' : ''}`}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setActive(false);
        if (!disabled) handleFiles(event.dataTransfer.files);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      aria-disabled={disabled}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    >
      <div className="dropzone-icon" aria-hidden="true">{icon ?? '+'}</div>
      <div className="dropzone-title">{title}</div>
      <div className="dropzone-hint">{hint}</div>
      <input
        ref={inputRef}
        type="file"
        className="hidden-input"
        accept={accept}
        multiple={multiple}
        onChange={(event) => {
          handleFiles(event.target.files);
          // Zuruecksetzen, damit dieselbe Datei erneut gewaehlt werden kann.
          event.target.value = '';
        }}
      />
    </div>
  );
}

/** Modaler Dialog. */
export function Modal({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <div className="row-between">
            <h2>{title}</h2>
            <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Schliessen">
              X
            </button>
          </div>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Beschriftetes Eingabefeld. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="tiny faint">{hint}</div>}
    </div>
  );
}

/** Umschaltbare Schaltflaeche. */
export function ToggleButton({
  active,
  onClick,
  title,
  children,
  disabled,
  small,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <button
      className={`btn${small ? ' btn-sm' : ''}${active ? ' toggled' : ''}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

/** Leerzustand mit Symbol und Hinweistext. */
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      <h3 style={{ marginBottom: 6 }}>{title}</h3>
      {children}
    </div>
  );
}

/** Sicherheit als farbiges Abzeichen. */
export function ConfidenceBadge({ value, label }: { value: number; label?: string }) {
  const percent = Math.round(value * 100);
  const kind = value >= 0.7 ? 'success' : value >= 0.45 ? 'warning' : 'danger';
  return (
    <span className={`badge badge-${kind}`}>
      {label ? `${label}: ` : ''}
      {percent} % sicher
    </span>
  );
}

/** Formatiert Sekunden als m:ss. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

/** Formatiert Byte-Angaben lesbar. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Formatiert einen Zeitstempel als deutsches Datum. */
export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
