import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origin: string;
  // Extra exact origins a native client may assert from (docs/35 §3). Android's
  // Credential Manager sends `android:apk-key-hash:<base64url(sha256(cert))>`
  // rather than an https origin, so the app's release signing identity has to be
  // named here or every assertion from the phone is rejected. iOS is expected to
  // send the https origin already in `origin` — expected, not observed, so it is
  // verified on a real device rather than assumed (docs/35 §3).
  //
  // Empty/absent is the default and is byte-identical to the single-origin
  // behaviour that predates it: `resolveExpectedOrigin` hands @simplewebauthn
  // the same lone string it always did.
  nativeOrigins?: readonly string[];
}

// One expected-origin value for both verification calls. A `string` when no
// native origin is configured — NOT a one-element array — so the "absent ⇒
// unchanged" property is structural rather than something a reviewer has to
// take on faith.
export function resolveExpectedOrigin(config: WebAuthnConfig): string | string[] {
  const native = config.nativeOrigins ?? [];
  return native.length === 0 ? config.origin : [config.origin, ...native];
}

// ── The verifier DI seam ──────────────────────────────────────────────────────
// The verify step is the one part that needs a real authenticator response,
// which cannot be synthesised server-side. We isolate it behind this port: the
// production adapter (createWebAuthnVerifier) calls @simplewebauthn; tests pass
// a fake so the ORCHESTRATION — atomic challenge consume, sign_count regression,
// session creation, fail-closed paths — is exercised deterministically.
// @simplewebauthn carries its own test suite for the cryptographic verification.

export interface RegistrationOutcome {
  verified: boolean;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
  aaguid: Uint8Array | null;
}

export interface AuthenticationOutcome {
  verified: boolean;
  newCounter: number;
}

export interface WebAuthnVerifier {
  verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<RegistrationOutcome>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: { id: string; publicKey: Uint8Array; counter: number; transports: string[] | null };
  }): Promise<AuthenticationOutcome>;
}

const UNVERIFIED_REGISTRATION: RegistrationOutcome = {
  verified: false,
  credentialId: new Uint8Array(0),
  publicKey: new Uint8Array(0),
  counter: 0,
  transports: null,
  aaguid: null,
};

export function createWebAuthnVerifier(config: WebAuthnConfig): WebAuthnVerifier {
  const expectedOrigin = resolveExpectedOrigin(config);
  return {
    async verifyRegistration({ response, expectedChallenge }) {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: config.rpId,
        requireUserVerification: true,
      });
      if (!result.verified || result.registrationInfo === undefined) return UNVERIFIED_REGISTRATION;
      const { credential, aaguid } = result.registrationInfo;
      return {
        verified: true,
        credentialId: base64urlToBytes(credential.id),
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ? [...credential.transports] : null,
        aaguid: parseAaguid(aaguid),
      };
    },
    async verifyAuthentication({ response, expectedChallenge, credential }) {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: config.rpId,
        requireUserVerification: true,
        credential: {
          id: credential.id,
          // Copy into a fresh ArrayBuffer-backed view: @simplewebauthn's types
          // require Uint8Array<ArrayBuffer>, while DB-loaded bytes are
          // Uint8Array<ArrayBufferLike>.
          publicKey: Uint8Array.from(credential.publicKey),
          counter: credential.counter,
          // exactOptionalPropertyTypes: omit `transports` rather than pass undefined.
          ...(credential.transports !== null
            ? { transports: credential.transports as AuthenticatorTransportFuture[] }
            : {}),
        },
      });
      return { verified: result.verified, newCounter: result.authenticationInfo.newCounter };
    },
  };
}

// Real option generation (no DI needed — deterministic, no verification). Kept
// here so the begin endpoints exercise the real library end-to-end.
export async function generateRegistrationChallenge(
  config: WebAuthnConfig,
  input: {
    userId: string;
    userName: string;
    excludeCredentials?: { id: string; transports: string[] | null }[];
  },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: input.userName,
    userID: Uint8Array.from(Buffer.from(input.userId, 'utf8')),
    attestationType: 'none',
    excludeCredentials: (input.excludeCredentials ?? []).map((c) => ({
      id: c.id,
      ...(c.transports !== null ? { transports: c.transports as AuthenticatorTransportFuture[] } : {}),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
}

export async function generateAuthenticationChallenge(
  config: WebAuthnConfig,
  allowCredentials: { id: string; transports: string[] | null }[] | undefined,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    ...(allowCredentials !== undefined
      ? {
          allowCredentials: allowCredentials.map((c) => ({
            id: c.id,
            ...(c.transports !== null
              ? { transports: c.transports as AuthenticatorTransportFuture[] }
              : {}),
          })),
        }
      : {}),
  });
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function base64urlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function bytesToBase64url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

// The aaguid arrives from @simplewebauthn as a formatted GUID string; store the
// 16 raw bytes (null if it isn't a well-formed GUID).
export function parseAaguid(guid: string): Uint8Array | null {
  const hex = guid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// The clone-detection rule (PHASE3_1 §"(d)" Flow 2 / reviewer requirement). A
// WebAuthn authenticator's signature counter must strictly increase. A counter
// that decreases OR stays flat across assertions signals credential cloning —
// EXCEPT when the authenticator never implements a counter (both stored and
// presented are 0), which is normal for many platform passkeys.
export function isSignCountRegression(storedCount: number, presentedCount: number): boolean {
  if (storedCount === 0 && presentedCount === 0) return false;
  return presentedCount <= storedCount;
}
