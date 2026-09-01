import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Guide } from '../src/screens/guide/Guide.js';
import { Changelog } from '../src/screens/public/Changelog.js';
import { BuildProvenance } from '../src/screens/public/build.js';
import { About, Contact, Press, Status } from '../src/screens/public/company.js';
import { Dpa, Privacy, SubProcessors, Terms, WindDown } from '../src/screens/public/legal.js';
import {
  Disclosure,
  KnownLimits,
  SecurityModel,
  ThreatModel,
} from '../src/screens/public/security.js';
import { NotFound } from '../src/site/NotFound.js';
import { AiTransparency } from '../src/screens/public/security.js';
import { setLocale } from '../src/i18n/index.js';

function renderAt(node: JSX.Element): ReturnType<typeof render> {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

// Every render here is inert by default. /status fetches live status on mount,
// and an unstubbed fetch settles AFTER the test has finished — which surfaces as
// act() warnings on whichever test happens to be running by then, and makes a
// real failure look like it came from an unrelated page. Cases that need live
// data restub fetch themselves.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public content pages', () => {
  it('legal pages no longer show the pre-launch draft banner', () => {
    for (const page of [<Privacy />, <Terms />, <Dpa />, <SubProcessors />, <WindDown />]) {
      const { unmount } = renderAt(page);
      expect(screen.queryByText(/pending legal review/i)).toBeNull();
      unmount();
    }
  });

  it('sub-processors lists the real stack and nothing it does not use', () => {
    const { container } = renderAt(<SubProcessors />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/Railway/);
    expect(text).toMatch(/Resend/);
    // Moved off Vertex 2026-08-25 — the AI features now call the Gemini API
    // directly. This assertion exists to keep the published list matching the
    // real stack, so it moves WITH the stack rather than being deleted.
    expect(text).toMatch(/Gemini API/);
    expect(text).toMatch(/Cloud KMS/);
    expect(text).toMatch(/S3-compatible/);
    // We do not use these — they must not be invented into the list.
    expect(text).not.toMatch(/Stripe|Twilio|SendGrid|Mailgun|Auth0/i);
  });

  it('security model has an honest "Independent reviews" section (no faked reports)', () => {
    const { container } = renderAt(<SecurityModel />);
    expect(screen.getByRole('heading', { name: /Independent reviews/i })).toBeInTheDocument();
    expect(container.querySelector('#audits')).not.toBeNull();
    expect(container.textContent ?? '').toMatch(/have not yet published/i);
  });

  it('makes no false compliance-certification claim', () => {
    const { container } = renderAt(<SecurityModel />);
    const text = container.textContent ?? '';
    // We may say we hold none; we must not claim to be certified.
    expect(text).not.toMatch(/SOC ?2[- ]?(certified|compliant)/i);
    expect(text).not.toMatch(/ISO ?27001[- ]?(certified|compliant)/i);
  });

  it('threat model and disclosure pages render', () => {
    renderAt(<ThreatModel />);
    expect(screen.getByRole('heading', { level: 1, name: /Threat model/i })).toBeInTheDocument();
    expect(screen.getByText(/malicious trusted contact/i)).toBeInTheDocument();
  });

  it('disclosure, about, status, changelog render their headings', () => {
    renderAt(<Disclosure />);
    expect(screen.getByRole('heading', { level: 1, name: /disclosure policy/i })).toBeInTheDocument();
    renderAt(<About />);
    // Was `getAllByText(/San Francisco and Berlin/i)` — a render smoke-check
    // that reached for a distinctive string and, in doing so, PINNED a false
    // claim: there are no offices in either city. Removing the line from the
    // page turned this green test red, which is the only reason it was found —
    // the 2026-08-13 audit of the corporate-identity claims missed it entirely
    // because it searched the pages, not their tests.
    //
    // Now asserts the heading, exactly like the three siblings in this test. A
    // smoke-check should reach for the thing that is structurally guaranteed to
    // be there, not the most quotable sentence on the page; the latter makes the
    // test a hostage to copy it was never meant to govern.
    expect(screen.getByRole('heading', { level: 1, name: /About Truecairn/i })).toBeInTheDocument();
    renderAt(<Status />);
    expect(screen.getByRole('heading', { level: 1, name: /Service status/i })).toBeInTheDocument();
    renderAt(<Changelog />);
    expect(screen.getByRole('heading', { level: 1, name: /Changelog/i })).toBeInTheDocument();
  });
});

