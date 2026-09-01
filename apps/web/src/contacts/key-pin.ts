import {
  contactSafetyNumber,
  fromBase64,
  lengthPrefixedConcat,
  lengthPrefixedSplit,
  randomSecretboxNonce,
  secretboxDecrypt,
  secretboxEncrypt,
  toBase64,
} from '@truecairn/crypto';
import type { ContactRow } from './api.js';
import { withContactMetadataKey } from './crypto.js';
import { withContactPinKey } from '@truecairn/client-crypto';
import { CONTACT_PIN_VERSION_V1_S1_TIER_KEY } from '@truecairn/keys';

// Owner-side verification of a contact's public keys (docs/15 §5.7.5 Path E).
//
// The server tells the owner's client which public keys belong to which
// contact, and until now the client believed it. One UPDATE against the
// contacts table substituted a key the operator held the secret for, and the
// genuine client sealed the release share straight to it. No code changed, so
// the reproducible build stayed clean and `/security/build` said so.
//
// The fix has two halves, and BOTH are needed:
//
//   1. The owner compares a safety number with the contact out of band — over a
//      phone call, in person, on any channel we do not carry. That is the only
//      step in this file that actually establishes anything; everything else is
//      bookkeeping around it.
//   2. The client PINS what was confirmed and refuses to seal to anything else.
//      Contact keys are deterministic from the contact's master key, so they
//      change only on a real rotation — already a sensitive action with a 7-day
//      delay and out-of-band notice. An unannounced change is therefore not a
//      surprise to be clicked through; it is an attack.
//
// The pin is sealed under the owner's S1 TIER KEY, following the display-label
// precedent in crypto.ts: the server stores ciphertext for a key it does not
// have. It cannot forge a pin, and the AAD binding (owner, contact) means it
// cannot move one row's pin to another or replay a removed contact's. It can
// DELETE one — that degrades to 'unverified', which blocks sealing. Fail closed
// (invariant #2).

const PIN_DOMAIN = 'truecairn/contact-key-pin/v1';
const enc = new TextEncoder();

// AAD binds the pin to the owner and the specific contact. Without this, a
// server could copy a pin the owner confirmed for contact A onto contact B's
// row, and B's substituted key would read as verified.
function pinAad(userId: string, contactId: string): Uint8Array {
  return lengthPrefixedConcat([
    enc.encode(PIN_DOMAIN),
    enc.encode(userId),
    enc.encode(contactId),
  ]);
}

// Both keys go in the pin because both are covered by the number the owner
// read out. Pinning only the sealing key would leave the Ed25519 half — the one
// that verifies affirmations — swappable after the fact.
function pinPlaintext(x25519Pubkey: Uint8Array, ed25519Pubkey: Uint8Array): Uint8Array {
  return lengthPrefixedConcat([x25519Pubkey, ed25519Pubkey]);
}

export interface SealedKeyPin {
  keyPinCiphertext: string;
  keyPinNonce: string;
}

// Record what the owner just confirmed. Callers must have SHOWN the owner the
// safety number and had them confirm it matches — this function cannot verify
// that happened, which is precisely why the UI around it matters.
export function sealKeyPin(input: {
  userId: string;
  contactId: string;
  x25519Pubkey: string;
  ed25519Pubkey: string;
  // The version the ROW already carries. Sealing under anything else would
  // leave the row's label and pin under different keys, and the row records
  // only one version for both.
  contactPinVersion: number;
}): SealedKeyPin {
  // Under the row's OWN version, not unconditionally v2. A contact created
  // after 0068 is already v2 and gets the master-derived key — which is the
  // fix: the S1 tier key is sealed to the S1 beneficiary and unsealed in their
  // browser on release, so pinning under it handed one recipient the owner's
  // confirmation for every contact (F1+F2). A pre-0068 row stays v1 until its
  // label and pin are rewritten together.
  return withContactMetadataKey(input.contactPinVersion, (key) => {
    const nonce = randomSecretboxNonce();
    const ct = secretboxEncrypt({
      key,
      nonce,
      plaintext: pinPlaintext(fromBase64(input.x25519Pubkey), fromBase64(input.ed25519Pubkey)),
      additionalData: pinAad(input.userId, input.contactId),
    });
    return { keyPinCiphertext: toBase64(ct), keyPinNonce: toBase64(nonce) };
  });
}

// What the client believes about a contact's keys right now.
//
// 'changed' and 'tampered' are deliberately NOT folded into 'unverified'. All
// three block sealing, but they mean different things to the person reading the
// screen: unverified is work not yet done, while the other two are evidence
// that something interfered. Collapsing them would hide the alarm inside the
// to-do item.
export type ContactKeyState =
  | { kind: 'no_keys' }
  | { kind: 'unverified' }
  | { kind: 'verified'; confirmedAt: string; safetyNumber: string }
  | { kind: 'changed'; confirmedAt: string; safetyNumber: string }
  | { kind: 'tampered' };

