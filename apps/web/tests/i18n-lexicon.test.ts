import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// ── The Spanish lexicon gate (QA 2026-08-25) ─────────────────────────────────
//
// `i18n-catalog.test.ts` checks that every key EXISTS and is non-blank. It has
// been green on every commit of the Spanish translation, and it always will be,
// because key parity is not the property that broke.
//
// What broke was between the strings. The Spanish catalogs gave the product's two
// most dangerous secrets TWO DIFFERENT NAMES, split cleanly along file
// boundaries, and every string was correct read on its own. As found, before the
// rename:
//
//                                   app/es  site/es  pages/es  emails  api
//   frase de liberación                  0        0        29       5    1
//   frase de contraseña de entrega      23        2         0       0    0
//   frase maestra                        0        0        12       3    0
//   frase de contraseña maestra          9        5         0       0    0
//   ceremonia de liberación              0        0         7       0    0
//   ceremonia de entrega                 2        4         0       0    0
//
// FIXED 2026-08-25: the owner chose the `liberación` side and app/es.ts +
// site/es.ts were migrated onto it (151 lines, two files). These checks are now
// LIVE GUARDS rather than markers — they were written to fail, they were watched
// failing, and they now hold the property instead of recording its absence.
//
// The counts above are kept deliberately. They are what the defect looked like,
// and a future reader comparing them to a fresh grep can tell drift from a
// deliberate change — which is the whole reason this file counts rather than
// eyeballs.
//
// COUNT CASE-INSENSITIVELY, and this is not pedantry: a case-sensitive grep read
// 20 where the truth was 23, because three occurrences start a sentence. The
// mistake was caught only because a simulated rename left three behind while
// grep called the file clean.
//
// WHY THIS IS A SAFETY DEFECT AND NOT A STYLE NIT. It lands on two of the
// QA brief's own Part 1 items:
//
//   §2, the anti-phishing line. Every email footer says «Nunca te pediremos tu
//   frase de liberación». The screen where the owner CREATES and rotates that
//   exact secret calls it «frase de contraseña de entrega»
//   (`engine.action.rotate_release_passphrase`). A warning protects someone only
//   if they recognise the thing being named, and those are different words.
//
//   §1, S2-optional vs S3-mandatory. /guide §7/§11 builds the whole
//   optional-fallback / mandatory-mask argument on «la frase de liberación» —
//   correctly, the distinction is fully intact there. The in-app plans screen
//   then calls the same secret «frase de contraseña de entrega». A reader who
//   takes those for two different secrets lands exactly on the confusion the
//   brief calls the most dangerous in the product.
//
// HOW IT GOT IN, and why a test rather than a note: the glossary in the header of
// catalog/app/es.ts defines `master passphrase` but never defines `release
// passphrase`, so that term drifted with nothing to check it against. Meanwhile
// catalog/pages/es.ts states in its own header that the app glossary "applies
// here unchanged" — and then uses `frase maestra`, which that glossary
// explicitly rejects. The file documenting the rule is the file breaking it. A
// comment could not catch that; this can, and it costs five file reads.
//
// DECISION-NEUTRAL BY DESIGN. Which side wins is a copy decision for the owner,
// not for a test. These assert only that a concept has ONE name, and name the
// variants found — so whichever direction the rename goes, the gate goes green.
const REPO_ROOT = resolve(process.cwd(), '../..');

// Every surface that renders Spanish to a person. The two outside apps/web are
// the ones that make this a repo-wide property rather than a web one: the emails
// and the deterministic readiness fallback are where the liberación-side
// vocabulary is currently correct, so a check scoped to apps/web would see one
// self-consistent half and pass.
const SPANISH_SURFACES: readonly string[] = [
  'apps/web/src/i18n/catalog/app/es.ts',
  'apps/web/src/i18n/catalog/site/es.ts',
  'apps/web/src/i18n/catalog/pages/es.ts',
  'packages/notifications/src/templates.es.ts',
  // Holds GAP_TEMPLATE_ES — the readiness paragraph every owner who turns AI off
  // sees. English lives in the same file; the phrases below are Spanish-only, so
  // reading the whole file is safe and keeps the check honest if the split moves.
  'apps/api/src/ai/readiness-prompt.ts',
];