// ── Known limits, /security/limits (D9, 2026-08-13) ──────────────────────────
//
// This page exists to say the things a marketing page would not. Its failure
// mode is therefore NOT a crash — it is a well-meaning copy edit that rounds an
// uncomfortable sentence off into a comfortable one, leaving a page that still
// renders, still reads well, and no longer discloses anything.
//
// So these assert on SUBSTANCE, not on headings. The S1/S2-vs-S3 asymmetry is
// the residual of the C-1 contact-key fix and the single most important claim
// here; "we verify contact keys" is what it decays into if nobody is watching.
// A change that flips one of these is a bug, not a test to update.
describe('known limits (/security/limits)', () => {
  function limitsText(): string {
    const { container } = renderAt(<KnownLimits />);
    return container.textContent ?? '';
  }

  it('renders', () => {
    renderAt(<KnownLimits />);
    expect(screen.getByRole('heading', { level: 1, name: /Known limits/i })).toBeInTheDocument();
  });

  it('states the S1/S2-vs-S3 safety-number asymmetry, both halves', () => {
    const text = limitsText();
    // The dependency...
    expect(text).toMatch(/S1 and S2[\s\S]{0,80}depend/i);
    // ...AND the exception. Either half alone is misleading: the first without
    // the second implies S3 is equally exposed; the second without the first
    // reads as reassurance.
    expect(text).toMatch(/S3 does not/i);
    // The reason S3 is different, so the claim is checkable rather than asserted.
    expect(text).toMatch(/release passphrase/i);
  });

  it('says nothing in the system can tell whether the call was made', () => {
    // The unenforceable half. Narrowed in Aug 2026 (an owner who never confirmed
    // at all is now warned), never closed — the page must not present it as
    // solved just because part of it improved.
    expect(limitsText()).toMatch(/nothing in the system can tell|cannot tell whether/i);
  });

  it('separates "the mechanism is tested" from "people have done it"', () => {
    const text = limitsText();
    expect(text).toMatch(/no release has ever been completed by a human/i);
    // Both claims, because collapsing them in either direction is the failure:
    // dropping the first undersells a real proof, dropping the second oversells
    // it into "releases work".
    expect(text).toMatch(/mechanism/i);
    expect(text).toMatch(/drills/i);
  });

  it('discloses the untested and unbuilt surfaces a buyer would ask about', () => {
    const text = limitsText();
    expect(text, 'mobile app not distributed (D4)').toMatch(/not distributed|no Truecairn app/i);
    expect(text, 'no load testing').toMatch(/no load or performance testing/i);
    expect(text, 'no audit or certifications').toMatch(/no independent security firm|no third-party/i);
    expect(text, 'single region/replica').toMatch(/single Postgres|one region|no failover/i);
    expect(text, 'recovery window is the honest 24h, not the 5min database figure').toMatch(/24 hours/i);
  });

  it('is reachable from the security model page and the wind-down playbook', () => {
    // Same disclosure instinct; a reader who finds one should find the other.
    const sec = renderAt(<SecurityModel />);
    expect(
      sec.container.querySelector('a[href="/security/limits"]'),
      '/security must link to /security/limits',
    ).not.toBeNull();

    const wind = renderAt(<WindDown />);
    expect(
      wind.container.querySelector('a[href="/security/limits"]'),
      '/legal/wind-down must link to /security/limits',
    ).not.toBeNull();
  });
});

