import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ── The extraction fence (docs/40 Phase 0) ───────────────────────────────────
//
// A screen that has been translated does not STAY translated. The next feature
// lands a `<p>Something went wrong</p>` in it, ships, reads perfectly in English
// and is invisible in Spanish — and nothing fails, because the app still works.
// That is how an i18n effort rots: not in one decision, but in twenty small ones
// nobody reviewed as language decisions.
//
// This is the same shape as date-locale-fence.test.ts, and for the same stated
// reason: "a comment is not a control. This is, and it costs one filesystem
// walk."
//
// AN ALLOWLIST THAT GROWS, NOT A GLOBAL RULE. Most of apps/web is not extracted
// yet, so a repo-wide version of this would be red on day one and switched off by
// the end of the week. Adding a file here is the last step of translating it, and
// from then on the file is held to the rule.
const TRANSLATED_FILES: readonly string[] = [
  'src/screens/Login.tsx',
  'src/screens/Register.tsx',
  'src/screens/Unlock.tsx',
  'src/i18n/LanguagePicker.tsx',
  'src/screens/vault/VaultList.tsx',
  'src/screens/vault/Vault.tsx',
  'src/screens/vault/VaultLockBanner.tsx',
  'src/vault/AttachmentPicker.tsx',
  'src/screens/vault/CreateItem.tsx',
  'src/screens/vault/FileCaptures.tsx',
  'src/screens/dashboard/Dashboard.tsx',
  'src/screens/engine/EngineDashboard.tsx',
  'src/screens/engine/ReleaseProgressPanel.tsx',
  'src/ai/AiDisclosure.tsx',
  'src/components/AppShell.tsx',
  'src/components/CommandPalette.tsx',
  'src/components/AccountMenu.tsx',
  'src/screens/assistant/Assistant.tsx',
  'src/screens/plans/Upgrade.tsx',
  'src/screens/Onboarding.tsx',
  'src/screens/settings/AuditTrail.tsx',
  'src/screens/plans/Plans.tsx',
  'src/components/ContinuityReportPanel.tsx',
  'src/screens/contacts/AcceptAndEnroll.tsx',
  'src/screens/vault/VaultItemDetail.tsx',
  'src/screens/ceremony/CeremonyPortal.tsx',
  'src/screens/settings/Settings.tsx',
  'src/screens/contacts/Contacts.tsx',
  'src/App.tsx',
  'src/AuthedApp.tsx',
  'src/screens/Landing.tsx',
  'src/screens/guide/Guide.tsx',
  'src/screens/public/build.tsx',
  'src/screens/public/company.tsx',
  'src/screens/public/security.tsx',
  'src/site/security-pills.ts',
  'src/site/NotFound.tsx',
  'src/site/SiteFooter.tsx',
  'src/site/PublicPage.tsx',
];

// Props whose VALUE is read by a person (or read out by a screen reader). Not
// className/id/type/autoComplete/data-testid — those are machine-facing and must
// never be translated.
const HUMAN_PROPS = /\b(placeholder|aria-label|alt|title|label|summary)\s*=\s*"([^"]*[A-Za-z]{2}[^"]*)"/g;

// Bare text between tags: `>Some words<`. `{t('key')}` is an expression, not
// text, so it never matches.
//
// Two narrowings live in this pattern, both for code that sits exactly where a
// text node would:
//
//   `>(?!;)` — a tag's `>` followed immediately by a semicolon ends a STATEMENT
//   (`return <p>{t('k')}</p>;`), so what follows is code. Without it the match
//   ran to the next real `<`, often dozens of lines of component logic.
//
//   The leading char class bars `)`, `:`, `,` and `;` — a JSX ternary written
//   across branches puts `) : renews != null ? (` between two elements, and no
//   real sentence starts with those.
//
// It bars ALL whitespace too, and that is the part that actually made the second
// one work. With `\n` alone the engine simply backtracked `\s*` by one character
// and matched a leading SPACE, which was still permitted — so the exclusion did
// nothing and the same code came straight back through. Found by dumping the real
// match; the fixed and broken patterns look identical until you print what
// matched.
const JSX_TEXT = />(?!;)\s*([^<>{}\s);:,][^<>{}]*?)\s*</g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// TypeScript generics look exactly like JSX tags to a regex, and the JSX_TEXT
// pattern above happily spanned from the `>` of `useState<...>` to the `<` of
// `Promise<void>` and reported the code in between as untranslated copy. (It did
// so on the first run of this file, which is why the discriminator is written
// down rather than assumed.)
//
// They are separable structurally: a generic's `<` follows an identifier
// character with no space (`useState<`, `Promise<`, `Record<`), while a JSX tag's
// `<` never does — it always follows whitespace, `(`, `{` or the start of a line.
// Run twice so one level of nesting (`Partial<Record<K, V>>`) also clears.
function stripGenerics(source: string): string {
  return source.replace(/(\w)<[^<>]*>/g, '$1').replace(/(\w)<[^<>]*>/g, '$1');
}

