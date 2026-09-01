import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../src/i18n/index.js';
import { Landing } from '../src/screens/Landing.js';
import { REPO_URL } from '../src/site/links.js';

// The landing page is pure presentation, but two things must hold: the marketing
// sections render, and every primary CTA actually enters the app (→ /register), with
// sign-in → /login. (Bundle isolation — no crypto on "/" — is enforced by the lazy
// split in main.tsx and verified at build time, not here.)
function renderLanding(): void {
  render(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>,
  );
}

describe('landing page (PHASE4 C6)', () => {
  it('renders the hero and the key marketing sections', () => {
    renderLanding();
    expect(
      screen.getByRole('heading', { level: 1, name: /Digital continuity for your most important/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /An engineered system/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /We engineer for the day/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Things people actually ask/i })).toBeInTheDocument();
  });

  it('routes every primary CTA into the app (register) and sign-in to login', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: 'Create a free account' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(screen.getByRole('link', { name: 'Start Personal' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    // Every "Get started" CTA (nav, free tier, final strip) lands on /register.
    const getStarted = screen.getAllByRole('link', { name: /get started/i });
    expect(getStarted.length).toBeGreaterThanOrEqual(2);
    for (const cta of getStarted) expect(cta).toHaveAttribute('href', '/register');
  });

  // ── The seven security claims (2026-08-10) ────────────────────────────────
  //
  // This section carries the security claims, and two of the seven had drifted
  // away from the system they describe. Both were the same failure: prose
  // asserting a fact that lives somewhere else in the repo, with nothing able to
  // compare the two.
  //
  //   03 said trusted-contact verification "uses signed magic links bound to a
  //      device fingerprint" with affirmations "signed with the contact's
  //      per-session key". None of that exists. Contacts hold their own
  //      accounts; enrolment is a possession proof over an Ed25519 and an X25519
  //      key; affirmations are signed with that enrolled key over
  //      `challenge || ceremonyId`. The real design is STRONGER than the claim,
  //      which is exactly why nobody noticed — an understated security claim
  //      still misleads a reader evaluating the threat model.
  //
  //   05 said "the repository is not public yet", three weeks after it was
  //      published (REPO_URL, 2026-07-25). /security/build had already been
  //      updated and was telling readers to go clone it, so the site contradicted
  //      itself on whether its central transparency claim was checkable.
  //
  // Claim 05 now RENDERS from REPO_URL, so publishing or unpublishing moves the
  // copy on its own; these pin the direction so it cannot be hand-edited back.
  describe('the security claims match the system they describe', () => {
    it('claim 05 tracks REPO_URL rather than asserting a publication state', () => {
      renderLanding();
      const claims = document.querySelector('.mk-claims');
      expect(claims).not.toBeNull();
      const text = claims?.textContent ?? '';
      if (REPO_URL === null) {
        expect(text).toContain('Client source will be published');
        expect(text).toContain('not public yet');
      } else {
        expect(text).toContain('Client source is published');
        // The stale sentence, and the badge that went with it.
        expect(text).not.toContain('not public yet');
        expect(text).not.toContain('not yet published');
        // The repository has to be reachable from the claim that cites it.
        expect(
          screen.getByRole('link', { name: 'repository' }),
        ).toHaveAttribute('href', REPO_URL);
      }
    });

    it('claim 05 does not promise a signature we have never published', () => {
      // release.yml has never been triggered — zero tags, zero releases — so the
      // reproducibility claim must offer digest COMPARISON and nothing more.
      // /security/build says this plainly; the landing page must not undercut it.
      renderLanding();
      const text = document.querySelector('.mk-claims')?.textContent ?? '';
      if (REPO_URL !== null) {
        expect(text).toContain('bundle digest');
        expect(text).toMatch(/not shipped is signed per-release attestation/i);
      }
    });

    it('claim 03 describes the possession proof, not magic links', () => {
      renderLanding();
      const text = document.querySelector('.mk-claims')?.textContent ?? '';
      for (const gone of ['magic link', 'device fingerprint', 'per-session key']) {
        expect(
          text.toLowerCase().includes(gone),
          `claim 03 describes "${gone}", which this system does not do — contacts prove possession of an enrolled key`,
        ).toBe(false);
      }
      expect(text).toMatch(/prove possession/i);
      expect(text).toMatch(/ceremony id/i);
    });

    it('all seven claims are present, so a fix cannot quietly delete one', () => {
      renderLanding();
      expect(document.querySelectorAll('.mk-claims > li')).toHaveLength(7);
    });
  });
  // ── <Trans> paragraphs ─────────────────────────────────────────────────────
  //
  // Six sentences on this page carry markup INSIDE the sentence — a link, an
  // <em>, a <strong> — so they go through <Trans> rather than t(), and the
  // catalog string holds placeholder tags like <threat>…</threat>.
  //
  // That is the one i18n construct with a silent failure mode: if the tag in the
  // catalog and the key in `components` ever stop matching, i18next does not
  // throw and does not warn — it renders the tag as LITERAL TEXT, and the reader
  // sees "The rest is in our <threat>threat model</threat>." with no link. It
  // still passes a snapshot, still passes typecheck, and still reads as English.
  //
  // So each one is checked twice: the element exists as a real element, and the
  // raw angle-bracket form does NOT appear anywhere in the rendered page.
  describe('sentences whose markup is part of the sentence', () => {
    afterEach(async () => {
      await setLocale('en');
    });

    const PLACEHOLDER_TAGS = ['<threat>', '<privacy>', '<build>', '<repo>', '<em>', '<strong>'];

    it('renders inline links as links, not as literal placeholder tags', () => {
      renderLanding();
      expect(screen.getByRole('link', { name: 'threat model' })).toHaveAttribute(
        'href',
        '/security/threat-model',
      );
      expect(screen.getByRole('link', { name: 'privacy policy' })).toHaveAttribute(
        'href',
        '/legal/privacy',
      );
      // Claim 05 renders one branch or the other; both name the build page.
      expect(screen.getAllByRole('link', { name: 'build page' })[0]).toHaveAttribute(
        'href',
        '/security/build',
      );
    });

    it('leaves no placeholder tag as visible text', () => {
      renderLanding();
      const text = document.body.textContent ?? '';
      for (const tag of PLACEHOLDER_TAGS) {
        expect(
          text.includes(tag),
          `"${tag}" rendered as literal text — the catalog tag and the components key have drifted apart`,
        ).toBe(false);
      }
    });

    it('keeps the same guarantee in Spanish, where the tags move within the sentence', async () => {
      await setLocale('es');
      renderLanding();
      const text = document.body.textContent ?? '';
      for (const tag of PLACEHOLDER_TAGS) {
        expect(text.includes(tag), `"${tag}" rendered as literal text in Spanish`).toBe(false);
      }
      // The Spanish sentence puts the link in a different place; it must still
      // BE a link, which is the thing a reordered translation can break.
      expect(screen.getByRole('link', { name: 'modelo de amenazas' })).toHaveAttribute(
        'href',
        '/security/threat-model',
      );
    });
  });
});
