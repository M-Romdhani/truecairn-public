import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  generateEnrollmentMaterial,
  lock,
  unlock,
  withTierKey,
  type KeyMaterial,
} from '@truecairn/client-crypto';
import {
  ed25519Verify,
  fromBase64,
  randomBytes,
  sealedBoxDecrypt,
  sealedBoxEncrypt,
  toBase64,
  toBase64Url,
  x25519KeypairFromSeed,
} from '@truecairn/crypto';
import { useEffect, useState, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assignS1Share, enrollAsContact, type ContactRow } from '../src/contacts/api.js';
import { encryptContactLabel } from '../src/contacts/crypto.js';
import { requireVerifiedContactKey, sealKeyPin } from '../src/contacts/key-pin.js';
import { SessionProvider, useSession } from '../src/crypto/session.js';
import { Contacts } from '../src/screens/contacts/Contacts.js';

const PASS = 'contacts-test-passphrase';
const USER_ID = '11111111-2222-3333-4444-555555555555';
const CONTACT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// 32 zero bytes, base64url, unpadded — a valid step-up challenge shape.
const CHALLENGE_B64URL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Build a contact row carrying the owner's confirmation of these exact keys,
// then mint the sealing token through the real gate. Tests go the long way round
// deliberately: a cast would let a future change break the gate while every test
// still passed. Requires an unlocked vault (the pin is sealed under the row's
// contact-metadata key).
function verifiedContactKey(
  contactId: string,
  x25519Pubkey: Uint8Array,
  ed25519Pubkey: Uint8Array,
): ReturnType<typeof requireVerifiedContactKey> {
  return requireVerifiedContactKey(USER_ID, contactRow(contactId, x25519Pubkey, ed25519Pubkey));
}

function contactRow(
  contactId: string,
  x25519Pubkey: Uint8Array,
  ed25519Pubkey: Uint8Array,
): ContactRow {
  // encryptContactLabel always writes v2, so the ROW must declare v2 too — the
  // label and the pin on one row are always the same version, and a row that
  // claims v1 while holding v2 ciphertext reads as `tampered`, which is the
  // versioning behaving correctly rather than a fixture detail to paper over.
  const label = encryptContactLabel('test contact');
  const pin = sealKeyPin({
    userId: USER_ID,
    contactId,
    x25519Pubkey: toBase64(x25519Pubkey),
    ed25519Pubkey: toBase64(ed25519Pubkey),
    contactPinVersion: 2,
  });
  return {
    contactId,
    role: 'personal',
    status: 'enrolled',
    displayLabelCiphertext: label.displayLabelCiphertext,
    displayLabelNonce: label.displayLabelNonce,
    x25519Pubkey: toBase64(x25519Pubkey),
    ed25519Pubkey: toBase64(ed25519Pubkey),
    keyPinCiphertext: pin.keyPinCiphertext,
    keyPinNonce: pin.keyPinNonce,
    keyPinConfirmedAt: new Date().toISOString(),
    contactPinVersion: label.contactPinVersion,
  };
}

