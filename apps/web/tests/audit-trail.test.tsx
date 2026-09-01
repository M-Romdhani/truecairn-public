import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { canonicalBytes, type CanonicalEntry } from '@truecairn/audit/canonical';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditTrail } from '../src/screens/settings/AuditTrail.js';

// The audit trail is only worth shipping if the verification is real. These
// tests build a genuine chain with the SAME canonical encoding the server signs,
// then tamper with it, and require the browser to notice — otherwise the
// "verify on this device" button is decoration, which on this surface would be
// worse than having no button at all.

const USER = '11111111-2222-3333-4444-555555555555';
const bytesToB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

async function sha256b64(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return bytesToB64(new Uint8Array(d));
}

// Build a real, correctly-linked chain.
async function chain(n: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const serverTimestamp = new Date(Date.UTC(2026, 6, 25, 0, 0, i));
    const canonical: CanonicalEntry = {
      seq: BigInt(i),
      userId: USER,
      eventType: 'test.event',
      eventPayload: { i },
      prevEntryHash: prev === null ? null : Uint8Array.from(atob(prev), (c) => c.charCodeAt(0)),
      serverTimestamp,
      serverKeyId: 'k1',
      clientTimestamp: null,
    };
    const entryHash = await sha256b64(canonicalBytes(canonical));
    out.push({
      seq: i,
      userId: USER,
      eventType: 'test.event',
      eventPayload: { i },
      prevEntryHash: prev,
      serverTimestamp: serverTimestamp.toISOString(),
      serverKeyId: 'k1',
      clientTimestamp: null,
      entryHash,
      serverSignature: 'AA==',
      userSignature: null,
      actor: 'owner',
    });
    prev = entryHash;
  }
  return out;
}

function mount(entries: Array<Record<string, unknown>>): ReturnType<typeof render> {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ entries, serverKeys: { k1: 'AA==' }, nextFromSeq: null }),
      } as Response),
    ),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuditTrail />
    </QueryClientProvider>,
  );
}

describe('audit trail — verified in the browser, not asserted by the server', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifies an intact chain on this device', async () => {
    mount(await chain(4));
    await screen.findByTestId('verify-btn');
    await userEvent.click(screen.getByTestId('verify-btn'));
    const ok = await screen.findByTestId('verdict-ok');
    expect(ok.textContent).toMatch(/Checked 4 records/);
  });

  it('CATCHES a record whose content was altered', async () => {
    const entries = await chain(4);
    // Exactly what a tampered history looks like: the payload changed but the
    // stored fingerprint did not.
    entries[2]!['eventPayload'] = { i: 999 };
    mount(entries);
    await screen.findByTestId('verify-btn');
    await userEvent.click(screen.getByTestId('verify-btn'));
    const bad = await screen.findByTestId('verdict-broken');
    expect(bad.textContent).toMatch(/Record 3 failed/);
    expect(bad.textContent).toMatch(/does not match its own fingerprint/);
  });

  it('CATCHES a record removed from the middle', async () => {
    const entries = await chain(5);
    entries.splice(2, 1); // drop seq 3
    mount(entries);
    await screen.findByTestId('verify-btn');
    await userEvent.click(screen.getByTestId('verify-btn'));
    const bad = await screen.findByTestId('verdict-broken');
    expect(bad.textContent).toMatch(/missing or out of order/);
  });

  it('CATCHES a broken link between records', async () => {
    const entries = await chain(4);
    entries[3]!['prevEntryHash'] = bytesToB64(new Uint8Array(32));
    mount(entries);
    await screen.findByTestId('verify-btn');
    await userEvent.click(screen.getByTestId('verify-btn'));
    expect((await screen.findByTestId('verdict-broken')).textContent).toMatch(
      /does not link to the one before it/,
    );
  });

  it('states the limit of what it proves', async () => {
    const { container } = mount(await chain(2));
    await screen.findByTestId('verify-btn');
    const text = container.textContent ?? '';
    // It must not imply it can detect a server dishonest from the start — the
    // same overclaim /security/build refuses to make.
    expect(text).toMatch(/we do not ask our own server/i);
    expect(text).toMatch(/dishonest from the very start/i);
  });

  it('marks entries the assistant caused', async () => {
    const entries = await chain(2);
    entries[1]!['actor'] = 'ai';
    mount(entries);
    const list = await screen.findByTestId('audit-entries');
    expect(list.textContent).toMatch(/by the assistant/);
  });
});
