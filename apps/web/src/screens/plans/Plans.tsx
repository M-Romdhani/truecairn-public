import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { VaultTier } from '@truecairn/shared';
import { fetchBillingStatus, fetchUsage } from '../../billing/api.js';
import { formatBytes } from '../../billing/pricing.js';
import { listContacts } from '../../contacts/api.js';
import { formatDateTime } from '../../lib/dates.js';
import { listItems } from '../../vault/api.js';
import { useT } from '../../i18n/useT.js';

// Continuity plans (design follow-on) — a READ-ONLY overview of the release
// ladder, derived from real data: vault items grouped by tier, and the trusted
// contacts who can hold shares. No separate "plans" backend; this consolidates
// what already exists (vault tiers + contacts + the locked consensus rules from
// docs/01) into one designed view. Rendered inside AppShell.

// Release copy describes the SHIPPED mechanics (docs/24). The two sensitive tiers
// treat the release passphrase DIFFERENTLY, and the copy must keep them distinct:
//   S2 — a flat 2-of-3 Shamir split where the release passphrase is one of the
//        three shares (the reserved last index): "any 2 of 3" reconstruct, so the
//        passphrase is an OPTIONAL fallback (two contacts suffice without it).
//   S3 — the nested scheme: the release passphrase is a MANDATORY mask over a
//        2-of-3 split held by three contacts. Reconstruction needs the passphrase
//        AND any 2 of 3 contacts; there is no contacts-only path, and losing the
//        passphrase makes S3 permanently unrecoverable. Not the old flat
//        four-share framing, and the passphrase is never "just a share" for S3.
// The rungs, as tiers. Their name/rule/need copy lives in the catalog keyed by
// tier — the distinction between S2's optional passphrase and S3's mandatory one
// is load-bearing and the catalog carries that note with the strings.
const LADDER: readonly VaultTier[] = ['s1', 's2', 's3'];

export function Plans(): JSX.Element {
  const t = useT();
  const vaultQ = useQuery({ queryKey: ['plans', 'vault'], queryFn: () => listItems() });
  const contactsQ = useQuery({ queryKey: ['plans', 'contacts'], queryFn: () => listContacts() });

  const items = vaultQ.data?.items ?? [];
  const contacts = contactsQ.data?.contacts ?? [];
  const enrolled = contacts.filter((c) => c.x25519Pubkey !== null).length;

  return (
    <section aria-labelledby="plans" className="app-col">
      <header className="page-head">
        <div>
          <div className="hint">{t('plans.eyebrow')}</div>
          <h1 id="plans" className="h-page">
            {t('plans.heading')}
          </h1>
          <p className="small t-2">{t('plans.lede')}</p>
        </div>
      </header>

      <div className="stack gap-md">
        <SubscriptionCard />

        <section className="card card-pad row between middle gap-md">
          <div className="stack min-w-0">
            <div className="row-title">{t('plans.contacts.title')}</div>
            <div className="small t-2">
              {t('plans.contacts.count', { count: contacts.length, enrolled })}
            </div>
          </div>
          <Link className="btn secondary sm" to="/contacts">
            {t('plans.contacts.manage')}
          </Link>
        </section>

        {LADDER.map((tier) => {
          const tierItems = items.filter((i) => i.tier === tier);
          const cats = Array.from(new Set(tierItems.map((i) => i.category)));
          return (
            <section className="card" key={tier}>
              <header className="card-h">
                <div>
                  <h2 className="h-section">
                    {tier.toUpperCase()} · {t(`plans.ladder.${tier}.name`)}
                  </h2>
                  <p className="small">{t(`plans.ladder.${tier}.rule`)}</p>
                </div>
                <span className={`badge${tierItems.length > 0 ? ' accent' : ''}`}>
                  {t('plans.tier.items', { count: tierItems.length })}
                </span>
              </header>
              <div className="card-pad row between middle gap-md">
                <div className="stack min-w-0">
                  <div className="small t-2">
                    {t('plans.tier.need', { need: t(`plans.ladder.${tier}.need`) })}
                  </div>
                  {cats.length > 0 && (
                    <div className="hint">
                      {t('plans.tier.categories', { categories: cats.join(', ') })}
                    </div>
                  )}
                </div>
                <Link className="btn ghost sm" to="/vault">
                  {t('plans.tier.openVault')}
                </Link>
              </div>
            </section>
          );
        })}

        <p className="hint">{t('plans.footnote')}</p>
      </div>
    </section>
  );
}

