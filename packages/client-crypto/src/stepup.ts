import { buildStepUpSigningInput } from '@truecairn/audit/canonical';
import { signWithUserKey } from './session.js';

// Re-exported so consumers (the web app + its tests) get the ONE shared canonical
// builder from @truecairn/client-crypto without taking a direct @truecairn/audit
// dependency — same builder the server verifies against.
export { buildStepUpSigningInput } from '@truecairn/audit/canonical';

// Client side of the step-up handshake (PHASE4 C2). Signs the SAME canonical
// bytes the server verifies — buildStepUpSigningInput is the single shared
// builder (imported here via @truecairn/audit's pure `canonical` subpath, no
// node:crypto), and the signature uses the unlocked session's master-key-derived
// Ed25519 key, which the server checks against user_key_material.audit_signing_
// pubkey (uploaded at provision). Requires the vault to be unlocked.
//
// The HTTP interceptor (apps/web) turns the R1 -> 403 -> sign -> R2 dance into
// one awaited call: on a 403 step-up-required it reads { challengeId, challenge },
// ensures a fresh second factor, calls signStepUp with the EXACT request body it
// will resend, and retries with the challenge + signature headers.

export interface StepUpSignatureInput {
  userId: string;
  actionType: string;
  // The 32-byte server challenge (decode the base64url `stepUp.challenge` first).
  challenge: Uint8Array;
  // The EXACT request body the server will canonicalise — must be the same value
  // sent on the retry, or the signatures cover different bytes.
  body: unknown;
}

export function signStepUp(input: StepUpSignatureInput): Uint8Array {
  const payload = buildStepUpSigningInput(
    input.userId,
    input.actionType,
    input.challenge,
    input.body,
  );
  return signWithUserKey(payload);
}
