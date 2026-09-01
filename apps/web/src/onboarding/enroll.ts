import { encodeKeyMaterial, generateEnrollmentMaterial, type KeyMaterial } from '@truecairn/client-crypto';
import { api, apiJson } from '../api/client.js';

export interface EnrollmentResult {
  material: KeyMaterial;
  // The 256-bit recovery code, for the UI to render then zeroize. Rendered as 64
  // HEX characters (`Onboarding.tsx`), not the BIP-39 words an earlier draft of
  // Q7 assumed — this comment claimed otherwise until 2026-08-27 (QA F7). The
  // encoding is a live design question, not settled: hex has no checksum, so a
  // single mistyped character is undetectable until the day it is needed. See
  // CLAUDE.md backlog #7 — changing it invalidates every code already issued, so
  // it needs a migration story rather than an edit here.
  recoveryCode: Uint8Array;
  userId: string;
}

// The enrollment ceremony's crypto + provision step (PHASE4 C2): generate all key
// material client-side (random master key wrapped under the passphrase and the
// recovery code, the three tier keys, the audit pubkey, the salts), upload the
// WRAPPED forms, and return the recovery code for display + the material for an
// immediate unlock. The passphrase is the caller's; generateEnrollmentMaterial
// does not retain it (the caller unlocks with it next, which zeroizes it).
export async function provisionAccount(
  passphrase: Uint8Array,
  fetchImpl?: typeof fetch,
): Promise<EnrollmentResult> {
  const { material, recoveryCode } = generateEnrollmentMaterial(passphrase);
  const res = await api('/v1/account/key-material', {
    method: 'POST',
    body: encodeKeyMaterial(material),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const { userId } = await apiJson<{ provisioned: boolean; userId: string }>(res);
  return { material, recoveryCode, userId };
}