// COMPARISON OPERATORS, the second thing that reads as a JSX tag to a regex.
// `{(steps.length ?? 0) > 0 && (` opens a "tag" at the `>` that then runs to the
// next real `<`, and the code in between gets reported as untranslated copy.
// (Found the same way as the generics case: by this test failing on real code.)
//
// Separable by spacing: a comparison is surrounded by whitespace on BOTH sides,
// while a JSX tag's `>` usually is not — `<div> x` has a letter before it.
//
// USUALLY, not always, and the exception is the sixth narrowing (2026-08-23).
// This comment used to assert the stronger version — "a multi-line tag's closing
// `>` is followed by a newline and then a tag or text, not by a bare space" —
// which is true about what FOLLOWS the `>` and says nothing about what precedes
// it. Prettier puts the closing `>` of a multi-line tag alone on its own line:
//
//     <button
//       type="button"
//       onClick={...}
//     >
//       Monthly
//     </button>
//
// so that `>` has a newline before it AND a newline after it, matched as a
// comparison, and `Monthly` — real untranslated copy, in an allowlisted file —
// was silently dropped from the report. A fence that reads clean because it
// deleted the evidence is worse than no fence, so the discriminator is written
// down: a `>` alone at the start of a line closes a tag. Nobody writes a
// comparison with the operator leading a line, and `>=` is excluded by lookahead
// so the operator strip below still sees it.
const TAG_CLOSE = '\u0000';
function stripComparisons(source: string): string {
  return (
    source
      // Arrow functions first: `(a) => a.x === 'y'` puts a `>` right where a tag
      // could open, and unlike a comparison it has no leading space to key on.
      // `=>` is never JSX, so it can go unconditionally.
      .replace(/=>/g, '__arrow__')
      // Protect line-leading tag closers, restore them after the operator strip.
      .replace(/^([ \t]*)>(?!=)/gm, `$1${TAG_CLOSE}`)
      .replace(/\s(?:<=|>=|<|>)\s/g, ' __cmp__ ')
      .replace(new RegExp(TAG_CLOSE, 'g'), '>')
  );
}

// Text that is deliberately NOT translated. Kept tiny and justified — every
// entry here is a hole in the fence.
function isExempt(text: string): boolean {
  // A lone entity or punctuation run carries no words.
  if (!/[A-Za-z]{2}/.test(text)) return true;
  // The product name is a proper noun in every language.
  if (text === 'Truecairn') return true;
  return false;
}

// The detector, as a pure function of source text — so its own behaviour is
// testable without a file on disk. See the self-test at the foot of this file:
// this has been narrowed FIVE times to clear false positives, and every
// narrowing risks quietly blinding it. A fence nobody has driven backwards is a
// fence nobody has tested.
export function findUntranslated(rawSource: string): {
  bareText: string[];
  humanProps: string[];
} {
  const source = stripComparisons(stripGenerics(stripComments(rawSource)));
  const bareText = [...source.matchAll(JSX_TEXT)]
    .map((m) => m[1]!.trim())
    .filter((text) => !isExempt(text));
  const humanProps = [...source.matchAll(HUMAN_PROPS)]
    .map((m) => `${m[1]!}="${m[2]!}"`)
    // An aria-label built from t() is an expression ({t('…')}), so anything
    // matching this regex is a hardcoded literal by construction.
    .filter((text) => !isExempt(text));
  return { bareText, humanProps };
}

