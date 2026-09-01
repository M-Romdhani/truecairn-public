import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { REQUEST_TIMEOUT_MS, STALE_UPLOAD_CLAIM_MS } from './upload-windows.js';

// 2026-08-08 re-audit, N-2. The upload claim's safety argument is a relationship
// between two numbers, and both halves of it were broken: nothing capped request
// DURATION at all, and the stale window was a hand-picked constant with a comment
// asserting a bound that bodyLimit (a SIZE cap) does not provide.

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp({ ...loadConfig({}), logLevel: 'silent' });
});
afterEach(async () => {
  await app.close();
});

describe('upload windows', () => {
  it('a claim can only go stale after the request holding it is provably dead', () => {
    // THE invariant. If this ever inverts, two live requests can hold the same
    // upload slot and interleave into one blob — undetectable corruption of
    // opaque ciphertext, discovered by a beneficiary years later.
    expect(STALE_UPLOAD_CLAIM_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });

  it('the server actually enforces a request-arrival timeout', () => {
    // Fastify defaults requestTimeout to 0 and then assigns
    // `server.requestTimeout = 0` unconditionally, which DISABLES Node's own
    // 300s default. So an unset option is not "Node's default applies", it is
    // "no timeout at all" — which is what made the takeover window reachable.
    expect(app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(app.server.requestTimeout).toBeGreaterThan(0);
  });
});
