import { Link, useLocation } from 'react-router-dom';
import { Trans } from 'react-i18next';
import { PublicPage } from './PublicPage.js';
import { useT } from '../i18n/useT.js';
import { CONTACT_EMAIL } from './links.js';

// The 404 page (2026-08-09, QA finding P3-1).
//
// WHY THIS EXISTS. Both route trees used to answer an unknown path with a
// redirect: the authed tree sent `*` to /register, the public tree sent `*` to
// /. The server was already doing the right thing — it returns a real 404 with
// the pristine SPA shell — and then the client threw that away, rewriting the
// address bar before anyone could read the URL that failed.
//
// That is worst for the person least able to cope with it. A trusted contact
// following a ceremony link that got mangled by a mail client saw a signup form
// and no indication anything had gone wrong: nothing to report, nothing to
// paste back to the owner, and a strong suggestion that the correct next step
// was to create an account. Someone acting on behalf of a person who may have
// died should never be quietly handed the wrong task.
//
// So: no redirect, and the broken URL is shown rather than discarded. It is the
// only copy of the evidence — the sender's link — and it is what makes the
// difference between "it didn't work" and a report anyone can act on.
export function NotFound(): JSX.Element {
  const t = useT();
  // The path as the browser still holds it. Rendered as text, never as a link
  // or as markup: this string is entirely attacker-chosen, and the one job of
  // this page is to display it inertly.
  const { pathname, search } = useLocation();
  const attempted = `${pathname}${search}`;

  return (
    <PublicPage eyebrow="404" title={t('site.notFound.title')} notFound>
      <p>{t('site.notFound.lede')}</p>

      <h2>{t('site.notFound.attempted')}</h2>
      <p>
        <code className="pub-break">{attempted}</code>
      </p>

      <h2>{t('site.notFound.sentHeading')}</h2>
      <p>{t('site.notFound.sentBody')}</p>
      <p>
        <Trans i18nKey="site.notFound.contactWarning" components={{ strong: <strong /> }} />
      </p>

      <h2>{t('site.notFound.whereHeading')}</h2>
      <ul>
        <li>
          <Link to="/">{t('site.notFound.home')}</Link>
        </li>
        <li>
          <Link to="/guide">{t('site.notFound.guide')}</Link>
          {t('site.notFound.guideNote')}
        </li>
        <li>
          <Link to="/security">{t('site.notFound.security')}</Link>
        </li>
        <li>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          {t('site.notFound.emailNote')}
        </li>
      </ul>
    </PublicPage>
  );
}
