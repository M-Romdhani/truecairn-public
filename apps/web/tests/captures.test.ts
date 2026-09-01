import { beforeEach, describe, expect, it } from 'vitest';
import { listCaptures, parseContainer, resetCaptureAvailability } from '../src/vault/captures.js';

// The capture routes are flag-gated (docs/34), so a browser talking to a
// flag-off server must ask once and then stop. This is pinned here as well as in
// the E2E network guard (`channels-remove.spec.ts`) because a regression should
// fail in two seconds, not five minutes.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

describe('listCaptures — a flag-off server is asked once, not once per visit', () => {
  beforeEach(() => resetCaptureAvailability());

  it('stops asking after the first 404', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(404, { type: 'about:blank', title: 'Not Found', status: 404 });
    }) as unknown as typeof fetch;

    expect(await listCaptures(fetchImpl)).toEqual([]);
    expect(await listCaptures(fetchImpl)).toEqual([]);
    expect(await listCaptures(fetchImpl)).toEqual([]);
    expect(calls, 'a flag-off server should be asked exactly once').toBe(1);
  });

  it('keeps asking a server that answers, and returns the queue', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(200, {
        captures: [{ id: 'a', tier: 's2', sizeBytes: 10, createdAt: '2026-07-31T00:00:00.000Z' }],
      });
    }) as unknown as typeof fetch;

    expect(await listCaptures(fetchImpl)).toHaveLength(1);
    expect(await listCaptures(fetchImpl)).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('does not swallow a real failure as "no captures"', async () => {
    // A 500 is not "the feature is off" — it is a server that is broken, and the
    // panel must not render an empty queue as if everything were fine.
    const fetchImpl = (async () =>
      jsonResponse(500, {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
      })) as unknown as typeof fetch;

    await expect(listCaptures(fetchImpl)).rejects.toThrow();
  });
});

describe('parseContainer — the format the phone writes (docs/34 §4)', () => {
  function build(meta: unknown, blobs: Uint8Array[] = []): Uint8Array {
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const magic = new TextEncoder().encode('TCCAP1');
    const total =
      magic.length + 4 + metaBytes.length + blobs.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    out.set(magic, 0);
    new DataView(out.buffer).setUint32(magic.length, metaBytes.length, false);
    out.set(metaBytes, magic.length + 4);
    let offset = magic.length + 4 + metaBytes.length;
    for (const b of blobs) {
      out.set(b, offset);
      offset += b.length;
    }
    return out;
  }

  // A container from a client that predates the category vocabulary (the phone
  // shipped a free-text field defaulting to 'documents') coerces to the narrowest
  // category rather than failing the filing. Losing a label is recoverable in one
  // click; refusing the capture would discard content the owner deliberately took.
  it('coerces a category outside the vocabulary rather than refusing it', () => {
    const parsed = parseContainer(
      build({ title: 't', category: 'documents', content: 'c', attachments: [] }, []),
    );
    expect(parsed.category).toBe('personal_archive');
  });

  it('coerces a MISSING category the same way, by the same rule', () => {
    const parsed = parseContainer(
      build({ title: 't', category: '', content: 'c', attachments: [] }, []),
    );
    expect(parsed.category).toBe('personal_archive');
  });

  it('reads title, category, content and attachments back in order', () => {
    const one = new Uint8Array([1, 2, 3]);
    const two = new Uint8Array([9, 9]);
    const parsed = parseContainer(
      build(
        {
          title: 'Passport',
          category: 'identity_documents',
          content: 'photo pages',
          attachments: [
            { name: 'a.jpg', mime: 'image/jpeg', size: 3 },
            { name: 'b.png', mime: 'image/png', size: 2 },
          ],
        },
        [one, two],
      ),
    );
    expect(parsed.title).toBe('Passport');
    expect(parsed.category).toBe('identity_documents');
    expect(parsed.content).toBe('photo pages');
    expect(parsed.attachments.map((a) => a.name)).toEqual(['a.jpg', 'b.png']);
    expect([...parsed.attachments[0]!.bytes]).toEqual([1, 2, 3]);
    expect([...parsed.attachments[1]!.bytes]).toEqual([9, 9]);
  });

  it('refuses a container that is not one', () => {
    expect(() => parseContainer(new Uint8Array(32))).toThrow(/bad magic/);
  });

  it('refuses a truncated attachment rather than returning short bytes', () => {
    // Declares 100 bytes and supplies 2. Filing a silently-truncated file would
    // store a corrupt item that looks successful.
    const container = build(
      { title: 't', category: 'c', content: '', attachments: [{ name: 'a', mime: 'm', size: 100 }] },
      [new Uint8Array([1, 2])],
    );
    expect(() => parseContainer(container)).toThrow(/truncated/);
  });
});
