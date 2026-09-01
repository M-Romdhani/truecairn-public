import { schema, type Database } from '@truecairn/db';
import type { UserId } from '@truecairn/shared';
import { asc, eq } from 'drizzle-orm';
import type { CanonicalEntry } from './canonical.js';
import { bytesEqual, entryHash } from './hash.js';
import { loadPublicKey, verifyServerSignature, verifyUserSignature } from './keys.js';

export type VerificationResult =
  | { ok: true; entriesChecked: number }
  | { ok: false; failureSeq: bigint; reason: VerificationFailure };

export type VerificationFailure =
  | 'seq_out_of_order'
  | 'prev_hash_mismatch'
  | 'entry_hash_mismatch'
  | 'server_key_unknown'
  | 'server_signature_invalid'
  | 'user_signature_invalid';

export interface VerifyOptions {
  userPublicKey?: Uint8Array;
}

// Walk the user's audit chain and verify every entry's hash + signatures.
// Returns the first failure if any. The chain is read in seq order; the per-
// user (user_id, seq) unique index means there's a single ordering.
export async function verifyChain(
  db: Database,
  userId: UserId,
  opts: VerifyOptions = {},
): Promise<VerificationResult> {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.userId, userId))
    .orderBy(asc(schema.auditLog.seq));

  let expectedSeq = 1n;
  let expectedPrevHash: Uint8Array | null = null;
  const publicKeyCache = new Map<string, Uint8Array>();

  for (const r of rows) {
    if (r.seq !== expectedSeq) {
      return { ok: false, failureSeq: r.seq, reason: 'seq_out_of_order' };
    }
    const prev = r.prevEntryHash;
    if (expectedPrevHash === null) {
      if (prev !== null) {
        return { ok: false, failureSeq: r.seq, reason: 'prev_hash_mismatch' };
      }
    } else {
      if (prev === null || !bytesEqual(prev, expectedPrevHash)) {
        return { ok: false, failureSeq: r.seq, reason: 'prev_hash_mismatch' };
      }
    }

    const canonical: CanonicalEntry = {
      seq: r.seq,
      userId: r.userId,
      eventType: r.eventType,
      eventPayload: r.eventPayload,
      prevEntryHash: prev,
      serverTimestamp: r.serverTimestamp,
      serverKeyId: r.serverKeyId,
      clientTimestamp: r.clientTimestamp,
    };
    const recomputed = entryHash(canonical);
    if (!bytesEqual(recomputed, r.entryHash)) {
      return { ok: false, failureSeq: r.seq, reason: 'entry_hash_mismatch' };
    }

    let serverPub = publicKeyCache.get(r.serverKeyId);
    if (!serverPub) {
      const loaded = await loadPublicKey(db, r.serverKeyId);
      if (!loaded) {
        return { ok: false, failureSeq: r.seq, reason: 'server_key_unknown' };
      }
      serverPub = loaded;
      publicKeyCache.set(r.serverKeyId, serverPub);
    }
    if (!verifyServerSignature(serverPub, recomputed, r.serverSignature)) {
      return { ok: false, failureSeq: r.seq, reason: 'server_signature_invalid' };
    }

    if (r.userSignature) {
      if (!opts.userPublicKey) {
        return { ok: false, failureSeq: r.seq, reason: 'user_signature_invalid' };
      }
      if (!verifyUserSignature(opts.userPublicKey, recomputed, r.userSignature)) {
        return { ok: false, failureSeq: r.seq, reason: 'user_signature_invalid' };
      }
    }

    expectedPrevHash = recomputed;
    expectedSeq = r.seq + 1n;
  }

  return { ok: true, entriesChecked: rows.length };
}

// verifyChain with the user's own audit-signing public key resolved for them.
//
// Entries carrying a user_signature can ONLY be verified against that key, and
// verifyChain treats a missing key as a failure — so every caller must load it
// or get spurious 'user_signature_invalid'. Both callers (the owner-facing
// /v1/account/audit/verify route and the worker's periodic sweep) go through
// here so they ask a byte-identical question; a drift between them would mean
// the alert and the owner's own view could disagree about their chain.
export async function verifyChainForUser(
  db: Database,
  userId: UserId,
): Promise<{ ok: true; entriesChecked: number } | { ok: false; failureSeq: number; reason: VerificationFailure }> {
  const [km] = await db
    .select({ pub: schema.userKeyMaterial.auditSigningPubkey })
    .from(schema.userKeyMaterial)
    .where(eq(schema.userKeyMaterial.userId, userId))
    .limit(1);

  const result = await verifyChain(db, userId, km?.pub ? { userPublicKey: km.pub } : {});
  return result.ok
    ? { ok: true, entriesChecked: result.entriesChecked }
    : { ok: false, failureSeq: Number(result.failureSeq), reason: result.reason };
}
