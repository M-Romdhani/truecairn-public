import { CONTACT_PIN_VERSION_V1_S1_TIER_KEY } from '@truecairn/keys';
import { api, apiJson } from '../api/client.js';
import { listContacts, type ContactRow } from './api.js';
import { decryptContactLabel, encryptContactLabel } from './crypto.js';
import { rewrapKeyPin } from './key-pin.js';

// ── F1 + F2 backfill: move pre-0068 contact metadata off the S1 tier key ──────
//
// Migration 0068 moved labels and pins to a master-derived key for rows written
// AFTER it. Rows written before are still v1, still under the S1 tier key, and
// so still readable by an S1 beneficiary the moment a release completes — for
// every contact, including S2/S3-only ones. This closes that.
//
// It runs on the CLIENT because only the client can: reading a v1 row needs the
// S1 tier key and writing v2 needs the master key. The server holds neither, so
// it can only accept bytes it could not have produced (see the route's own
// comment for the four states it refuses).
//
// Opportunistic on unlock, per PLAN-v1-launch.md §1.2: no forced
// re-confirmation, no migration screen, no blocking. An owner who never unlocks
// again keeps a v1 row, and that is the honest trade — the alternative is
// re-asking them to compare a safety number they already compared, which trains
// people to click through `tampered`.

export interface RekeyOutcome {
  // Rows the server moved to v2.
  rekeyed: number;
  // Rows left alone because their pin would not open. NOT a failure of this
  // sweep: an unopenable pin is already `tampered`, and rewriting one we cannot
  // read would launder it into a fresh-looking v2 row. They keep showing the
  // alarm at their old version.
  skippedUnreadable: number;
}

export async function rekeyLegacyContactMetadata(
  userId: string,
  fetchImpl?: typeof fetch,
): Promise<RekeyOutcome> {
  const { contacts } = await listContacts(fetchImpl);
  const legacy = contacts.filter(
    (c) => (c.contactPinVersion ?? CONTACT_PIN_VERSION_V1_S1_TIER_KEY) === CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
  );
  if (legacy.length === 0) return { rekeyed: 0, skippedUnreadable: 0 };

  const payload: Array<{
    contactId: string;
    displayLabelCiphertext: string;
    displayLabelNonce: string;
    keyPinCiphertext?: string;
    keyPinNonce?: string;
  }> = [];
  let skippedUnreadable = 0;

  for (const c of legacy) {
    const rewritten = rewriteOne(userId, c);
    if (rewritten === null) {
      skippedUnreadable += 1;
      continue;
    }
    payload.push(rewritten);
  }
  if (payload.length === 0) return { rekeyed: 0, skippedUnreadable };

  const res = await api('/v1/contacts/metadata-rekey', {
    method: 'POST',
    body: { contacts: payload },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const { rekeyed } = await apiJson<{ rekeyed: number }>(res);
  return { rekeyed, skippedUnreadable };
}

// One row, or null if any part of it cannot be honestly rewritten.
//
// The label and the pin move together or not at all: one column versions both,
// so sending half would produce a row whose version is a lie about the other
// half. The route rejects that too — this is the client not asking for it.
function rewriteOne(
  userId: string,
  c: ContactRow,
): {
  contactId: string;
  displayLabelCiphertext: string;
  displayLabelNonce: string;
  keyPinCiphertext?: string;
  keyPinNonce?: string;
} | null {
  let label: string;
  try {
    label = decryptContactLabel(
      c.displayLabelCiphertext,
      c.displayLabelNonce,
      CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
    );
  } catch {
    return null;
  }
  const relabelled = encryptContactLabel(label);

  const hasPin = c.keyPinCiphertext !== null && c.keyPinNonce !== null;
  if (!hasPin) {
    return {
      contactId: c.contactId,
      displayLabelCiphertext: relabelled.displayLabelCiphertext,
      displayLabelNonce: relabelled.displayLabelNonce,
    };
  }

  const pin = rewrapKeyPin({
    userId,
    contactId: c.contactId,
    fromVersion: CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
    keyPinCiphertext: c.keyPinCiphertext!,
    keyPinNonce: c.keyPinNonce!,
  });
  if (pin === null) return null;

  return {
    contactId: c.contactId,
    displayLabelCiphertext: relabelled.displayLabelCiphertext,
    displayLabelNonce: relabelled.displayLabelNonce,
    keyPinCiphertext: pin.keyPinCiphertext,
    keyPinNonce: pin.keyPinNonce,
  };
}
