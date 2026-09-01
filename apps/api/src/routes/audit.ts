import { loadPublicKey, verifyChainForUser } from '@truecairn/audit';
import { schema, type Database } from '@truecairn/db';
import { and, asc, eq, gte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/session.js';
import { unauthorized } from '../errors.js';

// ── The owner's audit chain (2026-07-25) ─────────────────────────────────────
//
// Until now the hash-linked, server-signed audit chain was WRITE-ONLY: there was
// no audit route of any kind, and `verifyChain` had no production caller — it
// existed solely in tests. A tamper-evident log that nobody can read or check
// provides no tamper-evidence; it only pays off when someone looks.
//
// Two routes, and the difference between them matters:
//
//   GET /v1/account/audit        — the owner's own chain, including every field
//     needed to verify it INDEPENDENTLY (canonical inputs, entry hashes,
//     signatures, and the server public keys the page references). This is the
//     one that carries the real guarantee, because the verification happens on
//     the owner's device, not here.
//
//   GET /v1/account/audit/verify — the SERVER checking its own chain. Be honest
//     about what this is worth: it detects corruption, partial writes and bugs,
//     and it is what the worker sweep alerts on. It is NOT a defence against a
//     malicious server — a server that rewrote history would also rewrite this
//     answer. It is offered as a fast operational signal, and the response says
//     so in `assurance` so no UI can quietly overstate it.
//
// Both are strictly owner-scoped (every query filters on the session's user id).
// The payloads are the owner's own metadata: by CLAUDE.md invariant 1 no
// plaintext, passphrase, key or share is ever written to an audit payload, so
// returning them to the owner who caused them discloses nothing the server did
// not already hold.

const MAX_PAGE = 500;
const DEFAULT_PAGE = 100;

const b64 = (b: Uint8Array | null): string | null =>
  b === null ? null : Buffer.from(b).toString('base64');

export function auditRoutes(app: FastifyInstance, db: Database): void {
  // ── Read the owner's chain (verifiable page) ────────────────────────────────
  app.get(
    '/v1/account/audit',
    {
      preHandler: [requireSession],
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            fromSeq: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE },
          },
        },
      },
    },
    async (request) => {
      const session = request.session;
      if (session === null) throw unauthorized('no session');
      const q = request.query as { fromSeq?: number; limit?: number };
      const fromSeq = BigInt(q.fromSeq ?? 1);
      const limit = q.limit ?? DEFAULT_PAGE;

      // Ascending from the cursor: verification is a walk, so the natural read
      // order is the order the chain is checked in.
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.userId, session.userId), gte(schema.auditLog.seq, fromSeq)))
        .orderBy(asc(schema.auditLog.seq))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const nextFromSeq = rows.length > limit ? page[page.length - 1]!.seq + 1n : null;

      // The public keys this page references, so a client can verify without a
      // second round trip and without trusting a key we didn't actually sign under.
      const keyIds = [...new Set(page.map((r) => r.serverKeyId))];
      const serverKeys: Record<string, string> = {};
      for (const keyId of keyIds) {
        const pub = await loadPublicKey(db, keyId);
        if (pub !== null) serverKeys[keyId] = Buffer.from(pub).toString('base64');
      }

      return {
        entries: page.map((r) => ({
          // The canonical inputs, in the exact shape canonicalBytes() expects —
          // the browser rebuilds the signed bytes from these and nothing else.
          seq: Number(r.seq),
          userId: r.userId,
          eventType: r.eventType,
          eventPayload: r.eventPayload,
          prevEntryHash: b64(r.prevEntryHash),
          serverTimestamp: r.serverTimestamp.toISOString(),
          serverKeyId: r.serverKeyId,
          clientTimestamp: r.clientTimestamp?.toISOString() ?? null,
          // The claims being checked.
          entryHash: b64(r.entryHash),
          serverSignature: b64(r.serverSignature),
          userSignature: b64(r.userSignature),
          // Forensic metadata, deliberately OUTSIDE the signed canonical entry
          // (migration 0035) — surfaced so the owner can see AI-caused entries.
          actor: r.actor,
        })),
        serverKeys,
        nextFromSeq: nextFromSeq === null ? null : Number(nextFromSeq),
      };
    },
  );

  // ── Server-side chain verification (operational signal) ─────────────────────
  app.get('/v1/account/audit/verify', { preHandler: [requireSession] }, async (request) => {
    const session = request.session;
    if (session === null) throw unauthorized('no session');
    const result = await verifyChainForUser(db, session.userId);
    return {
      ...result,
      // Named, not buried in prose: this answer comes from the same server that
      // wrote the entries. The owner-device verification is the real check.
      assurance: 'server_asserted',
    };
  });
}

// verifyChainForUser lives in @truecairn/audit so this route and the worker's
// periodic sweep ask a byte-identical question — see the note there.
