import { Link } from 'react-router-dom';
import { BrandMark } from '../components/BrandMark.js';
import { Wordmark } from '../components/Wordmark.js';
import { REPO_URL } from './links.js';
import '../screens/Landing.css';
import { SourceLangLink } from './SourceLangLink.js';
import { Trans } from 'react-i18next';
import { LanguagePicker } from '../i18n/LanguagePicker.js';
import { useT } from '../i18n/useT.js';

// The marketing footer, lifted out of Landing so the landing page and every
// public content page (security, legal, company, changelog, guide) share ONE set
// of real links — no dead `#` hrefs, one place to edit. Uses the existing
// .mk-footer* classes (Landing.css) so it renders identically to before.
//
// Link policy (see TASK 1): internal pages are <Link>; landing-section anchors
// are plain <a href="/#…"> so they work from any page (the browser handles the
// hash scroll after navigating home); links with no real destination yet are
// REMOVED rather than pointed at `#`.
export function SiteFooter(): JSX.Element {
  const t = useT();
  return (
    <footer className="mk-footer">
      <div className="mk-footer-inner">
        <div className="mk-footer-col">
          <Link className="mk-brand mk-footer-brand" to="/">
            <BrandMark />
            <Wordmark />
          </Link>
          <p className="mk-footer-tagline">{t('site.footer.tagline')}</p>
        </div>

        <div className="mk-footer-col">
          <h2 className="mk-footer-h">{t('site.footer.product')}</h2>
          <a href="/#product">{t('site.footer.vault')}</a>
          <a href="/#product">{t('site.footer.contacts')}</a>
          <a href="/#product">{t('site.footer.plans')}</a>
          <a href="/#product">{t('site.footer.ceremony')}</a>
          <Link to="/guide">{t('site.footer.guide')}</Link>
          <SourceLangLink to="/changelog">{t('site.footer.changelog')}</SourceLangLink>
        </div>

        <div className="mk-footer-col">
          <h2 className="mk-footer-h">{t('site.footer.security')}</h2>
          <Link to="/security">{t('site.footer.securityModel')}</Link>
          <Link to="/security/threat-model">{t('site.footer.threatModel')}</Link>
          <Link to="/security/ai">{t('site.footer.ai')}</Link>
          <Link to="/security#audits">{t('site.footer.reviews')}</Link>
          <Link to="/security/build">{t('site.footer.build')}</Link>
          <Link to="/security/limits">{t('site.footer.limits')}</Link>
          {/* The source link and /security/build are a pair: the page shows the
              digest of the bundle you are running, and this is where you go to
              rebuild it and compare. Rendered only when REPO_URL is real — on a
              page about verifying us, a dead link is worse than no link. */}
          {REPO_URL !== null && (
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              {t('site.footer.source')}
            </a>
          )}
          <Link to="/security/disclosure">{t('site.footer.disclosure')}</Link>
        </div>

        <div className="mk-footer-col">
          <h2 className="mk-footer-h">{t('site.footer.company')}</h2>
          <Link to="/company/about">{t('site.footer.about')}</Link>
          <Link to="/company/contact">{t('site.footer.contact')}</Link>
          <Link to="/company/press">{t('site.footer.press')}</Link>
          <Link to="/status">{t('site.footer.status')}</Link>
          {/* "Customers" removed: we do not publish customer logos or testimonials. */}
        </div>

        <div className="mk-footer-col">
          <h2 className="mk-footer-h">{t('site.footer.legal')}</h2>
          <SourceLangLink to="/legal/privacy">{t('site.footer.privacy')}</SourceLangLink>
          <SourceLangLink to="/legal/terms">{t('site.footer.terms')}</SourceLangLink>
          <SourceLangLink to="/legal/dpa">{t('site.footer.dpa')}</SourceLangLink>
          <SourceLangLink to="/legal/sub-processors">
            {t('site.footer.subProcessors')}
          </SourceLangLink>
          <SourceLangLink to="/legal/wind-down">{t('site.footer.windDown')}</SourceLangLink>
        </div>
      </div>

      <div className="mk-footer-legal">
        {/* Apache-2.0, matching the LICENSE at the repo root and the one already
            published on the public mirror. This line used to read "© 2026
            Truecairn, Inc. All rights reserved." — two false claims in eight
            words. No such company exists (docs/31 §1 holds the entity decision
            open), and a reserved-rights formula contradicts a licence we had
            ALREADY granted: every reader who rebuilt the bundle from
            /security/build was working from a repo whose footer told them they
            could not. The holder is "Truecairn Contributors" because there is no
            legal entity to name, and naming one that does not exist is the error
            being fixed here, not a smaller version of it.

            Linked only when REPO_URL is real, matching the Source code link
            above: on a footer whose whole job is to be checkable, a dead licence
            link is worse than an unlinked licence name. */}
        <span>
          <Trans
            i18nKey="site.footer.licence"
            components={{
              // Linked only when REPO_URL is real: on a footer whose whole job is
              // to be checkable, a dead licence link is worse than an unlinked
              // licence name. <span> renders the label with no href.
              licence:
                REPO_URL !== null ? (
                  <a
                    href={`${REPO_URL}/blob/main/LICENSE`}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                ) : (
                  <span />
                ),
            }}
          />
        </span>
        {/* The language control for the ENTIRE public site. It sat only on the
            auth screens and in Settings, which meant the one surface a Spanish
            reader actually arrives on — the landing page, and every guide,
            security and company page behind it — offered no way to switch.
            Auto-detection covers a Spanish-configured browser; it does nothing
            for a Spanish reader on a machine set to English, which is a large
            share of the people this is for.

            In the footer because that is where a reader looks for it, and
            because SiteFooter is rendered by both Landing and PublicPage — one
            mount reaches all of it. It still renders nothing while only one
            language is offered, exactly as it does everywhere else. */}
        <LanguagePicker className="mk-footer-lang" />
      </div>
    </footer>
  );
}
