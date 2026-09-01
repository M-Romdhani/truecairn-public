import { useQuery } from '@tanstack/react-query';
import type { EngineState } from '@truecairn/shared';
import { Link } from 'react-router-dom';
import { Trans } from 'react-i18next';
import { getEngineStatus } from '../../engine/api.js';
import { useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/useT.js';

// Vault writes are refused while a release/review/returning is in progress
// (apps/api/src/vault/engine-gate.ts — a hard invariant: you can't rewrite what
// is being released). Without this proactive banner the only signal was a 409 at
// save time, which read as a plan/limit bug (QA 2026-07-23 F5). Shown wherever
// vault edits happen, it names the pause and points at the Engine page where the
// owner resolves it. Fail-soft: a failed status fetch hides the banner rather
// than blocking the vault.

// Mirrors the server's LOCKED_FOR_WRITE set. Holds message KEYS, not sentences:
// the reason is rendered at display time so a language change re-renders it, and
// so the copy lives in the catalog with every other translatable string.
const LOCKED_REASON: Partial<Record<EngineState, TranslationKey>> = {
  release_review: 'vault.locked.reason.release_review',
  limited_release: 'vault.locked.reason.limited_release',
  staged_release: 'vault.locked.reason.staged_release',
  full_release: 'vault.locked.reason.full_release',
  returning: 'vault.locked.reason.returning',
  review_required: 'vault.locked.reason.review_required',
};

export function VaultLockBanner({ fetchImpl }: { fetchImpl?: typeof fetch }): JSX.Element | null {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['engine-status'],
    queryFn: () => getEngineStatus(fetchImpl),
    retry: false,
  });
  const state = data?.state ?? null;
  const reasonKey = state !== null ? LOCKED_REASON[state] : undefined;
  if (reasonKey === undefined) return null;
  return (
    <p role="status" className="alert info" data-testid="vault-locked-banner">
      <Trans
        i18nKey="vault.locked.banner"
        values={{ reason: t(reasonKey) }}
        components={{ engine: <Link to="/engine" className="link" /> }}
      />
    </p>
  );
}
