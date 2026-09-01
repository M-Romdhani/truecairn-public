import { signStepUp } from '@truecairn/client-crypto';
import { fromBase64Url, toBase64Url } from '@truecairn/crypto';

// The transparent step-up interceptor (PHASE4 C2). It turns the server's
// R1 -> 403 -> sign -> R2 handshake into one awaited call: send the mutating
// request; on a `step-up-required` 403, (optionally) prove a fresh second factor,
// sign the SHARED canonical payload over the EXACT body we will resend
// (signStepUp -> buildStepUpSigningInput, the one builder the server verifies
// against), and retry with the challenge + signature headers. The vault must be
// unlocked (signStepUp uses the in-memory master-key-derived Ed25519 key).

const STEPUP_REQUIRED_TYPE = 'https://truecairn.app/problems/step-up-required';
const CHALLENGE_HEADER = 'x-truecairn-stepup-challenge';
const SIGNATURE_HEADER = 'x-truecairn-stepup-signature';

interface StepUpChallenge {
  challengeId: string;
  challenge: string; // base64url, 32 bytes
  actionType: string;
  secondFactor?: { satisfiedBySession: boolean; accepted: string[]; freshnessWindowSeconds: number };
  expiresAt: string;
}

export interface StepUpDeps {
  userId: string;
  // Prove a fresh second factor (TOTP / passkey) when the server reports the
  // session's is stale. Resolves once it is fresh; the interceptor then retries.
  proveSecondFactor: (accepted: string[]) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface MutatingRequest {
  url: string;
  method?: string;
  body?: unknown;
}

export async function requestWithStepUp(req: MutatingRequest, deps: StepUpDeps): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const method = req.method ?? 'POST';
  const send = (extra: Record<string, string>): Promise<Response> => {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json', ...extra },
      credentials: 'include',
    };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    return doFetch(req.url, init);
  };

  const r1 = await send({});
  if (r1.status !== 403) return r1;
  const problem = (await r1
    .clone()
    .json()
    .catch(() => null)) as ({ type?: string; stepUp?: StepUpChallenge } | null);
  if (problem === null || problem.type !== STEPUP_REQUIRED_TYPE || problem.stepUp === undefined) {
    return r1; // a different 403 (e.g. vault-owner-required) — not ours to retry
  }

  const su = problem.stepUp;
  if (su.secondFactor !== undefined && !su.secondFactor.satisfiedBySession) {
    await deps.proveSecondFactor(su.secondFactor.accepted);
  }

  // Sign over the SAME body the server will canonicalise (request.body ?? {}).
  const challenge = fromBase64Url(su.challenge);
  const signature = signStepUp({
    userId: deps.userId,
    actionType: su.actionType,
    challenge,
    body: req.body ?? {},
  });

  return send({
    [CHALLENGE_HEADER]: su.challengeId,
    [SIGNATURE_HEADER]: toBase64Url(signature),
  });
}
