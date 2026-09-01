import { blake2bHash, BLAKE2B_256_OUTPUT_BYTES } from './blake2b.js';
import { lengthPrefixedConcat } from './util.js';

// Contact key fingerprint — the owner-side check that the public keys the
// SERVER served for a contact are the keys that contact actually holds.
//
// Why this exists: the server distributes contact public keys, and the owner's
// client seals release shares to whatever bytes it receives. A single
// `UPDATE contacts SET contact_x25519_pubkey = …` substitutes a key whose
// secret the operator holds, and the genuine, published, reproducibly-built
// client then seals the share to it, behaving exactly as written. Because no
// code changes, the build digest is unchanged and `/security/build` reports
// clean (docs/15 §5.7.5 Path E). The possession proof does not help: the server
// is both its issuer and its verifier, so it proves the submitter holds the
// secrets for the keys the SERVER chose to challenge — nothing to the owner.
//
// The only defence is a value the two humans compare over a channel the server
// does not carry. That is this number.
//
// Construction:
//   digest = BLAKE2b-256( lp(DOMAIN) || lp(x25519_pubkey) || lp(ed25519_pubkey) )
//   where lp(x) = u32_be(len(x)) || x
//
// Length-prefixed for the same reason as the outer-layer AAD (packages/keys
// aad.ts): concatenating two 32-byte keys is unambiguous today only by accident
// of their being equal-length, so a future key type of a different length could
// otherwise collide with a swapped pair of the current ones. Domain-separated
// so this digest can never equal one computed elsewhere over the same bytes.
//
// BOTH keys are covered deliberately. Sealing uses X25519 alone, but a
// fingerprint over X25519 alone would let the server pair a genuine Ed25519
// (whose affirmation signatures verify) with a substituted X25519 (which reads
// the share) — the substitution would be invisible in the half the owner
// checks. Covering both means any substitution, of either key or of both
// consistently, changes the number.

export const CONTACT_FINGERPRINT_DOMAIN = 'truecairn/contact-key-fingerprint/v1';

// 6 groups x 5 digits = 30 decimal digits ~ 99.6 bits. Enough that forging a
// keypair to match a target number is infeasible, short enough to read aloud
// over a phone call without either person losing their place. Same shape and
// per-party length as the safety numbers people already know from other
// end-to-end encrypted messengers.
export const CONTACT_FINGERPRINT_GROUPS = 6;
export const CONTACT_FINGERPRINT_GROUP_DIGITS = 5;
const BYTES_PER_GROUP = 5;
const GROUP_MODULUS = 100000; // 10 ** CONTACT_FINGERPRINT_GROUP_DIGITS

export interface ContactKeyFingerprintInput {
  x25519PublicKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
}

// The raw 32-byte digest. Callers that need to *compare* keys should compare
// the key bytes themselves (see the pin in apps/web) — this digest is for
// DISPLAY, and is truncated on the way to digits.
export function contactKeyFingerprint(input: ContactKeyFingerprintInput): Uint8Array {
  if (input.x25519PublicKey.length === 0 || input.ed25519PublicKey.length === 0) {
    throw new Error('contactKeyFingerprint requires both public keys');
  }
  const message = lengthPrefixedConcat([
    new TextEncoder().encode(CONTACT_FINGERPRINT_DOMAIN),
    input.x25519PublicKey,
    input.ed25519PublicKey,
  ]);
  return blake2bHash({ message, outputLength: BLAKE2B_256_OUTPUT_BYTES });
}

// Render a digest as grouped decimal digits: "12345 67890 …".
//
// Each group takes 5 digest bytes as a big-endian integer (< 2^40, exact in a
// double) reduced mod 100000. The reduction is very slightly biased — 2^40 is
// not a multiple of 10^5 — by about one part in 10^7, which does not matter for
// a value whose job is to be compared for equality by two people out of band.
export function formatContactSafetyNumber(digest: Uint8Array): string {
  const needed = CONTACT_FINGERPRINT_GROUPS * BYTES_PER_GROUP;
  if (digest.length < needed) {
    throw new Error(`safety number needs >= ${needed} digest bytes, got ${digest.length}`);
  }
  const groups: string[] = [];
  for (let g = 0; g < CONTACT_FINGERPRINT_GROUPS; g++) {
    let acc = 0;
    for (let b = 0; b < BYTES_PER_GROUP; b++) {
      acc = acc * 256 + digest[g * BYTES_PER_GROUP + b]!;
    }
    groups.push(String(acc % GROUP_MODULUS).padStart(CONTACT_FINGERPRINT_GROUP_DIGITS, '0'));
  }
  return groups.join(' ');
}

// The value both screens show. The owner reads it off their contact list; the
// contact reads it off their own screen, computed from keys their own master
// key derives and never from anything the server sent them. If the two strings
// match, no substitution happened.
export function contactSafetyNumber(input: ContactKeyFingerprintInput): string {
  return formatContactSafetyNumber(contactKeyFingerprint(input));
}
