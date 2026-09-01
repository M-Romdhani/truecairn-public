import { schema, type Database } from '@truecairn/db';
import { desc } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Audit-key lineage (F-5, raised by the 2026-08-10 restore drill).
//
// The drill proved OUTER_LAYER_KEK by unwrapping a STORED row — a wrong-but-
// well-formed key fails that, which is the whole point. SERVER_AUDIT_SIGNING_KEY
// got no equivalent test, and it turns out it cannot have one by accident,
// because of how the key id is derived:
//
//   resolveServerSigner() reads the env value → decodeServerSigner() derives
//   keyId from the VALUE ITSELF (sha256 of the public half) → registers it with
//   onConflictDoNothing.
//
// So a mis-transcribed key does not fail. It yields a DIFFERENT key id, inserts
// as a NEW registry row, and the service boots clean. Every existing entry keeps
// verifying, because the verifier looks each entry up by ITS OWN key id and
// finds the original public key still registered. Audit-chain verification in
// Settings shows green throughout. In production the boot guard throws only when
// the variable is MISSING, never when it is merely different.
//
// The result is a silent lineage split: new entries signed under a key nobody
// has a paper copy of, indistinguishable from a deliberate rotation.
//
// This module makes that state observable. It is deliberately NOT fatal —
// rotation is legitimate and retired keys must keep verifying, so refusing to
// boot on a lineage change would break the one operation that legitimately
// causes one. The right size is a loud log line at boot plus a visible ops
// check, which is what the callers do with this.
// ---------------------------------------------------------------------------

export type AuditKeyLineage =
  // Nothing has ever been signed here — a fresh deployment. Not a finding.
  | { kind: 'no_entries'; keyId: string }
  // The configured key is the one that signed the most recent entry.
  | { kind: 'current'; keyId: string }
  // The most recent entry was signed under a DIFFERENT key. Either a rotation
  // that has not signed anything yet, or a mis-transcribed / wrongly-seeded
  // secret. The two are indistinguishable from here, and saying so is the point.
  | { kind: 'split'; keyId: string; chainKeyId: string };

// Compare the configured signer against the key that signed the most recent
// audit entry.
//
// Called once per process at boot (resolveServerSigner) and never on a request
// path: `audit_log` has no global timestamp index — only (user_id,
// server_timestamp) — so this ORDER BY is a scan, which is fine once per boot
// and would not be fine on /status. The ops check therefore reports the value
// computed here rather than re-deriving it per request; a signing key cannot
// change under a running process, so a boot-time reading stays accurate for the
// life of that process.
export async function inspectAuditKeyLineage(
  db: Database,
  keyId: string,
): Promise<AuditKeyLineage> {
  const [latest] = await db
    .select({ serverKeyId: schema.auditLog.serverKeyId })
    .from(schema.auditLog)
    .orderBy(desc(schema.auditLog.serverTimestamp))
    .limit(1);

  if (latest === undefined) return { kind: 'no_entries', keyId };
  if (latest.serverKeyId === keyId) return { kind: 'current', keyId };
  return { kind: 'split', keyId, chainKeyId: latest.serverKeyId };
}

// One line describing a lineage, for a log or an ops detail. Key IDs are safe to
// print — they are sha256-derived public identifiers already stored in plaintext
// on every audit row and served by /v1/audit. The SECRET is never touched here:
// this module never reads SERVER_AUDIT_SIGNING_KEY and never accepts it.
export function describeAuditKeyLineage(lineage: AuditKeyLineage): string {
  switch (lineage.kind) {
    case 'no_entries':
      return `signing under ${lineage.keyId}; no audit entries yet, so the key's lineage is not yet provable`;
    case 'current':
      return `signing under ${lineage.keyId}, which signed the most recent audit entry`;
    case 'split':
      return (
        `signing under ${lineage.keyId}, but the most recent audit entry was signed under ` +
        `${lineage.chainKeyId}. Expected after a deliberate rotation; otherwise this deployment ` +
        `is signing under a key that is not the one the chain was built with`
      );
  }
}

// The full set of keys that has ever signed an entry here, oldest-registered
// first. A DISTINCT over `audit_log` with no supporting index, so this is drill
// tooling only (scripts/audit-key-check.ts) — never a boot path and never a
// request path. Realistically one or two rows; the bound is there so a surprise
// cannot turn an operator command into a long scan's worth of output.
export async function auditChainKeyIds(db: Database, limit = 32): Promise<string[]> {
  const rows = await db
    .selectDistinct({ serverKeyId: schema.auditLog.serverKeyId })
    .from(schema.auditLog)
    .limit(limit);
  return rows.map((r) => r.serverKeyId).sort();
}
