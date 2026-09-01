import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN_GUARD_HEADER, registerOriginGuard } from './origin-guard.js';
import type { ApiConfig } from './config.js';

// The origin lock (QA 2026-08-26 F1, remediation 3). What makes the trusted
// client-IP header believable: without it, anyone who reaches the origin
// directly can set that header by hand.
const SECRET = 'a-shared-secret-only-the-edge-knows';

function config(over: Partial<ApiConfig> = {}): ApiConfig {
  return { originGuardSecret: SECRET, ...over } as ApiConfig;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(cfg: ApiConfig): Promise<FastifyInstance> {
  const instance = Fastify();
  registerOriginGuard(instance, cfg);
  instance.get('/v1/anything', () => ({ ok: true }));
  instance.get('/ready', () => ({ status: 'ready' }));
  instance.get('/health', () => ({ status: 'ok' }));
  await instance.ready();
  app = instance;
  return instance;
}

describe('origin guard: only the trusted edge gets through', () => {
  it('refuses a request with no guard header', async () => {
    const instance = await build(config());
    const res = await instance.inject({ method: 'GET', url: '/v1/anything' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a request with the wrong secret', async () => {
    const instance = await build(config());
    const res = await instance.inject({
      method: 'GET',
      url: '/v1/anything',
      headers: { [ORIGIN_GUARD_HEADER]: 'not-the-secret' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admits a request carrying the secret', async () => {
    const instance = await build(config());
    const res = await instance.inject({
      method: 'GET',
      url: '/v1/anything',
      headers: { [ORIGIN_GUARD_HEADER]: SECRET },
    });
    expect(res.statusCode).toBe(200);
  });

  it('discloses nothing in the refusal body', async () => {
    // A prober should learn "closed", not which header would open it.
    const instance = await build(config());
    const res = await instance.inject({ method: 'GET', url: '/v1/anything' });
    expect(res.body).toBe('');
    expect(res.body).not.toContain(ORIGIN_GUARD_HEADER);
  });

  it('is NOT installed when no secret is configured', async () => {
    // Must stay byte-for-byte inert until the edge rule exists — setting the
    // variable first would lock out every real visitor.
    const instance = await build(config({ originGuardSecret: undefined }));
    const res = await instance.inject({ method: 'GET', url: '/v1/anything' });
    expect(res.statusCode).toBe(200);
  });
});

describe('origin guard: the platform healthcheck must never be blocked', () => {
  // This is the footgun that would hurt most. Railway hits /ready on the
  // INTERNAL address, so it carries no edge header. Guarding it fails the
  // healthcheck, which restarts the container — and scripts/start-railway.sh
  // binds the API and the RELEASE WORKER to one lifecycle, so a guarded /ready
  // is a permanent restart loop on the engine that watches for the owner's
  // silence. A "fix" that removes these exemptions is a bug.
  it.each(['/ready', '/health'])('%s answers without the guard header', async (path) => {
    const instance = await build(config());
    const res = await instance.inject({ method: 'GET', url: path });
    expect(res.statusCode).toBe(200);
  });

  it('exempts the healthcheck even with a query string', async () => {
    const instance = await build(config());
    const res = await instance.inject({ method: 'GET', url: '/ready?probe=1' });
    expect(res.statusCode).toBe(200);
  });

  it('does not let the exemption be widened by a path prefix', async () => {
    // /ready is exact-matched; /readyish or /ready/../v1 must not slip through.
    const instance = await build(config());
    const res = await instance.inject({ method: 'GET', url: '/readyish' });
    expect(res.statusCode).toBe(403);
  });
});