describe('translated screens contain no untranslated copy', () => {
  it.each(TRANSLATED_FILES)('%s', async (file) => {
    const found = findUntranslated(await readFile(resolve(process.cwd(), file), 'utf8'));
    // Named, not counted, so a failure says exactly what to extract.
    expect(found).toEqual({ bareText: [], humanProps: [] });
  });
});

// ── The fence's own regression test ──────────────────────────────────────────
//
// Every shape below was a REAL false positive, found by this test failing on real
// code, in this order: TypeScript generics (`useState<…>` … `Promise<void>`); a
// comparison operator inside an expression; a statement-terminating `</p>;`; an
// arrow function's `=>`; and a ternary's `) : x ? (` between two branches.
//
// Each narrowing is pinned here so a later one cannot silently widen them back,
// and the positive cases prove the detector still sees real untranslated copy
// after all five.
describe('the detector itself', () => {
  it('finds hardcoded text and hardcoded human-facing props', () => {
    const found = findUntranslated(`
      export function Screen(): JSX.Element {
        return (
          <div>
            <p>Something went wrong</p>
            <button aria-label="Dismiss this notice" />
            <img alt="A photograph of a door" />
          </div>
        );
      }
    `);
    expect(found.bareText).toEqual(['Something went wrong']);
    expect(found.humanProps).toEqual([
      'aria-label="Dismiss this notice"',
      'alt="A photograph of a door"',
    ]);
  });

  it('is not fooled by JS syntax that looks like JSX', () => {
    const found = findUntranslated(`
      export function Screen(): JSX.Element {
        const [error, setError] = useState<'a' | 'b' | null>(null);
        async function go(): Promise<void> {
          await thing();
        }
        if (isLoading) return <p className="small">{t('x.loading')}</p>;
        const ready = items.length > 0 && count < 10;
        return (
          <div>
            {items.some((i) => i.kind === 'ai') && <span>{t('x.badge')}</span>}
            {ready ? <b>{t('x.a')}</b> : <i>{t('x.b')}</i>}
            {cancelled && ends != null ? (
              <div>{t('x.ends')}</div>
            ) : renews != null ? (
              <div>{t('x.renews')}</div>
            ) : null}
          </div>
        );
      }
    `);
    expect(found).toEqual({ bareText: [], humanProps: [] });
  });

  // The sixth narrowing's regression case, and the first one that was a MISS
  // rather than a false positive: `stripComparisons` was deleting the closing
  // `>` of every Prettier-wrapped multi-line tag, taking the text node after it
  // with it. Every earlier narrowing made the fence quieter on purpose; this one
  // had made it quieter by accident, which is the failure mode a fence cannot
  // have. Found in src/screens/Landing.tsx, where `Monthly`/`Yearly` sat bare
  // inside an allowlisted file and the fence reported it clean.
  it('sees copy after the closing > of a multi-line tag', () => {
    const found = findUntranslated(`
      <button
        type="button"
        className={period === 'monthly' ? 'active' : ''}
        onClick={() => setPeriod('monthly')}
      >
        Monthly
      </button>
    `);
    expect(found.bareText).toEqual(['Monthly']);
  });

  it('ignores machine-facing props and comments', () => {
    const found = findUntranslated(`
      // A comment with real words in it that must not be flagged.
      /* Nor a block comment describing behaviour. */
      export const X = () => (
        <input className="input" data-testid="thing" type="email" autoComplete="username" />
      );
    `);
    expect(found).toEqual({ bareText: [], humanProps: [] });
  });

  it('exempts the product name, which is a proper noun in every language', () => {
    expect(findUntranslated('<p>Truecairn</p>').bareText).toEqual([]);
  });
});
