import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The landing's below-the-fold imagery is CSS `background-image`, which cannot
// carry loading="lazy". It is deferred instead by hanging the declaration off
// `.in` — the class the reveal-on-scroll IntersectionObserver adds. That works
// only if the `.in` anchor is the element the observer actually OBSERVES, i.e.
// the one carrying `data-reveal`.
//
// It is not always the same element. `data-reveal` sits on the two `.mk-photo`
// divs directly, but on the PARENT `<article class="mk-feat">` of each
// `.mk-feat-shot` — so `.mk-feat-shot.vault.in` matches nothing and those four
// previews would never load. Nothing would report it: no console error, no
// failing render, just a `background-color` placeholder where a screenshot
// should be. A 2026-08-12 performance audit proposed exactly that selector.
//
// This test is the guard. It reads both files and checks every deferred
// background against the reveal anchors the markup really has.
const root = resolve(process.cwd(), '../..');
const cssRaw = readFileSync(resolve(root, 'apps/web/src/screens/Landing.css'), 'utf8');
const tsx = readFileSync(resolve(root, 'apps/web/src/screens/Landing.tsx'), 'utf8');
// Comments out first: the rules above name the WRONG selector on purpose, to
// explain why it is wrong, and a guard that reads prose flags its own warning.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

// Every class list on an element that carries data-reveal — className comes
// first on all of them, so look back a short window from the attribute.
const revealClasses = new Set<string>();
for (const m of tsx.matchAll(/data-reveal="true"/g)) {
  const before = tsx.slice(Math.max(0, m.index - 300), m.index);
  const cls = [...before.matchAll(/className="([^"]+)"/g)].pop();
  if (cls !== undefined) for (const c of cls[1]!.split(/\s+/)) revealClasses.add(c);
}

// Rule blocks that set a landing background-image, with their selector.
const deferredRules = [...css.matchAll(/([^{}]+)\{([^}]*background-image[^}]*)\}/g)]
  .map((m) => ({ selector: m[1]!.trim().split('\n').pop()!.trim(), body: m[2]! }))
  .filter((r) => r.body.includes('/assets/landing/'));

describe('landing: deferred background images stay wired to a real reveal anchor', () => {
  it('finds the media rules it is meant to guard', () => {
    // Two photographs + four preview shots. If this drops, the rest of the file
    // is asserting over an empty list and proving nothing.
    expect(deferredRules).toHaveLength(6);
  });

  it('anchors every deferred background on an element that carries data-reveal', () => {
    expect(revealClasses.size).toBeGreaterThan(0);
    for (const rule of deferredRules) {
      // `.a.b.in` or `.a.in .b.c` — the anchor is the class `.in` is attached to.
      const anchor = /\.([a-z0-9-]+)\.in\b/.exec(rule.selector);
      expect(anchor, `no .in anchor in selector: ${rule.selector}`).not.toBeNull();
      expect(
        revealClasses.has(anchor![1]!),
        `${rule.selector} gates its image on .${anchor![1]!}.in, but nothing with class ` +
          `"${anchor![1]!}" carries data-reveal — the observer never adds .in there, ` +
          `so this image would never load. Reveal anchors are: ${[...revealClasses].join(', ')}`,
      ).toBe(true);
    }
  });

  it('never attaches .in directly to .mk-feat-shot', () => {
    // The specific mistake, called out by name so the failure explains itself.
    expect(css).not.toMatch(/\.mk-feat-shot(\.[a-z-]+)*\.in\b/);
  });

  it('references only the transcoded derivatives, never the PNG masters', () => {
    // The .png files stay in public/ as masters (see that folder's README), but
    // a rule pointing at one is a 1.7 MB regression that looks identical.
    const pngRefs = deferredRules.filter((r) => /\/assets\/landing\/[^"']+\.png/.test(r.body));
    expect(pngRefs.map((r) => r.selector)).toEqual([]);
  });
});
