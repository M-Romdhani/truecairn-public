import { CONTACT_PIN_VERSION_V1_S1_TIER_KEY } from '@truecairn/keys';
import { decryptContactLabel } from '../../contacts/crypto.js';
import type {
  ReleaseProgressAffirmation,
  ReleaseProgressCeremony,
  ReleaseProgressRecipient,
} from '../../engine/api.js';
import { formatDateTime } from '../../lib/dates.js';
import { useT, type TFunction } from '../../i18n/useT.js';

// The owner's live view of their release ceremonies: who has affirmed, which
// windows are running, who has retrieved. Transparency that doubles as a
// collusion alarm — if a release is a false positive (or an attack), THIS is
// where the owner sees it, with the protective actions living right above on
// the same screen (check-in / cancel release). Deliberately read-only: this
// panel must never grow a lever of its own that a stolen session could pull.

// Closed sets mirroring what the server can send. Each label is a message key
// derived from the code, so TypeScript checks the whole set against the catalog
// and an unmapped value falls back to the raw enum rather than hiding anything —
// on a safety panel, an awkward label beats a blank.
const TIERS = ['s1', 's2', 's3'] as const;
const STATUSES = [
  'initiated',
  'collecting_affirmations',
  'awaiting_outer_key',
  'reconstructing',
  'released',
  'cancelled',
  'failed',
] as const;
const REASONS = [
  'sync_window_expired_below_threshold',
  'reconstruction_timed_out',
  'user_returned',
  'dispute_raised',
] as const;
const ROLES = ['personal', 'professional', 'recovery'] as const;

const has = (set: readonly string[], v: string): boolean => set.includes(v);
const tierLabel = (v: string, t: TFunction): string =>
  has(TIERS, v) ? t(`release.progress.tier.${v as (typeof TIERS)[number]}`) : v;
const statusLabel = (v: string, t: TFunction): string =>
  has(STATUSES, v) ? t(`release.progress.status.${v as (typeof STATUSES)[number]}`) : v;
const reasonLabel = (v: string, t: TFunction): string =>
  has(REASONS, v) ? t(`release.progress.reason.${v as (typeof REASONS)[number]}`) : v.replace(/_/g, ' ');
const roleLabel = (v: string, t: TFunction): string =>
  has(ROLES, v) ? t(`release.progress.role.${v as (typeof ROLES)[number]}`) : v;

// Labels are decrypted with the session master key on THIS device. If a label
// can't be decrypted (e.g. mid-relock), degrade to a neutral name — never
// crash the safety panel over a display string.
function contactName(ct: string, nonce: string, version: number, t: TFunction): string {
  try {
    return decryptContactLabel(ct, nonce, version);
  } catch {
    return t('release.progress.unnamedContact');
  }
}

function affirmationLine(a: ReleaseProgressAffirmation, t: TFunction): string {
  switch (a.status) {
    case 'tentative':
      return a.revocationWindowExpiresAt !== null
        ? t('release.progress.aff.tentativeUntil', {
            when: formatDateTime(a.revocationWindowExpiresAt),
          })
        : t('release.progress.aff.tentative');
    case 'committed':
      return a.committedAt !== null
        ? t('release.progress.aff.committedAt', { when: formatDateTime(a.committedAt) })
        : t('release.progress.aff.committed');
    case 'revoked':
      return a.revokedAt !== null
        ? t('release.progress.aff.revokedAt', { when: formatDateTime(a.revokedAt) })
        : t('release.progress.aff.revoked');
    default:
      return t('release.progress.aff.none');
  }
}

function recipientLine(r: ReleaseProgressRecipient, t: TFunction): string {
  if (r.status === 'released') {
    return r.completedAt !== null
      ? t('release.progress.rcp.retrievedAt', { when: formatDateTime(r.completedAt) })
      : t('release.progress.rcp.retrieved');
  }
  return t('release.progress.rcp.none');
}

function CeremonyCard({ c }: { c: ReleaseProgressCeremony }): JSX.Element {
  const t = useT();
  const live = !['released', 'cancelled', 'failed'].includes(c.status);
  const gateOpen = c.status === 'reconstructing' || c.status === 'released';
  const reason = c.failureReason ?? c.cancellationReason;
  return (
    <li className="list-row" data-testid={`release-progress-${c.tier}`}>
      <div className="stack flex-1 min-w-0 gap-sm">
        <div className="row-title">
          {tierLabel(c.tier, t)}
          <span className={`badge ${gateOpen ? 'danger' : live ? 'warning' : ''}`} style={{ marginLeft: 8 }}>
            {statusLabel(c.status, t)}
          </span>
        </div>
        <div className="small t-2" data-testid={`release-progress-${c.tier}-consensus`}>
          {t('release.progress.consensus', { committed: c.committed, threshold: c.threshold })}
          {c.status === 'collecting_affirmations' &&
            t('release.progress.windowCloses', {
              when: formatDateTime(c.syncWindowExpiresAt),
            })}
          {c.reconstructionStartedAt !== null &&
            t('release.progress.gateOpened', {
              when: formatDateTime(c.reconstructionStartedAt),
            })}
        </div>
        {reason !== null && (
          <div className="small t-2">{reasonLabel(reason, t)}</div>
        )}
        <ul className="list">
          {c.affirmations.map((a) => (
            <li key={a.contactId} className="small t-2" data-testid={`release-progress-aff-${a.contactId}`}>
              {contactName(
                a.displayLabelCiphertext,
                a.displayLabelNonce,
                a.contactPinVersion ?? CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
                t,
              )}
              {' · '}
              {roleLabel(a.role, t)}
              {' · '}
              {affirmationLine(a, t)}
            </li>
          ))}
          {gateOpen &&
            c.recipients.map((r) => (
              <li key={`r-${r.contactId}`} className="small t-2" data-testid={`release-progress-rcp-${r.contactId}`}>
                {contactName(
                  r.displayLabelCiphertext,
                  r.displayLabelNonce,
                  r.contactPinVersion ?? CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
                  t,
                )}
                {' · '}
                {recipientLine(r, t)}
              </li>
            ))}
        </ul>
      </div>
    </li>
  );
}

export function ReleaseProgressPanel({
  ceremonies,
}: {
  ceremonies: ReleaseProgressCeremony[];
}): JSX.Element | null {
  const t = useT();
  if (ceremonies.length === 0) return null;
  return (
    <section className="card" data-testid="release-progress">
      <header className="card-h">
        <div>
          <h2 className="h-section">{t('release.progress.heading')}</h2>
          <p className="small">{t('release.progress.lede')}</p>
        </div>
      </header>
      <ul className="list">
        {ceremonies.map((c) => (
          <CeremonyCard key={c.ceremonyId} c={c} />
        ))}
      </ul>
    </section>
  );
}
