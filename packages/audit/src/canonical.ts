// Canonical byte encoding of an audit_log entry.
//
// The encoding is the source of truth for both the hash chain and the
// signatures. Two implementations (e.g. server in TS, future client SDK)
// MUST produce byte-identical output for the same logical entry — otherwise
// signatures over different bytes would fail verification.
//
// Layout (version 1):
//   0x01                                # version byte
//   u64_be(seq)                         # 8 bytes
//   uuid_bytes(user_id)                 # 16 bytes
//   lp(utf8(event_type))                # 4-byte length prefix + bytes
//   lp(canonical_json(event_payload))   # 4-byte length prefix + bytes
//   lp(prev_entry_hash_or_empty)        # 4-byte length prefix + 32 bytes (or 0)
//   u64_be(server_timestamp_unix_micros)
//   lp(utf8(server_key_id))
//   lp(utf8(client_timestamp_iso_or_empty))
//
// entry_hash = SHA-256(canonical(entry))
// server_signature = Ed25519_server(entry_hash)
// user_signature (optional, supplied by client for sensitive events) =
//   Ed25519_user(entry_hash)
//
// Note: user_signature is intentionally NOT part of canonical(entry) so the
// user can sign entry_hash itself, binding their signature to the chain
// position (because seq + prev_entry_hash are inside canonical).

export const CANONICAL_VERSION = 0x01;

export interface CanonicalEntry {
  seq: bigint;
  userId: string; // UUID, hyphenated
  eventType: string;
  eventPayload: unknown; // JSON-serialisable; will be canonical-JSON-encoded
  prevEntryHash: Uint8Array | null;
  serverTimestamp: Date;
  serverKeyId: string;
  clientTimestamp: Date | null;
}

export function canonicalBytes(entry: CanonicalEntry): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(Uint8Array.of(CANONICAL_VERSION));
  parts.push(u64be(entry.seq));
  parts.push(uuidBytes(entry.userId));
  parts.push(lp(utf8(entry.eventType)));
  parts.push(lp(canonicalJson(entry.eventPayload)));
  parts.push(lp(entry.prevEntryHash ?? new Uint8Array(0)));
  parts.push(u64be(BigInt(entry.serverTimestamp.getTime()) * 1000n));
  parts.push(lp(utf8(entry.serverKeyId)));
  parts.push(lp(utf8(entry.clientTimestamp ? entry.clientTimestamp.toISOString() : '')));
  return concat(parts);
}

// ---------------------------------------------------------------------------
// Step-up signing input (PHASE3_4 §c). A SEPARATE domain-tagged payload the
// client signs with its master-key-derived Ed25519 key to authorise a sensitive
// action; the server (requireStepUp) verifies it against
// user_key_material.audit_signing_pubkey. It reuses the exact lp / uuid16 /
// canonicalJson encoding above so the CLIENT and SERVER produce byte-identical
// input — this builder is the SINGLE source of truth for both sides, so they
// cannot drift. It lives here (canonical.ts is pure — no node deps) so the
// browser imports it via the `@truecairn/audit/canonical` subpath without
// pulling the node:crypto-backed audit barrel (PHASE4 C2).
//
//   0x01 || lp(utf8(domain)) || uuid16(userId) || lp(utf8(actionType))
//        || challenge(32) || lp(canonicalJson(actionParams))
export const STEPUP_SIGNING_DOMAIN = 'truecairn.stepup.v1';

export function buildStepUpSigningInput(
  userId: string,
  actionType: string,
  challenge: Uint8Array,
  actionParams: unknown,
): Uint8Array {
  return concat([
    Uint8Array.of(0x01),
    lp(utf8(STEPUP_SIGNING_DOMAIN)),
    uuidBytes(userId),
    lp(utf8(actionType)),
    challenge,
    lp(canonicalJson(actionParams)),
  ]);
}

// ---------------------------------------------------------------------------
// Canonical JSON (a strict subset of RFC 8785). Sufficient for our payloads,
// which are flat object/array/string/number/boolean/null structures. Rejects
// values we will not store in audit payloads to keep the encoding strict.
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): Uint8Array {
  return utf8(serialize(value));
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'string') return encodeString(v);
  if (typeof v === 'number') return encodeNumber(v);
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) {
    return '[' + v.map(serialize).join(',') + ']';
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys
        .map((k) => {
          const val = obj[k];
          if (val === undefined) return null; // skip undefined fields
          return encodeString(k) + ':' + serialize(val);
        })
        .filter((s): s is string => s !== null)
        .join(',') +
      '}'
    );
  }
  throw new Error(`canonicalJson: unsupported value type: ${typeof v}`);
}

function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error('canonicalJson: non-finite number');
  }
  if (Number.isInteger(n)) return n.toString();
  // Floats are dangerous in canonical encodings (representation varies). We
  // reject them entirely — audit payloads should never contain floats.
  throw new Error('canonicalJson: floats are not allowed in audit payloads');
}

function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x22) out += '\\"';
    else if (cp === 0x5c) out += '\\\\';
    else if (cp === 0x08) out += '\\b';
    else if (cp === 0x0c) out += '\\f';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x0d) out += '\\r';
    else if (cp === 0x09) out += '\\t';
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += ch;
  }
  out += '"';
  return out;
}

// ---------------------------------------------------------------------------
// Byte-fiddling helpers
// ---------------------------------------------------------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function u64be(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, n, false);
  return buf;
}

function u32be(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

// Exported so other domain signatures (e.g. the API's step-up payload) reuse
// the exact same length-prefix and uuid16 encoding rather than re-deriving it.
export function lp(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out.set(u32be(payload.length), 0);
  out.set(payload, 4);
  return out;
}

export function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`invalid uuid: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
