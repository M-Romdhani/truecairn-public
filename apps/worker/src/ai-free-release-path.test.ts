import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Gap plan G-1, the strongest form of "the release path can never be blocked by
// AI": the worker — the SOLE release driver (CLAUDE.md invariant 7) — and the
// ceremony package it drives make NO model calls at all. Narration is generated
// on the API's recipient-gated READ path instead (the deliberate D3 deviation),
// so an AI outage, a hung provider, or a hostile model response is structurally
// incapable of touching ceremony creation, the report snapshot, or the release
// ladder. This source scan pins that: no AI SDK, no model client, no narration
// module may be imported anywhere under the worker or the ceremony package. A
// "fix" that relaxes this list is a bug — wire new AI features through the API.

const FORBIDDEN = ['@google/genai', 'ai/gemini', 'ai/narration', 'GoogleGenAI'];

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOTS = [
  join(here), // apps/worker/src
  join(here, '..', '..', '..', 'packages', 'ceremony', 'src'),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('release path is AI-free (import fence)', () => {
  it('no worker or ceremony source imports a model client or the narration module', () => {
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const src = readFileSync(file, 'utf8');
        for (const marker of FORBIDDEN) {
          expect(src.includes(marker), `${file} references '${marker}'`).toBe(false);
        }
      }
    }
  });
});