export function evaluateContactKeyState(userId: string, c: ContactRow): ContactKeyState {
  // `== null` catches undefined as well as null, deliberately. A response from
  // an older API instance mid-deploy has no ed25519Pubkey or pin fields at all,
  // and the safe reading of "the field isn't there" is "we have nothing to
  // verify" — not a crash, and certainly not a pass.
  if (c.x25519Pubkey == null || c.ed25519Pubkey == null) return { kind: 'no_keys' };

  const served = pinPlaintext(fromBase64(c.x25519Pubkey), fromBase64(c.ed25519Pubkey));
  const safetyNumber = contactSafetyNumber({
    x25519PublicKey: fromBase64(c.x25519Pubkey),
    ed25519PublicKey: fromBase64(c.ed25519Pubkey),
  });

  if (c.keyPinCiphertext == null || c.keyPinNonce == null || c.keyPinConfirmedAt == null) {
    return { kind: 'unverified' };
  }

  let pinned: Uint8Array;
  try {
    // Read under whichever key this row was written with. A v1 row stays
    // readable, so the owner is never forced to redo the out-of-band comparison
    // — §1.2's rule, and the reason there is a v1 reader here at all.
    pinned = withContactMetadataKey(c.contactPinVersion ?? CONTACT_PIN_VERSION_V1_S1_TIER_KEY, (key) =>
      secretboxDecrypt({
        key,
        nonce: fromBase64(c.keyPinNonce!),
        ciphertext: fromBase64(c.keyPinCiphertext!),
        additionalData: pinAad(userId, c.contactId),
      }),
    );
  } catch {
    // The AEAD rejected it: forged, corrupted, or lifted from another contact's
    // row. Not something to retry past.
    return { kind: 'tampered' };
  }

  // Compare the framed bytes, not the safety number. The number is a truncated
  // digest built for humans to read aloud; the pin is the actual key material,
  // so this comparison is exact and has no truncation to argue about.
  const match =
    pinned.length === served.length && pinned.every((b, i) => b === served[i]);

  // A parse failure here would mean our own writer produced something our reader
  // cannot understand — treat it as tampering rather than papering over it.
  try {
    const parts = lengthPrefixedSplit(pinned);
    if (parts.length !== 2) return { kind: 'tampered' };
  } catch {
    return { kind: 'tampered' };
  }

  return match
    ? { kind: 'verified', confirmedAt: c.keyPinConfirmedAt, safetyNumber }
    : { kind: 'changed', confirmedAt: c.keyPinConfirmedAt, safetyNumber };
}

// The safety number to display for a contact whose keys we have. Same value the
// contact sees on their own screen, computed there from their own master key.
export function contactRowSafetyNumber(c: ContactRow): string | null {
  if (c.x25519Pubkey == null || c.ed25519Pubkey == null) return null;
  return contactSafetyNumber({
    x25519PublicKey: fromBase64(c.x25519Pubkey),
    ed25519PublicKey: fromBase64(c.ed25519Pubkey),
  });
}

// ── The seal gate ────────────────────────────────────────────────────────────
//
// A token that can only be minted by passing the pin check. The sealing
// functions in crypto.ts take THIS rather than a base64 string, so "did anyone
// verify this key?" is answered by the type system at every call site, present
// and future, instead of by a null check somebody remembers to write. The
// original guard was `x25519Pubkey !== null` with the comment "never seal to an
// unverified key" — it meant "this contact enrolled", and the gap between what
// it said and what it checked is the entire finding.
declare const verifiedBrand: unique symbol;

export interface VerifiedContactKey {
  readonly [verifiedBrand]: true;
  readonly contactId: string;
  readonly x25519Pubkey: string;
}

export class UnverifiedContactKeyError extends Error {
  readonly state: ContactKeyState['kind'];
  constructor(state: ContactKeyState['kind']) {
    super(`refusing to seal to a contact key in state '${state}'`);
    this.name = 'UnverifiedContactKeyError';
    this.state = state;
  }
}

// Mint a sealing token, or refuse. There is no bypass argument and there must
// never be one: a caller that "knows better" is the attack.
export function requireVerifiedContactKey(userId: string, c: ContactRow): VerifiedContactKey {
  const state = evaluateContactKeyState(userId, c);
  if (state.kind !== 'verified') throw new UnverifiedContactKeyError(state.kind);
  return {
    contactId: c.contactId,
    x25519Pubkey: c.x25519Pubkey!,
  } as VerifiedContactKey;
}

// Re-encrypt an existing pin from one storage version to another WITHOUT
// changing what it says (F1+F2 backfill).
//
// The plaintext is decrypted and re-sealed verbatim. It is deliberately NOT
// re-derived from the contact's CURRENT public keys, which would be easier and
// would be a hole: if the server had substituted a key since the owner
// confirmed, re-deriving would silently launder the substitution into a fresh
// "confirmation" the owner never made — turning the migration into the exact
// attack the pin exists to detect (docs/15 §5.7.5 Path E).
//
// Returns null when the pin cannot be opened. That is the right answer rather
// than an error: an unopenable pin is already `tampered`, and a row that cannot
// be read cannot be honestly rewritten, so it stays at its old version and keeps
// showing the alarm.
export function rewrapKeyPin(input: {
  userId: string;
  contactId: string;
  fromVersion: number;
  keyPinCiphertext: string;
  keyPinNonce: string;
}): SealedKeyPin | null {
  const aad = pinAad(input.userId, input.contactId);
  let plaintext: Uint8Array;
  try {
    plaintext = withContactMetadataKey(input.fromVersion, (key) =>
      secretboxDecrypt({
        key,
        nonce: fromBase64(input.keyPinNonce),
        ciphertext: fromBase64(input.keyPinCiphertext),
        additionalData: aad,
      }),
    );
  } catch {
    return null;
  }
  // Same AAD, so the rewritten pin stays bound to the same (owner, contact) —
  // a rekey must not make a pin portable between rows.
  return withContactPinKey((key) => {
    const nonce = randomSecretboxNonce();
    const ct = secretboxEncrypt({ key, nonce, plaintext, additionalData: aad });
    return { keyPinCiphertext: toBase64(ct), keyPinNonce: toBase64(nonce) };
  });
}