let material: KeyMaterial;
beforeAll(() => {
  material = generateEnrollmentMaterial(utf8(PASS)).material;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => lock());

// ── PROPERTY #2: enrolment possession proof ──────────────────────────────────
// The client must produce proofs the SERVER accepts. The mock here performs the
// EXACT two checks finishEnroll does (apps/api/src/contacts/enroll.ts), with real
// crypto: (1) the Ed25519 signature verifies against the submitted affirmation
// pubkey over the issued challenge; (2) the returned nonce equals the one we
// sealed to the submitted X25519 pubkey — provable only by holding the secret key.
describe('contact enrolment possession proof (PHASE4 C4 property #2)', () => {
  it('produces an Ed25519 signature + an X25519 unseal the server accepts', async () => {
    unlock(utf8(PASS), material); // the contact-affirmation keys derive from the master key
    let edPub!: Uint8Array;
    let edChallenge!: Uint8Array;
    let xNonce!: Uint8Array;
    let signatureAccepted = false;
    let nonceAccepted = false;

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      if (u.endsWith('/v1/contacts/enroll/options')) {
        // The contact submitted its PUBLIC halves; stage them + issue challenges.
        const xPub = fromBase64(body['x25519Pubkey']!);
        edPub = fromBase64(body['ed25519Pubkey']!);
        edChallenge = randomBytes(32);
        xNonce = randomBytes(32);
        const sealed = sealedBoxEncrypt({ recipientPublicKey: xPub, plaintext: xNonce });
        return json({
          ed25519ChallengeId: 'ed-1',
          ed25519Challenge: toBase64Url(edChallenge),
          x25519ChallengeId: 'x-1',
          x25519SealedNonce: toBase64Url(sealed),
        });
      }
      if (u.endsWith('/v1/contacts/enroll/verify')) {
        const signature = fromBase64(body['ed25519Signature']!);
        const nonceBack = fromBase64(body['x25519Nonce']!);
        signatureAccepted = ed25519Verify(signature, edChallenge, edPub);
        nonceAccepted = nonceBack.length === xNonce.length && toBase64(nonceBack) === toBase64(xNonce);
        if (!signatureAccepted || !nonceAccepted) return json({ title: 'reject' }, 400);
        return json({ enrolled: true });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    await enrollAsContact(CONTACT_ID, fetchImpl);

    // BOTH possession proofs checked out — the server would mark the contact enrolled.
    expect(signatureAccepted).toBe(true);
    expect(nonceAccepted).toBe(true);
    lock();
  });
});

// ── PROPERTY #1: share-wrap zero-knowledge ───────────────────────────────────
// The raw S1 tier key must NEVER appear in the request body. What leaves the
// browser is the tier key SEALED to the contact's X25519 pubkey — a box the
// server cannot open. We prove both: the raw key's bytes are absent, and the
// sealed envelope decrypts (with the contact's secret key) back to that key.
describe('contact share-wrap zero-knowledge (PHASE4 C4 property #1)', () => {
  it('ships only the sealed envelope — the raw S1 tier key never appears in the body', async () => {
    unlock(utf8(PASS), material);
    const recipient = x25519KeypairFromSeed(randomBytes(32)); // the test-controlled contact
    const tierKeyB64 = withTierKey('s1', (k) => toBase64(k)); // the secret that must NOT leak

    let sentBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = init.body as string;
      return json({ sensitiveActionId: 'sa1', effectiveAt: new Date().toISOString() }, 202);
    }) as unknown as typeof fetch;

    await assignS1Share(
      {
        contactKey: verifiedContactKey(CONTACT_ID, recipient.publicKey, randomBytes(32)),
      },
      { userId: USER_ID, proveSecondFactor: async () => {}, fetchImpl },
    );

    expect(sentBody).toBeDefined();
    // The raw S1 tier key is NOWHERE in the request body.
    expect(sentBody!).not.toContain(tierKeyB64);
    const parsed = JSON.parse(sentBody!) as { s1EnvelopeCiphertext?: string };
    // What IS sent is the sealed envelope — and it round-trips to the S1 tier key.
    expect(parsed.s1EnvelopeCiphertext).toBeTruthy();
    const opened = sealedBoxDecrypt({
      recipientPublicKey: recipient.publicKey,
      recipientSecretKey: recipient.secretKey,
      ciphertext: fromBase64(parsed.s1EnvelopeCiphertext!),
    });
    expect(toBase64(opened)).toBe(tierKeyB64);
    lock();
  });
});

// ── PROPERTY #3 + the non-enrolled client-side block ─────────────────────────
function Unlocked({ children }: { children: ReactNode }): JSX.Element | null {
  const s = useSession();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    s.unlock(utf8(PASS), material, USER_ID);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ready ? <>{children}</> : null;
}