const sources = new Map<string, string>();

// ── Scan what the product SAYS, not what the source explains about it ───────
//
// This gate counted raw file text, comments included. That is wrong in a way
// that only shows up once the gate starts working: the fix for the
// `frase de contraseña` drift (#224) added a header comment NAMING the rejected
// phrase so the next reader would understand what had gone wrong — and the gate
// counted its own documentation as two live occurrences and turned `main` red.
//
// A check about the words a person reads on screen must read only the words a
// person reads on screen. So string literals are extracted first, and comments
// are never scanned. The practical effect is that a comment may name a rejected
// term — which is exactly what a comment explaining a rejected term needs to do.
function stringLiteralsOf(source: string): string {
  // A single left-to-right walk, because the two things being told apart can
  // contain each other: a comment may quote a phrase (this file's own header
  // does, in backticks) and a string may contain '//'. A regex for either one
  // alone gets the other wrong — the first attempt at this extracted strings
  // without skipping comments and read the header's `frase de contraseña` as a
  // template literal, which is the very miscount it was written to remove.
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      const from = i;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i += 1;
      }
      out.push(source.slice(from, i));
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('\n');
}

beforeAll(async () => {
  for (const file of SPANISH_SURFACES) {
    const raw = await readFile(resolve(REPO_ROOT, file), 'utf8');
    sources.set(file, stringLiteralsOf(raw));
  }
});

// Case-insensitive phrase count. Deliberately NOT a \b-anchored regex: JS word
// boundaries are unreliable either side of an accented character without the
// unicode flag, and every phrase here is multi-word, so a plain substring scan is
// both correct and impossible to get subtly wrong.
function countPhrase(source: string, phrase: string): number {
  const hay = source.toLowerCase();
  const needle = phrase.toLowerCase();
  let count = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = hay.indexOf(needle, at + needle.length);
  }
  return count;
}

// Where a phrase appears, as `file×count`, for the failure message. A bare "these
// disagree" would send the reader back to grep; this hands over the rename list.
function locate(phrase: string): string[] {
  return [...sources.entries()]
    .map(([file, source]) => [file, countPhrase(source, phrase)] as const)
    .filter(([, n]) => n > 0)
    .map(([file, n]) => `${file}×${n}`);
}

interface Concept {
  /** The English concept, as the glossary would name it. */
  readonly concept: string;
  /** Why a reader is harmed if this one drifts. */
  readonly stake: string;
  /**
   * The competing Spanish names. Each must be UNAMBIGUOUS — a phrase that can
   * only mean this concept. That is why these are collocations and not single
   * words: `entrega` on its own legitimately means notification *delivery* in
   * pages/es.ts ("una caída de entrega"), and banning the bare word would have
   * shipped a test that fails on correct Spanish.
   */
  readonly variants: readonly string[];
}

