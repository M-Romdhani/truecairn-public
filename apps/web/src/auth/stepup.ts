import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, apiJson } from '../api/client.js';

// The step-up second factor via passkey (PHASE4 C5A). The app shell passes this as
// the step-up interceptor's `proveSecondFactor`: when a sensitive action's R1
// reports the session's second factor is stale, the user re-taps the passkey they
// ALREADY hold (a WebAuthn assertion with userVerification), which stamps
// last_stepup_at server-side; the interceptor then signs and resends (R2). No TOTP,
// no new factor — this is what makes every step-up gate reachable in the browser
// (it replaces the "second-factor prompt not wired" stub the C3/C4 screens shipped).
//
// The signature matches StepUpDeps.proveSecondFactor — `(accepted: string[]) =>
// Promise<void>`. `accepted` is advisory (the server already scoped the options to
// this session's credentials), so we ignore it and always present the passkey.

// The browser's WebAuthn ceremony can stall without ever settling (QA Pass 2
// Finding A — the same failure class as the Pass 1 sign-in hang). Time-box it so
// a stalled prompt REJECTS into each screen's existing catch → a visible error,
// never a silent forever-pending mutation.
const STEP_UP_CEREMONY_TIMEOUT_MS = 60_000;

export async function proveStepUpWithPasskey(
  _accepted?: string[],
  fetchImpl?: typeof fetch,
): Promise<void> {
  const optRes = await api('/v1/auth/step-up/webauthn/options', {
    method: 'POST',
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const { options, challengeId } = await apiJson<{
    options: PublicKeyCredentialRequestOptionsJSON;
    challengeId: string;
  }>(optRes);
  // @simplewebauthn/browser runs navigator.credentials.get and serialises the
  // assertion in the exact shape @simplewebauthn/server verifies (same contract as
  // loginPasskey), so the client/server WebAuthn handshake holds by construction.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    startAuthentication({ optionsJSON: options }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('step-up passkey prompt timed out')),
        STEP_UP_CEREMONY_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  await apiJson(
    await api('/v1/auth/step-up/second-factor', {
      method: 'POST',
      body: { method: 'webauthn', challengeId, response },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}
