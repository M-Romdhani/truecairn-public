import { describe, expect, it } from 'vitest';
import { LOCALES, DEFAULT_LOCALE, OFFERED_LOCALES, isLocale, matchLocale } from '@truecairn/shared';
import { appEn } from '../src/i18n/catalog/app/en.js';
import { appEs } from '../src/i18n/catalog/app/es.js';
import { pagesEn } from '../src/i18n/catalog/pages/en.js';
import { pagesEs } from '../src/i18n/catalog/pages/es.js';
import { siteEn, SOURCE_LANGUAGE_ONLY_KEYS } from '../src/i18n/catalog/site/en.js';
import { siteEs } from '../src/i18n/catalog/site/es.js';

// The catalog ships in three halves (docs/40 Phase 2) — site loads eagerly, app
// loads with AuthedApp, pages loads with PublicPages — but they merge into ONE
// i18next namespace, so every check below runs over the union. The split is a
// delivery decision; a key is either defined or it is not, and which bundle
// carries it changes nothing about what the app can say.
const en: Record<string, string> = { ...siteEn, ...appEn, ...pagesEn };
const es: Record<string, string | undefined> = { ...siteEs, ...appEs, ...pagesEs };

// The catalogs are data, and data drifts silently. These are the checks a human
// cannot do by eye across two files (docs/40 Phase 0).

const enKeys = Object.keys(en).sort();
const esKeys = Object.keys(es).sort();

describe('deliberately-untranslated keys', () => {
  // The exclusion list must name keys that EXIST, or it silently stops excluding
  // anything and the coverage number quietly drops — the failure mode is a
  // number that looks like work outstanding when it is a stale list.
  it('names only keys the source catalog actually has', () => {
    expect(SOURCE_LANGUAGE_ONLY_KEYS.filter((k) => !(k in en))).toEqual([]);
  });

  // And they must be genuinely absent from the translation: a key on this list
  // that HAS been translated means the decision changed and the list did not.
  it('are absent from the Spanish catalog', () => {
    expect(SOURCE_LANGUAGE_ONLY_KEYS.filter((k) => k in es)).toEqual([]);
  });
});

describe('the three catalog halves', () => {
  // Merging with spread means a key present in both halves would be silently
  // resolved by whichever spreads last — and at RUNTIME by whichever
  // addResourceBundle ran last, which is a different answer. Neither is a
  // decision anyone made, so the overlap is the bug.
  it('define no key twice', () => {
    const halves = [
      ['site', siteEn],
      ['app', appEn],
      ['pages', pagesEn],
    ] as const;
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [name, half] of halves) {
      for (const key of Object.keys(half)) {
        const first = seen.get(key);
        if (first === undefined) seen.set(key, name);
        else clashes.push(`${key} (${first} + ${name})`);
      }
    }
    expect(clashes).toEqual([]);
  });

  // The site half is what an anonymous visitor downloads to read the landing.
  // Its size is the reason the split exists, so keep the number visible: a key
  // that drifts into it costs every first visit.
  // THE POINT OF THE THIRD HALF, asserted rather than left to a comment. The
  // long-form public pages are several times the landing's word count, and the
  // whole reason they were split out is that an anonymous visitor to "/" must
  // not download them. If the eager half ever grows past the lazy content half,
  // a page's copy has drifted into site/ and the split has quietly stopped
  // paying for itself.
  it('keeps the eager half smaller than the content it defers', () => {
    expect(Object.keys(siteEn).length).toBeLessThan(Object.keys(pagesEn).length);
  });

  it('reports the eagerly-loaded half', () => {
    console.log(
      `[i18n] site half ${Object.keys(siteEn).length} keys (eager) · ` +
        `app half ${Object.keys(appEn).length} keys (lazy) · ` +
        `pages half ${Object.keys(pagesEn).length} keys (lazy)`,
    );
    expect(Object.keys(siteEn).length).toBeGreaterThan(0);
  });
});

