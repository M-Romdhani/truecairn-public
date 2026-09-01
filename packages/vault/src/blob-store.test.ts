import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobKey, createBlobStore, LocalDiskBlobStore, S3BlobStore } from './blob-store.js';

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

describe('blobKey', () => {
  it('is the stable <userId>/<attachmentId>.bin layout', () => {
    expect(blobKey('user-1', 'att-2')).toBe('user-1/att-2.bin');
  });
});

describe('LocalDiskBlobStore', () => {
  let dir: string;
  let store: LocalDiskBlobStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tc-blob-'));
    store = new LocalDiskBlobStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips put → get → delete; missing is null / idempotent success', async () => {
    const key = blobKey('u', 'a');
    const put = await store.put(key, Readable.from(Buffer.from('hello world')), 11);
    expect(put.bytesWritten).toBe(11);

    const got = await store.get(key);
    expect(got).not.toBeNull();
    expect(got!.sizeBytes).toBe(11);
    expect(await drain(got!.stream)).toBe('hello world');

    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.delete(key); // already gone → no throw
  });

  it('get returns null for an absent key', async () => {
    expect(await store.get(blobKey('nope', 'nope'))).toBeNull();
  });
});

const baseCfg = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'vault',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret/key',
};
const asFetch = (fn: (req: Request) => Promise<Response>): typeof fetch =>
  ((input: unknown) => fn(input as Request)) as typeof fetch;

describe('S3BlobStore (real SigV4 signing, injected transport)', () => {
  it('PUT signs UNSIGNED-PAYLOAD and targets path-style {endpoint}/{bucket}/{key}', async () => {
    let seen: Request | undefined;
    const store = new S3BlobStore({
      ...baseCfg,
      forcePathStyle: true,
      fetchImpl: asFetch(async (req) => {
        seen = req;
        return new Response(null, { status: 200 });
      }),
    });
    const res = await store.put(blobKey('u', 'a'), Readable.from(Buffer.from('hi')), 2);
    expect(res.bytesWritten).toBe(2);
    expect(seen!.method).toBe('PUT');
    expect(seen!.url).toBe('https://s3.example.com/vault/u/a.bin');
    expect(seen!.headers.get('authorization')).toMatch(/AWS4-HMAC-SHA256/);
    expect(seen!.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
  });

  it('PUT reports the bytes it actually sent, not the size it was promised', async () => {
    // 2026-08-07 security audit. This used to `return { bytesWritten: sizeBytes }`
    // — the declared size handed straight back — which made the caller's
    // `bytesWritten !== cl` integrity check compare a number to itself. It passed
    // for ANY body, including a truncated one, so the guard existed on the local
    // disk backend and silently did nothing on this one.
    const store = new S3BlobStore({
      ...baseCfg,
      forcePathStyle: true,
      fetchImpl: asFetch(async (req) => {
        // Drain the body so the counting transform actually sees the chunks.
        if (req.body !== null) await req.arrayBuffer();
        return new Response(null, { status: 200 });
      }),
    });
    // Declares 10 bytes, sends 3. The mismatch is what the caller rolls back on.
    const res = await store.put(blobKey('u', 'a'), Readable.from(Buffer.from('abc')), 10);
    expect(res.bytesWritten).toBe(3);
  });

  it('GET returns the stream + size; 404 → null', async () => {
    const ok = new S3BlobStore({
      ...baseCfg,
      fetchImpl: asFetch(
        async () => new Response('payload', { status: 200, headers: { 'content-length': '7' } }),
      ),
    });
    const got = await ok.get(blobKey('u', 'a'));
    expect(got!.sizeBytes).toBe(7);
    expect(await drain(got!.stream)).toBe('payload');

    const miss = new S3BlobStore({
      ...baseCfg,
      fetchImpl: asFetch(async () => new Response(null, { status: 404 })),
    });
    expect(await miss.get(blobKey('u', 'a'))).toBeNull();
  });

  it('DELETE is idempotent (204 and 404 both succeed); virtual-hosted URL when path-style off', async () => {
    let seen: Request | undefined;
    const store = new S3BlobStore({
      ...baseCfg,
      forcePathStyle: false,
      fetchImpl: asFetch(async (req) => {
        seen = req;
        return new Response(null, { status: 204 });
      }),
    });
    await store.delete(blobKey('u', 'a'));
    expect(seen!.method).toBe('DELETE');
    expect(seen!.url).toBe('https://vault.s3.example.com/u/a.bin');

    const gone = new S3BlobStore({
      ...baseCfg,
      fetchImpl: asFetch(async () => new Response(null, { status: 404 })),
    });
    await expect(gone.delete(blobKey('u', 'a'))).resolves.toBeUndefined();
  });

  it('PUT throws on an unhandled non-ok status', async () => {
    const store = new S3BlobStore({
      ...baseCfg,
      fetchImpl: asFetch(async () => new Response('denied', { status: 403 })),
    });
    await expect(
      store.put(blobKey('u', 'a'), Readable.from(Buffer.from('x')), 1),
    ).rejects.toThrow(/S3 put 403/);
  });
});

describe('createBlobStore', () => {
  it('defaults to local disk', () => {
    expect(createBlobStore({})).toBeInstanceOf(LocalDiskBlobStore);
    expect(createBlobStore({ ATTACHMENTS_BACKEND: 'local', ATTACHMENTS_DIR: '/tmp/x' })).toBeInstanceOf(
      LocalDiskBlobStore,
    );
  });

  it('builds an S3 store when configured', () => {
    const s = createBlobStore({
      ATTACHMENTS_BACKEND: 's3',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'vault',
      S3_ACCESS_KEY_ID: 'AKIA',
      S3_SECRET_ACCESS_KEY: 'sk',
    });
    expect(s).toBeInstanceOf(S3BlobStore);
  });

  it('fails fast when ATTACHMENTS_BACKEND=s3 but credentials are missing', () => {
    expect(() => createBlobStore({ ATTACHMENTS_BACKEND: 's3', S3_BUCKET: 'vault' })).toThrow(
      /requires S3_ENDPOINT/,
    );
  });

  it('rejects an unknown backend', () => {
    expect(() => createBlobStore({ ATTACHMENTS_BACKEND: 'gcs' })).toThrow(/unknown ATTACHMENTS_BACKEND/);
  });
});
