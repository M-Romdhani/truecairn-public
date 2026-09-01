import { useEffect, useRef, useState } from 'react';
import { canonicalFor, descriptionFor, jsonLdFor, titleFor } from '../site/page-meta.js';
import { Trans } from 'react-i18next';
import { useActiveLocale, useT } from '../i18n/useT.js';
import { usePageMeta } from '../site/usePageMeta.js';
import { Link } from 'react-router-dom';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import {
  FREE_LIMITS,
  PERSONAL_LIMITS,
  PERSONAL_PRICE,
  formatBytes,
  personalAnnualSavings,
  personalAnnualSavingsPct,
  personalPerMonth,
  releaseTiersLabel,
  splitPrice,
  type BillingPeriod,
} from '../billing/pricing.js';
import { BrandMark } from '../components/BrandMark.js';
import { Wordmark } from '../components/Wordmark.js';
import { REPO_URL } from '../site/links.js';
import { SiteFooter } from '../site/SiteFooter.js';
import { SourceLangLink } from '../site/SourceLangLink.js';
import './Landing.css';

// The public marketing surface — the 2026 redesign (design-reference "Landing
// Redesign"): dark video hero, alternating light/ink sheets, Poppins/Figtree
// type, and the dash→arrow CTA. Still the FIRST unauthenticated page and the one
// bearing the security claims. It imports NO crypto/auth/session code; the authed
// app (libsodium WASM + session machinery) is lazy-loaded only when a visitor
// navigates to /register or /login (see main.tsx). Class-only styling
// (Landing.css) because the SPA CSP forbids inline styles.

// The hero media, named once. HERO_POSTER_SRC is exported because prerender.tsx
// emits a <link rel="preload"> for exactly this file on '/' — a preload pointing
// at a url the page does not use costs a whole extra fetch and warns in the
// console, so the two must never be edited apart.
export const HERO_POSTER_SRC = '/assets/landing/hero-poster.webp';
const HERO_LOOP_SRC = '/assets/landing/hero-loop-720.mp4';

