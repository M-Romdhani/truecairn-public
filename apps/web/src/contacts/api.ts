import { contactPublicKeys, openSealedToContact, signContactChallenge } from '@truecairn/client-crypto';
import { fromBase64Url, toBase64 } from '@truecairn/crypto';
import type { ContactRole, ContactStatus, RecipientType } from '@truecairn/shared';
import { api, apiJson } from '../api/client.js';
import { requestWithStepUp, type StepUpDeps } from '../api/stepup.js';
import { encryptContactLabel, sealS1EnvelopeToContact } from './crypto.js';
import type { VerifiedContactKey } from './key-pin.js';
import { sealKeyPin } from './key-pin.js';

export interface ContactRow {
  contactId: string;
  role: ContactRole;
  status: ContactStatus;
  displayLabelCiphertext: string;
  displayLabelNonce: string;
  // Which key the label AND the pin on this row are encrypted under (0068).
  // 1 = the S1 tier key (readable by the S1 beneficiary — findings F1+F2),
  // 2 = the master-derived contact-metadata key. Optional so a response from an
  // older API instance mid-deploy is read as v1 rather than crashing, which is
  // the correct reading: a row that predates the field predates the migration.
  contactPinVersion?: number;
  // Present ONLY for enrolled/active contacts (the server withheld it otherwise).
  //
  // That check says the contact finished enrolment — nothing more. It does NOT
  // say these keys are theirs: the server chose these bytes, and the possession
  // proof behind 'enrolled' was issued and verified by that same server. Whether
  // the OWNER has confirmed them out of band is answered by key-pin.ts, and
  // sealing goes through requireVerifiedContactKey() rather than reading these
  // fields directly.
  x25519Pubkey: string | null;
  ed25519Pubkey: string | null;
  // The owner's confirmation, sealed under the key contactPinVersion names —
  // opaque to the server, and to everything here until an unlocked client opens
  // it. Was the S1 tier key until 0068, which made it readable by the S1
  // beneficiary along with every label (F1+F2).
  keyPinCiphertext: string | null;
  keyPinNonce: string | null;
  keyPinConfirmedAt: string | null;
}

