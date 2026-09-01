import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NotificationChannelType } from '@truecairn/shared';
import { PRO_CHANNEL_TYPES, WITHDRAWN_CHANNEL_TYPES } from './entitlement.js';

// A channel type nobody can enrol must not be advertised as something you get.
//
// WhatsApp was withdrawn on 2026-08-01: Meta refuses to let the account create
// `truecairn_channel_verification`, and that template gates channel verification
// ITSELF, so no WhatsApp channel can be created at all — by anyone, on any plan.
// It had been sold as part of Truecairn Personal, and the changelog retracts
// that publicly. Every surface that goes on listing it is that same claim made
// again, on a page someone is reading while deciding whether to pay.
//
// The withdrawal is one server constant and the clients read the server's
// `enrollableChannelTypes`, which is what makes it a one-line reversible change.
// COPY does not read anything, which is why it needed a gate: the mobile app's
// settings screen still said "email, SMS, WhatsApp or web push" nine days after
// the withdrawal, and the docs/28 plan table still listed it as a Personal-plan
// channel.
//
// Reads WITHDRAWN_CHANNEL_TYPES rather than naming whatsapp, so a re-add
// (deleting that one entry) un-gates the copy automatically instead of leaving a
// hardcoded assertion to fail on the day the channel comes back.

// This file lives at apps/api/src/billing/, so the repo root is four up.
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

// How each channel type is written in user-facing copy. Keyed by type so a
// future withdrawal cannot slip through unnamed — the first test fails if a
// withdrawn type has no entry here.
const COPY_NAMES: Partial<Record<NotificationChannelType, readonly string[]>> = {
  whatsapp: ['whatsapp', 'whats app'],
  sms: ['sms', 'text message'],
  email: ['email'],
  push: ['web push'],
};

// Surfaces that describe what a plan GIVES you, or which channels reach you.
// Deliberately narrow and enumerated rather than a repo-wide scan: the same word
// appears legitimately in three other kinds of place, and a gate that cannot
// tell them apart gets suppressed rather than fixed.
//
//   - it RECORDS the withdrawal (the changelog, docs/04, docs/26, the comments
//     in Settings.tsx) — that is the honest record and must survive;
//   - it IMPLEMENTS the channel, dormant (whatsapp-cloud.ts, the template map,
//     the pgEnum value, the client's channel-type union) — the changelog says
//     "it is paused, not abandoned; the work is finished and waiting", and
//     deleting it would make that sentence false and turn a re-add into a
//     rewrite;
//   - it carries BILLING semantics (PRO_CHANNEL_TYPES, the grandfathering rules
//     in docs/28, the residualPaid filter in Settings.tsx) — a verified row from
//     before the withdrawal is a paid channel that keeps delivering, and the
//     downgrade sweep reads that set.
const PLAN_SURFACES = [
  'apps/web/src/screens/plans/Plans.tsx',
  'apps/web/src/billing/pricing.ts',
  'apps/mobile/lib/src/screens/settings_screen.dart',
];

// The curated public export withholds apps/mobile (public-export/manifest.txt),
// so that surface is absent in that tree and this gate would throw ENOENT there
// — a published suite that cannot pass on the published tree is worse than a
// narrower gate. It is skipped ONLY when the whole app is missing: inside a full
// checkout the file must exist, so deleting or renaming it still fails here
// rather than quietly removing a surface from the gate.
function surfaceIsOutOfTree(rel: string): boolean {
  const app = rel.split('/').slice(0, 2).join('/');
  return !existsSync(join(repoRoot, app));
}

// docs/28's plan comparison table only — the rest of that file is the billing
// semantics above, where naming the type is correct.
const DOCS_28_TABLE = { file: 'docs/28-billing.md', from: '| | Free | Personal |', lines: 10 };

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

// Comments are stripped before matching, because the distinction this gate is
// drawing is exactly the one between COPY and COMMENTARY. A source file may —
// and should — explain in a comment why a withdrawn type is absent from the
// sentence beside it; that is the honest record, not an advertisement. Only what
// a user can read counts. TS/TSX and Dart share this comment syntax, so one
// stripper covers all three surfaces.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function mentions(text: string, names: readonly string[]): string | null {
  const haystack = text.toLowerCase();
  return names.find((n) => haystack.includes(n)) ?? null;
}

describe('withdrawn channel types are not advertised as available', () => {
  const withdrawn = [...WITHDRAWN_CHANNEL_TYPES];

  it('every withdrawn type has a known copy spelling, so none can slip through unnamed', () => {
    for (const type of withdrawn) {
      expect(COPY_NAMES[type], `add ${type} to COPY_NAMES or this gate cannot see it`).toBeDefined();
    }
  });

  it('no plan or pricing surface names one', () => {
    for (const type of withdrawn) {
      const names = COPY_NAMES[type] ?? [];
      for (const file of PLAN_SURFACES) {
        if (surfaceIsOutOfTree(file)) continue;
        const hit = mentions(withoutComments(read(file)), names);
        expect(hit, `${file} advertises the withdrawn channel type '${type}' (matched "${hit}")`).toBeNull();
      }
    }
  });

  it("the docs/28 plan table does not list one", () => {
    const lines = read(DOCS_28_TABLE.file).split('\n');
    const start = lines.findIndex((l) => l.includes(DOCS_28_TABLE.from));
    expect(start, `${DOCS_28_TABLE.file} no longer contains the plan table header`).toBeGreaterThan(-1);
    const table = lines.slice(start, start + DOCS_28_TABLE.lines).join('\n');
    for (const type of withdrawn) {
      const hit = mentions(table, COPY_NAMES[type] ?? []);
      expect(hit, `the docs/28 plan table lists the withdrawn channel type '${type}'`).toBeNull();
    }
  });

  it('a withdrawn type still carries its billing semantics — availability is a separate question', () => {
    // The counterpart, stated so a later "tidy-up" cannot read the assertions
    // above as "remove every trace". whatsapp stays in PRO_CHANNEL_TYPES because
    // that set is what the downgrade sweep and the residualPaid banner read: a
    // grandfathered verified row is a PAID channel that keeps delivering, and
    // docs/28's rule is that a channel already guarding a vault is never
    // re-gated. Withdrawing an offer and un-billing an existing channel are
    // different acts.
    expect(PRO_CHANNEL_TYPES).toContain('whatsapp');
    expect(WITHDRAWN_CHANNEL_TYPES.has('whatsapp')).toBe(true);
    // And the Settings downgrade banner still covers it, so someone holding one
    // is still reassured it keeps working.
    expect(read('apps/web/src/screens/settings/Settings.tsx')).toContain(
      "ch.channelType === 'whatsapp'",
    );
    // And that filter is CODE, not a comment — the line above would pass on a
    // file that had deleted the filter and left the comment explaining it.
    expect(withoutComments(read('apps/web/src/screens/settings/Settings.tsx'))).toContain(
      "ch.channelType === 'whatsapp'",
    );
  });

  it('the gate is not vacuous', () => {
    // If the withdrawn set is ever emptied — the intended end state when the
    // template is approved — the assertions above pass trivially. That is
    // correct, and this says so out loud rather than leaving a green run to be
    // mistaken for coverage.
    expect(COPY_NAMES.whatsapp).toBeDefined();
    if (withdrawn.length === 0) return;
    // With a non-empty set, prove the matcher would actually fire.
    expect(mentions('email, SMS, WhatsApp or web push', COPY_NAMES.whatsapp!)).toBe('whatsapp');
  });
});
