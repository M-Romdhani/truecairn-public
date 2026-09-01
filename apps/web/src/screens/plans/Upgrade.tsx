import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchBillingStatus, getCheckoutUrl } from '../../billing/api.js';
import {
  FREE_LIMITS,
  PERSONAL_LIMITS,
  PERSONAL_PRICE,
  checkoutPlanFor,
  formatBytes,
  personalAnnualSavings,
  personalAnnualSavingsPct,
  personalPerMonth,
  releaseTiersLabel,
  splitPrice,
  type BillingPeriod,
} from '../../billing/pricing.js';
import { formatDateTime } from '../../lib/dates.js';
import './upgrade.css';
import { useT } from '../../i18n/useT.js';

// A focused, standalone upgrade page (task 4): the Plans "Upgrade" button lands
// here. A back arrow returns to the vault. A Monthly/Yearly switch drives the
// paid plan's price AND the checkout it opens; Free frames the value beside it.
// Rendered OUTSIDE the app sidebar (App.tsx) so it reads as its own page, like
// the reference upgrade flow. Personal is the only paid plan, and the only
// self-serve one; its charge is authoritative from LemonSqueezy — the figures
// here are the display prices from billing/pricing.ts.
//
// TWO TIERS, because two tiers exist. A third "Pro" card (Custom pricing, a
// "Talk to us" link to /company/contact, multi-account governance, SAML SSO,
// notary integration) was removed 2026-08-01 for the same reason it was removed
// from the landing page the same day: none of it was built. It survived that
// pass only because the report which found it quoted the landing page and not
// this file. This surface was the worse of the two — it is shown to a SIGNED-IN
// user at the moment they are deciding to pay, so "Talk to us" opened a sales
// conversation about features that do not exist.