describe('message catalogs', () => {
  // The direction that MATTERS. A key in a translation but not in the source is
  // dead weight nobody will ever see rendered: either a typo (so the real key is
  // silently falling back to English) or a string deleted from en.ts and left
  // behind here. Both are invisible in a running app — the page looks right.
  it('has no key in es that does not exist in en', () => {
    expect(esKeys.filter((k) => !(k in en))).toEqual([]);
  });

  // The other direction is NOT an error: an untranslated key falls back to
  // English by design (see the header of catalog/app/es.ts). Reported, not
  // enforced, so a partial catalog can ship while the number stays honest.
  //
  // DELIBERATELY-UNTRANSLATED KEYS ARE EXCLUDED FROM THE PERCENTAGE and named
  // separately. The changelog and legal metadata are source-language only by
  // decision, not by backlog (SOURCE_LANGUAGE_ONLY_ROUTES in @truecairn/shared),
  // and counting them as missing would make the number drift down every time
  // someone exercises that decision — which is the opposite of what a coverage
  // figure is for. It measures work outstanding, not choices already made.
  it('reports Spanish coverage', () => {
    const bySettledDecision = new Set<string>(SOURCE_LANGUAGE_ONLY_KEYS);
    const translatable = enKeys.filter((k) => !bySettledDecision.has(k));
    const missing = translatable.filter((k) => !(k in es));
    // FLOORED, not rounded. 683 of 684 keys rounds to "100%", which is exactly
    // the flattering number this repo refuses elsewhere — /status suppresses a
    // percentage rather than publish one it cannot stand behind. A catalog with
    // one key missing is not complete, and the number must not say it is.
    const pct = Math.floor(((translatable.length - missing.length) / translatable.length) * 100);
    console.log(
      `[i18n] es coverage ${pct}% — ${translatable.length - missing.length}/${translatable.length} translatable keys` +
        ` (+${bySettledDecision.size} source-language only by decision)` +
        (missing.length > 0 ? `; falling back to en: ${missing.join(', ')}` : ''),
    );
    expect(translatable.length).toBeGreaterThan(0);
  });

  // An empty or whitespace-only string renders as a blank label, which reads as
  // a layout bug rather than a missing translation.
  it('has no blank values in either catalog', () => {
    const blank = (cat: Record<string, string | undefined>): string[] =>
      Object.entries(cat)
        .filter(([, v]) => v === undefined || v.trim() === '')
        .map(([k]) => k);
    expect(blank(en)).toEqual([]);
    expect(blank(es)).toEqual([]);
  });

  // The unlock screen's two errors must never collapse into each other in ANY
  // language. The English comment in Unlock.tsx explains what it costs when they
  // do: a user holding the CORRECT passphrase is told it is wrong, on a device
  // that merely ran out of memory, and the invited response is destructive.
  // A translator working key-by-key cannot see that relationship; this can.
  it('keeps the two unlock failures distinguishable in every locale', () => {
    for (const [name, cat] of [['en', en], ['es', es]] as const) {
      const memory = cat['auth.unlock.error.memory'];
      const passphrase = cat['auth.unlock.error.passphrase'];
      if (memory === undefined || passphrase === undefined) continue; // falls back to en
      expect(memory, `${name}: the two unlock errors are identical`).not.toBe(passphrase);
      // The memory message exists to say "not your passphrase". If a translation
      // is shorter than the passphrase error, that clause has been dropped.
      expect(memory.length, `${name}: memory error looks truncated`).toBeGreaterThan(
        passphrase.length,
      );
    }
  });
});

describe('locale resolution', () => {
  it('accepts only known locales', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('es')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale('')).toBe(false);
  });

  // Regional Spanish resolves to 'es' rather than falling through to English —
  // the case that actually shows up, since almost no browser reports a bare 'es'.
  // Passed LOCALES explicitly: this asserts the MATCHING, independently of which
  // languages happen to be offered today.
  it('matches on the primary subtag', () => {
    expect(matchLocale(['es-MX'], LOCALES)).toBe('es');
    expect(matchLocale(['es-419', 'en-US'], LOCALES)).toBe('es');
    expect(matchLocale(['en-GB'], LOCALES)).toBe('en');
  });

  it('falls back to the default when nothing matches', () => {
    expect(matchLocale(['fr-FR', 'de'], LOCALES)).toBe(DEFAULT_LOCALE);
    expect(matchLocale([], LOCALES)).toBe(DEFAULT_LOCALE);
  });

  it('keeps the default inside the supported set', () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });
});

describe('what is OFFERED to users', () => {
  // The gate that stops a half-translated language reaching anyone. Auto-
  // detection defaults to the OFFERED set, so a Spanish browser must still get
  // English until Spanish is deliberately turned on.
  it('does not auto-detect into a language that is not offered', () => {
    // Was asserted with ['es-ES','es'] while Spanish was withheld. Spanish is
    // offered as of 2026-08-26, so that pair now correctly resolves to 'es' and
    // asserting otherwise would pin the gate open. The PROPERTY is unchanged —
    // a browser asking for something we do not offer gets the source language —
    // so it is now asserted with a language we genuinely do not offer.
    expect(matchLocale(['fr-FR', 'fr'])).toBe(DEFAULT_LOCALE);
    expect(matchLocale(['de'])).toBe(DEFAULT_LOCALE);
    // And the offered one resolves, which is the other half of the same rule.
    expect(matchLocale(['es-ES', 'es'])).toBe('es');
  });

  it('offers only languages that exist', () => {
    expect(OFFERED_LOCALES.filter((l) => !LOCALES.includes(l))).toEqual([]);
  });

  // Offering a language with no catalog would render every key back at the user
  // as raw dotted text. The source language needs no catalog of its own.
  it('offers only languages with a catalog', () => {
    const catalogued = new Set(['en', 'es']);
    expect(OFFERED_LOCALES.filter((l) => !catalogued.has(l))).toEqual([]);
  });

  it('always offers the default language', () => {
    expect(OFFERED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});
