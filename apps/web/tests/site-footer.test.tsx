import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { OFFERED_LOCALES } from '@truecairn/shared';
import { SiteFooter } from '../src/site/SiteFooter.js';

// The footer used to be a wall of dead `#` links. Every link must now resolve to
// a real internal page, a landing-section anchor, or be removed entirely — and
// nothing fabricated (no "Customers") may remain. The Source code link was
// absent while REPO_URL was null and is now a real external link — the rule was
// never "no source link", it was "no DEAD source link".
function renderFooter(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <SiteFooter />
    </MemoryRouter>,
  );
}

describe('site footer', () => {
  it('points every column link at a real destination', () => {
    renderFooter();
    const expectHref = (name: string, href: string): void =>
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(href);

    expectHref('User guide', '/guide');
    expectHref('Changelog', '/changelog');
    expectHref('Security model', '/security');
    expectHref('Threat model', '/security/threat-model');
    expectHref('Independent reviews', '/security#audits');
    expectHref('Disclosure policy', '/security/disclosure');
    expectHref('About', '/company/about');
    expectHref('Contact', '/company/contact');
    expectHref('Press', '/company/press');
    expectHref('Status', '/status');
    expectHref('Privacy', '/legal/privacy');
    expectHref('Terms', '/legal/terms');
    expectHref('DPA', '/legal/dpa');
    expectHref('Sub-processors', '/legal/sub-processors');
    expectHref('Wind-down playbook', '/legal/wind-down');
  });

  it('contains no dead `#` links', () => {
    const { container } = renderFooter();
    const dead = Array.from(container.querySelectorAll('a')).filter(
      (a) => a.getAttribute('href') === '#',
    );
    expect(dead).toHaveLength(0);
  });

  it('links Build provenance and a REAL source repository', () => {
    renderFooter();
    // The pair that makes the provenance claim checkable: the page showing the
    // digest of the bundle you are running, and where to go to rebuild it.
    expect(screen.getByRole('link', { name: 'Build provenance' })).toBeTruthy();
    const source = screen.getByRole('link', { name: 'Source code' });
    const href = source.getAttribute('href') ?? '';
    expect(href).toMatch(/^https:\/\/github\.com\//);
    // Never a placeholder, a '#', or a stringified null — this link exists only
    // because REPO_URL is real, and a dead one here would be worse than none.
    expect(href).not.toMatch(/null|undefined|example\.com|#$/);
    expect(source.getAttribute('rel')).toContain('noopener');
  });

  it('does not surface fabricated links (Customers)', () => {
    renderFooter();
    expect(screen.queryByRole('link', { name: 'Customers' })).toBeNull();
  });

  // ── The copyright line (2026-08-13) ────────────────────────────────────────
  // It read "© 2026 Truecairn, Inc. All rights reserved." on all 17 prerendered
  // public pages, which packed two false claims into eight words:
  //
  //   1. No company has been incorporated (docs/31 §1 holds the decision open),
  //      so there is no "Truecairn, Inc." to hold a copyright.
  //   2. "All rights reserved." contradicted a licence ALREADY published — the
  //      public mirror has carried Apache-2.0 in its LICENSE and README for
  //      months. Anyone who followed /security/build to rebuild the bundle was
  //      reading a footer that told them they had no right to.
  //
  // The second is the one worth a permanent test. A reserved-rights formula and
  // an open-source grant cannot both be true, and of the two the footer is the
  // one a reader meets first, on every page.
  describe('the copyright line', () => {
    function legalText(): string {
      const { container } = renderFooter();
      return container.querySelector('.mk-footer-legal')?.textContent ?? '';
    }

    it('never reserves rights it has already licensed away', () => {
      expect(legalText()).not.toMatch(/all rights reserved/i);
    });

    it('claims no corporate entity', () => {
      // Same rule as the JSON-LD pin in page-meta.test.tsx. Both surfaces, or a
      // corporate identity simply returns through whichever one is unguarded.
      expect(legalText()).not.toMatch(/\bInc\.?\b|\bLLC\b|\bLtd\.?\b|\bGmbH\b|\bCorp\.?\b/);
    });

    it('names the licence and links it to the published text', () => {
      const text = legalText();
      // Must match the holder named in the root LICENSE appendix
      // (`Copyright 2026 Truecairn`). Two different copyright holders across the
      // two files is the drift this whole change-set exists to remove.
      expect(text).toContain('© 2026 Truecairn');
      expect(text).toContain('Apache 2.0 License');
      // REPO_URL is real, so this must be a live link rather than bare prose —
      // the same "no dead link, but no unlinked claim either" rule the Source
      // code link above follows. A licence a reader cannot open is a claim.
      const licence = screen.getByRole('link', { name: 'Apache 2.0 License' });
      const href = licence.getAttribute('href') ?? '';
      expect(href).toMatch(/^https:\/\/github\.com\/.+\/LICENSE$/);
      expect(href).not.toMatch(/null|undefined/);
      expect(licence.getAttribute('rel')).toContain('noopener');
    });

    it('states no office it does not have', () => {
      // "Built in San Francisco and Berlin." sat on the next line and was false
      // in both cities.
      expect(legalText()).not.toMatch(/San Francisco|Berlin/);
    });
  });

  // ── The language control for the whole public site ────────────────────────
  //
  // Spanish shipped with the picker mounted only on the auth screens and in
  // Settings. Every public page — the landing first among them — offered no way
  // to switch, which is the surface a Spanish reader actually arrives on.
  // Auto-detection covers a Spanish-configured browser and does nothing for a
  // Spanish reader whose machine is set to English.
  //
  // Asserted HERE because SiteFooter is what Landing and PublicPage share: one
  // mount reaches every public page, and one test protects all of them.
  it('carries the language picker, so every public page can switch', () => {
    renderFooter();
    if (OFFERED_LOCALES.length < 2) {
      // Renders nothing while there is no choice to make — the same rule the
      // control applies everywhere else. Stated rather than skipped so that
      // narrowing OFFERED_LOCALES does not leave a stale assertion behind.
      expect(screen.queryByTestId('language-picker')).not.toBeInTheDocument();
      return;
    }
    const picker = screen.getByTestId('language-picker');
    expect(picker).toBeInTheDocument();
    // Every offered language is reachable from it, not just the current one.
    for (const locale of OFFERED_LOCALES) {
      expect(picker.querySelector(`option[value="${locale}"]`)).not.toBeNull();
    }
  });
});