import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { generateEnrollmentMaterial, lock, unlock, type KeyMaterial } from '@truecairn/client-crypto';
import type { VaultItemDto } from '@truecairn/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '../src/crypto/session.js';
import { CreateItem } from '../src/screens/vault/CreateItem.js';
import { VaultItemDetail } from '../src/screens/vault/VaultItemDetail.js';
import { VaultLockBanner } from '../src/screens/vault/VaultLockBanner.js';
import { wrapItem } from '../src/vault/crypto.js';

// The item id is part of BOTH AADs now, so the fixture id has to be the one
// the ciphertext was bound to — a mismatch is a decryption failure, by design.
const ITEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const PASS = 'vault-test-passphrase';
const SECRET_TITLE = 'Swiss bank account';
const SECRET_CONTENT = 'IBAN CH93 0076 2011 6238 5295 7 — the money is here';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let material: KeyMaterial;

beforeAll(() => {
  material = generateEnrollmentMaterial(utf8(PASS)).material;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => lock());

// Unlocks the React session (sets userId) before rendering children — needed for
// the sensitive flows, which build the step-up signing input from the user id.
function Unlocked({ children }: { children: ReactNode }): JSX.Element | null {
  const s = useSession();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    s.unlock(utf8(PASS), material, '11111111-2222-3333-4444-555555555555');
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ready ? <>{children}</> : null;
}

function renderInProviders(ui: ReactNode, withUserId = false): void {
  const qc = new QueryClient();
  render(
    // VaultItemDetail renders a react-router <Link> (the "← Back to vault"
    // affordance), so the component needs a Router in tests just as it has one
    // in the app.
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <SessionProvider>{withUserId ? <Unlocked>{ui}</Unlocked> : ui}</SessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('vault zero-knowledge (PHASE4 C3)', () => {
  // PROPERTY #1 — the most important: the plaintext NEVER appears in the request
  // body. What leaves the browser is ciphertext, wrapped client-side.
  it('create-item sends only ciphertext — the plaintext never appears in the POST body', async () => {
    unlock(utf8(PASS), material);
    let sentBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = init.body as string;
        // Echo the client's id, as the server does — the item ciphertext is
        // bound to it, so answering with a different one is a server fault and
        // createItem now rejects it.
        const sentId = (JSON.parse(sentBody) as { id: string }).id;
        return json({ id: sentId, createdAt: new Date().toISOString() }, 201);
      }),
    );

    render(<CreateItem />);
    await userEvent.type(screen.getByLabelText('Title'), SECRET_TITLE);
    await userEvent.type(screen.getByLabelText('Content'), SECRET_CONTENT);
    await userEvent.click(screen.getByRole('button', { name: /save item/i }));

    await waitFor(() => expect(sentBody).toBeDefined());
    // The plaintext title and content are NOWHERE in the request body.
    expect(sentBody!).not.toContain(SECRET_CONTENT);
    expect(sentBody!).not.toContain(SECRET_TITLE);
    // What IS sent is ciphertext + nonces (and the tier/category metadata).
    const parsed = JSON.parse(sentBody!) as Record<string, string>;
    expect(parsed['contentCiphertext']).toBeTruthy();
    expect(parsed['titleCiphertext']).toBeTruthy();
    expect(parsed['wrappedPerItemKey']).toBeTruthy();
    lock();
  });

  it('round-trips: a wrapped item fetched back decrypts to the original title + content', async () => {
    unlock(utf8(PASS), material);
    const wrapped = wrapItem(ITEM_ID, 's1', SECRET_TITLE, SECRET_CONTENT);
    const itemDto: VaultItemDto = {
      id: ITEM_ID,
      tier: 's1',
      aadVersion: 2 as const,
      category: 'general',
      clientOrdinal: null,
      ...wrapped,
      attachments: [],
      deletedAt: null,
      pendingDeleteAt: null,
      createdAt: 'c',
      updatedAt: 'u',
    };
    const fetchImpl = vi.fn(async () => json(itemDto)) as unknown as typeof fetch;

    renderInProviders(<VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('item content')).toHaveTextContent(SECRET_CONTENT);
    lock();
  });
});