// Monochrome cairn glyph for eyebrows and section rules — draws in currentColor
// (assets/brand/mark-mono.svg), unlike the fixed-slate BrandMark.
function CairnGlyph({ size = 23 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <ellipse cx="14" cy="22" rx="9" ry="2.2" fill="currentColor" />
      <ellipse cx="14" cy="16.5" rx="7.2" ry="2" fill="currentColor" opacity="0.85" />
      <ellipse cx="14" cy="11.4" rx="5.4" ry="1.8" fill="currentColor" opacity="0.7" />
      <ellipse cx="14" cy="6.8" rx="3.6" ry="1.5" fill="currentColor" opacity="0.55" />
      <ellipse cx="14" cy="3" rx="2" ry="1" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

// The CTA gesture: on hover the dash and the label DEPART leftward while an arrow
// ARRIVES at the far right edge — the button gesturing across its own width rather
// than swapping one icon for another in the same slot. Motion is entirely CSS.
//
// The arrow is a SIBLING of the icon slot, not a child of it, and that is load-bearing.
// It has to be positioned against `.btn-mk` to reach the right edge, so it cannot live
// inside `.btn-mk-ic` (which is `position: relative` and therefore would be its
// containing block). Being `position: absolute` it is not a flex item, so it
// contributes nothing to layout and the button keeps the exact width it has at rest.
//
// `.btn-mk-ic` keeps its 22px whether or not the dash is still inside it — the slot is
// what reserves the space, so the departing dash cannot reflow anything.
function ArrowCta(): JSX.Element {
  return (
    <>
      <span className="btn-mk-ic" aria-hidden="true">
        <svg className="ic-dash" width="22" height="2" viewBox="0 0 22 2" fill="none">
          <path d="M1 1h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <svg
        className="ic-arrow"
        aria-hidden="true"
        width="18"
        height="12"
        viewBox="0 0 18 12"
        fill="none"
      >
        <path
          d="M1 6h15m-5-5 5 5-5 5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}

// Wraps a bare CTA label so it can be translated. Purely a handle for the animation:
// it adds no padding, no margin and no font change, and as a flex item it measures
// exactly as the bare text node it replaces — so the gap to the dash is unchanged and
// the accessible name (which the landing E2E matches with `exact: true`) is untouched,
// since the icons beside it are aria-hidden.
function CtaLabel({ children }: { children: string }): JSX.Element {
  return <span className="btn-mk-label">{children}</span>;
}

function Eyebrow({ children, inverse = false }: { children: string; inverse?: boolean }): JSX.Element {
  return (
    <p className={`mk-eyebrow${inverse ? ' inverse' : ''}`}>
      <CairnGlyph />
      {children}
    </p>
  );
}

function CairnRule(): JSX.Element {
  return (
    <div className="mk-rule" aria-hidden="true">
      <CairnGlyph />
    </div>
  );
}

export function Landing(): JSX.Element {
  // The landing renders outside PublicPage, so it applies its own head metadata.
  // Its JSON-LD is the richest on the site — Organization, WebSite and the
  // SoftwareApplication with its offers all describe the site as a whole, so
  // jsonLdFor() puts them here and nowhere else; every other public page gets a
  // WebPage (and, if nested, a breadcrumb) through PublicPage.
  const locale = useActiveLocale();
  const t = useT();
  usePageMeta({
    title: titleFor('/', locale),
    description: descriptionFor('/', locale),
    canonical: canonicalFor('/', locale),
    jsonLd: jsonLdFor('/', locale),
  });
  const [menuOpen, setMenuOpen] = useState(false);
  // Pricing billing-period switch (task 3): the paid plan shows its monthly rate
  // or its annual effective monthly + savings. Defaults to yearly — the better
  // deal, and what the "Save N%" affordance points at.
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('yearly');
  const videoRef = useRef<HTMLVideoElement>(null);

  // Hero video: decorative (aria-hidden), so it must never be on the critical
  // path. The POSTER is what paints — and what Chrome reports as the LCP for a
  // <video>, measured, with the element named as the video and the poster as the
  // resource. So the poster is preloaded from the prerendered <head> and the loop
  // is fetched only once the page has settled: no `src` and no `autoPlay` in the
  // markup, `preload="none"`, and the URL assigned here.
  //
  // That the src is absent from the PRERENDERED html is load-bearing beyond
  // priority. main.tsx uses createRoot, so the browser starts fetching whatever
  // <video src> the prerendered markup has, React then discards that DOM, and the
  // fetch restarts — measured as two full requests on a throttled connection and
  // one on a fast one. Assigning late means there is nothing to discard.
  //
  // Three cases get the poster alone and never spend the megabyte: a visitor who
  // asked for less motion, a metered or 2G connection, and a small screen where
  // the loop is mostly behind .mk-hero-scrim anyway. All three are read HERE and
  // never during render — the landing's render must stay deterministic, because
  // the prerendered and client markup have to agree.
  //
  // React's `muted` prop only sets the property, which some browsers check too
  // late for autoplay, so set it imperatively before play(). play() may return
  // undefined on older engines (and jsdom), so don't assume a promise.
  useEffect(() => {
    const v = videoRef.current;
    if (v === null) return;
    // Capability-checked, like the IntersectionObserver fallback below it —
    // matchMedia is universal in browsers and absent in jsdom, and an effect that
    // throws takes the whole page down at commit rather than degrading. An
    // environment that cannot answer a media query is one with no viewport to
    // answer for, so "no match" is the right reading; the landing's own tests run
    // in exactly that environment and are what pin this.
    const matches = (q: string): boolean =>
      typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
    const reduced = matches('(prefers-reduced-motion: reduce)');
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
      .connection;
    const thin = conn?.saveData === true || /2g/.test(conn?.effectiveType ?? '');
    const small = matches('(max-width: 640px)');
    if (reduced || thin || small) return;

    const start = (): void => {
      v.muted = true;
      v.src = HERO_LOOP_SRC;
      const p: unknown = v.play();
      if (p instanceof Promise) p.catch(() => {});
    };
    // requestIdleCallback where available, a timer elsewhere (Safari < 17). Two
    // handles rather than one: cancelIdleCallback and clearTimeout are not
    // interchangeable, and mixing them fails silently.
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(start, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(start, 1500);
    return () => window.clearTimeout(id);
  }, []);

  // Reveal-on-scroll. The hiding rule is scoped to body.mk-anim so the page
  // paints fully without JS; prefers-reduced-motion neutralizes it in CSS.
  useEffect(() => {
    document.body.classList.add('mk-anim');
    const els = Array.from(document.querySelectorAll('[data-reveal]'));
    if (typeof IntersectionObserver === 'undefined') {
      for (const el of els) el.classList.add('in');
      return () => document.body.classList.remove('mk-anim');
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
    );
    for (const el of els) io.observe(el);
    return () => {
      io.disconnect();
      document.body.classList.remove('mk-anim');
    };
  }, []);

  return (
    <div className="mk-land">
      {/* ——— Nav ——— */}
      <nav className="mk-nav">
        <div className="mk-nav-inner">
          <Link className="mk-brand" to="/">
            <BrandMark size={26} />
            <Wordmark />
          </Link>
          <div className={`mk-nav-links${menuOpen ? ' open' : ''}`}>
            <a href="#product" onClick={() => setMenuOpen(false)}>{t('site.landing.nav.product')}</a>
            <a href="#security" onClick={() => setMenuOpen(false)}>{t('site.landing.nav.security')}</a>
            <a href="#use-cases" onClick={() => setMenuOpen(false)}>{t('site.landing.nav.useCases')}</a>
            <a href="#pricing" onClick={() => setMenuOpen(false)}>{t('site.landing.nav.pricing')}</a>
            <a href="#faq" onClick={() => setMenuOpen(false)}>{t('site.landing.nav.faq')}</a>
          </div>
          <div className="mk-nav-actions">
            <Link className="mk-nav-signin" to="/login">
              {t('site.chrome.signIn')}
            </Link>
            <Link className="btn-mk ink sm" to="/register">
              <ArrowCta />
              <CtaLabel>{t('site.chrome.getStarted')}</CtaLabel>
            </Link>
            <button
              type="button"
              className="mk-nav-toggle"
              aria-label={t('site.landing.nav.openMenu')}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
      </nav>

      {/* One <main> around everything between the nav and the footer. The page
          had none, so a screen reader had no landmark to jump to and the whole
          marketing page was one undifferentiated region (axe: landmark-one-main).
          Purely structural — .mk-sheet's -58px overlap is a plain margin, not an
          adjacency selector, and the hero and the sheets stay siblings here. */}
      <main id="main-content">
        {/* ——— Hero ——— */}
        <header className="mk-hero">
          {/* No src and no autoPlay by design — both are supplied by the effect
              above, which is what keeps the loop off the critical path. The poster
              is the WebP because the attribute takes ONE url with no <source>
              negotiation, and it has to be the same file the <head> preloads. */}
          <video
            ref={videoRef}
            className="mk-hero-video"
            poster={HERO_POSTER_SRC}
            preload="none"
            muted
            loop
            playsInline
            tabIndex={-1}
            aria-hidden="true"
          />
          <div className="mk-hero-scrim" aria-hidden="true" />
          <div className="mk-hero-inner">
            <Eyebrow>{t('site.landing.hero.eyebrow')}</Eyebrow>
            <h1 className="mk-h-hero">{t('site.landing.hero.title')}</h1>
            <p className="mk-hero-sub">
              {t('site.landing.hero.lede')}
            </p>
            <div className="mk-hero-ctas">
              <Link className="btn-mk white" to="/register">
                <ArrowCta />
                <CtaLabel>{t('site.landing.hero.ctaPrimary')}</CtaLabel>
              </Link>
              <a className="btn-mk outline-inv" href="#security">
                {t('site.landing.hero.ctaSecondary')}
              </a>
            </div>
            <div className="mk-hero-trust">
              <span>{t('site.landing.hero.badge.encrypted')}</span>
              <span>·</span>
              <span>{t('site.landing.hero.badge.zeroKnowledge')}</span>
              <span>·</span>
              <span>{t('site.landing.hero.badge.revocation')}</span>
            </div>
          </div>
        </header>

        {/* ——— Light sheet: the problem ———
            The hero hands straight to the argument. A product tour used to sit
            here (an auto-advancing carousel of app recordings) and it was removed
            on purpose: it fired before the visitor knew what problem we solve, it
            shrank dense app UI past the point of legibility, and a slider under
            the hero competed with the scroll the hero had just asked for. The
            recordings are still in /assets/landing/screens — see that folder's
            README before putting a tour back, and put it BELOW this section. */}
        <div className="mk-sheet light">
          <section className="mk-section">
            <div className="mk-problem-intro">
              <div
                className="mk-photo notebook"
                data-reveal="true"
                role="img"
                aria-label={t('site.landing.problem.photoAlt')}
              />
              <div data-reveal="true">
                <Eyebrow>{t('site.landing.problem.eyebrow')}</Eyebrow>
                <h2 className="mk-h-section">{t('site.landing.problem.title')}</h2>
                <p className="mk-lead">
                  {t('site.landing.problem.lede')}
                </p>
              </div>
            </div>

            <div className="mk-scenarios">
              <div className="mk-scenario" data-reveal="true">
                <div className="who">{t('site.landing.problem.founder.role')}</div>
                <h3>{t('site.landing.problem.founder.title')}</h3>
                <p>
                  {t('site.landing.problem.founder.body')}
                </p>
              </div>
              <div className="mk-scenario ink" data-reveal="true">
                <div className="who">{t('site.landing.problem.crypto.role')}</div>
                <h3>{t('site.landing.problem.crypto.title')}</h3>
                <p>
                  {t('site.landing.problem.crypto.body')}
                </p>
              </div>
              <div className="mk-scenario" data-reveal="true">
                <div className="who">{t('site.landing.problem.freelancer.role')}</div>
                <h3>{t('site.landing.problem.freelancer.title')}</h3>
                <p>
                  {t('site.landing.problem.freelancer.body')}
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* ——— Ink sheet: the product ——— */}
        <div className="mk-sheet ink">
          <section className="mk-section" id="product">
            <Eyebrow inverse>{t('site.landing.product.eyebrow')}</Eyebrow>
            <h2 className="mk-h-section">{t('site.landing.product.title')}</h2>
            <p className="mk-lead">
              {t('site.landing.product.lede')}
            </p>

            <div className="mk-feat-grid">
              <article className="mk-feat" data-reveal="true">
                <div className="mk-feat-shot vault" />
                <div className="mk-feat-body">
                  <div className="mk-feat-eyebrow">{t('site.landing.product.vault.eyebrow')}</div>
                  <h3>{t('site.landing.product.vault.title')}</h3>
                  <p>
                    {t('site.landing.product.vault.body')}
                  </p>
                </div>
              </article>

              <article className="mk-feat" data-reveal="true">
                <div className="mk-feat-shot contacts" />
                <div className="mk-feat-body">
                  <div className="mk-feat-eyebrow">{t('site.landing.product.contacts.eyebrow')}</div>
                  <h3>{t('site.landing.product.contacts.title')}</h3>
                  <p>
                    {t('site.landing.product.contacts.body')}
                  </p>
                </div>
              </article>

              <article className="mk-feat" data-reveal="true">
                <div className="mk-feat-shot plans" />
                <div className="mk-feat-body">
                  <div className="mk-feat-eyebrow">{t('site.landing.product.plans.eyebrow')}</div>
                  <h3>{t('site.landing.product.plans.title')}</h3>
                  <p>
                    {t('site.landing.product.plans.body')}
                  </p>
                </div>
              </article>

              <article className="mk-feat" data-reveal="true">
                <div className="mk-feat-shot ceremony" />
                <div className="mk-feat-body">
                  <div className="mk-feat-eyebrow">{t('site.landing.product.ceremony.eyebrow')}</div>
                  <h3>{t('site.landing.product.ceremony.title')}</h3>
                  <p>
                    {t('site.landing.product.ceremony.body')}
                  </p>
                </div>
              </article>
            </div>

            <div className="mk-how">
              <div className="mk-how-step" data-reveal="true">
                <div className="n">01</div>
                <h4>{t('site.landing.steps.add.title')}</h4>
                <p>{t('site.landing.steps.add.body')}</p>
              </div>
              <div className="mk-how-step" data-reveal="true">
                <div className="n">02</div>
                <h4>{t('site.landing.steps.invite.title')}</h4>
                <p>{t('site.landing.steps.invite.body')}</p>
              </div>
              <div className="mk-how-step" data-reveal="true">
                <div className="n">03</div>
                <h4>{t('site.landing.steps.arm.title')}</h4>
                <p>{t('site.landing.steps.arm.body')}</p>
              </div>
              <div className="mk-how-step" data-reveal="true">
                <div className="n">04</div>
                <h4>{t('site.landing.steps.checkIn.title')}</h4>
                <p>{t('site.landing.steps.checkIn.body')}</p>
              </div>
            </div>
          </section>
        </div>

        {/* ——— Light sheet: security → use cases → pricing → FAQ → CTA ——— */}
        <div className="mk-sheet light">
          <section className="mk-section" id="security">
            <div className="mk-security">
              <div data-reveal="true">
                <Eyebrow>{t('site.landing.security.eyebrow')}</Eyebrow>
                <h2 className="mk-h-section">{t('site.landing.security.title')}</h2>
                <p className="mk-lead">
                  <Trans
                    i18nKey="site.landing.security.lede"
                    components={{
                      threat: <Link className="mk-inline-link" to="/security/threat-model" />,
                    }}
                  />
                </p>

                <ol className="mk-claims">
                  <li>
                    <span className="num">01</span>
                    <span className="body">
                      <strong>{t('site.landing.security.claim.zeroKnowledge.label')}</strong>{' '}
                      <Trans
                        i18nKey="site.landing.security.claim.zeroKnowledge.body"
                        components={{
                          // SourceLangLink, not Link: /legal/privacy is published in the
                          //   source language only, so the router basename must NOT prefix it.
                          //   As a <Link> this rendered href="/es/legal/privacy", a URL the
                          //   build never produces and the API 404s.
                          privacy: <SourceLangLink className="mk-inline-link" to="/legal/privacy" />,
                        }}
                      />
                    </span>
                    <span className="meta">{t('site.landing.security.claim.zeroKnowledge.meta')}</span>
                  </li>
                  <li>
                    <span className="num">02</span>
                    <span className="body">
                      <strong>{t('site.landing.security.claim.encrypted.label')}</strong>{' '}
                      {t('site.landing.security.claim.encrypted.body')}
                    </span>
                    <span className="meta">{t('site.landing.security.claim.encrypted.meta')}</span>
                  </li>
                  <li>
                    <span className="num">03</span>
                    <span className="body">
                      <strong>{t('site.landing.security.claim.contacts.label')}</strong>{' '}
                      <Trans
                        i18nKey="site.landing.security.claim.contacts.body"
                        components={{ em: <em /> }}
                      />
                    </span>
                    <span className="meta">{t('site.landing.security.claim.contacts.meta')}</span>
                  </li>
                  <li>
                    <span className="num">04</span>
                    <span className="body">
                      <strong>{t('site.landing.security.claim.audit.label')}</strong> {t('site.landing.security.claim.audit.body')}
                    </span>
                    <span className="meta">{t('site.landing.security.claim.audit.meta')}</span>
                  </li>
                  <li>
                    <span className="num">05</span>
                    <span className="body">
                      {REPO_URL === null ? (
                        <>
                          <strong>
                            {t('site.landing.security.claim.source.labelUnpublished')}
                          </strong>{' '}
                          <Trans
                            i18nKey="site.landing.security.claim.source.bodyUnpublished"
                            components={{
                              build: <Link className="mk-inline-link" to="/security/build" />,
                            }}
                          />
                        </>
                      ) : (
                        <>
                          <strong>
                            {t('site.landing.security.claim.source.labelPublished')}
                          </strong>{' '}
                          <Trans
                            i18nKey="site.landing.security.claim.source.bodyPublished"
                            components={{
                              repo: (
                                <a className="mk-inline-link" href={REPO_URL} rel="noreferrer" />
                              ),
                              build: <Link className="mk-inline-link" to="/security/build" />,
                            }}
                          />
                        </>
                      )}
                    </span>
                    <span className="meta">
                      {REPO_URL === null
                        ? t('site.landing.security.claim.source.metaUnpublished')
                        : t('site.landing.security.claim.source.metaPublished')}
                    </span>
                  </li>
                  <li>
                    <span className="num">06</span>
                    <span className="body">
                      <Trans
                        i18nKey="site.landing.security.claim.audits.body"
                        components={{ strong: <strong /> }}
                      />
                    </span>
                    <span className="meta">{t('site.landing.security.claim.audits.meta')}</span>
                  </li>
                  <li>
                    <span className="num">07</span>
                    <span className="body">
                      <strong>{t('site.landing.security.claim.recovery.label')}</strong> {t('site.landing.security.claim.recovery.body')}
                    </span>
                    <span className="meta">{t('site.landing.security.claim.recovery.meta')}</span>
                  </li>
                </ol>
              </div>

              <div
                className="mk-photo vault-drawer"
                data-reveal="true"
                role="img"
                aria-label={t('site.landing.product.photoAlt')}
              />
            </div>
          </section>

          <CairnRule />

          <section className="mk-section" id="use-cases">
            <div data-reveal="true">
              <Eyebrow>{t('site.landing.audience.eyebrow')}</Eyebrow>
              <h2 className="mk-h-section">{t('site.landing.audience.title')}</h2>
              <p className="mk-lead">
                {t('site.landing.audience.lede')}
              </p>
            </div>

            <div className="mk-cases">
              <article className="mk-case" data-reveal="true">
                <header className="mk-case-h">
                  <h3>{t('site.landing.audience.founders.title')}</h3>
                  <span className="audience">{t('site.landing.audience.whoThisFits')}</span>
                </header>
                <p>
                  {t('site.landing.audience.founders.body')}
                </p>
                <dl>
                  <dt>{t('site.landing.audience.planLabel')}</dt>
                  <dd>{t('site.landing.audience.founders.plan')}</dd>
                  <dt>{t('site.landing.audience.cooldownLabel')}</dt>
                  <dd>{t('site.landing.audience.founders.cooldown')}</dd>
                  <dt>{t('site.landing.audience.itemsLabel')}</dt>
                  <dd>{t('site.landing.audience.founders.items')}</dd>
                </dl>
              </article>

              <article className="mk-case" data-reveal="true">
                <header className="mk-case-h">
                  <h3>{t('site.landing.audience.crypto.title')}</h3>
                  <span className="audience">{t('site.landing.audience.whoThisFits')}</span>
                </header>
                <p>
                  {t('site.landing.audience.crypto.body')}
                </p>
                <dl>
                  <dt>{t('site.landing.audience.planLabel')}</dt>
                  <dd>{t('site.landing.audience.crypto.plan')}</dd>
                  <dt>{t('site.landing.audience.cooldownLabel')}</dt>
                  <dd>{t('site.landing.audience.crypto.cooldown')}</dd>
                  <dt>{t('site.landing.audience.itemsLabel')}</dt>
                  <dd>{t('site.landing.audience.crypto.items')}</dd>
                </dl>
              </article>

              <article className="mk-case" data-reveal="true">
                <header className="mk-case-h">
                  <h3>{t('site.landing.audience.freelancers.title')}</h3>
                  <span className="audience">{t('site.landing.audience.whoThisFits')}</span>
                </header>
                <p>
                  {t('site.landing.audience.freelancers.body')}
                </p>
                <dl>
                  <dt>{t('site.landing.audience.planLabel')}</dt>
                  <dd>{t('site.landing.audience.freelancers.plan')}</dd>
                  <dt>{t('site.landing.audience.cooldownLabel')}</dt>
                  <dd>{t('site.landing.audience.freelancers.cooldown')}</dd>
                  <dt>{t('site.landing.audience.itemsLabel')}</dt>
                  <dd>{t('site.landing.audience.freelancers.items')}</dd>
                </dl>
              </article>

              <article className="mk-case" data-reveal="true">
                <header className="mk-case-h">
                  <h3>{t('site.landing.audience.remote.title')}</h3>
                  <span className="audience">{t('site.landing.audience.whoThisFits')}</span>
                </header>
                <p>
                  {t('site.landing.audience.remote.body')}
                </p>
                <dl>
                  <dt>{t('site.landing.audience.planLabel')}</dt>
                  <dd>{t('site.landing.audience.remote.plan')}</dd>
                  <dt>{t('site.landing.audience.cooldownLabel')}</dt>
                  <dd>{t('site.landing.audience.remote.cooldown')}</dd>
                  <dt>{t('site.landing.audience.itemsLabel')}</dt>
                  <dd>{t('site.landing.audience.remote.items')}</dd>
                </dl>
              </article>
            </div>
          </section>

          <CairnRule />

          <section className="mk-section" id="pricing">
            <div data-reveal="true">
              <Eyebrow>{t('site.landing.pricing.eyebrow')}</Eyebrow>
              <h2 className="mk-h-section">
                {t('site.landing.pricing.title')}
              </h2>
              <p className="mk-lead">
                {t('site.landing.pricing.lede')}
              </p>
            </div>

            <div className="mk-billing-row" data-reveal="true">
              <div className="mk-billing-switch" role="group" aria-label={t('site.landing.pricing.billingPeriod')}>
                <button
                  type="button"
                  className={billingPeriod === 'monthly' ? 'active' : ''}
                  aria-pressed={billingPeriod === 'monthly'}
                  onClick={() => setBillingPeriod('monthly')}
                >
                  {t('site.landing.pricing.monthly')}
                </button>
                <button
                  type="button"
                  className={billingPeriod === 'yearly' ? 'active' : ''}
                  aria-pressed={billingPeriod === 'yearly'}
                  onClick={() => setBillingPeriod('yearly')}
                >
                  {t('site.landing.pricing.yearly')}{' '}
                  <span className="mk-save">
                    {t('site.landing.pricing.save', { pct: personalAnnualSavingsPct })}
                  </span>
                </button>
              </div>
            </div>

            <div className="mk-pricing">
              <div className="mk-tier" data-reveal="true">
                <div className="mk-tier-name">{t('site.landing.pricing.free')}</div>
                <div className="mk-tier-price">
                  <span className="amount">$0</span>
                  <span className="per">{t('site.landing.pricing.forever')}</span>
                </div>
                {/* One copy block per card, however many lines it holds — the row
                    track it sits in is shared, so the CTA below it starts on the
                    same line as the neighbouring card's. */}
                <div className="mk-tier-copy">
                  <p className="mk-tier-desc">{t('site.landing.pricing.freeBlurb')}</p>
                </div>
                <div className="mk-tier-cta">
                  <Link className="btn-mk outline md" to="/register">
                    <ArrowCta />
                    <CtaLabel>{t('site.landing.pricing.freeCta')}</CtaLabel>
                  </Link>
                </div>
                <ul>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.trustedContacts')}{' '}
                    <span className="qty">{FREE_LIMITS.maxContacts}</span>
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.vaultItems')}{' '}
                    <span className="qty">{FREE_LIMITS.maxVaultItems}</span>
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.attachments')}{' '}
                    <span className="qty">{formatBytes(FREE_LIMITS.maxStorageBytes)}</span>
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.releaseTiers')}{' '}
                    <span className="qty">{releaseTiersLabel('free')}</span>
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.freeChannels')}
                  </li>
                </ul>
              </div>

              <div className="mk-tier featured" data-reveal="true">
                <div className="mk-tier-name">
                  {t('site.landing.pricing.personal')}{' '}
                  <span className="mk-pop">
                    <span className="dot" />
                    {t('site.landing.pricing.popular')}
                  </span>
                </div>
                <div className="mk-tier-price">
                  <span className="amount">${splitPrice(personalPerMonth(billingPeriod)).dollars}</span>
                  <span className="cents">.{splitPrice(personalPerMonth(billingPeriod)).cents}</span>
                  <span className="per">
                    {billingPeriod === 'yearly'
                      ? t('site.landing.pricing.perMonthAnnually')
                      : t('site.landing.pricing.perMonthMonthly')}
                  </span>
                </div>
                <div className="mk-tier-copy">
                  <p className="mk-tier-sub">
                    {billingPeriod === 'yearly'
                      ? t('site.landing.pricing.annualSubline', {
                          amount: `$${PERSONAL_PRICE.annualPerYear}`,
                          saved: `$${personalAnnualSavings}`,
                        })
                      : t('site.landing.pricing.monthlySubline', {
                          amount: `$${PERSONAL_PRICE.monthlyPerMonth * 12}`,
                          pct: personalAnnualSavingsPct,
                        })}
                  </p>
                  <p className="mk-tier-desc">
                    {t('site.landing.pricing.personalBlurb')}
                  </p>
                </div>
                <div className="mk-tier-cta">
                  <Link className="btn-mk accent md" to="/register">
                    <ArrowCta />
                    <CtaLabel>{t('site.landing.pricing.personalCta')}</CtaLabel>
                  </Link>
                </div>
                <ul>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.everythingInFree')}
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.trustedContacts')}{' '}
                    <span className="qty">{t('site.landing.pricing.unlimited')}</span>
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.vaultItems')} <span className="qty">{t('site.landing.pricing.unlimited')}</span>
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.attachments')}{' '}
                    <span className="qty">{formatBytes(PERSONAL_LIMITS.maxStorageBytes)}</span>
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.releaseTiers')}{' '}
                    <span className="qty">{releaseTiersLabel('pro')}</span>
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.sms')}
                  </li>
                  <li>
                    <span className="tick">✓</span> {t('site.landing.pricing.multichannel')}
                  </li>
                </ul>
              </div>

            </div>
          </section>

          <CairnRule />

          <section className="mk-section" id="faq">
            <div data-reveal="true">
              <Eyebrow>{t('site.landing.faq.eyebrow')}</Eyebrow>
              <h2 className="mk-h-section">{t('site.landing.faq.title')}</h2>
            </div>

            <div className="mk-faq" data-reveal="true">
              <details open>
                <summary>{t('site.landing.faq.passphrase.q')}</summary>
                <p>
                  <Trans
                    i18nKey="site.landing.faq.passphrase.a"
                    components={{ strong: <strong /> }}
                  />
                </p>
              </details>
              <details>
                <summary>{t('site.landing.faq.contact.q')}</summary>
                <p>
                  {t('site.landing.faq.contact.a')}
                </p>
              </details>
              <details>
                <summary>{t('site.landing.faq.unreachable.q')}</summary>
                <p>
                  {t('site.landing.faq.unreachable.a')}
                </p>
              </details>
              <details>
                <summary>{t('site.landing.faq.read.q')}</summary>
                <p>
                  {t('site.landing.faq.read.a')}
                </p>
              </details>
              <details>
                <summary>{t('site.landing.faq.cooldown.q')}</summary>
                <p>
                  {t('site.landing.faq.cooldown.a')}
                </p>
              </details>
              <details>
                <summary>{t('site.landing.faq.windDown.q')}</summary>
                <p>
                  {t('site.landing.faq.windDown.a')}
                </p>
              </details>
            </div>
          </section>

          <section className="mk-cta-strip" data-reveal="true">
            {/* Bottom of the page, so it must never be fetched during first paint:
                loading="lazy" is what stops 1.8 MB competing with the hero. The
                intrinsic size is on the <img> so the lazy load cannot shift layout.
                AVIF first, WebP for engines without it; the .png source stays in
                public/ as the master (see that folder's README). */}
            <picture>
              <source srcSet="/assets/landing/photo-cairn-dusk.avif" type="image/avif" />
              <source srcSet="/assets/landing/photo-cairn-dusk.webp" type="image/webp" />
              <img
                className="mk-cta-photo"
                src="/assets/landing/photo-cairn-dusk.webp"
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                width={1400}
                height={934}
              />
            </picture>
            <div className="mk-cta-scrim" aria-hidden="true" />
            <div className="mk-cta-body">
              <h2>{t('site.landing.closing.title')}</h2>
              <p>
                {t('site.landing.closing.lede')}
              </p>
              <div className="mk-cta-actions">
                <Link className="btn-mk white" to="/register">
                  <ArrowCta />
                  <CtaLabel>{t('site.landing.hero.ctaPrimary')}</CtaLabel>
                </Link>
                <a className="btn-mk outline-inv" href="#security">
                  {t('site.landing.hero.ctaSecondary')}
                </a>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* ——— Footer (shared with the public content pages) ——— */}
      <SiteFooter />
    </div>
  );
}