// ── Press kit (2026-07-29) ───────────────────────────────────────────────────
//
// A press page's failure mode is a claim a journalist repeats and we then have to
// correct. These pin the claims, not the layout.
describe('press page', () => {
  it('hands out the SAME boilerplate it displays', async () => {
    // The risk this closes: a copy button that quietly serves a rosier version of
    // the paragraph on the page. Whatever the clipboard receives has to be the
    // text a reader can see and check.
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    const { container } = renderAt(<Press />);
    const bodies = Array.from(container.querySelectorAll('.pr-copy-body')).map(
      (el) => el.textContent ?? '',
    );
    const buttons = screen.getAllByRole('button', { name: /^Copy /i });
    expect(buttons).toHaveLength(bodies.length);
    expect(bodies).toHaveLength(2);

    for (const [i, button] of buttons.entries()) {
      await userEvent.click(button);
      expect(writeText).toHaveBeenLastCalledWith(bodies[i]);
    }
    vi.unstubAllGlobals();
  });

  it('states the load-bearing zero-knowledge claim and refuses the overclaims', () => {
    const { container } = renderAt(<Press />);
    const text = container.textContent ?? '';
    // The one line we want quoted.
    expect(text).toMatch(/we cannot read your vault, and we cannot reset your passphrase/i);
    // The three things a story could get wrong, said plainly.
    expect(text).toMatch(/not published a third-party security audit/i);
    expect(text).toMatch(/no SOC 2, no ISO 27001/i);
    expect(text).toMatch(/no logos, no testimonials, no user counts/i);
    // And never the claims themselves.
    expect(text).not.toMatch(/SOC ?2[- ]?(certified|compliant)/i);
    expect(text).not.toMatch(/unbreakable\.|military-grade|trusted by \d/i);
  });

  it('offers the four brand marks as real files, and the correct wordmark rule', () => {
    const { container } = renderAt(<Press />);
    const downloads = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.pr-dl[download]'));
    // Four marks + three screenshots, every one a path under /assets (the same
    // files the app itself serves, so a download cannot drift from what we ship).
    expect(downloads).toHaveLength(7);
    for (const a of downloads) expect(a.getAttribute('href')).toMatch(/^\/assets\/(brand|landing)\//);
    // The wordmark guidance must describe the real brand, not the old lowercase
    // form the design export used.
    expect(container.textContent ?? '').toMatch(/written TrueCairn/);
  });
});

// ── Status (2026-07-29) ──────────────────────────────────────────────────────
//
// This page exists to NOT overclaim, the same way build provenance does. The
// invariants: no invented numbers, and the one reassurance that actually matters.
describe('status page', () => {
  it('leads with the reassurance that an outage cannot release a vault', () => {
    renderAt(<Status />);
    expect(screen.getByRole('status').textContent ?? '').toMatch(
      /An outage cannot release your vault/i,
    );
  });

  // The page went live on 2026-07-30, so "there is no dashboard" is no longer the
  // invariant. What survives — and is the actual point — is that every number and
  // every green dot must come from the server. With no data loaded there is
  // nothing to show, and the page must show nothing rather than a default.
  it('publishes no figure and no green tile before any data arrives', async () => {
    const { container } = renderAt(<Status />);
    const text = container.textContent ?? '';
    // No fabricated availability, SLA, or incident history.
    expect(text).not.toMatch(/\b\d{2}\.\d+% ?(uptime|availability)/i);
    expect(text).not.toMatch(/all systems (operational|normal)/i);
    // No component may render an 'ok' dot from a page that has been told nothing.
    expect(container.querySelectorAll('.st-watch-list .st-dot.ok')).toHaveLength(0);
  });

  it('reports unknown — never ok — when the status API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { container } = renderAt(<Status />);
    await screen.findByText(/Status unavailable/i);
    // Reaching the page proves the web tier is up and says nothing about the
    // engine. A failed fetch that rendered as green would be the exact lie this
    // page exists to avoid.
    expect(container.querySelector('.st-live .st-dot.unknown')).not.toBeNull();
    expect(container.querySelector('.st-live .st-dot.ok')).toBeNull();
  });

  it('says how long it has been measuring instead of rounding a thin window up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          releasePath: 'ok',
          checks: [{ id: 'worker', label: 'Release worker', state: 'ok', releaseCritical: true }],
          failing: [],
          availability: {
            measuringSince: '2026-07-30T00:00:00.000Z',
            observedDays: 0.4,
            requestedWindowDays: 90,
            // Not enough evidence yet — the server declines to compute one.
            releasePathOkPercent: null,
            unobservedMinutes: 0,
          },
          observedAt: '2026-07-30T10:00:00.000Z',
        }),
      })),
    );
    const { container } = renderAt(<Status />);
    await screen.findByText(/not yet long enough to publish a percentage/i);
    expect(container.textContent ?? '').not.toMatch(/\d+(\.\d+)?%/);
  });

  it('shows the measured figure, and says plainly that gaps count against it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          releasePath: 'ok',
          checks: [{ id: 'worker', label: 'Release worker', state: 'ok', releaseCritical: true }],
          failing: [],
          availability: {
            measuringSince: '2026-04-01T00:00:00.000Z',
            observedDays: 90,
            requestedWindowDays: 90,
            releasePathOkPercent: 99.4,
            unobservedMinutes: 12,
          },
          observedAt: '2026-07-30T10:00:00.000Z',
        }),
      })),
    );
    const { container } = renderAt(<Status />);
    await screen.findByText(/99\.4%/);
    const text = container.textContent ?? '';
    // The unobserved minutes are not hidden: they are the caveat that makes the
    // number honest rather than flattering.
    expect(text).toMatch(/12 minutes/);
    expect(text).toMatch(/against/i);
  });

  it('keeps "unknown" as a state and names what is actually unknown', () => {
    const { container } = renderAt(<Status />);
    const text = container.textContent ?? '';
    for (const state of ['ok', 'degraded', 'down', 'unknown']) {
      expect(text).toContain(state);
    }
    // The page's argument only holds while it refuses to round unknown up to
    // green, so what is not instrumented stays named.
    expect(text).toMatch(/not separately instrumented/i);
    // Backups became a dot on 2026-08-11, and the page has to say what that dot
    // actually means: a dated human restore, NOT a live probe of the platform's
    // snapshots. A green tile readable as "a backup ran last night" would be the
    // overclaim this whole section exists to prevent.
    expect(text).toMatch(/Database backups/);
    expect(text).toMatch(/does not mean “a backup ran last night”/);
    expect(text).toMatch(/restored from/i);
  });

  it('describes the channel-failure pause as BOUNDED (30 days), not indefinite', () => {
    // The stall bound is the 2026-07-25 correction: pausing forever guaranteed a
    // wrongful non-release. A page that reverted to "pauses until we hear from
    // you" would be describing behaviour the engine no longer has.
    const { container } = renderAt(<Status />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/30 days/);
    expect(text).not.toMatch(/pauses? (indefinitely|forever)/i);
  });
});