describe('vault write-lock during release/review (QA 2026-07-23 F5)', () => {
  // When the engine is in a release/review/returning state the server 409s vault
  // writes (vault-locked-during-release). The create form must name that cause
  // and point at the Engine page — NOT the generic "please try again", which
  // read as a plan/limit bug.
  it('a 409 vault-locked create shows the release/review reason + an Engine link, not the generic error', async () => {
    unlock(utf8(PASS), material);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          {
            type: 'https://truecairn.app/problems/vault-locked-during-release',
            title: 'Vault locked during release',
            status: 409,
            detail: 'vault content cannot be modified while a release is in progress',
          },
          409,
        ),
      ),
    );

    render(
      <MemoryRouter>
        <CreateItem />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText('Title'), 'Docs');
    await userEvent.type(screen.getByLabelText('Content'), 'body');
    await userEvent.click(screen.getByRole('button', { name: /save item/i }));

    const locked = await screen.findByTestId('item-locked');
    expect(locked).toHaveTextContent(/release or review is in progress/i);
    expect(locked.querySelector('a')?.getAttribute('href')).toBe('/engine');
    // The generic "please try again" error must NOT be shown for this case.
    expect(screen.queryByText(/We could not save this item/i)).not.toBeInTheDocument();
    lock();
  });

  it('the proactive banner shows in a locked engine state and hides in active', async () => {
    const lockedFetch = vi.fn(async () => json({ state: 'review_required' })) as unknown as typeof fetch;
    renderInProviders(<VaultLockBanner fetchImpl={lockedFetch} />);
    await waitFor(() => expect(screen.getByTestId('vault-locked-banner')).toBeInTheDocument());
    expect(screen.getByTestId('vault-locked-banner')).toHaveTextContent(/paused for review/i);

    cleanup();
    const activeFetch = vi.fn(async () => json({ state: 'active' })) as unknown as typeof fetch;
    renderInProviders(<VaultLockBanner fetchImpl={activeFetch} />);
    // Give the query a tick; the banner must never appear for a writable state.
    await Promise.resolve();
    expect(screen.queryByTestId('vault-locked-banner')).not.toBeInTheDocument();
  });
});

describe('attach-at-creation (2026-07-18)', () => {
  it('creates the item, then uploads each file encrypted — the plaintext never leaves', async () => {
    unlock(utf8(PASS), material);
    let reserveCount = 0;
    const putBodies: Uint8Array[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const u = String(url);
        const method = init.method ?? 'GET';
        if (u.endsWith('/v1/vault/items') && method === 'POST')
          return json({ id: (JSON.parse(init.body as string) as { id: string }).id, createdAt: 'c' }, 201);
        if (/\/v1\/vault\/items\/[^/]+\/attachments$/.test(u) && method === 'POST') {
          reserveCount += 1;
          return json({ attachmentId: `att-${reserveCount}` }, 201);
        }
        const m = u.match(/\/v1\/vault\/items\/[^/]+\/attachments\/(att-\d+)\/bytes$/);
        if (m && method === 'PUT') {
          putBodies.push(init.body as Uint8Array);
          return json({ attachmentId: m[1], sizeBytes: 42 }, 200);
        }
        throw new Error(`unexpected ${method} ${u}`);
      }),
    );

    const onCreated = vi.fn();
    render(
      <MemoryRouter>
        <CreateItem onCreated={onCreated} />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText('Title'), 'Passport');
    await userEvent.type(screen.getByLabelText('Content'), 'passport number 12345');
    const SECRET_FILE_BODY = 'SSN-999-88-7777 — secret file body';
    await userEvent.upload(screen.getByTestId('new-attach-file'), [
      new File([SECRET_FILE_BODY], 'passport.pdf', { type: 'application/pdf' }),
      new File(['second file body'], 'insurance.pdf', { type: 'application/pdf' }),
    ]);
    expect(screen.getByTestId('new-attach-picklist')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /save item/i }));

    // The shell is told the item was created WITH attachments (→ navigate to it).
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.any(String), true));
    // Two files → two reserve + two byte PUTs, all under the new item's id.
    expect(reserveCount).toBe(2);
    expect(putBodies).toHaveLength(2);
    // Each blob is ciphertext: the plaintext file body appears in NONE of them.
    for (const b of putBodies) {
      expect(new TextDecoder().decode(b)).not.toContain(SECRET_FILE_BODY);
    }
    lock();
  });

  it('a failed upload keeps the item and links the user to it to retry (no silent loss)', async () => {
    unlock(utf8(PASS), material);
    let reserveCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const u = String(url);
        const method = init.method ?? 'GET';
        if (u.endsWith('/v1/vault/items') && method === 'POST')
          return json({ id: (JSON.parse(init.body as string) as { id: string }).id, createdAt: 'c' }, 201);
        if (/\/v1\/vault\/items\/[^/]+\/attachments$/.test(u) && method === 'POST') {
          reserveCount += 1;
          // First file reserves fine; the second hits the storage cap (402).
          if (reserveCount === 2)
            return json({ type: 'about:blank', title: 'Storage limit', status: 402 }, 402);
          return json({ attachmentId: `att-${reserveCount}` }, 201);
        }
        const m = u.match(/\/v1\/vault\/items\/[^/]+\/attachments\/(att-\d+)\/bytes$/);
        if (m && method === 'PUT') return json({ attachmentId: m[1], sizeBytes: 10 }, 200);
        throw new Error(`unexpected ${method} ${u}`);
      }),
    );

    const onCreated = vi.fn();
    render(
      <MemoryRouter>
        <CreateItem onCreated={onCreated} />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText('Title'), 'Docs');
    await userEvent.type(screen.getByLabelText('Content'), 'body');
    await userEvent.upload(screen.getByTestId('new-attach-file'), [
      new File(['a'], 'ok.pdf', { type: 'application/pdf' }),
      new File(['b'], 'insurance.pdf', { type: 'application/pdf' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /save item/i }));

    const note = await screen.findByTestId('create-partial');
    expect(note).toHaveTextContent(/insurance\.pdf/);
    // The link points at the item the CLIENT created — its id is the one the
    // ciphertext is bound to, not something the server chose.
    expect(note.querySelector('a')?.getAttribute('href')).toMatch(/^\/vault\/[0-9a-f-]{36}$/);
    // The item WAS created but we did not navigate away (hadAttachments=false).
    expect(onCreated).toHaveBeenCalledWith(expect.any(String), false);
    lock();
  });
});