function renderContacts(fetchImpl: typeof fetch): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SessionProvider>
        <Unlocked>
          <Contacts fetchImpl={fetchImpl} proveSecondFactor={async () => {}} />
        </Unlocked>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('contact share-assignment UX honesty (PHASE4 C4 property #3)', () => {
  it('routes the assignment through step-up and surfaces the PENDING state (never "armed")', async () => {
    // Encrypt the label under the SAME s1 tier key the screen will decrypt with.
    unlock(utf8(PASS), material);
    const labelEnc = encryptContactLabel('Mum');
    const contactPubkey = toBase64(x25519KeypairFromSeed(randomBytes(32)).publicKey);
    const contactEdPubkey = toBase64(randomBytes(32));
    // The owner already compared this contact's security code out of band — the
    // screen only offers "Assign S1 share" once that has happened.
    const pin = sealKeyPin({
      userId: USER_ID,
      contactId: CONTACT_ID,
      x25519Pubkey: contactPubkey,
      ed25519Pubkey: contactEdPubkey,
      contactPinVersion: 2,
    });
    lock(); // the React Unlocked wrapper re-unlocks with a userId

    const effectiveAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    const listResponse = {
      contacts: [
        {
          contactId: CONTACT_ID,
          role: 'personal',
          status: 'enrolled',
          ...labelEnc,
          x25519Pubkey: contactPubkey,
          ed25519Pubkey: contactEdPubkey,
          ...pin,
          keyPinConfirmedAt: new Date().toISOString(),
        },
      ],
    };
    let sharePosts = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      const method = (init.method ?? 'GET').toUpperCase();
      if (u.endsWith('/v1/contacts') && method === 'GET') return json(listResponse);
      if (u.endsWith('/v1/contacts/shares')) {
        sharePosts += 1;
        const headers = (init.headers ?? {}) as Record<string, string>;
        if (headers['x-truecairn-stepup-signature'] === undefined) {
          // R1: demand step-up (the second factor is already fresh on the session).
          return json(
            {
              type: 'https://truecairn.app/problems/step-up-required',
              title: 'Step-up required',
              status: 403,
              stepUp: {
                challengeId: 'ch1',
                challenge: CHALLENGE_B64URL,
                actionType: 'add_contact',
                secondFactor: { satisfiedBySession: true, accepted: ['totp'], freshnessWindowSeconds: 600 },
                expiresAt: effectiveAt,
              },
            },
            403,
          );
        }
        // R2: signed → enqueued (202), pending for 7 days.
        return json({ sensitiveActionId: 'sa1', effectiveAt }, 202);
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderContacts(fetchImpl);

    // The decrypted label renders in the contact list AND the B share-holders
    // picker — both are legitimate, so assert at-least-one rather than exactly-one.
    await waitFor(() => expect(screen.getAllByText(/Mum/).length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole('button', { name: 'Assign S1 share' }));

    // The pending banner appears and is honest about the 7-day cancellable window.
    await waitFor(() => expect(screen.getByTestId(`pending-${CONTACT_ID}`)).toBeInTheDocument());
    expect(screen.getByTestId(`pending-${CONTACT_ID}`)).toHaveTextContent(/pending/i);
    expect(screen.getByTestId(`pending-${CONTACT_ID}`)).toHaveTextContent(/cancellable for 7 days/i);
    // It went through the R1→R2 step-up handshake (two POSTs to the shares endpoint).
    expect(sharePosts).toBe(2);
    lock();
  });

  // The gate at the affordance, not just in the crypto. An ENROLLED contact
  // whose security code the owner has not compared out of band gets no assign
  // button at all — the server proved possession to itself, which says nothing
  // about whose key this is.
  it('does NOT offer a share for an enrolled but UNCONFIRMED contact', async () => {
    unlock(utf8(PASS), material);
    const labelEnc = encryptContactLabel('Unconfirmed Uncle');
    const contactPubkey = toBase64(x25519KeypairFromSeed(randomBytes(32)).publicKey);
    lock();
    const listResponse = {
      contacts: [
        {
          contactId: CONTACT_ID,
          role: 'personal',
          status: 'enrolled',
          ...labelEnc,
          x25519Pubkey: contactPubkey,
          ed25519Pubkey: toBase64(randomBytes(32)),
          keyPinCiphertext: null,
          keyPinNonce: null,
          keyPinConfirmedAt: null,
        },
      ],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/contacts')) return json(listResponse);
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    renderContacts(fetchImpl);

    await waitFor(() => expect(screen.getAllByText(/Unconfirmed Uncle/).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Assign S1 share' })).toBeNull();
    expect(screen.getByTestId(`key-unverified-${CONTACT_ID}`)).toBeInTheDocument();
    // The way forward is offered, and it is the out-of-band comparison.
    expect(screen.getByTestId(`security-code-${CONTACT_ID}`)).toBeInTheDocument();
    lock();
  });

  // A key that changed after confirmation is an ALARM, not a prompt to redo a
  // chore: contact keys derive from the contact's master key, so they move only
  // on a rotation, which already arrives as a notice 7 days ahead.
  it('flags a SUBSTITUTED key as changed and withholds the share affordance', async () => {
    unlock(utf8(PASS), material);
    const labelEnc = encryptContactLabel('Substituted Sam');
    const realPubkey = toBase64(x25519KeypairFromSeed(randomBytes(32)).publicKey);
    const edPubkey = toBase64(randomBytes(32));
    // Confirmed against the REAL key…
    const pin = sealKeyPin({
      userId: USER_ID,
      contactId: CONTACT_ID,
      x25519Pubkey: realPubkey,
      ed25519Pubkey: edPubkey,
      contactPinVersion: 2,
    });
    lock();
    // …but the server now serves a different one.
    const attackerPubkey = toBase64(x25519KeypairFromSeed(randomBytes(32)).publicKey);
    const listResponse = {
      contacts: [
        {
          contactId: CONTACT_ID,
          role: 'personal',
          status: 'enrolled',
          ...labelEnc,
          x25519Pubkey: attackerPubkey,
          ed25519Pubkey: edPubkey,
          ...pin,
          keyPinConfirmedAt: new Date().toISOString(),
        },
      ],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/contacts')) return json(listResponse);
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    renderContacts(fetchImpl);

    await waitFor(() => expect(screen.getAllByText(/Substituted Sam/).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Assign S1 share' })).toBeNull();
    const badge = screen.getByTestId(`key-changed-${CONTACT_ID}`);
    expect(badge).toBeInTheDocument();
    // It announces itself rather than waiting to be noticed.
    expect(badge).toHaveAttribute('role', 'alert');
    lock();
  });

  it('does NOT offer a share for a non-enrolled contact — blocked client-side', async () => {
    unlock(utf8(PASS), material);
    const labelEnc = encryptContactLabel('Pending Pal');
    lock();
    // pending_keygen → the server withholds the pubkey (null), so the UI can only
    // ever seal to a VERIFIED key. The "Assign S1 share" affordance must be absent.
    const listResponse = {
      contacts: [
        { contactId: CONTACT_ID, role: 'personal', status: 'pending_keygen', ...labelEnc, x25519Pubkey: null },
      ],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/contacts')) return json(listResponse);
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    renderContacts(fetchImpl);

    await waitFor(() => expect(screen.getByText(/Pending Pal/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Assign S1 share' })).toBeNull();
    expect(screen.getByTestId(`awaiting-${CONTACT_ID}`)).toBeInTheDocument();
    lock();
  });

  // A not-yet-enrolled invite (no share affordance) DOES offer a Cancel control —
  // the audit follow-up: a way to delete a pending contact. Session-only POST.
  it('offers Cancel invite on a not-yet-enrolled contact and POSTs the cancellation', async () => {
    unlock(utf8(PASS), material);
    const labelEnc = encryptContactLabel('Junk Invite');
    lock();
    let cancelled = false;
    let cancelPosts = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (u.endsWith('/v1/contacts/cancel-invite') && method === 'POST') {
        cancelPosts += 1;
        expect(JSON.parse(String(init.body))).toEqual({ contactId: CONTACT_ID });
        cancelled = true;
        return json({ cancelled: true });
      }
      if (u.endsWith('/v1/contacts')) {
        return json({
          contacts: cancelled
            ? []
            : [
                {
                  contactId: CONTACT_ID,
                  role: 'personal',
                  status: 'pending_keygen',
                  ...labelEnc,
                  x25519Pubkey: null,
                },
              ],
        });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderContacts(fetchImpl);

    await waitFor(() => expect(screen.getByText(/Junk Invite/)).toBeInTheDocument());
    // No share affordance (not enrolled), but a Cancel invite control IS offered.
    expect(screen.queryByRole('button', { name: 'Assign S1 share' })).toBeNull();
    await userEvent.click(screen.getByTestId(`cancel-invite-${CONTACT_ID}`));

    await waitFor(() => expect(cancelPosts).toBe(1));
    // The list refetches empty — the pending contact is gone.
    await waitFor(() => expect(screen.queryByText(/Junk Invite/)).toBeNull());
    lock();
  });

  // AI invitation drafter (Build with Gemini XPRIZE): only the role leaves the
  // browser; the owner gets an editable draft to send with the token.
  it('drafts an invitation message with AI', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/v1/contacts')) return json({ contacts: [] });
      if (u.endsWith('/v1/ai/draft-invite'))
        return json({ message: 'Hi — I would like you to be a trusted contact for me.' });
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderContacts(fetchImpl);
    await userEvent.click(screen.getByRole('button', { name: 'Draft a message with AI' }));

    await waitFor(() => expect(screen.getByTestId('invite-draft')).toBeInTheDocument());
    expect(screen.getByDisplayValue(/trusted contact for me/)).toBeInTheDocument();
  });
});