describe('user guide — corrected S3 model (docs/24)', () => {
  function renderGuide(): ReturnType<typeof render> {
    // The guide is a single crypto-free PUBLIC page: it renders with NO
    // SessionProvider (it must not import the authed graph). Rendering it bare here
    // also guards that it never reintroduces a useSession dependency.
    return render(
      <MemoryRouter>
        <Guide />
      </MemoryRouter>,
    );
  }

  it('describes S3 as passphrase-mandatory and permanently unrecoverable if lost', () => {
    const { container } = renderGuide();
    const text = container.textContent ?? '';
    expect(text).toMatch(/mandatory mask/i);
    expect(text).toMatch(/permanently unrecoverable/i);
    // S2 keeps the optional-fallback framing.
    expect(text).toMatch(/optional fallback/i);
  });

  it('does NOT use the old "3-of-4" S3 framing', () => {
    const { container } = renderGuide();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/3-of-4/i);
    expect(text).not.toMatch(/any three of four/i);
  });
});

// ── Build provenance (2026-07-25) ────────────────────────────────────────────
//
// This page's whole value is that it does NOT overclaim. Browser-delivered E2EE
// cannot self-verify — the code computing the digest is served by the origin it
// is checking — and a page that implied otherwise would be worse than no page,
// because it would convert an honest limitation into false assurance. These
// tests pin the honesty, not the layout.
describe('build provenance page', () => {
  const manifest = {
    commit: 'abc123',
    ref: 'v1.2.3',
    builtAt: '2026-07-25T00:00:00.000Z',
    bundleDigest: 'deadbeef'.repeat(8),
    assetCount: 2,
    assets: { 'index.html': 'aa'.repeat(32), 'assets/app.js': 'bb'.repeat(32) },
  };

  function withManifest(ok: boolean): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok,
          json: () => Promise.resolve(manifest),
        } as Response),
      ),
    );
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the running bundle digest and its source commit', async () => {
    withManifest(true);
    renderAt(<BuildProvenance />);
    expect(await screen.findByText(manifest.bundleDigest)).toBeTruthy();
    expect(screen.getByText('abc123')).toBeTruthy();
    expect(screen.getByText('v1.2.3')).toBeTruthy();
  });

  it('states the limit plainly — this page could itself be lied to', async () => {
    withManifest(true);
    const { container } = renderAt(<BuildProvenance />);
    await screen.findByText(manifest.bundleDigest);
    const text = container.textContent ?? '';
    // The non-negotiable sentence: same origin serves both the bundle and the
    // checker, so a fully compromised origin can doctor both.
    expect(text).toMatch(/does not.*mean this page cannot lie to you/i);
    expect(text).toMatch(/same origin/i);
    // And it must not claim verification it cannot perform.
    expect(text).not.toMatch(/verified authentic|guaranteed untampered|proven safe/i);
  });

  it('gives real rebuild-and-compare instructions now the repo is public', async () => {
    withManifest(true);
    const { container } = renderAt(<BuildProvenance />);
    await screen.findByText(manifest.bundleDigest);
    const text = container.textContent ?? '';
    // The whole point of publishing: "record this digest" becomes "rebuild it
    // yourself and compare". The page must now offer the stronger instruction.
    expect(text).toMatch(/rebuild from source/i);
    expect(text).not.toMatch(/not public yet/i);
    const repo = container.querySelector('a[href^="https://github.com/"]');
    expect(repo).not.toBeNull();
    // Still never a stringified null — the null-safe branch must stay intact so
    // this degrades correctly if the repo is ever unpublished.
    expect(container.querySelector('a[href="null"]')).toBeNull();
  });

  // Regression pin for QA finding P1-3 (2026-08-09). The page told readers to
  // "find the release matching the commit above and open its build attestation".
  // There are no releases, no tags and no attestations — release.yml has never
  // been triggered — so the one surface built to be checked adversarially was
  // advertising a capability that did not exist. On THIS page that is the worst
  // possible failure: the first researcher who follows the steps finds nothing
  // and concludes the whole verification story is theatre.
  //
  // Re-add the attestation instruction only when a tagged release actually
  // publishes one. Until then these assertions are the guard.
  it('does not send the reader after an attestation that has never been published', async () => {
    withManifest(true);
    const { container } = renderAt(<BuildProvenance />);
    await screen.findByText(manifest.bundleDigest);
    const text = container.textContent ?? '';
    // No instruction to go open a release artifact.
    expect(text).not.toMatch(/open its build attestation/i);
    expect(text).not.toMatch(/find the release matching/i);
    // And the gap is stated, not merely omitted — silence would still leave a
    // reader assuming the signed artifact exists somewhere.
    expect(text).toMatch(/no tagged release has been published/i);
    // A branch name must never be presented as a release (in production `ref` is
    // the deploy branch, because nothing is tagged).
    expect(screen.queryByRole('rowheader', { name: /^Release$/i })).toBeNull();
  });

  // The mirror can lag the deployment, so a digest mismatch is ambiguous by
  // construction. A page that implied otherwise would manufacture false alarms
  // about tampering — the mirror image of overclaiming, and just as dishonest.
  it('warns that a mismatch may only mean the versions differ', async () => {
    withManifest(true);
    const { container } = renderAt(<BuildProvenance />);
    await screen.findByText(manifest.bundleDigest);
    expect(container.textContent ?? '').toMatch(/expect a difference if the two are not at the same commit/i);
  });

  it('says so when a build shipped no manifest instead of implying tampering', async () => {
    withManifest(false);
    const { container } = renderAt(<BuildProvenance />);
    const empty = await screen.findByText(/did not publish a manifest/i);
    expect(empty).toBeTruthy();
    expect(container.textContent ?? '').toMatch(/reason to ask us, not as proof/i);
  });
});