const LEXICON: readonly Concept[] = [
  {
    concept: 'release passphrase',
    stake: 'Part 1 §2 — the anti-phishing line must name a secret the owner recognises',
    variants: ['frase de liberación', 'frase de contraseña de entrega'],
  },
  {
    concept: 'master passphrase',
    stake: 'Part 1 §2 — the two secrets fail differently and must stay tellable apart',
    // `frase de contraseña` added 2026-08-26 after a catalog review found the
    // gate had a hole exactly its own shape. It enumerated the two variants
    // someone thought of, and the catalog had a THIRD — reintroducing
    // «contraseña», the word this product's glossary explicitly rejects because
    // "the product deliberately says passphrase, not password, and the
    // distinction is the whole security argument".
    //
    // It was not theoretical drift. Two landing strings named one secret twice,
    // differently, WITHIN A SINGLE SENTENCE: «Tu frase maestra nunca sale de tu
    // dispositivo … no podemos ayudarte a recuperar la frase de contraseña».
    // Both were self-consistent English, both were grammatical Spanish, and the
    // gate was green throughout.
    //
    // NOTE the ordering constraint the self-test below enforces: no variant may
    // contain another, so `frase de contraseña maestra` cannot sit here beside
    // `frase de contraseña`. The longer form is the narrower claim and is fully
    // covered by the shorter one, so the shorter one replaces it.
    variants: ['frase maestra', 'frase de contraseña'],
  },
  {
    concept: 'release ceremony',
    stake: 'the contact-facing ceremony copy and the in-app copy describe one event',
    variants: ['ceremonia de liberación', 'ceremonia de entrega'],
  },
  {
    concept: 'release ladder',
    stake: 'the guide explains the ladder the engine screen then shows',
    variants: ['escalera de liberación', 'escalera de entrega'],
  },
  {
    concept: 'release plan',
    stake: 'the owner files vault items into the thing both surfaces name',
    variants: ['plan de liberación', 'plan de entrega'],
  },
];

describe('the lexicon check itself', () => {
  // CLAUDE.md: "prove the mechanism too, not just the symptom". A gate nobody has
  // watched catch anything is a gate nobody has tested.
  it('counts a phrase, case- and accent-insensitively where it should be', () => {
    const sample = 'La frase de liberación. LA FRASE DE LIBERACIÓN otra vez, y frase maestra.';
    expect(countPhrase(sample, 'frase de liberación')).toBe(2);
    expect(countPhrase(sample, 'frase maestra')).toBe(1);
    expect(countPhrase(sample, 'frase de contraseña de entrega')).toBe(0);
  });

  // The two competing names must not nest, or the longer one would be counted
  // twice — once as itself and once inside the shorter scan — and a file using
  // only one name would read as using both. They do not nest today; assert it,
  // because a future variant added to LEXICON easily could.
  it('uses variants that cannot be counted inside one another', () => {
    for (const { concept, variants } of LEXICON) {
      for (const a of variants) {
        for (const b of variants) {
          if (a === b) continue;
          expect(a.toLowerCase().includes(b.toLowerCase()), `${concept}: "${a}" contains "${b}"`).toBe(
            false,
          );
        }
      }
    }
  });

  // A path that stops resolving turns every check below into a scan of an empty
  // string, which passes. Same failure mode i18n-catalog.test.ts guards when it
  // insists the exclusion list names keys that exist.
  it('reads every surface it claims to cover', () => {
    for (const file of SPANISH_SURFACES) {
      expect(sources.get(file)?.length ?? 0, `${file} read as empty`).toBeGreaterThan(0);
    }
  });

  // The concepts are only worth checking if they are actually SAID in Spanish.
  // A typo in a variant would otherwise make a concept silently un-checkable.
  it('names concepts that appear in the Spanish surfaces at all', () => {
    for (const { concept, variants } of LEXICON) {
      const total = variants.reduce((n, v) => n + locate(v).length, 0);
      expect(total, `${concept}: none of its variants appear anywhere — typo?`).toBeGreaterThan(0);
    }
  });
});

describe('one Spanish name per concept', () => {
  // These shipped as `it.fails()` markers — the sanctioned pattern (CLAUDE.md,
  // "leave the artifact, not the paragraph"): the assertion states the CORRECT
  // behaviour, passes while the defect is live BECAUSE it fails, and turns red
  // the moment someone fixes it, so the marker retires itself rather than pinning
  // the bug in place. All six retired together when the rename landed, which is
  // the mechanism working end to end and not a thing to be undone.
  for (const { concept, stake, variants } of LEXICON) {
    it(`${concept} — one name, not ${variants.length} (${stake})`, () => {
      const inUse = variants.filter((v) => locate(v).length > 0);
      const detail = inUse.map((v) => `"${v}" in ${locate(v).join(', ')}`).join('  vs  ');
      expect(inUse, `${concept} is named ${inUse.length} ways: ${detail}`).toHaveLength(1);
    });
  }
});

