import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { fetchAccount } from '../account/keyMaterial.js';
import { useSignOut } from '../auth/useSignOut.js';
import { fetchBillingStatus } from '../billing/api.js';
import { useSession } from '../crypto/session.js';
import { useT } from '../i18n/useT.js';
import './account-menu.css';

// The sidebar account menu (2026 design): a header with the owner's name, email
// and plan, then plain text rows — no leading icons — with Sign out separated at
// the foot. A trigger chip at the foot of the sidebar shows the name + plan (like
// the reference apps) and opens the menu upward. Avatar initials derive from the
// display name (or the email) locally — nothing leaves the browser.

// Initials from the display name (first letters of the first two words) or, when
// no name is set, from the email's local part. Local — nothing leaves the browser.
function initialsFor(name: string | null, email: string | undefined): string {
  if (name !== null && name.trim() !== '') {
    const words = name.trim().split(/\s+/).filter((w) => w.length > 0);
    const letters = words.length >= 2 ? `${words[0]![0]!}${words[1]![0]!}` : name.slice(0, 2);
    return letters.toUpperCase();
  }
  if (email === undefined || email.trim() === '') return '·';
  const local = email.split('@')[0] ?? email;
  const tokens = local.split(/[._+-]+/).filter((t) => t.length > 0);
  const letters = tokens.length >= 2 ? `${tokens[0]![0]!}${tokens[1]![0]!}` : local.slice(0, 2);
  return letters.toUpperCase();
}

// The name shown on the chip: the honorific (if any) followed by the display
// name. Null when the owner has set no name — the chip falls back to a generic
// label so it is never empty.
function formatName(title: string | null, displayName: string | null): string | null {
  if (displayName === null || displayName.trim() === '') return null;
  return title !== null && title !== '' ? `${title} ${displayName}` : displayName;
}

const IcUnfold = (): JSX.Element => (
  <svg className="acct-unfold" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function AccountMenu(): JSX.Element {
  const t = useT();
  const { status } = useSession();
  const { signOut, signingOut } = useSignOut();
  const { pathname } = useLocation();
  const accountQ = useQuery({ queryKey: ['account', 'me'], queryFn: () => fetchAccount() });
  const email = accountQ.data?.email;
  const fullName = formatName(accountQ.data?.title ?? null, accountQ.data?.displayName ?? null);
  // Plan tier for the chip (like the reference apps' "· Pro"). 'pro' is the paid
  // "Truecairn Personal" plan; everything else is the free tier.
  const billingQ = useQuery({ queryKey: ['billing', 'status'], queryFn: () => fetchBillingStatus() });
  const tierLabel =
    billingQ.data?.plan === 'pro' ? t('account.plan.personal') : t('account.plan.free');

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Close on route change (following any link in the menu dismisses it).
  useEffect(() => setOpen(false), [pathname]);

  // Close on outside-click and on Escape; Escape returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Arrow-key navigation within the open menu (it carries role="menu").
  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(
      popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % items.length;
    else if (e.key === 'ArrowUp') next = idx <= 0 ? items.length - 1 : idx - 1;
    else if (e.key === 'End') next = items.length - 1;
    items[next]?.focus();
  }

  const initials = initialsFor(accountQ.data?.displayName ?? null, email);
  const statusLine =
    status === 'unlocked' ? t('account.menu.vaultUnlocked') : t('account.menu.vaultLocked');

  return (
    <div className="acct" ref={rootRef}>
      {open && (
        <div className="acct-pop" id="account-menu" role="menu" aria-label={t('account.menu.label')} ref={popRef} onKeyDown={onMenuKeyDown}>
          <div className="acct-head">
            {fullName !== null && <div className="acct-head-name">{fullName}</div>}
            <div className="acct-head-email" data-testid="account-email">
              {email ?? '—'}
            </div>
            <div className="acct-head-status">
              {tierLabel} · {statusLine}
            </div>
          </div>

          <div className="acct-sep" />
          <Link role="menuitem" className="acct-item" to="/settings">
            <span className="acct-item-label">{t('account.menu.settings')}</span>
          </Link>
          <Link role="menuitem" className="acct-item" to="/plans">
            <span className="acct-item-label">{t('account.menu.plans')}</span>
          </Link>
          <Link role="menuitem" className="acct-item" to="/guide">
            <span className="acct-item-label">{t('account.menu.guide')}</span>
          </Link>

          <div className="acct-sep" />
          <button
            type="button"
            role="menuitem"
            className="acct-item danger"
            disabled={signingOut}
            onClick={() => void signOut()}
          >
            <span className="acct-item-label">
              {signingOut ? t('account.menu.signingOut') : t('account.menu.signOut')}
            </span>
          </button>
        </div>
      )}

      <button
        type="button"
        className="acct-trigger"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="avi sm" aria-hidden="true">
          {initials}
        </div>
        <div className="stack acct-label">
          <div className="acct-trigger-name">{fullName ?? t('account.menu.yourAccount')}</div>
          <div className="acct-trigger-status">
            <span className="acct-trigger-tier">{tierLabel}</span>
            <span aria-hidden="true"> · </span>
            {/* Kept as its own node with exactly the status word so the E2E and
                unit hooks that assert lock-status text keep matching. */}
            <span data-testid="lock-status">{status}</span>
          </div>
        </div>
        <IcUnfold />
      </button>
    </div>
  );
}
