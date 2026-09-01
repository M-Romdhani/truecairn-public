import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listContacts } from '../contacts/api.js';
import { CONTACT_PIN_VERSION_V1_S1_TIER_KEY } from '@truecairn/keys';
import { decryptContactLabel } from '../contacts/crypto.js';
import { listItems } from '../vault/api.js';
import { decryptTitle } from '../vault/crypto.js';
import { useT, type TFunction } from '../i18n/useT.js';
import './command-palette.css';

// ── The ⌘K command palette ───────────────────────────────────────────────────
//
// The sidebar has advertised "⌘ K" since the design landed, over an <input> with
// no handler on it — a shortcut the chrome promised and nothing implemented.
// This is that promise kept.
//
// EVERYTHING IT SEARCHES IS ALREADY ON THIS DEVICE IN THE CLEAR. Vault titles and
// contact labels are decrypted client-side from the tier key and the master key
// respectively (the same decryptTitle / decryptContactLabel the Vault and
// Contacts screens call), so matching them costs no request and reveals nothing
// to the server. The query string is never sent anywhere — there is no search
// endpoint behind this, deliberately, and the footer says so on screen.
//
// The rows are therefore a LOCAL projection, and the palette must never grow a
// server-side search: that would turn "what is in my vault" into a query the
// server can see, which is precisely the property the product sells.

export interface PaletteAction {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

// Fetch only while OPEN. AppShell renders on every authed route, so an
// unconditional query here would put two extra requests on every page load to
// populate a list nobody has asked for yet.
function useLocalRows(open: boolean, t: TFunction): PaletteAction[] {
  const navigate = useNavigate();
  // The CANONICAL keys the Vault and Contacts screens already use, not private
  // 'palette' ones. Same data under two names is two fetches and two caches that
  // can disagree — opening the palette on /contacts would otherwise re-fetch a
  // list already on screen.
  const vaultQ = useQuery({
    queryKey: ['vault-items', ''],
    queryFn: () => listItems(),
    enabled: open,
  });
  const contactsQ = useQuery({
    queryKey: ['contacts'],
    queryFn: () => listContacts(),
    enabled: open,
  });

  return useMemo(() => {
    const rows: PaletteAction[] = [];

    // A locked vault (or a title still sealed under an old tier key) must cost
    // one row, never the palette — the same containment VaultList applies.
    for (const it of vaultQ.data?.items ?? []) {
      let title: string;
      try {
        title = decryptTitle(it);
      } catch {
        continue;
      }
      if (title.trim() === '') continue;
      rows.push({
        id: `vault:${it.id}`,
        label: title,
        group: t('palette.group.vault'),
        // react-router 7 returns a promise from navigate(); a route change is
        // genuinely fire-and-forget here, so the void is the intent, not a silencer.
        run: () => void navigate(`/vault/${it.id}`),
      });
    }

    for (const c of contactsQ.data?.contacts ?? []) {
      let label: string;
      try {
        label = decryptContactLabel(c.displayLabelCiphertext, c.displayLabelNonce, c.contactPinVersion ?? CONTACT_PIN_VERSION_V1_S1_TIER_KEY);
      } catch {
        continue;
      }
      if (label.trim() === '') continue;
      rows.push({
        id: `contact:${c.contactId}`,
        label,
        group: t('palette.group.contacts'),
        run: () => void navigate('/contacts'),
      });
    }

    return rows;
  }, [vaultQ.data, contactsQ.data, navigate, t]);
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}): JSX.Element | null {
  const t = useT();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Where focus came from, so closing returns it there rather than to <body>.
  const restoreTo = useRef<HTMLElement | null>(null);

  const navRows: PaletteAction[] = useMemo(
    () =>
      [
        ['/home', 'palette.go.home'],
        ['/vault', 'palette.go.vault'],
        ['/plans', 'palette.go.plans'],
        ['/contacts', 'palette.go.contacts'],
        ['/engine', 'palette.go.engine'],
        ['/ceremony', 'palette.go.ceremony'],
        ['/assistant', 'palette.go.assistant'],
        ['/settings', 'palette.go.settings'],
        ['/contacts/accept', 'palette.go.acceptInvite'],
      ].map(([to, key]) => ({
        id: `go:${to!}`,
        label: t(key as Parameters<TFunction>[0]),
        group: t('palette.group.go'),
        run: () => void navigate(to!),
      })),
    [navigate, t],
  );

  const localRows = useLocalRows(open, t);
  const all = useMemo(() => [...navRows, ...localRows], [navRows, localRows]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter((r) => r.label.toLowerCase().includes(needle));
  }, [all, q]);

  // ⌘K / Ctrl+K toggles from anywhere in the authed app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    setQ('');
    setCursor(0);
    inputRef.current?.focus();
    return () => restoreTo.current?.focus();
  }, [open]);

  // Clamp the cursor whenever filtering shortens the list under it.
  useEffect(() => setCursor((c) => (c >= rows.length ? 0 : c)), [rows.length]);

  if (!open) return null;

  const close = (): void => onOpenChange(false);
  const runAt = (i: number): void => {
    const row = rows[i];
    if (row === undefined) return;
    close();
    row.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c + 1) % rows.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c - 1 + rows.length) % rows.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runAt(cursor);
    }
  };

  return (
    <div
      className="pal-scrim"
      role="presentation"
      onClick={close}
      data-testid="command-palette"
    >
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.label')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="pal-head">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="pal-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={rows[cursor] !== undefined ? `pal-row-${cursor}` : undefined}
            autoComplete="off"
          />
          <span className="kbd">{t('palette.esc')}</span>
        </div>

        <div className="pal-list" id="pal-list" role="listbox" ref={listRef} aria-label={t('palette.label')}>
          {rows.map((r, i) => (
            <button
              key={r.id}
              id={`pal-row-${i}`}
              type="button"
              role="option"
              aria-selected={i === cursor}
              className={`pal-row${i === cursor ? ' active' : ''}`}
              onClick={() => runAt(i)}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="pal-row-label">{r.label}</span>
              <span className="mono t-3 pal-row-group">{r.group}</span>
            </button>
          ))}
          {rows.length === 0 && (
            <div className="pal-empty">
              <div className="empty-line" />
              <p className="small">{t('palette.empty')}</p>
            </div>
          )}
        </div>

        <div className="pal-foot">
          <span className="small t-3">{t('palette.hint.move')}</span>
          <span className="small t-3">{t('palette.hint.run')}</span>
          <span className="small t-3 pal-foot-note">{t('palette.hint.local')}</span>
        </div>
      </div>
    </div>
  );
}
