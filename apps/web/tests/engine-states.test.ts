import { describe, expect, it } from 'vitest';
import { ENGINE_STATES } from '@truecairn/shared';
import { appEn } from '../src/i18n/catalog/app/en.js';
import { appEs } from '../src/i18n/catalog/app/es.js';
import { LADDER, ladderPosition } from '../src/engine/states.js';

// ── Every engine state has a name, in every language ─────────────────────────
//
// Written after finding that the Home dashboard's own label map named four states
// the engine cannot be in (`grace`, `check_in_due`, `reconstructing`, `released`)
// and omitted seven it can — including `check_in_pending`, the ordinary "we are
// waiting to hear from you" state. Those seven fell through to a
// `replace(/_/g,' ')` fallback, so the most common non-active engine state
// rendered as English snake_case on a Spanish account.
//
// Key parity alone would not have caught it: both catalogs agreed with each
// other perfectly. What neither agreed with was ENGINE_STATES. This asserts
// against the enum, which is the only thing that actually decides what the
// engine can report.

describe('engine state labels', () => {
  it('cover every member of ENGINE_STATES in English', () => {
    const missing = ENGINE_STATES.filter((s) => !(`engine.state.${s}` in appEn));
    expect(missing).toEqual([]);
  });

  it('cover every member of ENGINE_STATES in Spanish', () => {
    const missing = ENGINE_STATES.filter((s) => !(`engine.state.${s}` in appEs));
    expect(missing).toEqual([]);
  });

  // The other direction: a label for a state that cannot occur is how the old map
  // hid its gaps — four confident-looking entries nothing could ever render.
  it('name no state the engine cannot be in', () => {
    const known = new Set<string>([...ENGINE_STATES, 'none']);
    const phantom = Object.keys(appEn)
      .filter((k) => k.startsWith('engine.state.'))
      .map((k) => k.slice('engine.state.'.length))
      .filter((s) => !known.has(s));
    expect(phantom).toEqual([]);
  });

  // No label may contain an underscore, in EITHER language. This is the property
  // the whole fix is about: the old Home map's gaps fell through to
  // `replace(/_/g,' ')` and rendered machine names at people. Because
  // engineStateLabel() calls t() with a key both catalogs are asserted to have
  // above, a missing key — which i18next would echo back as
  // "engine.state.check_in_pending", underscores and all — cannot happen either.
  //
  // Spanish is checked even though OFFERED_LOCALES is ['en'] today: the catalog is
  // complete and the flip to offer it should turn on strings that are already
  // right, not start a round of discovering they are not.
  it('render no label as raw snake_case, in either language', () => {
    for (const s of ENGINE_STATES) {
      expect(appEn[`engine.state.${s}` as keyof typeof appEn]).not.toMatch(/_/);
      expect(appEs[`engine.state.${s}` as keyof typeof appEs]).not.toMatch(/_/);
    }
  });

  // And no label may be blank or accidentally left as the English string in the
  // Spanish catalog for a state whose name genuinely differs.
  it('give every state a non-empty Spanish name', () => {
    for (const s of ENGINE_STATES) {
      const es = appEs[`engine.state.${s}` as keyof typeof appEs];
      expect(typeof es === 'string' && es.trim().length > 0).toBe(true);
    }
  });
});

describe('the liveness ladder', () => {
  it('is made only of real engine states, in escalating order', () => {
    for (const rung of LADDER) expect(ENGINE_STATES).toContain(rung);
    expect(new Set(LADDER).size).toBe(LADDER.length);
  });

  it('places every engine state somewhere', () => {
    for (const s of ENGINE_STATES) {
      const pos = ladderPosition(s);
      if (pos.kind !== 'before') {
        expect(pos.index).toBeGreaterThanOrEqual(0);
        expect(pos.index).toBeLessThan(LADDER.length);
      }
    }
    expect(ladderPosition(null).kind).toBe('before');
  });

  // The safety property: a hold or a return must never be drawn as having climbed
  // PAST the last rung where nothing has been handed over. Overstating position
  // here is the one error on this picture that would genuinely alarm someone.
  it('never anchors a hold or a return above release_review', () => {
    const ceiling = LADDER.indexOf('release_review');
    for (const s of ['review_required', 'returning'] as const) {
      const pos = ladderPosition(s);
      // Narrow before reading `index` — 'before' carries no position, and the
      // assertion below is the whole point of the test.
      expect(pos.kind).toBe('aside');
      if (pos.kind === 'before') throw new Error(`${s} unexpectedly mapped before the ladder`);
      expect(pos.index).toBeLessThanOrEqual(ceiling);
    }
  });

  it('treats an unarmed engine as before the ladder', () => {
    expect(ladderPosition('pre_active').kind).toBe('before');
  });
});
