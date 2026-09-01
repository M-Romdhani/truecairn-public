import { useRef, useState, type DragEvent } from 'react';
import { useT } from '../i18n/useT.js';
import { formatBytes } from '../lib/format.js';

// Reusable file picker: a drag-and-drop zone + a multi-select <input>, plus the
// selected-file list with per-file remove. Stateless about encryption/upload —
// it only manages the chosen File[]; the caller decides when to encrypt+upload.
// Shared by the create form (attach-at-creation) and the item detail (add-later)
// so the two surfaces behave identically and never drift.
export function AttachmentPicker({
  files,
  onChange,
  disabled = false,
  idPrefix,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  // Distinguishes the two mount points for stable test ids / input ids.
  idPrefix: string;
}): JSX.Element {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function add(list: FileList | null): void {
    if (list === null) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      // De-dupe on (name, size) so a double drop doesn't upload twice.
      if (!next.some((e) => e.name === f.name && e.size === f.size)) next.push(f);
    }
    onChange(next);
    // Clear the native input so re-selecting the same file still fires onChange.
    if (inputRef.current) inputRef.current.value = '';
  }

  function remove(index: number): void {
    onChange(files.filter((_, i) => i !== index));
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    add(e.dataTransfer.files);
  }

  return (
    <div className="stack gap-sm">
      <div
        className={`dropzone${dragOver ? ' dropzone-over' : ''}`}
        data-testid={`${idPrefix}-dropzone`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <p className="small t-2">{t('vault.attach.dropHint')}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="input"
          data-testid={`${idPrefix}-file`}
          disabled={disabled}
          onChange={(e) => add(e.target.files)}
        />
        <p className="small t-3">{t('vault.attach.encryptedNote')}</p>
      </div>
      {files.length > 0 && (
        <ul className="pick-list" data-testid={`${idPrefix}-picklist`}>
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${i}`} className="row between middle gap-md">
              <span className="small">
                {f.name} · {formatBytes(f.size)}
              </span>
              <button
                type="button"
                className="btn secondary sm"
                disabled={disabled}
                data-testid={`${idPrefix}-remove-${i}`}
                onClick={() => remove(i)}
              >
                {t('vault.attach.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
