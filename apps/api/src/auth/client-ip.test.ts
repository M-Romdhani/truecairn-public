import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerClientIp, resolveClientIp } from './client-ip.js';
import { clientIp } from './rate-limit-route.js';
import type { ApiConfig } from '../config.js';

// ── The client IP must never be client-controlled (QA 2026-08-26 F1) ─────────
//
// Regression pin for a real defect: `clientIp()` returned the LEFTMOST
// X-Forwarded-For entry, which is the value the client supplies. Every per-IP
// control keyed on it — login, passkey, step-up TOTP (whose only app-layer brake
// this is, by design: it has no per-account lock), the AI ceilings and the
// sustained-abuse signal — so rotating one header per request defeated all of
// them at once.
//
// The shape of a real chain matters and is why the old code looked fine: both
// Cloudflare and Railway APPEND to the RIGHT, so anything the client sent stays
// leftmost and looks exactly like an origin-most hop.
const SPOOFED = '9.9.9.9';
const CLOUDFLARE_HOP = '172.68.1.1';
const RAILWAY_HOP = '10.0.0.5';
const REAL_CLIENT = '203.0.113.7';
const FORGED_CHAIN = `${SPOOFED}, ${CLOUDFLARE_HOP}, ${RAILWAY_HOP}`;

function config(over: Partial<ApiConfig> = {}): ApiConfig {
  return { trustProxy: true, clientIpHeader: undefined, originGuardSecret: undefined, ...over } as ApiConfig;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

// Boot a real Fastify with the hook installed and report what the throttles
// would key on for a given set of request headers.
async function bucketFor(
  cfg: ApiConfig,
  headers: Record<string, string>,
  opts: { trustProxy?: boolean; remoteAddress?: string } = {},
): Promise<string> {
  app = Fastify({ trustProxy: opts.trustProxy ?? true });
  registerClientIp(app, cfg);
  let seen = '';
  app.get('/probe', (request) => {
    seen = clientIp(request);
    return { ok: true };
  });
  await app.ready();
  await app.inject({
    method: 'GET',
    url: '/probe',
    headers,
    remoteAddress: opts.remoteAddress ?? RAILWAY_HOP,
  });
  return seen;
}

describe('clientIp: a forged X-Forwarded-For cannot choose the rate-limit bucket', () => {
  it('ignores the leftmost XFF entry when a trusted header is configured', async () => {
    const bucket = await bucketFor(config({ clientIpHeader: 'cf-connecting-ip' }), {
      'x-forwarded-for': FORGED_CHAIN,
      'cf-connecting-ip': REAL_CLIENT,
    });
    expect(bucket).toBe(REAL_CLIENT);
    expect(bucket).not.toBe(SPOOFED);
  });

  it('ignores XFF entirely when no trusted header is configured', async () => {
    // The pre-fix code returned SPOOFED here under trustProxy:true. Falling back
    // to the socket peer is coarse but never client-chosen.
    const bucket = await bucketFor(config(), { 'x-forwarded-for': FORGED_CHAIN });
    expect(bucket).toBe(RAILWAY_HOP);
    expect(bucket).not.toBe(SPOOFED);
  });

  it('does not fall back to XFF when the trusted header is missing', async () => {
    // The dangerous case: attacker omits cf-connecting-ip and supplies XFF,
    // hoping we degrade to it. We must degrade to the socket, not the header.
    const bucket = await bucketFor(config({ clientIpHeader: 'cf-connecting-ip' }), {
      'x-forwarded-for': FORGED_CHAIN,
    });
    expect(bucket).toBe(RAILWAY_HOP);
    expect(bucket).not.toBe(SPOOFED);
  });

  it('is not rescued or broken by TRUST_PROXY either way', async () => {
    // Measured 2026-08-26: the old defect reproduced under BOTH settings, so
    // neither value may quietly become load-bearing again.
    for (const trustProxy of [true, false]) {
      const bucket = await bucketFor(config({ clientIpHeader: 'cf-connecting-ip' }), {
        'x-forwarded-for': FORGED_CHAIN,
        'cf-connecting-ip': REAL_CLIENT,
      }, { trustProxy });
      expect(bucket, `trustProxy=${String(trustProxy)}`).toBe(REAL_CLIENT);
      await app?.close();
      app = null;
    }
  });

  it('cannot be split into many buckets by rotating the forged header', async () => {
    // The actual attack: one attacker, N distinct buckets. All requests must
    // land in ONE bucket, whatever they claim.
    const buckets = new Set<string>();
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      buckets.add(
        await bucketFor(config({ clientIpHeader: 'cf-connecting-ip' }), {
          'x-forwarded-for': `${forged}, ${CLOUDFLARE_HOP}`,
          'cf-connecting-ip': REAL_CLIENT,
        }),
      );
      await app?.close();
      app = null;
    }
    expect(buckets).toEqual(new Set([REAL_CLIENT]));
  });

  it('refuses a DUPLICATED trusted header instead of picking a half', async () => {
    // Regression pin for a hole this suite found in the fix itself (2026-08-27).
    // Node JOINS duplicate headers into one comma-separated string rather than
    // an array, so a client that also sends `cf-connecting-ip` yielded
    // "<edge>,<client>" — and an implementation that took one half let the
    // attacker vary the bucket again. Ambiguity must fall back to the socket.
    app = Fastify({ trustProxy: true });
    registerClientIp(app, config({ clientIpHeader: 'cf-connecting-ip' }));
    let seen = '';
    app.get('/probe', (request) => {
      seen = clientIp(request);
      return { ok: true };
    });
    await app.ready();
    await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'cf-connecting-ip': [REAL_CLIENT, SPOOFED] as unknown as string },
      remoteAddress: RAILWAY_HOP,
    });
    expect(seen).toBe(RAILWAY_HOP);
    expect(seen).not.toContain(SPOOFED);
  });

  it('cannot be split into buckets by varying the appended duplicate', async () => {
    // The attack the previous case would have permitted, stated directly.
    const buckets = new Set<string>();
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      app = Fastify({ trustProxy: true });
      registerClientIp(app, config({ clientIpHeader: 'cf-connecting-ip' }));
      let seen = '';
      app.get('/probe', (request) => {
        seen = clientIp(request);
        return { ok: true };
      });
      await app.ready();
      await app.inject({
        method: 'GET',
        url: '/probe',
        headers: { 'cf-connecting-ip': [REAL_CLIENT, forged] as unknown as string },
        remoteAddress: RAILWAY_HOP,
      });
      buckets.add(seen);
      await app.close();
      app = null;
    }
    expect(buckets.size).toBe(1);
  });
});

