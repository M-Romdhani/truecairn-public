import { generateCeremonyEphemeralKeypair, type CeremonyEphemeralKeypair } from '@truecairn/ceremony/client';
import { fromBase64, toBase64 } from '@truecairn/crypto';

// The recipient's ceremony ephemeral keypair, persisted on THIS device.
//
// The ceremony spans days–weeks between registration and the gate opening, so
// the secret half must survive page reloads: localStorage, keyed by ceremony.
// Device-local by design — the platform only ever receives the PUBLIC key, and
// a re-registration with a different key is rejected server-side (shares
// already sealed to the first key would become undecryptable), which makes
// this stored key the only way to open them. V1 trade-off (documented in the
// threat model's device-trust assumption): anything able to read this
// device's localStorage can hold the SEALED shares' unseal key, but the
// sealed shares themselves remain server-side behind the session + the
// temporal gate.

const KEY_PREFIX = 'truecairn.ceremony-ephemeral.';

// The stored key is scoped by the RECIPIENT (their user id), not the ceremony
// alone: the ephemeral belongs to one recipient, and two recipients can share a
// browser profile (a family computer, or QA testing several identities in one
// profile). Keying by ceremony alone let the two collide — and one recipient's
// discard-on-success wiped the other's key, stranding their own retrieval (QA
// 2026-07-21 D9's shared-session note). `scope` is the current user id.
function storageKey(scope: string, ceremonyId: string): string {
  return `${KEY_PREFIX}${scope}.${ceremonyId}`;
}

export function loadOrCreateEphemeral(scope: string, ceremonyId: string): CeremonyEphemeralKeypair {
  const existing = localStorage.getItem(storageKey(scope, ceremonyId));
  if (existing !== null) {
    const parsed = JSON.parse(existing) as { publicKey: string; secretKey: string };
    return { publicKey: fromBase64(parsed.publicKey), secretKey: fromBase64(parsed.secretKey) };
  }
  const kp = generateCeremonyEphemeralKeypair();
  localStorage.setItem(
    storageKey(scope, ceremonyId),
    JSON.stringify({ publicKey: toBase64(kp.publicKey), secretKey: toBase64(kp.secretKey) }),
  );
  return kp;
}

export function loadEphemeral(scope: string, ceremonyId: string): CeremonyEphemeralKeypair | null {
  const existing = localStorage.getItem(storageKey(scope, ceremonyId));
  if (existing === null) return null;
  const parsed = JSON.parse(existing) as { publicKey: string; secretKey: string };
  return { publicKey: fromBase64(parsed.publicKey), secretKey: fromBase64(parsed.secretKey) };
}

// Once the ceremony is over (released or terminal), the keypair has no further
// use — drop it so the unseal capability doesn't outlive the ceremony.
export function discardEphemeral(scope: string, ceremonyId: string): void {
  localStorage.removeItem(storageKey(scope, ceremonyId));
}