describe('the share of a release', () => {
  // Asymmetric on purpose, and the asymmetry is the honest part. `fragmento` is
  // unambiguous — it can only mean a Shamir share — and appears 38× in app/es.ts
  // and 2× in site/es.ts, never in pages/es.ts or the emails. Its counterpart
  // `parte` cannot be counted the same way: pages/es.ts uses it in the share
  // sense ("Dos cualesquiera de esas tres partes lo reconstruyen") AND in the
  // ordinary one ("las partes importantes de tu vida digital"), so a symmetric
  // count would report a disagreement that is partly just Spanish.
  //
  // So this checks the one direction that is decidable: the app-side word is
  // absent. The rename went the `parte` way, so this now holds. If it is ever
  // reversed — `parte` → `fragmento` everywhere — this test is WRONG and should
  // be inverted, not deleted.
  //
  // The rename was NOT a find-and-replace: «un parte» is a real Spanish word
  // meaning "a report", so fragmento (m) → parte (f) had to carry its articles
  // and adjectives with it. A blind swap produces grammatical text that says
  // something else.
  it('is called the same thing in the app as in the guide and the emails', () => {
    expect(locate('fragmento'), 'app-side share word; the guide and emails say «parte»').toEqual(
      [],
    );
  });
});

describe('positioning the Spanish copy must not adopt', () => {
  // CLAUDE.md hard rule: never pitch this as a "dead man's switch", in any copy,
  // doc, or AI prompt. That is pinned in English on the model prompts
  // (assist-prompt.test.ts, briefing-prompt.test.ts) and was pinned NOWHERE in
  // Spanish — the ban lived only on the surfaces that speak English.
  //
  // Green today (zero occurrences) and it stays a live guard rather than a
  // marker: this is the one that catches a well-meaning future translator
  // reaching for the idiom because it is the familiar Spanish name for the
  // category.
  it('never calls the product an "interruptor de hombre muerto"', () => {
    for (const banned of ['hombre muerto', 'hombre-muerto']) {
      expect(locate(banned), `banned positioning: "${banned}"`).toEqual([]);
    }
  });
});

describe('the pages that exist to state an absence', () => {
  // Part 1 §8 of the QA brief. /security/limits, /security/build and
  // /company/press exist to say what has NOT been done — no third-party audit,
  // no certifications, no completed human release, no incorporated company — and
  // their entire value is that they do not hedge.
  //
  // public-pages.test.tsx asserts this in ENGLISH (it renders those pages and
  // checks the refusals) and asserted it in Spanish nowhere. So the honesty of
  // the Spanish copy rested on nobody having softened it — which is exactly the
  // property a translation pass is most likely to erode, because "no lo hemos
  // hecho" is the least comfortable sentence on the page to translate.
  it('still names the certifications we do not have', () => {
    for (const claim of ['SOC 2', 'ISO 27001']) {
      expect(locate(claim), `the Spanish copy no longer refuses "${claim}"`).not.toEqual([]);
    }
  });

  it('never softens an absence into a promise', () => {
    // Measured 2026-08-25: every phrase below is at ZERO across all five Spanish
    // surfaces, so this is a live guard rather than a marker.
    //
    // DELIBERATELY NOT BANNED: «todavía no» (10×) and «aún no» (2×). Those are
    // the honest form — "no independent review has happened yet" — and a test
    // that banned them would fail on the very sentences it exists to protect.
    // The line is between stating an absence and promising its end.
    const hedges = [
      'próximamente',
      'en breve',
      'estamos trabajando',
      'en progreso',
      'muy pronto',
      'disponible pronto',
    ];
    for (const hedge of hedges) {
      expect(locate(hedge), `an absence has been softened into "${hedge}"`).toEqual([]);
    }
  });
});
