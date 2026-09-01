import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ── Every model-output surface must APPLY the language directive ─────────────
//
// `language.test.ts` asserts the directive's contract: what it appends, what it
// must never carry, that it is empty in the source language. It does that over
// the six exported *_SYSTEM_INSTRUCTION constants — so it proves the directive
// is right, and nothing about whether a surface actually uses it.
//
// That gap is invisible in the worst way. A route that passes the RAW constant
// to the model still works, still passes every prompt test, and simply answers
// an owner who chose Spanish in English. Nothing fails; the feature is just
// quietly absent on that one surface.
//
// A QA pass on 2026-08-25 recorded the six surfaces as "correct by inspection —
// all six go through systemInstructionFor()". They do. This is that reading
// turned into something that stays true: CLAUDE.md's rule is that a finding
// which ships as a test outlives one that ships as a sentence, and "verified by
// reading only" is exactly the label this file exists to retire.
//
// Same shape and same reasoning as authority-fence.test.ts and
// ai-free-release-path.test.ts: scan the real source, not a curated list.
const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, '..');

// The six surfaces, by the constant each one sends. Named here so a RENAME shows
// up as a missing surface rather than as a scan that quietly matched nothing.
const SURFACE_CONSTANTS: readonly string[] = [
  'ASSIST_SYSTEM_INSTRUCTION',
  'BRIEFING_SYSTEM_INSTRUCTION',
  'PLAN_SYSTEM_INSTRUCTION',
  'READINESS_SYSTEM_INSTRUCTION',
  'INVITE_SYSTEM_INSTRUCTION',
  'NARRATION_SYSTEM_INSTRUCTION',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    // The prompt modules DEFINE and export these constants; a definition is not
    // a send. `language.ts` names them in its own doc comment for the same
    // reason and must not be read as a call site either.
    if (entry.endsWith('-prompt.ts') || entry === 'language.ts') continue;
    out.push(full);
  }
  return out;
}

// Strip imports and comments before scanning. An `import { X } from …` mentions
// the constant without sending it, and a comment explaining the rule would
// otherwise read as a violation of it.
function strip(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import\s[\s\S]*?from\s+'[^']*';\s*$/gm, '');
}

interface Use {
  readonly file: string;
  readonly constant: string;
  readonly wrapped: boolean;
}

function usages(): Use[] {
  const found: Use[] = [];
  for (const file of sourceFiles(API_SRC)) {
    const body = strip(readFileSync(file, 'utf8'));
    for (const match of body.matchAll(/\b([A-Z][A-Z0-9_]*_SYSTEM_INSTRUCTION)\b/g)) {
      const before = body.slice(0, match.index).trimEnd();
      found.push({
        file: relative(API_SRC, file),
        constant: match[1]!,
        wrapped: before.endsWith('systemInstructionFor('),
      });
    }
  }
  return found;
}

describe('the language fence', () => {
  // A scan that matches nothing passes every assertion below it. This is the
  // guard on the guard — the same failure mode i18n-catalog.test.ts closes when
  // it insists its exclusion list names keys that exist.
  it('finds every surface it claims to cover', () => {
    const seen = new Set(usages().map((u) => u.constant));
    for (const constant of SURFACE_CONSTANTS) {
      expect(seen.has(constant), `${constant} has no call site — renamed, or the scan broke`).toBe(
        true,
      );
    }
  });

  it('knows a raw send from a wrapped one', () => {
    // Prove the detector before trusting it (CLAUDE.md): the discriminator is
    // whether `systemInstructionFor(` immediately precedes the constant, so
    // check it against both shapes rather than assuming the regex is right.
    const wrapped = strip('const s = systemInstructionFor(ASSIST_SYSTEM_INSTRUCTION, locale);');
    const raw = strip('const s = ASSIST_SYSTEM_INSTRUCTION;');
    const probe = (body: string): boolean => {
      const m = /\b([A-Z][A-Z0-9_]*_SYSTEM_INSTRUCTION)\b/.exec(body)!;
      return body.slice(0, m.index).trimEnd().endsWith('systemInstructionFor(');
    };
    expect(probe(wrapped)).toBe(true);
    expect(probe(raw)).toBe(false);
  });
});

describe('no model-output surface answers in the wrong language', () => {
  it('sends every system instruction through systemInstructionFor', () => {
    const raw = usages()
      .filter((u) => !u.wrapped)
      .map((u) => `${u.file} sends ${u.constant} without systemInstructionFor()`);
    // Listed rather than counted: the failure names the file to fix, because the
    // symptom in production is silent — that surface just answers in English.
    expect(raw).toEqual([]);
  });
});