describe('item detail: record vs. attachments information architecture', () => {
  it('scopes immutability to the record and reads attachments as separate + multi-file', async () => {
    unlock(utf8(PASS), material);
    const wrapped = wrapItem(ITEM_ID, 's1', SECRET_TITLE, SECRET_CONTENT);
    const itemDto: VaultItemDto = {
      id: ITEM_ID,
      tier: 's1',
      aadVersion: 2 as const,
      category: 'general',
      clientOrdinal: null,
      ...wrapped,
      attachments: [],
      deletedAt: null,
      pendingDeleteAt: null,
      createdAt: 'c',
      updatedAt: 'u',
    };
    const fetchImpl = vi.fn(async () => json(itemDto)) as unknown as typeof fetch;
    renderInProviders(<VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument(),
    );
    // The immutability line names title + content — not attachments.
    expect(screen.getByText(/title and content can.?t be edited/i)).toBeInTheDocument();
    expect(screen.getByText(/Attachments below are managed separately/i)).toBeInTheDocument();
    // The attachments section states independence and offers a multi-file picker.
    expect(screen.getByText(/added or removed independently/i)).toBeInTheDocument();
    expect(screen.getByTestId('detail-attach-file')).toHaveProperty('multiple', true);
    lock();
  });
});

describe('vault tier-move UX honesty (PHASE4 C3 property #2)', () => {
  it('routes the tier change through step-up and surfaces the PENDING state (never "done")', async () => {
    // Prepare a real wrapped S1 item to serve.
    unlock(utf8(PASS), material);
    const wrapped = wrapItem(ITEM_ID, 's1', SECRET_TITLE, SECRET_CONTENT);
    lock(); // the React Unlocked wrapper re-unlocks with a userId
    const itemDto: VaultItemDto = {
      id: ITEM_ID,
      tier: 's1',
      aadVersion: 2 as const,
      category: 'general',
      clientOrdinal: null,
      ...wrapped,
      attachments: [],
      deletedAt: null,
      pendingDeleteAt: null,
      createdAt: 'c',
      updatedAt: 'u',
    };
    const effectiveAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    let tierPosts = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith(`/v1/vault/items/${ITEM_ID}`) && (init.method ?? 'GET') === 'GET') return json(itemDto);
      if (u.endsWith('/v1/vault/items/tier')) {
        tierPosts += 1;
        const headers = (init.headers ?? {}) as Record<string, string>;
        if (headers['x-truecairn-stepup-signature'] === undefined) {
          // R1: demand step-up (a fresh second factor is already satisfied).
          return json(
            {
              type: 'https://truecairn.app/problems/step-up-required',
              title: 'Step-up required',
              status: 403,
              stepUp: {
                challengeId: 'ch1',
                challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 32 bytes b64url
                actionType: 'set_vault_item_tier',
                secondFactor: { satisfiedBySession: true, accepted: ['totp'], freshnessWindowSeconds: 300 },
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

    renderInProviders(
      <VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} proveSecondFactor={async () => {}} />,
      /* withUserId */ true,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Request tier change' }));

    // The pending banner appears and is honest about the 7-day window.
    await waitFor(() => expect(screen.getByTestId('pending-action')).toBeInTheDocument());
    expect(screen.getByTestId('pending-action')).toHaveTextContent(/pending/i);
    expect(screen.getByTestId('pending-action')).toHaveTextContent(/cancellable for 7 days/i);
    // It went through the R1→R2 step-up handshake (two POSTs to the tier endpoint).
    expect(tierPosts).toBe(2);
    // The UI does NOT claim the move applied: the item still shows its OLD tier.
    expect(screen.getByTestId('item-tier')).toHaveTextContent('S1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-02 (QA 2026-08-10). The "Move to tier" control displayed one tier and
// submitted another. The <select> omits the item's current tier, so the
// hardcoded `useState<VaultTier>('s2')` matched no option on an S2 item: the
// browser rendered the first option (S1) while React state stayed 's2', and the
// request asked to move the item to the tier it was already in — a guaranteed
// 400 from tierMovePrecondition. On S1 and S3 the same constant produced a
// wrong-but-VALID move, which nothing rejects at all.
//
// Note WHY the existing tier-move test above did not catch this: it serves an
// S1 item, the one tier where the constant 's2' happens to be a valid option.
// So these run every tier, and assert the invariant directly — the value the
// control DISPLAYS is the value the request SENDS.
// ─────────────────────────────────────────────────────────────────────────────
describe('vault tier-move: the control submits what it displays (QA 2026-08-10 F-02)', () => {
  for (const tier of ['s1', 's2', 's3'] as const) {
    it(`sends the displayed tier, not a constant, on an ${tier.toUpperCase()} item`, async () => {
      unlock(utf8(PASS), material);
      const wrapped = wrapItem(ITEM_ID, tier, SECRET_TITLE, SECRET_CONTENT);
      lock();
      const itemDto: VaultItemDto = {
        id: ITEM_ID,
        tier,
        aadVersion: 2 as const,
        category: 'general',
        clientOrdinal: null,
        ...wrapped,
        attachments: [],
        deletedAt: null,
        pendingDeleteAt: null,
        createdAt: 'c',
        updatedAt: 'u',
      };
      const effectiveAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
      let sentTier: string | undefined;
      const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        const u = String(url);
        if (u.endsWith(`/v1/vault/items/${ITEM_ID}`) && (init.method ?? 'GET') === 'GET') return json(itemDto);
        if (u.endsWith('/v1/vault/items/tier')) {
          sentTier = (JSON.parse(String(init.body)) as { newTier: string }).newTier;
          return json({ sensitiveActionId: 'sa1', effectiveAt }, 202);
        }
        throw new Error(`unexpected ${u}`);
      }) as unknown as typeof fetch;

      renderInProviders(
        <VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} proveSecondFactor={async () => {}} />,
        /* withUserId */ true,
      );
      await waitFor(() => expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument());

      const select = screen.getByLabelText('Move to tier') as HTMLSelectElement;
      const optionValues = [...select.options].map((o) => o.value);
      // The item's own tier is never an option, and the rendered value is one
      // of the options that remain — the two halves of the bug.
      expect(optionValues).not.toContain(tier);
      expect(optionValues).toContain(select.value);
      const displayed = select.value;

      await userEvent.click(screen.getByRole('button', { name: 'Request tier change' }));
      await waitFor(() => expect(sentTier).toBeDefined());

      expect(sentTier).toBe(displayed);
      // …and therefore never the item's own tier, which is the 400.
      expect(sentTier).not.toBe(tier);
      // The pending banner names the tier that was actually requested.
      expect(screen.getByTestId('pending-action')).toHaveTextContent(displayed.toUpperCase());
    });
  }

  it('still honours an explicit choice over the derived default', async () => {
    unlock(utf8(PASS), material);
    const wrapped = wrapItem(ITEM_ID, 's1', SECRET_TITLE, SECRET_CONTENT);
    lock();
    const itemDto: VaultItemDto = {
      id: ITEM_ID,
      tier: 's1',
      aadVersion: 2 as const,
      category: 'general',
      clientOrdinal: null,
      ...wrapped,
      attachments: [],
      deletedAt: null,
      pendingDeleteAt: null,
      createdAt: 'c',
      updatedAt: 'u',
    };
    const effectiveAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    let sentTier: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith(`/v1/vault/items/${ITEM_ID}`) && (init.method ?? 'GET') === 'GET') return json(itemDto);
      if (u.endsWith('/v1/vault/items/tier')) {
        sentTier = (JSON.parse(String(init.body)) as { newTier: string }).newTier;
        return json({ sensitiveActionId: 'sa1', effectiveAt }, 202);
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderInProviders(
      <VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} proveSecondFactor={async () => {}} />,
      /* withUserId */ true,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText('Move to tier'), 's3');
    await userEvent.click(screen.getByRole('button', { name: 'Request tier change' }));
    await waitFor(() => expect(sentTier).toBeDefined());
    expect(sentTier).toBe('s3');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The other half of F-02: a refused sensitive action has to SAY so, in terms the
// owner can act on, somewhere they will see it. Both halves failed here — the
// handler discarded the RFC 7807 problem and printed "Please try again" (a
// deterministic 400 will fail identically on retry), and the alert rendered
// below the entire attachments block, off-screen from the button that caused it.
// ─────────────────────────────────────────────────────────────────────────────
describe('vault item detail: refusals are surfaced where the owner acted', () => {
  const itemWithAttachments = (tier: 's1' | 's2' | 's3') => {
    unlock(utf8(PASS), material);
    const wrapped = wrapItem(ITEM_ID, tier, SECRET_TITLE, SECRET_CONTENT);
    lock();
    return {
      id: ITEM_ID,
      tier,
      aadVersion: 2 as const,
      category: 'general',
      clientOrdinal: null,
      ...wrapped,
      attachments: [
        { id: 'bbbbbbbb-1111-4222-8333-444444444444', sizeBytes: 181, status: 'stored', pendingDeleteAt: null, createdAt: '2026-08-10T00:29:23.000Z' },
      ],
      deletedAt: null,
      pendingDeleteAt: null,
      createdAt: 'c',
      updatedAt: 'u',
    };
  };

  it("shows the server's reason for a refusal instead of a generic retry prompt", async () => {
    const itemDto = itemWithAttachments('s2');
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith(`/v1/vault/items/${ITEM_ID}`) && (init.method ?? 'GET') === 'GET') return json(itemDto);
      if (u.endsWith('/v1/vault/items/delete')) {
        return json(
          {
            type: 'https://truecairn.app/problems/vault-locked-during-release',
            title: 'Vault locked',
            status: 409,
            detail: 'your vault is locked while a release is in progress',
          },
          409,
        );
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderInProviders(
      <VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} proveSecondFactor={async () => {}} />,
      /* withUserId */ true,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('your vault is locked while a release is in progress');
    expect(alert).not.toHaveTextContent(/please try again/i);
  });

  it('renders the refusal above the attachments block, not below it', async () => {
    const itemDto = itemWithAttachments('s2');
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.endsWith(`/v1/vault/items/${ITEM_ID}`) && (init.method ?? 'GET') === 'GET') return json(itemDto);
      if (u.endsWith('/v1/vault/items/delete')) {
        return json({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'nope' }, 409);
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    renderInProviders(
      <VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} proveSecondFactor={async () => {}} />,
      /* withUserId */ true,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const alert = await screen.findByRole('alert');

    // DOCUMENT_POSITION_FOLLOWING (4) = the attachments section comes AFTER the
    // alert. This is the assertion that would have failed before the fix: the
    // alert used to sit past every attachment row and the upload button.
    const attachments = screen.getByTestId('attachments-section');
    expect(alert.compareDocumentPosition(attachments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-01 (QA 2026-08-10). `pending_delete_at` was written by the delete route and
// serialized by nothing, so the seven-day cancellable window existed and was
// invisible from the item it would destroy: request a deletion, navigate away,
// come back, and the Delete button was simply there again as though nothing had
// happened. The banner the owner saw came only from the 202 response held in
// React state, and evaporated on re-render.
//
// These assert the PERSISTED state — served by the API, surviving a reload —
// not the local echo.
// ─────────────────────────────────────────────────────────────────────────────
describe('vault item: a scheduled deletion is visible from the item (QA 2026-08-10 F-01)', () => {
  const effectiveAt = '2026-08-17T00:32:37.000Z';

  // Leaves the module-scoped key UNLOCKED: these render without the Unlocked
  // wrapper (no sensitive action is exercised), so the component's own
  // unwrapItem needs the key still in memory.
  const scheduledItem = (over: Record<string, unknown> = {}) => {
    unlock(utf8(PASS), material);
    const wrapped = wrapItem(ITEM_ID, 's2', SECRET_TITLE, SECRET_CONTENT);
    return {
      id: ITEM_ID,
      tier: 's2',
      aadVersion: 2 as const,
      category: 'general',
      clientOrdinal: null,
      ...wrapped,
      attachments: [],
      deletedAt: null,
      pendingDeleteAt: effectiveAt,
      createdAt: 'c',
      updatedAt: 'u',
      ...over,
    };
  };

  it('shows the scheduled deletion on a fresh load, with where to cancel it', async () => {
    const itemDto = scheduledItem();
    const fetchImpl = vi.fn(async () => json(itemDto)) as unknown as typeof fetch;
    renderInProviders(<VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} />);

    const banner = await screen.findByTestId('pending-deletion');
    expect(banner).toHaveTextContent(/Deletion scheduled/i);
    // The item is NOT gone yet — it stays readable during the window, and the
    // copy has to say so rather than implying the deletion already happened.
    expect(banner).toHaveTextContent(/stays readable until then/i);
    expect(screen.getByRole('link', { name: 'Engine page' })).toHaveAttribute('href', '/engine');
    // Still readable, and the content is still decrypted and shown.
    expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument();
    expect(screen.getByText(SECRET_CONTENT)).toBeInTheDocument();
  });

  it('replaces the destructive actions while a deletion is scheduled', async () => {
    const itemDto = scheduledItem();
    const fetchImpl = vi.fn(async () => json(itemDto)) as unknown as typeof fetch;
    renderInProviders(<VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} />);

    await screen.findByTestId('pending-deletion');
    // The exact defect: the Actions block came back as if nothing were pending.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request tier change' })).not.toBeInTheDocument();
  });

  it('shows nothing when no deletion is scheduled', async () => {
    const itemDto = scheduledItem({ pendingDeleteAt: null });
    const fetchImpl = vi.fn(async () => json(itemDto)) as unknown as typeof fetch;
    renderInProviders(<VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: SECRET_TITLE })).toBeInTheDocument());
    expect(screen.queryByTestId('pending-deletion')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  // The unreported sibling the response contract turned up: purge sets
  // pending_delete_at and leaves status on 'stored', so the row looked live and
  // still offered "Remove (7-day)" for a file already scheduled to go.
  it('marks an attachment whose purge is already scheduled', async () => {
    const attId = 'bbbbbbbb-1111-4222-8333-444444444444';
    const itemDto = scheduledItem({
      pendingDeleteAt: null,
      attachments: [
        { id: attId, sizeBytes: 181, status: 'stored', pendingDeleteAt: effectiveAt, createdAt: 'c' },
      ],
    });
    const fetchImpl = vi.fn(async () => json(itemDto)) as unknown as typeof fetch;
    renderInProviders(<VaultItemDetail itemId={ITEM_ID} fetchImpl={fetchImpl} />);

    const marker = await screen.findByTestId(`attachment-pending-delete-${attId}`);
    expect(marker).toHaveTextContent(/Removal scheduled/i);
    expect(screen.queryByTestId(`attachment-purge-${attId}`)).not.toBeInTheDocument();
    // Still downloadable during the window — it has not been purged yet.
    expect(screen.getByTestId(`attachment-download-${attId}`)).toBeInTheDocument();
  });
});
