import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, apiJson } from '../api/client.js';

// Passkey register + login (PHASE3_1 Flows 1-2, wired to the UI in PHASE4 C2).
// @simplewebauthn/browser runs the WebAuthn ceremony (navigator.credentials.*)
// and serialises the response in the exact shape @simplewebauthn/server@13
// verifies — so the client/server WebAuthn contract holds by construction, the
// same way client-crypto holds the crypto contract. Registration creates the
// account + first passkey (no session); login sets the session cookie.

export async function registerPasskey(email: string, fetchImpl?: typeof fetch): Promise<void> {
  const optRes = await api('/v1/auth/register/options', {
    method: 'POST',
    body: { email },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const { options, challengeId } = await apiJson<{
    options: PublicKeyCredentialCreationOptionsJSON;
    challengeId: string;
  }>(optRes);
  const response = await startRegistration({ optionsJSON: options });
  await apiJson(
    await api('/v1/auth/register/verify', {
      method: 'POST',
      body: { challengeId, response },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function loginPasskey(email: string, fetchImpl?: typeof fetch): Promise<string> {
  const optRes = await api('/v1/auth/login/options', {
    method: 'POST',
    body: { email },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  const { options, challengeId } = await apiJson<{
    options: PublicKeyCredentialRequestOptionsJSON;
    challengeId: string;
  }>(optRes);
  const response = await startAuthentication({ optionsJSON: options });
  const { userId } = await apiJson<{ userId: string }>(
    await api('/v1/auth/login/verify', {
      method: 'POST',
      body: { challengeId, response },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
  return userId;
}