export async function inviteContact(
  input: { role: ContactRole; recipientType?: RecipientType; label: string },
  fetchImpl?: typeof fetch,
): Promise<{ contactId: string; inviteToken: string }> {
  const label = encryptContactLabel(input.label);
  const res = await api('/v1/contacts', {
    method: 'POST',
    body: {
      role: input.role,
      ...(input.recipientType !== undefined ? { recipientType: input.recipientType } : {}),
      // ...label carries displayLabelCiphertext, displayLabelNonce AND
      // contactPinVersion — the version travels with the ciphertext it describes.
      ...label,
    },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  return apiJson(res);
}

export async function listContacts(fetchImpl?: typeof fetch): Promise<{ contacts: ContactRow[] }> {
  return apiJson(await api('/v1/contacts', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }));
}

// Record that the owner compared the safety number with this contact out of
// band and it matched. The pin is sealed here, on the owner's device, under a
// key the server does not have — so what crosses the wire is a blob the server
// can store, delete, or refuse, but not write.
export async function confirmContactKeys(
  input: {
    userId: string;
    contactId: string;
    x25519Pubkey: string;
    ed25519Pubkey: string;
    // The row's own version, so the pin is sealed under the same key as the
    // label beside it. Callers pass the contact row's contactPinVersion.
    contactPinVersion: number;
  },
  fetchImpl?: typeof fetch,
): Promise<{ replaced: boolean }> {
  const pin = sealKeyPin(input);
  return apiJson(
    await api('/v1/contacts/key-pin', {
      method: 'POST',
      body: { contactId: input.contactId, ...pin },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function acceptInvite(
  inviteToken: string,
  fetchImpl?: typeof fetch,
): Promise<{ contactId: string }> {
  return apiJson(
    await api('/v1/contacts/accept', {
      method: 'POST',
      body: { inviteToken },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// Cancel a not-yet-enrolled invite (invited/pending_keygen) — session-only, the
// inverse of inviteContact. An ENROLLED contact must be removed via the step-up
// removal instead; the server hard-gates this to never-enrolled contacts.
export async function cancelInvite(
  contactId: string,
  fetchImpl?: typeof fetch,
): Promise<{ cancelled: boolean }> {
  return apiJson(
    await api('/v1/contacts/cancel-invite', {
      method: 'POST',
      body: { contactId },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// Contact-side enrolment: derive the affirmation keypairs (from the contact's own
// master key), upload the pubkeys, then PROVE possession — sign the Ed25519
// challenge AND unseal the X25519 sealed nonce — and verify. The server accepts
// only if both proofs check (the C2-step-up-interop analogue for contacts).
export async function enrollAsContact(contactId: string, fetchImpl?: typeof fetch): Promise<void> {
  const { x25519Pubkey, ed25519Pubkey } = contactPublicKeys();
  const optRes = await api('/v1/contacts/enroll/options', {
    method: 'POST',
    body: { contactId, x25519Pubkey: toBase64(x25519Pubkey), ed25519Pubkey: toBase64(ed25519Pubkey) },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const opt = await apiJson<{
    ed25519ChallengeId: string;
    ed25519Challenge: string;
    x25519ChallengeId: string;
    x25519SealedNonce: string;
  }>(optRes);

  const ed25519Signature = signContactChallenge(fromBase64Url(opt.ed25519Challenge));
  const x25519Nonce = openSealedToContact(fromBase64Url(opt.x25519SealedNonce));

  await apiJson(
    await api('/v1/contacts/enroll/verify', {
      method: 'POST',
      body: {
        contactId,
        ed25519ChallengeId: opt.ed25519ChallengeId,
        ed25519Signature: toBase64(ed25519Signature),
        x25519ChallengeId: opt.x25519ChallengeId,
        x25519Nonce: toBase64(x25519Nonce),
      },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// Owner assigns an S1 release share to an ENROLLED contact: seal the S1 tier key
// to the contact's pubkey, then enqueue via step-up (add_contact, 7-day delay).
export async function assignS1Share(
  input: { contactKey: VerifiedContactKey },
  deps: StepUpDeps,
): Promise<{ sensitiveActionId: string; effectiveAt: string }> {
  const s1EnvelopeCiphertext = sealS1EnvelopeToContact(input.contactKey);
  const res = await requestWithStepUp(
    {
      url: '/v1/contacts/shares',
      method: 'POST',
      body: { contactId: input.contactKey.contactId, tier: 's1', s1EnvelopeCiphertext },
    },
    deps,
  );
  return apiJson(res);
}

// Owner designates a contact as a NON-affirming beneficiary of a tier — they
// receive the release without holding a share or affirming. A sensitive action:
// step-up + 7-day delay. S2/S3 deliver via holders re-sealing shares at ceremony
// time, so no key material is sent here. S1 has no shares: the beneficiary needs
// their OWN sealed envelope of the S1 tier key, sealed here on the owner's device
// (requires a VERIFIED contact key), exactly like an S1 share assignment — and
// for the same reason: this is the second path that seals an S1 tier key to a
// single contact, so it needs the same pin check, not a copy of it.
export async function designateBeneficiary(
  input: { contactId: string; tier: 's1' | 's2' | 's3'; contactKey?: VerifiedContactKey },
  deps: StepUpDeps,
): Promise<{ sensitiveActionId: string; effectiveAt: string }> {
  if (input.tier === 's1' && input.contactKey === undefined) {
    throw new Error('an S1 beneficiary requires a verified contact key');
  }
  const body =
    input.tier === 's1'
      ? {
          contactId: input.contactId,
          tier: 's1' as const,
          s1EnvelopeCiphertext: sealS1EnvelopeToContact(input.contactKey!),
        }
      : { contactId: input.contactId, tier: input.tier };
  const res = await requestWithStepUp(
    { url: '/v1/contacts/beneficiary', method: 'POST', body },
    deps,
  );
  return apiJson(res);
}

// Owner assigns the S2/S3 contact shares (Checkpoint B): for S2, record the
// reserved release-passphrase slot (create-once; the Q8-deferred capture happened
// just before, in splitAndSealTierShares). Nested S3 (docs/24) has no passphrase
// slot — the passphrase is the XOR mask — so S3 skips that step. Then enqueue one
// step-up add_contact action per sealed contact share. Each enqueue is its own
// step-up-bound request — the step-up signature binds the exact body, so they
// cannot share one proof.
export async function assignTierShares(
  input: {
    tier: 's2' | 's3';
    assignments: Array<{ contactId: string; shareIndex: number; wrappedShareCiphertext: string }>;
  },
  deps: StepUpDeps,
): Promise<Array<{ sensitiveActionId: string; effectiveAt: string }>> {
  if (input.tier === 's2') {
    await apiJson(
      await api('/v1/release/passphrase-slot', {
        method: 'POST',
        body: { tier: 's2' },
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    );
  }
  const results: Array<{ sensitiveActionId: string; effectiveAt: string }> = [];
  for (const a of input.assignments) {
    const res = await requestWithStepUp(
      {
        url: '/v1/contacts/shares',
        method: 'POST',
        body: {
          contactId: a.contactId,
          tier: input.tier,
          shareIndex: a.shareIndex,
          wrappedShareCiphertext: a.wrappedShareCiphertext,
        },
      },
      deps,
    );
    results.push(await apiJson(res));
  }
  return results;
}
