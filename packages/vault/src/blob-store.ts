// Backend-agnostic storage for attachment blobs (PHASE3_3 → backlog #3). The
// blob is an opaque client-encrypted byte stream — the server never crypto-
// processes it; the gate is inherited from the parent vault item. Two backends:
// local disk (dev/default) and S3-compatible object storage. Moving off the
// shared local disk lets the API and worker run as SEPARATE services (today they
// must share an ATTACHMENTS_DIR, forcing one container). Everything streams so a
// 100 MiB blob never buffers in memory.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { AwsClient } from 'aws4fetch';

// The object key for a blob. Stable across backends: <userId>/<attachmentId>.bin.
// Both ids are UUIDs, so there is no path-traversal / key-injection surface.
export function blobKey(userId: string, attachmentId: string): string {
  return `${userId}/${attachmentId}.bin`;
}

export interface BlobStore {
  // Stream `body` to `key`. Returns the bytes actually written so the caller can
  // verify it matches the declared Content-Length.
  put(key: string, body: Readable, sizeBytes: number): Promise<{ bytesWritten: number }>;
  // Open `key` for streaming, or null if absent.
  get(key: string): Promise<{ stream: Readable; sizeBytes: number } | null>;
  // Remove `key`. Idempotent: a missing object is success — the DB row is the
  // durable state; the blob is best-effort (Q5), so an already-gone blob is fine.
  delete(key: string): Promise<void>;
}

// ── Local disk ────────────────────────────────────────────────────────────────
// Layout: <baseDir>/<userId>/<attachmentId>.bin — the pre-existing on-disk shape.
export class LocalDiskBlobStore implements BlobStore {
  constructor(private readonly baseDir: string) {}

  private path(key: string): string {
    return join(this.baseDir, key);
  }

  async put(key: string, body: Readable, _sizeBytes: number): Promise<{ bytesWritten: number }> {
    const filePath = this.path(key);
    await mkdir(dirname(filePath), { recursive: true });
    const ws = createWriteStream(filePath);
    // pipeline is backpressure-aware: it pauses the source when the disk write is
    // slow and propagates errors + closes both streams.
    await pipeline(body, ws);
    return { bytesWritten: ws.bytesWritten };
  }

  async get(key: string): Promise<{ stream: Readable; sizeBytes: number } | null> {
    const filePath = this.path(key);
    const st = await stat(filePath).catch(() => null);
    if (st === null) return null;
    return { stream: createReadStream(filePath), sizeBytes: st.size };
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

// ── S3-compatible ───────────────────────────────────────────────────────────
// Signs requests with SigV4 (aws4fetch) so it works against AWS S3, Cloudflare
// R2, Backblaze B2, MinIO, etc. Only put/get/delete of opaque blobs is needed.
export interface S3BlobStoreConfig {
  endpoint: string; // e.g. https://s3.us-east-1.amazonaws.com, https://<id>.r2.cloudflarestorage.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // path-style (default) → {endpoint}/{bucket}/{key} (MinIO/most S3-compatible);
  // virtual-hosted (false) → {bucket}.{host}/{key} (AWS S3 default).
  forcePathStyle?: boolean;
  // Injectable for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
}

export class S3BlobStore implements BlobStore {
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: S3BlobStoreConfig) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: 's3',
    });
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    const ep = cfg.endpoint.replace(/\/+$/, '');
    if (cfg.forcePathStyle === false) {
      const u = new URL(ep);
      this.base = `${u.protocol}//${cfg.bucket}.${u.host}`;
    } else {
      this.base = `${ep}/${encodeURIComponent(cfg.bucket)}`;
    }
  }

  private url(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  // Sign with aws4fetch (SigV4) then send via the injected fetch — so signing is
  // real and the transport is mockable in tests.
  private async send(key: string, init: RequestInit): Promise<Response> {
    const signed = await this.client.sign(this.url(key), init);
    return this.fetchImpl(signed);
  }

  async put(key: string, body: Readable, sizeBytes: number): Promise<{ bytesWritten: number }> {
    // Count what actually goes over the wire (2026-08-07 security audit). This
    // used to `return { bytesWritten: sizeBytes }` — the DECLARED size echoed
    // straight back — which made the caller's `bytesWritten !== cl` integrity
    // check a no-op on this backend: it compared a number to itself and passed
    // for any body at all, including a truncated one. The local-disk backend
    // reports a real count (`ws.bytesWritten`), so the check meant something
    // there and nothing here, which is the worst shape for a guard to have.
    let observed = 0;
    const counting = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        observed += chunk.length;
        cb(null, chunk);
      },
    });
    // SigV4 over a stream: we can't hash the payload up front, so declare it
    // UNSIGNED-PAYLOAD (aws4fetch then skips body hashing; TLS still protects it).
    // duplex:'half' is required for a streaming request body under fetch.
    const res = await this.send(key, {
      method: 'PUT',
      body: Readable.toWeb(body.pipe(counting)) as unknown as RequestInit['body'],
      headers: {
        'content-length': String(sizeBytes),
        'content-type': 'application/octet-stream',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      duplex: 'half',
    } as RequestInit);
    if (!res.ok) throw new Error(`S3 put ${res.status}: ${await safeText(res)}`);
    return { bytesWritten: observed };
  }

  async get(key: string): Promise<{ stream: Readable; sizeBytes: number } | null> {
    const res = await this.send(key, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok || res.body === null) throw new Error(`S3 get ${res.status}`);
    const len = Number(res.headers.get('content-length'));
    const stream = Readable.fromWeb(res.body as unknown as WebReadableStream);
    return { stream, sizeBytes: Number.isFinite(len) ? len : 0 };
  }

  async delete(key: string): Promise<void> {
    const res = await this.send(key, { method: 'DELETE' });
    // 204 deleted; 404 already gone — both are idempotent success.
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete ${res.status}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────
// Selects the backend from env. Local is the default (dev, tests, CI need no S3).
// ATTACHMENTS_BACKEND=s3 requires the full S3 credential set or it throws at
// startup (fail fast — never silently fall back to a local disk in production).
export interface BlobStoreEnv {
  ATTACHMENTS_BACKEND?: string | undefined;
  ATTACHMENTS_DIR?: string | undefined;
  S3_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
  S3_BUCKET?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_FORCE_PATH_STYLE?: string | undefined;
}

export function createBlobStore(env: BlobStoreEnv): BlobStore {
  const backend = (env.ATTACHMENTS_BACKEND ?? 'local').toLowerCase();
  if (backend === 's3') {
    const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
    if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
      throw new Error(
        'ATTACHMENTS_BACKEND=s3 requires S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY',
      );
    }
    return new S3BlobStore({
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
    });
  }
  if (backend !== 'local') {
    throw new Error(`unknown ATTACHMENTS_BACKEND '${backend}' (expected 'local' or 's3')`);
  }
  return new LocalDiskBlobStore(env.ATTACHMENTS_DIR ?? 'attachments');
}
