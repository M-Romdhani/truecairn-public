import { buildStepUpSigningInput, generateEnrollmentMaterial, lock, unlock } from '@truecairn/client-crypto';
import { ed25519Verify, fromBase64Url, randomBytes, toBase64Url } from '@truecairn/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { requestWithStepUp } from '../src/api/stepup.js';

// The interceptor signs the SAME canonical bytes the server verifies (PHASE4 C2).
// We exercise it against a mock fetch (403 step-up-required → 202) with a REAL
// unlocked session, then VERIFY the signature it produced against the session's
// audit pubkey using the shared builder — proving byte-for-byte agreement without
// a server, the same interop discipline as C1's crypto.

const STEPUP_REQUIRED_TYPE = 'https://truecairn.app/problems/step-up-required';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

let pubkey: Uint8Array;

beforeAll(() => {
  const { material } = generateEnrollmentMaterial(utf8('pw-interceptor'));
  pubkey = material.auditSigningPubkey;
  unlock(utf8('pw-interceptor'), material);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  lock();
});

function challengeProblem(challenge: Uint8Array, actionType: string, satisfiedBySession: boolean): Response {
  return new Response(
    JSON.stringify({
      type: STEPUP_REQUIRED_TYPE,
      title: 'Step-up authentication required',
      status: 403,
      stepUp: {
        challengeId: 'chal-id-1',
        challenge: toBase64Url(challenge),
        actionType,
        secondFactor: { satisfiedBySession, accepted: ['totp', 'webauthn'], freshnessWindowSeconds: 300 },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }),
    { status: 403, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('step-up interceptor', () => {
  it('signs the canonical payload over the request body and the signature verifies server-side', async () => {
    const challenge = randomBytes(32);
    const body = { recoveryCodeSalt: 'AAAA', masterKeyWrappedByRecovery: 'BBBB', masterKeyRecoveryNonce: 'CCCC' };
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return calls.length === 1
        ? challengeProblem(challenge, 'rotate_recovery_code', /* satisfiedBySession */ true)
        : new Response(JSON.stringify({ sensitiveActionId: 'a', effectiveAt: 'b' }), { status: 202 });
    }) as unknown as typeof fetch;

    const res = await requestWithStepUp(
      { url: '/v1/account/recovery-code/rotate', method: 'POST', body },
      { userId: USER_ID, proveSecondFactor: async () => {}, fetchImpl },
    );

    expect(res.status).toBe(202);
    expect(calls).toHaveLength(2);
    // R1 carried no step-up headers; R2 carried the challenge + signature.
    const r2Headers = calls[1]!.headers as Record<string, string>;
    expect(r2Headers['x-truecairn-stepup-challenge']).toBe('chal-id-1');
    const sig = fromBase64Url(r2Headers['x-truecairn-stepup-signature']!);

    // The signature verifies over the SHARED canonical input for this exact body.
    const expectedInput = buildStepUpSigningInput(USER_ID, 'rotate_recovery_code', challenge, body);
    expect(ed25519Verify(sig, expectedInput, pubkey)).toBe(true);
    // And NOT over a different body (binding).
    const otherInput = buildStepUpSigningInput(USER_ID, 'rotate_recovery_code', challenge, { ...body, masterKeyRecoveryNonce: 'XXXX' });
    expect(ed25519Verify(sig, otherInput, pubkey)).toBe(false);
  });

  it('proves a fresh second factor first when the session lacks one, then retries', async () => {
    const challenge = randomBytes(32);
    const proveSecondFactor = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => challengeProblem(challenge, 'delete_account', false))
      .mockImplementationOnce(async () => challengeProblem(challenge, 'delete_account', false))
      .mockImplementationOnce(async () => new Response('{}', { status: 202 })) as unknown as typeof fetch;

    const res = await requestWithStepUp(
      { url: '/v1/account/delete', method: 'POST', body: {} },
      { userId: USER_ID, proveSecondFactor, fetchImpl },
    );
    expect(res.status).toBe(202);
    expect(proveSecondFactor).toHaveBeenCalledOnce();
  });

  it('passes a non-step-up 403 straight through (does not retry)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ type: 'https://truecairn.app/problems/vault-owner-required', status: 403 }), {
        status: 403,
      }),
    ) as unknown as typeof fetch;
    const res = await requestWithStepUp(
      { url: '/v1/account/recovery-code/rotate', method: 'POST', body: {} },
      { userId: USER_ID, proveSecondFactor: async () => {}, fetchImpl },
    );
    expect(res.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledOnce(); // no retry
  });
});