const IcArrowLeft = (): JSX.Element => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path d="M11 4l-5 5 5 5M6 9h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function Upgrade(): JSX.Element {
  const t = useT();
  // Yearly is the better deal and where "Save N%" points — default to it.
  const [period, setPeriod] = useState<BillingPeriod>('yearly');
  const [error, setError] = useState<'checkout' | null>(null);
  const statusQ = useQuery({ queryKey: ['billing', 'status'], queryFn: () => fetchBillingStatus() });
  const checkoutM = useMutation({
    mutationFn: () => getCheckoutUrl(checkoutPlanFor(period)),
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: () =>
      setError('checkout'),
  });

  const isPro = (statusQ.data?.plan ?? 'free') === 'pro';
  const price = splitPrice(personalPerMonth(period));

  return (
    <div className="upgrade-page">
      <header className="upgrade-topbar">
        <Link to="/vault" className="upgrade-back" data-testid="upgrade-back">
          <IcArrowLeft />
          {t('upgrade.back')}
        </Link>
      </header>

      <main className="upgrade-main" id="main-content">
        <div className="upgrade-head">
          <h1 className="upgrade-title">{t('upgrade.title')}</h1>
          <p className="upgrade-lead">{t('upgrade.lead')}</p>
          <div className="upgrade-switch" role="group" aria-label={t('upgrade.period.label')}>
            <button
              type="button"
              className={period === 'monthly' ? 'active' : ''}
              aria-pressed={period === 'monthly'}
              onClick={() => setPeriod('monthly')}
            >
              {t('upgrade.period.monthly')}
            </button>
            <button
              type="button"
              className={period === 'yearly' ? 'active' : ''}
              aria-pressed={period === 'yearly'}
              onClick={() => setPeriod('yearly')}
            >
              {t('upgrade.period.yearly')}{' '}
              <span className="upgrade-save">
                {t('upgrade.period.save', { pct: personalAnnualSavingsPct })}
              </span>
            </button>
          </div>
        </div>

        <div className="upgrade-grid">
          {/* Free */}
          <section className="upgrade-tier">
            <div className="upgrade-tier-name">{t('upgrade.free.name')}</div>
            <div className="upgrade-price">
              <span className="amount">$0</span>
              <span className="per">{t('upgrade.free.per')}</span>
            </div>
            {/* One copy block per card so both cards have the same five blocks:
                the shared row tracks below align the CTA and the feature list
                across cards even though only Personal carries a billing line. */}
            <div className="upgrade-copy">
              <p className="upgrade-tier-desc">{t('upgrade.free.desc')}</p>
            </div>
            <div className="upgrade-cta">
              <span className="btn secondary w-full center" aria-disabled="true">
                {isPro ? t('upgrade.free.included') : t('upgrade.free.yourPlan')}
              </span>
            </div>
            <ul className="upgrade-feats">
              {/* `?? ''` reproduces what this rendered before extraction: these
                  limits are `number | null` (null = unlimited) and the Free card
                  interpolated the raw value, so null printed as nothing. Not
                  substituting 0 — that would state a limit the plan does not
                  have. Whether a null limit should read "Unlimited" here is a
                  copy question, not one to settle inside a mechanical
                  extraction. */}
              <li>{t('upgrade.free.feat.contacts', { count: FREE_LIMITS.maxContacts ?? '' })}</li>
              <li>{t('upgrade.free.feat.items', { count: FREE_LIMITS.maxVaultItems ?? '' })}</li>
              <li>
                {t('upgrade.feat.attachments', {
                  size: formatBytes(FREE_LIMITS.maxStorageBytes),
                })}
              </li>
              <li>{t('upgrade.feat.tiers', { tiers: releaseTiersLabel('free') })}</li>
              <li>{t('upgrade.free.feat.channels')}</li>
            </ul>
          </section>

          {/* Personal — the one self-serve paid plan */}
          <section className="upgrade-tier featured">
            <div className="upgrade-tier-name">
              {t('upgrade.personal.name')}{' '}
              <span className="upgrade-pop">{t('upgrade.personal.popular')}</span>
            </div>
            <div className="upgrade-price">
              <span className="amount">${price.dollars}</span>
              <span className="cents">.{price.cents}</span>
              <span className="per">{t('upgrade.personal.per')}</span>
            </div>
            <div className="upgrade-copy">
              <p className="upgrade-sub" data-testid="upgrade-personal-sub">
                {period === 'yearly'
                  ? t('upgrade.personal.billedYearly', {
                      total: PERSONAL_PRICE.annualPerYear,
                      saving: personalAnnualSavings,
                    })
                  : t('upgrade.personal.billedMonthly', {
                      total: PERSONAL_PRICE.monthlyPerMonth,
                    })}
              </p>
              <p className="upgrade-tier-desc">{t('upgrade.personal.desc')}</p>
            </div>
            <div className="upgrade-cta">
              {isPro ? (
                <span className="btn primary w-full center" aria-disabled="true" data-testid="current-pro">
                  {t('upgrade.personal.current')}
                </span>
              ) : (
                <button
                  type="button"
                  className="btn primary w-full center"
                  disabled={checkoutM.isPending}
                  data-testid="upgrade-checkout"
                  onClick={() => checkoutM.mutate()}
                >
                  {checkoutM.isPending
                    ? t('upgrade.personal.opening')
                    : t('upgrade.personal.cta')}
                </button>
              )}
            </div>
            <ul className="upgrade-feats">
              <li>{t('upgrade.personal.feat.everything')}</li>
              <li>{t('upgrade.personal.feat.contacts')}</li>
              <li>{t('upgrade.personal.feat.items')}</li>
              <li>
                {t('upgrade.feat.attachments', {
                  size: formatBytes(PERSONAL_LIMITS.maxStorageBytes),
                })}
              </li>
              <li>{t('upgrade.feat.tiers', { tiers: releaseTiersLabel('pro') })}</li>
              <li>{t('upgrade.personal.feat.sms')}</li>
              <li>{t('upgrade.personal.feat.multichannel')}</li>
            </ul>
          </section>
        </div>

        {isPro && statusQ.data?.renewsAt != null && (
          <p className="upgrade-note" data-testid="upgrade-renews">
            {t('upgrade.renews', { when: formatDateTime(statusQ.data.renewsAt) })}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="alert upgrade-alert">
            {t('upgrade.error.checkout')}
          </p>
        )}

        <p className="upgrade-fineprint">
          {t('upgrade.fineprint')}
          {/* The sentence above promised something the product had no way to do.
              Subscribers get the route to it here, at the promise, rather than
              only on the Plans card. */}
          {isPro && statusQ.data?.customerPortalUrl != null && (
            <>
              {' '}
              <a
                href={statusQ.data.customerPortalUrl}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="upgrade-manage-subscription"
              >
                {t('upgrade.manageSubscription')}
              </a>
              .
            </>
          )}
        </p>
      </main>
    </div>
  );
}