describe('clientIp: the invariant holds even without the hook', () => {
  it('falls back to the socket peer, not request.ip, on a bare instance', async () => {
    // A unit test that stands up Fastify without registerClientIp must not get
    // the spoofable value — otherwise the fix is only as good as remembering
    // to install it.
    app = Fastify({ trustProxy: true });
    let seen = '';
    app.get('/probe', (request) => {
      seen = clientIp(request);
      return { ok: true };
    });
    await app.ready();
    await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-forwarded-for': FORGED_CHAIN },
      remoteAddress: RAILWAY_HOP,
    });
    expect(seen).toBe(RAILWAY_HOP);
    expect(seen).not.toBe(SPOOFED);
  });
});

describe('resolveClientIp: header name handling', () => {
  const req = (headers: Record<string, unknown>): Parameters<typeof resolveClientIp>[0] =>
    ({ headers, socket: { remoteAddress: RAILWAY_HOP } }) as unknown as Parameters<typeof resolveClientIp>[0];

  it('ignores a blank trusted header rather than bucketing on empty string', () => {
    expect(resolveClientIp(req({ 'cf-connecting-ip': '   ' }), config({ clientIpHeader: 'cf-connecting-ip' }))).toBe(
      RAILWAY_HOP,
    );
  });

  it('trims surrounding whitespace', () => {
    expect(resolveClientIp(req({ 'cf-connecting-ip': ` ${REAL_CLIENT} ` }), config({ clientIpHeader: 'cf-connecting-ip' }))).toBe(
      REAL_CLIENT,
    );
  });

  it('returns a stable constant when even the socket is unavailable', () => {
    const bare = { headers: {}, socket: {} } as unknown as Parameters<typeof resolveClientIp>[0];
    expect(resolveClientIp(bare, config())).toBe('unknown');
  });
});
