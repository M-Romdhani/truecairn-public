import { openSealedToContact, signContactChallenge } from '@truecairn/client-crypto';
import { buildShareSigningInput, rewrapShareToRecipient } from '@truecairn/ceremony/client';
import { fromBase64, toBase64, wipe } from '@truecairn/crypto';
import type { TierKeyShare } from '@truecairn/keys';
import { getSealContext, postSealedShare } from './api.js';

// The affirming contact's share contribution (Checkpoint B): open the OWN
// wrapped Shamir share with the contact X25519 key, re-seal it to every
// registered recipient not yet covered, sign each seal's binding (affirmation,
// recipient, recipient ephemeral key, exact ciphertext) with the contact
// Ed25519 key, upload. Entirely on the contact's device — the platform
// receives only sealed boxes + signatures. Idempotent: recipients already in
// sealedTo are skipped, so re-running after a late registration only adds the
// missing seals. Returns how many recipients are now covered.
export async function provideShares(ceremonyId: string, fetchImpl?: typeof fetch): Promise<number> {
  const ctx = await getSealContext(ceremonyId, fetchImpl);
  const outstanding = ctx.recipients.filter((r) => !ctx.sealedTo.includes(r.recipientContactId));
  if (outstanding.length === 0) return ctx.sealedTo.length;

  const shareBytes = openSealedToContact(fromBase64(ctx.wrappedShareCiphertext));
  try {
    const share = { bytes: shareBytes, tier: ctx.tier } as TierKeyShare;
    for (const recipient of outstanding) {
      const recipientEphemeralPubkey = fromBase64(recipient.ephemeralPubkey);
      const sealed = rewrapShareToRecipient(share, recipientEphemeralPubkey);
      const signature = signContactChallenge(
        buildShareSigningInput({
          affirmationId: ctx.affirmationId,
          recipientContactId: recipient.recipientContactId,
          recipientEphemeralPubkey,
          sealedShareCiphertext: sealed,
        }),
      );
      await postSealedShare(
        ceremonyId,
        {
          recipientContactId: recipient.recipientContactId,
          sealedShareCiphertext: toBase64(sealed),
          shareSignature: toBase64(signature),
        },
        fetchImpl,
      );
    }
  } finally {
    wipe(shareBytes);
  }
  return ctx.sealedTo.length + outstanding.length;
}
