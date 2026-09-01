// Per-relationship contact keys: the properties that make them worth having.
//
// v1 derived ONE contact keypair from the master key, so a contact presented the
// same public key in every owner's `contacts` row and the database revealed who
// shares a contact without decrypting anything (docs/15's adversary). v2 binds
// each keypair to one relationship.
//
// The tests below are the claim, stated as properties rather than examples:
// unlinkable across relationships, deterministic within one, domain-separated
// between the two key types, and distinct from v1 so an upgrade is a real change.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto, x25519KeypairFromSeed, ed25519KeypairFromSeed } from '@truecairn/crypto';
import {
  deriveContactEd25519Seed,
  deriveContactEd25519SeedForRelationship,
  deriveContactX25519Seed,
  deriveContactX25519SeedForRelationship,
} from './subkeys.js';
import type { UnwrappedMasterKey } from './types.js';

const master = (fill: number): UnwrappedMasterKey =>
  new Uint8Array(32).fill(fill) as UnwrappedMasterKey;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('per-relationship contact key derivation (v2)', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  // THE property. This is the correlation leak, closed: one contact, two owners,
  // two unrelated public keys in the database.
  it('the SAME contact presents DIFFERENT keys to different owners', () => {
    const k = master(7);
    expect(hex(deriveContactX25519SeedForRelationship(k, A))).not.toBe(
      hex(deriveContactX25519SeedForRelationship(k, B)),
    );
    expect(hex(deriveContactEd25519SeedForRelationship(k, A))).not.toBe(
      hex(deriveContactEd25519SeedForRelationship(k, B)),
    );
  });

  // ...and the PUBLIC keys, which are what actually lands in the database, differ
  // too. Asserting on seeds alone would leave the interesting half untested.
  it('the derived PUBLIC keys differ across relationships', () => {
    const k = master(7);
    const x1 = x25519KeypairFromSeed(deriveContactX25519SeedForRelationship(k, A));
    const x2 = x25519KeypairFromSeed(deriveContactX25519SeedForRelationship(k, B));
    expect(hex(x1.publicKey)).not.toBe(hex(x2.publicKey));

    const e1 = ed25519KeypairFromSeed(deriveContactEd25519SeedForRelationship(k, A));
    const e2 = ed25519KeypairFromSeed(deriveContactEd25519SeedForRelationship(k, B));
    expect(hex(e1.publicKey)).not.toBe(hex(e2.publicKey));
  });

  // Determinism is what lets the contact custody ONE secret instead of N. Without
  // it, per-relationship keys would mean per-relationship backups.
  it('the same (master key, relationship) always derives the same seed', () => {
    const k = master(7);
    expect(hex(deriveContactX25519SeedForRelationship(k, A))).toBe(
      hex(deriveContactX25519SeedForRelationship(k, A)),
    );
    expect(hex(deriveContactEd25519SeedForRelationship(k, A))).toBe(
      hex(deriveContactEd25519SeedForRelationship(k, A)),
    );
  });

  it('different master keys never collide on the same relationship', () => {
    expect(hex(deriveContactX25519SeedForRelationship(master(7), A))).not.toBe(
      hex(deriveContactX25519SeedForRelationship(master(8), A)),
    );
  });

  // Domain separation inside the PRF. If these matched, the X25519 private seed
  // and the Ed25519 signing seed would be the same bytes used two ways.
  it('the X25519 and Ed25519 seeds for ONE relationship are independent', () => {
    const k = master(7);
    expect(hex(deriveContactX25519SeedForRelationship(k, A))).not.toBe(
      hex(deriveContactEd25519SeedForRelationship(k, A)),
    );
  });

  // The prefix is why this holds. With a suffix, a crafted relationship id could
  // make one purpose's message equal another's.
  it('a relationship id cannot be crafted to collide with another purpose', () => {
    const k = master(7);
    const crafted = `x25519:${A}`;
    expect(hex(deriveContactEd25519SeedForRelationship(k, crafted))).not.toBe(
      hex(deriveContactX25519SeedForRelationship(k, A)),
    );
  });

  // v2 must differ from v1, or an "upgrade" would be a no-op that silently left
  // the correlation in place.
  it('v2 differs from the v1 global seed', () => {
    const k = master(7);
    expect(hex(deriveContactX25519SeedForRelationship(k, A))).not.toBe(
      hex(deriveContactX25519Seed(k)),
    );
    expect(hex(deriveContactEd25519SeedForRelationship(k, A))).not.toBe(
      hex(deriveContactEd25519Seed(k)),
    );
  });

  // v1 stays derivable: existing relationships must keep working through the
  // migration window, and PLAN-v1-launch.md §1.2's rule is read-both-write-v2.
  it('v1 is unchanged and still derivable', () => {
    const k = master(7);
    expect(hex(deriveContactX25519Seed(k))).toBe(hex(deriveContactX25519Seed(k)));
    expect(deriveContactX25519Seed(k)).toHaveLength(32);
    expect(deriveContactEd25519Seed(k)).toHaveLength(32);
  });

  it('seeds are the expected length', () => {
    const k = master(7);
    expect(deriveContactX25519SeedForRelationship(k, A)).toHaveLength(32);
    expect(deriveContactEd25519SeedForRelationship(k, A)).toHaveLength(32);
  });

  // The committed vectors (docs/32 §9). Read from the SAME file the Dart suite
  // reads — never copied — so a mobile port that ignores relationshipId, or
  // appends the purpose instead of prefixing it, fails against the same bytes.
  it('reproduces the committed vectors', () => {
    const v = JSON.parse(
      readFileSync(join(__dirname, 'vectors/subkeys.json'), 'utf8'),
    ) as {
      masterKeyHex: string;
      contactBindingV2: {
        relationships: { relationshipId: string; x25519SeedHex: string; ed25519SeedHex: string }[];
      };
    };
    const mk = Uint8Array.from(Buffer.from(v.masterKeyHex, 'hex')) as UnwrappedMasterKey;
    expect(v.contactBindingV2.relationships).toHaveLength(2);
    for (const r of v.contactBindingV2.relationships) {
      expect(hex(deriveContactX25519SeedForRelationship(mk, r.relationshipId))).toBe(r.x25519SeedHex);
      expect(hex(deriveContactEd25519SeedForRelationship(mk, r.relationshipId))).toBe(r.ed25519SeedHex);
    }
    // Two DIFFERENT relationships, pinned — the vectors themselves encode the
    // unlinkability claim, not just this test.
    const [a, b] = v.contactBindingV2.relationships;
    expect(a!.x25519SeedHex).not.toBe(b!.x25519SeedHex);
    expect(a!.ed25519SeedHex).not.toBe(b!.ed25519SeedHex);
  });
});