// Truecairn Personal (billing). Free covers the core safety on email + push;
// Personal adds the paid verification channel (SMS). The upgrade flow
// itself (plan value, monthly/yearly choice, hosted LemonSqueezy checkout) lives
// on the dedicated /upgrade page — this card is a status summary + one way in.
// (Internal plan/slug identifiers stay 'pro' — 'Personal' is the display name.)
function SubscriptionCard(): JSX.Element {
  const t = useT();
  const statusQ = useQuery({ queryKey: ['billing', 'status'], queryFn: () => fetchBillingStatus() });
  const usageQ = useQuery({ queryKey: ['account', 'usage'], queryFn: () => fetchUsage() });
  const usage = usageQ.data;

  const plan = statusQ.data?.plan ?? 'free';

  if (plan === 'pro') {
    const renews = statusQ.data?.renewsAt;
    const ends = statusQ.data?.endsAt;
    const cancelled = statusQ.data?.status === 'cancelled';
    const portal = statusQ.data?.customerPortalUrl;
    return (
      <section className="card card-pad stack gap-sm" data-testid="subscription-pro">
        <div className="row between middle gap-md">
          <div className="stack min-w-0">
            <div className="row-title">
              {t('plans.sub.proName')} <span className="badge accent">{t('plans.sub.active')}</span>
            </div>
            <div className="small t-2">
              {t('plans.sub.proBlurb', {
                storage: usage ? formatBytes(usage.storageBytes.limit ?? 0) : '',
              })}
            </div>
          </div>
        </div>
        {usage && (
          <div className="small t-2" data-testid="usage-summary">
            {t('plans.sub.usage', {
              used: formatBytes(usage.storageBytes.used),
              limit: formatBytes(usage.storageBytes.limit ?? 0),
            })}
          </div>
        )}
        {cancelled && ends != null ? (
          <div className="small t-2">
            {t('plans.sub.endsOn', { when: formatDateTime(ends) })}
          </div>
        ) : renews != null ? (
          <div className="small t-2">{t('plans.sub.renews', { when: formatDateTime(renews) })}</div>
        ) : null}
        {portal != null && (
          // The cancel path. Checkout and /upgrade both promise "cancel
          // anytime" and this is the only place in the product that made it
          // possible — before it existed, cancelling meant finding the
          // LemonSqueezy receipt email. Opens the store's billing page, where
          // the customer signs in with their own email; we hold no key that
          // could cancel on their behalf, by design. The .row wrapper is what
          // sizes the anchor to its text — .stack stretches its children.
          <div className="row">
            <a
              className="btn secondary sm"
              href={portal}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="manage-subscription"
            >
              {t('plans.sub.manage')}
            </a>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="card" data-testid="subscription-free">
      <header className="card-h">
        <div>
          <h2 className="h-section">{t('plans.sub.proName')}</h2>
          <p className="small">{t('plans.sub.freeBlurb')}</p>
        </div>
      </header>
      {usage && (
        <div className="card-pad row gap-lg wrap" data-testid="usage-summary">
          <UsageStat
            label={t('plans.sub.stat.contacts')}
            used={usage.contacts.used}
            limit={usage.contacts.limit}
          />
          <UsageStat
            label={t('plans.sub.stat.items')}
            used={usage.vaultItems.used}
            limit={usage.vaultItems.limit}
          />
          <UsageStat
            label={t('plans.sub.stat.storage')}
            usedText={formatBytes(usage.storageBytes.used)}
            limitText={formatBytes(usage.storageBytes.limit ?? 0)}
          />
        </div>
      )}
      <div className="card-pad row gap-sm middle wrap">
        <Link className="btn primary sm" to="/upgrade" data-testid="upgrade">
          {t('plans.sub.upgrade')}
        </Link>
        <span className="hint">{t('plans.sub.upgradeHint')}</span>
      </div>
    </section>
  );
}

// A compact "used / limit" stat for the Plans usage summary. Numeric caps pass
// used/limit; storage passes pre-formatted usedText/limitText.
function UsageStat({
  label,
  used,
  limit,
  usedText,
  limitText,
}: {
  label: string;
  used?: number;
  limit?: number | null;
  usedText?: string;
  limitText?: string;
}): JSX.Element {
  const value =
    usedText !== undefined
      ? `${usedText} / ${limitText}`
      : `${used ?? 0} / ${limit === null || limit === undefined ? '∞' : limit}`;
  return (
    <div className="stack">
      <div className="hint">{label}</div>
      <div className="row-title">{value}</div>
    </div>
  );
}