// ── 404 (2026-08-09, QA P3-1) ────────────────────────────────────────────────
//
// Both route trees used to answer an unknown path with a redirect, which
// destroyed the URL that failed before anyone could read or report it. The
// person that hurt most was a trusted contact holding a ceremony link mangled in
// transit: they got a signup form and no sign anything had gone wrong. These
// tests pin the two properties that make the page worth having — it keeps the
// evidence, and it does not send that person off to create an account.
describe('404 page', () => {
  function renderPath(path: string): ReturnType<typeof render> {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <NotFound />
      </MemoryRouter>,
    );
  }

  it('shows the address that failed, so it can be reported', () => {
    const { container } = renderPath('/ceremonies/abc-123%20broken?token=xyz');
    const text = container.textContent ?? '';
    expect(text).toContain('/ceremonies/abc-123%20broken?token=xyz');
  });

  it('tells a trusted contact NOT to sign up to work around a broken link', () => {
    const { container } = renderPath('/nope');
    const text = container.textContent ?? '';
    expect(text).toMatch(/trusted contact/i);
    expect(text).toMatch(/do not create an account/i);
    // And it must not reassure them that their vault/account is broken.
    expect(text).toMatch(/nothing has gone wrong with your account/i);
  });

  it('renders the attempted path inertly — never as a link', () => {
    // The pathname is entirely attacker-chosen. Displaying it is the point;
    // making it clickable, or letting it become markup, is not.
    const { container } = renderPath('/javascript:alert(1)');
    const anchors = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(anchors.some((h) => h?.includes('javascript:'))).toBe(false);
    expect(container.querySelector('code')?.textContent).toBe('/javascript:alert(1)');
  });

  it('asks not to be indexed and publishes no canonical for a URL that does not exist', () => {
    renderPath('/not-a-real-page');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toMatch(
      /noindex/i,
    );
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
  });
});


