import { afterEach, describe, expect, it } from 'vitest';
import { renderTemplate } from './templates.js';
import { NOTIFICATION_PURPOSES } from '@truecairn/shared';

// Branded email shell + welcome (CV-brand pass, restyled to the 2026 design).
// The invariant under test: the continuity notices get a branded HTML shell whose
// *content* is identical to the bare text — the brand adds presentation, never
// information — and no open/read tracking is embedded (D2). Welcome is the one
// rich body.

const ORIGINAL_BASE = process.env['PUBLIC_BASE_URL'];
afterEach(() => {
  if (ORIGINAL_BASE === undefined) delete process.env['PUBLIC_BASE_URL'];
  else process.env['PUBLIC_BASE_URL'] = ORIGINAL_BASE;
});

describe('renderTemplate — branded shell', () => {
  it('wraps a bare notice in the shell without adding any content beyond the text', () => {
    const t = renderTemplate('check_in_request');
    expect(t.body).toBe('This is a Truecairn account status notification. Open the app to confirm you are active.');
    expect(t.html).toBeDefined();
    // The shell carries the wordmark and the exact bare text…
    expect(t.html).toContain('TrueC');
    expect(t.html).toContain('This is a Truecairn account status notification. Open the app to confirm you are active.');
    // …and nothing that tracks a read: no image beacon. (We don't forbid the
    // WORD "opened" — the footer honestly promises we don't track it; we forbid
    // the mechanism, which is an embedded image.) This doubles as the guard on
    // the brand itself: the cairn mark and wordmark must stay styled table cells
    // and text, never hosted art, so there is nothing for a client to fetch.
    expect(t.html!.toLowerCase()).not.toContain('<img');
  });

  it('renders the wordmark as TrueCairn with the "ai" accented, matching the SPA', () => {
    const t = renderTemplate('check_in_request');
    // One text run, accent on the "ai" only (Wordmark.tsx / brand.dart do the same).
    expect(t.html).toContain('TrueC<span style="color:#9daaff">ai</span>rn');
    // Never the design-mockup lowercase spelling.
    expect(t.html).not.toContain('>truecairn<');
  });

  it('injects the verification code into BOTH the text and the branded html', () => {
    const t = renderTemplate('channel_verification', { code: '424242' });
    expect(t.body).toContain('424242');
    expect(t.html).toContain('424242');
    // The code is the only per-delivery content; still no image/tracking.
    expect(t.html!.toLowerCase()).not.toContain('<img');
  });

  it('does not tell a code email that the detail is never in an email', () => {
    // The standing anti-phishing line is true of every other purpose, and false
    // of this one — the code IS in the email. A shell that said it anyway would
    // teach the reader to distrust the sentence everywhere else.
    const code = renderTemplate('channel_verification', { code: '424242' });
    expect(code.html).not.toContain('never in an email');
    expect(code.html).toContain('grants no access to your vault');
    // The passphrase promise is unconditional, so it survives on both.
    expect(code.html).toContain('never ask for your release passphrase');
    expect(renderTemplate('check_in_request').html).toContain('never in an email');
  });

  it('escapes html-unsafe characters from a body into the shell', () => {
    // No current template has these, but the escaper is load-bearing if one ever
    // carries a param — prove it neutralizes markup rather than injecting it.
    const t = renderTemplate('channel_verification', { code: '<script>&"x"' });
    expect(t.html).not.toContain('<script>');
    expect(t.html).toContain('&lt;script&gt;');
  });

  it('welcome is the one rich body, still branded and tracking-free, carrying no vault content', () => {
    const t = renderTemplate('welcome');
    expect(t.subject).toBe('Welcome to Truecairn');
    expect(t.html).toBeDefined();
    expect(t.html).toContain('Welcome to Truecairn');
    expect(t.html).toContain('Arm your continuity engine');
    // The three numbered setup steps are the point of this one.
    for (const n of ['01', '02', '03']) expect(t.html).toContain(`>${n}</td>`);
    // Honest no-tracking promise stated in the footer; no actual tracking.
    expect(t.html).toContain('never whether you opened or read it');
    expect(t.html!.toLowerCase()).not.toContain('<img');
    // The plain-text fallback exists for non-HTML clients, and carries the same
    // steps in the same order — an HTML-blocking client loses styling, not sense.
    expect(t.body).toContain('Your email is confirmed');
    expect(t.body).toContain('Add a trusted contact');
    expect(t.body).toContain('Arm your continuity engine');
  });

  it('every purpose produces an html shell with a header label and a way in', () => {
    for (const purpose of NOTIFICATION_PURPOSES) {
      const html = renderTemplate(purpose).html;
      expect(html, purpose).toBeDefined();
      // The header band's category label — every purpose has one, so no email
      // ever ships with an empty slot where the label should be.
      expect(html, purpose).toMatch(/text-transform:uppercase;color:#7d7f9e">[a-z][a-z -]*</);
      expect(html, purpose).toContain('text-decoration:none;letter-spacing:-0.01em">');
    }
  });

  it('builds links from PUBLIC_BASE_URL, and never puts a token in one', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://example.test/';
    const html = renderTemplate('escalation_request').html!;
    // Trailing slash normalised; app and public pages share the one origin.
    expect(html).toContain('href="https://example.test/home"');
    expect(html).toContain('href="https://example.test/settings"');
    expect(html).toContain('href="https://example.test/guide"');
    expect(html).not.toContain('example.test//');
    // Every link is a bare path. A capability in a URL would make the email
    // itself the credential — the reader signs in on the other side instead.
    for (const href of html.match(/href="[^"]*"/g) ?? []) {
      expect(href, href).not.toMatch(/[?#]/);
    }
  });

  it('prints no postal address', () => {
    // The design mockup carried a placeholder office. We do not have one to
    // print, and an invented address on a zero-knowledge product's mail is the
    // kind of small lie the rest of the product is built to avoid.
    const html = renderTemplate('welcome').html!;
    expect(html).not.toMatch(/Suite|Street|\b[A-Z]{2} \d{5}\b/);
  });
});

// ── Locale (docs/40 Phase 3) ────────────────────────────────────────────────
//
// Emails are the surface where a translation bug is least visible and most
// costly: nobody reviews an outbound message, and the reader cannot report a
// wrong one back to the page it came from. So the invariants above are asserted
// again in Spanish rather than assumed to carry over — the shell must still add
// no information, still embed no tracking, and still name the RELEASE passphrase
// in its anti-phishing line.
describe('renderTemplate — a second language', () => {
  it('falls back to the source language for an unknown locale, never to a key', () => {
    // The type says Locale, but the value arrives from a database column, and a
    // row written before a locale was retired is exactly how a "cannot happen"
    // value happens. English is the honest fallback; a blank subject is not.
    const t = renderTemplate('check_in_request', undefined, 'de' as 'es');
    expect(t.subject).toBe('Confirm you are active');
    expect(t.body).toContain('Truecairn');
  });

  it('translates the body and the subject of every purpose', () => {
    for (const purpose of NOTIFICATION_PURPOSES) {
      const en = renderTemplate(purpose);
      const es = renderTemplate(purpose, undefined, 'es');
      expect(es.subject, purpose).not.toBe(en.subject);
      expect(es.body, purpose).not.toBe(en.body);
      expect(es.subject.trim(), purpose).not.toBe('');
      expect(es.body.trim(), purpose).not.toBe('');
    }
  });

  it('marks the document language so a screen reader pronounces it correctly', () => {
    expect(renderTemplate('welcome', undefined, 'es').html).toContain('<html lang="es"');
    expect(renderTemplate('welcome').html).toContain('<html lang="en"');
  });

  it('keeps the shell information-free in Spanish too', () => {
    for (const purpose of NOTIFICATION_PURPOSES) {
      const t = renderTemplate(purpose, undefined, 'es');
      // Rule 1 of the shell: no images, so there is nothing for a client to
      // fetch and therefore nothing to observe. This is the mechanical half of
      // the public promise never to detect a read.
      expect(t.html!.toLowerCase(), purpose).not.toContain('<img');
      // Every purpose still gets a category label and a way in.
      expect(t.html, purpose).toMatch(/text-transform:uppercase;color:#7d7f9e">[^<]+</);
      expect(t.html, purpose).toContain('text-decoration:none;letter-spacing:-0.01em">');
    }
  });

  it('keeps the anti-phishing line about the RELEASE passphrase, not the master one', () => {
    // The two are different secrets that fail differently, and templates.ts has
    // already had to correct one being used for the other once. A translation is
    // where that conflation would recur unnoticed — "frase maestra" here would
    // train an owner to hand over the wrong secret.
    const notice = renderTemplate('check_in_request', undefined, 'es').html!;
    expect(notice).toContain('frase de liberación');
    expect(notice).not.toContain('frase maestra');
    const welcome = renderTemplate('welcome', undefined, 'es');
    expect(welcome.body).toContain('Nunca te pediremos tu frase de liberación');
    // The welcome body DOES name the master passphrase, correctly, where it
    // explains what encrypts the vault. Both secrets appear; neither is used for
    // the other's job.
    expect(welcome.body).toContain('frase maestra');
  });

  it('carries the verification code into both the text and the html, in either language', () => {
    for (const locale of ['en', 'es'] as const) {
      const t = renderTemplate('channel_verification', { code: '482913' }, locale);
      expect(t.body, locale).toContain('482913');
      expect(t.html, locale).toContain('482913');
      // The positional variable is the code alone, which is language-neutral —
      // that is what keeps the approved WhatsApp template in step no matter what
      // sentence surrounds it.
      expect(t.variables, locale).toEqual({ '1': '482913' });
    }
  });

  it('does not tell a Spanish code email that the detail is never in an email', () => {
    // The same contradiction guarded in English above: a message CARRYING the
    // code cannot also claim the detail is never in an email.
    const code = renderTemplate('channel_verification', { code: '482913' }, 'es').html!;
    expect(code).toContain('Este código solo confirma');
    expect(code).not.toContain('nunca en un correo');
  });

  it('keeps the welcome steps in the same order, with the same numbering', () => {
    const es = renderTemplate('welcome', undefined, 'es');
    for (const n of ['01', '02', '03']) expect(es.html).toContain(`>${n}</td>`);
    // The plain-text fallback carries the same three steps: an HTML-blocking
    // client loses styling, not sense — in either language.
    expect(es.body).toContain('Añade un contacto de confianza');
    expect(es.body).toContain('Activa tu motor de continuidad');
  });

  it('mixes no English chrome into a Spanish email', () => {
    // THE FAILURE THIS EXISTS FOR: the shell is assembled from a dozen separate
    // strings — header label, CTA, reassurance band, footer notice, three footer
    // links — and each falls back to English independently. Miss one and the
    // email still renders, still reads, and has an English button in the middle
    // of a Spanish page. Nobody reviews an outbound message, so nothing else
    // would catch it.
    //
    // Asserted as whole phrases rather than single words: "Help" appears inside
    // no Spanish word, but a bare word list would flag the URLs and the inline
    // CSS. These are the exact strings the fallbacks would produce.
    const ENGLISH_CHROME = [
      'Open Truecairn',
      'Finish setup',
      'Notification settings',
      'Security model',
      '>Help<',
      'The detail is in the app',
      'This code only confirms',
      'You are receiving this because',
      'never whether you opened or read it',
      'to finish setting up',
      'welcome to Truecairn',
    ];
    for (const purpose of NOTIFICATION_PURPOSES) {
      const html = renderTemplate(purpose, { code: '482913' }, 'es').html!;
      for (const phrase of ENGLISH_CHROME) {
        expect(html.includes(phrase), `${purpose}: English chrome "${phrase}" leaked`).toBe(false);
      }
    }
  });

  it('gives every purpose a Spanish header label', () => {
    // The label map is a partial override, so a purpose added later inherits the
    // English label silently. This is the one string that would sit in the header
    // band of an otherwise-Spanish email.
    for (const purpose of NOTIFICATION_PURPOSES) {
      const es = renderTemplate(purpose, undefined, 'es').html!;
      const en = renderTemplate(purpose).html!;
      const label = (h: string): string =>
        /text-transform:uppercase;color:#7d7f9e">([^<]+)</.exec(h)?.[1] ?? '';
      expect(label(es), purpose).not.toBe('');
      expect(label(es), `${purpose}: header label is still the English one`).not.toBe(label(en));
    }
  });

  it('prints no postal address in Spanish either', () => {
    expect(renderTemplate('welcome', undefined, 'es').html).not.toMatch(
      /Suite|Street|\b[A-Z]{2} \d{5}\b/,
    );
  });

  it('leaks no vault content, tier, or release detail in any language', () => {
    // The rule every body obeys (PHASE3_5 §f/§g): say enough to ACT, nothing
    // more. An interceptor learns only that the recipient uses Truecairn. These
    // are the words a well-meaning translator adds to make a bare notice sound
    // less abrupt — "your vault", "your contacts", the tier names.
    const FORBIDDEN = /bóveda|contacto de confianza|S1|S2|S3|liberación/i;
    for (const purpose of NOTIFICATION_PURPOSES) {
      const t = renderTemplate(purpose, undefined, 'es');
      // welcome is the one rich body and explains the product on purpose;
      // plan_downgraded names the vault to make its safety promise; the
      // contact-facing notices must name the role they are addressing.
      if (purpose === 'welcome' || purpose === 'plan_downgraded') continue;
      if (purpose.startsWith('ceremony_') || purpose === 'contact_invitation') continue;
      expect(t.body, purpose).not.toMatch(FORBIDDEN);
    }
  });
});
