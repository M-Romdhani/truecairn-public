import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  SOURCE_LANGUAGE_ONLY_ROUTES,
  localePathPrefix,
  localesForRoute,
  localizePath,
  splitLocalePath,
} from '@truecairn/shared';
import '../src/i18n/index.js';
import { Landing } from '../src/screens/Landing.js';
import { SiteFooter } from '../src/site/SiteFooter.js';
import { SourceLangLink } from '../src/site/SourceLangLink.js';

// The language lives in the URL for public pages (docs/40 Phase 2), carried by
// the router's basename so ordinary <Link>s stay language-relative.

describe('locale paths', () => {
  it('round-trips every locale', () => {
    for (const locale of LOCALES) {
      for (const path of ['/', '/security', '/security/threat-model']) {
        const localized = localizePath(path, locale);
        expect(splitLocalePath(localized)).toEqual({ locale, path });
      }
    }
  });

  it('leaves the default language unprefixed', () => {
    // /security, never /en/security: those URLs are indexed and linked, and
    // moving them would break every inbound link to buy nothing.
    expect(localePathPrefix(DEFAULT_LOCALE)).toBe('');
    expect(localizePath('/security', DEFAULT_LOCALE)).toBe('/security');
  });

  it('does not mistake a path that merely starts with the letters', () => {
    // '/estate-planning' is not the Spanish '/tate-planning'.
    expect(splitLocalePath('/estate-planning')).toEqual({
      locale: DEFAULT_LOCALE,
      path: '/estate-planning',
    });
  });

  it('treats a bare prefix as that language’s home', () => {
    expect(splitLocalePath('/es')).toEqual({ locale: 'es', path: '/' });
  });

  it('is idempotent, so callers never have to check first', () => {
    expect(localizePath('/es/security', 'es')).toBe('/es/security');
    expect(localizePath('/es/security', DEFAULT_LOCALE)).toBe('/security');
  });
});

// ── The bug this whole component exists for ──────────────────────────────────
//
// The basename prefixes EVERY link, including the ones pointing at pages
// published in one language only. Before SourceLangLink the Spanish pages
// shipped six links to /es/legal/* — URLs the build never produced. Found by
// reading the built HTML, not the code, which is why it is pinned here.
// `basename` is spread rather than passed as `undefined`: the repo's tsconfig
// sets exactOptionalPropertyTypes, so an explicit undefined is not the same as
// an absent prop.
const renderUnder = (locale: string, ui: ReactElement): ReturnType<typeof render> => {
  const isDefault = locale === DEFAULT_LOCALE;
  return render(
    <MemoryRouter
      {...(isDefault ? {} : { basename: `/${locale}` })}
      initialEntries={[isDefault ? '/security' : `/${locale}/security`]}
    >
      {ui}
    </MemoryRouter> as ReactElement,
  );
};

// Every page a Spanish reader can reach. The sweep below renders each one under
// the /es basename and checks no link points at a page that language never
// produces.
//
// IT USED TO BE THE FOOTER ALONE, and that was not enough. The footer is where
// these links obviously live, so it is where SourceLangLink was obviously used —
// and the one that got away was the "privacy policy" link in the middle of a
// sentence in the landing page's security lede, written as an ordinary <Link>
// because at that call site it does not look like a language decision at all.
// It rendered href="/es/legal/privacy": a URL the prerenderer never writes and
// isKnownClientRoute() answers false for, so the API serves a 404. Found by
// grepping the BUILT html, which is not a thing anyone does twice; this catches
// it in a unit test instead.
const PAGES_A_SPANISH_READER_REACHES: readonly (readonly [string, () => JSX.Element])[] = [
  ['SiteFooter', () => <SiteFooter />],
  ['Landing', () => <Landing />],
];

describe('links out of the current language', () => {
  it.each(PAGES_A_SPANISH_READER_REACHES.map(([name]) => name))(
    'never prefixes a source-language-only route: %s',
    (name) => {
      const entry = PAGES_A_SPANISH_READER_REACHES.find(([n]) => n === name);
      renderUnder('es', entry![1]());
      for (const route of SOURCE_LANGUAGE_ONLY_ROUTES) {
        for (const a of screen.queryAllByRole('link')) {
          const href = a.getAttribute('href') ?? '';
          expect(
            href,
            `${href} points at a ${route} page that is never rendered in Spanish`,
          ).not.toBe(`/es${route}`);
        }
      }
    },
  );

  it('still prefixes an ordinary route', () => {
    renderUnder('es', <SourceLangLink to="/security">security</SourceLangLink>);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/es/security');
  });

  it('renders a source-language-only route as a plain unprefixed link', () => {
    // A plain <a>, not <Link reloadDocument> — the first fix, which was still
    // wrong and looked right: reloadDocument changes how a click navigates, not
    // how the href is generated, so the attribute stayed /es/legal/privacy.
    renderUnder('es', <SourceLangLink to="/legal/privacy">privacy</SourceLangLink>);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/legal/privacy');
  });

  it('leaves both kinds alone in the source language', () => {
    renderUnder(DEFAULT_LOCALE, <SourceLangLink to="/legal/privacy">privacy</SourceLangLink>);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/legal/privacy');
  });
});

describe('which languages a route is published in', () => {
  it('publishes source-language-only routes once', () => {
    for (const route of SOURCE_LANGUAGE_ONLY_ROUTES) {
      expect(localesForRoute(route)).toEqual([DEFAULT_LOCALE]);
    }
  });
});