// ── <Trans> markup, in both languages ───────────────────────────────────────
//
// Sentences whose markup is part of the sentence — an inline link, an <em>, a
// <strong> — go through <Trans>, so the catalog string carries placeholder tags
// like <threat>…</threat> and the component supplies the element.
//
// THE FAILURE MODE IS SILENT. If the tag in the catalog and the key in
// `components` stop matching, i18next does not throw and does not warn: it
// renders the tag as LITERAL TEXT. The page still renders, still typechecks,
// still reads as prose — and a reader sees "<threat>threat model</threat>" with
// no link. Nothing else in this suite would notice, because every other
// assertion here is about substance, and the substance is all still there.
//
// Run in Spanish as well as English, because that is where it actually breaks:
// a translator moving a link to where their language needs it is exactly the
// edit that mistypes a tag, and Spanish is the language nobody reviewing a diff
// here reads closely.
describe('sentences whose markup is part of the sentence', () => {
  afterEach(async () => {
    await setLocale('en');
  });

  const PAGES: readonly (readonly [string, JSX.Element])[] = [
    ['guide', <Guide />],
    ['security model', <SecurityModel />],
    ['threat model', <ThreatModel />],
    ['AI transparency', <AiTransparency />],
    ['disclosure', <Disclosure />],
    ['known limits', <KnownLimits />],
    ['build provenance', <BuildProvenance />],
    ['about', <About />],
    ['contact', <Contact />],
    ['press', <Press />],
    ['status', <Status />],
  ];

  // Every placeholder tag used anywhere in the pages catalog. A new one that is
  // not listed here is not checked, so add it when you add the sentence.
  const PLACEHOLDER_TAGS = [
    '<strong>',
    '<em>',
    '<code>',
    '<threat>',
    '<privacy>',
    '<security>',
    '<model>',
    '<ai>',
    '<build>',
    '<repo>',
    '<winddown>',
    '<status>',
    '<limits>',
    '<disclosure>',
    '<contact>',
    '<email>',
    '<secrets>',
    '<tiers>',
    '<press>',
    '<audits>',
    '<changelog>',
  ];

  function assertNoLiteralTags(label: string, lang: string): void {
    const text = document.body.textContent ?? '';
    for (const tag of PLACEHOLDER_TAGS) {
      expect(
        text.includes(tag),
        `${label} (${lang}): "${tag}" rendered as literal text — the catalog tag and the components key have drifted apart`,
      ).toBe(false);
    }
  }

  it.each(PAGES.map(([name]) => name))('renders real markup in English: %s', (name) => {
    renderAt(PAGES.find(([n]) => n === name)![1]);
    assertNoLiteralTags(name, 'en');
  });

  it.each(PAGES.map(([name]) => name))('renders real markup in Spanish: %s', async (name) => {
    await setLocale('es');
    renderAt(PAGES.find(([n]) => n === name)![1]);
    assertNoLiteralTags(name, 'es');
  });

  // A tag rendering correctly is necessary but not sufficient: <Trans> with an
  // unknown component key drops the tag and keeps the text, which passes the
  // check above while silently losing the link. So assert the links exist too,
  // in the language where a reordered sentence could lose them.
  it('keeps inline links as links in Spanish', async () => {
    await setLocale('es');
    renderAt(<SecurityModel />);
    expect(screen.getByRole('link', { name: 'modelo de amenazas' })).toHaveAttribute(
      'href',
      '/security/threat-model',
    );
    expect(screen.getByRole('link', { name: 'límites conocidos' })).toHaveAttribute(
      'href',
      '/security/limits',
    );
    // Source-language-only by decision: the wind-down playbook has no /es page,
    // so this must stay an unprefixed plain link even on a Spanish page.
    expect(screen.getByRole('link', { name: 'plan de cierre' })).toHaveAttribute(
      'href',
      '/legal/wind-down',
    );
  });
});
