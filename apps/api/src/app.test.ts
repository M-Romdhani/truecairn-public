import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { APP_VERSION, loadConfig } from './config.js';
import { NEVER_LOG_FIELDS } from './logging.js';

// The endpoint test pattern for Phase 3: build the app, exercise it with
// app.inject() (Fastify's in-process request injection — no socket, no
// supertest), assert the response. Every subsequent endpoint follows this.

let app: FastifyInstance;

beforeEach(() => {
  // logLevel 'silent' keeps test output clean; everything else is real.
  app = buildApp({ ...loadConfig({}), logLevel: 'silent' });
});

afterEach(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns 200 with the documented body', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe(APP_VERSION);
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('response is serialized against the JSON Schema (no extra fields)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(Object.keys(res.json()).sort()).toEqual(['status', 'uptimeSeconds', 'version']);
  });
});

describe('error shape (RFC 7807)', () => {
  it('an unknown route returns a problem+json 404 in the standard shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body.status).toBe(404);
    expect(body.title).toBe('Not Found');
    expect(typeof body.instance).toBe('string'); // request id
    expect(body.type).toBe('about:blank');
  });

  it('a thrown ApiError renders as its problem shape', async () => {
    // Register a throwaway route that throws an ApiError to prove the handler.
    const { badRequest } = await import('./errors.js');
    app.get('/boom', async () => {
      throw badRequest('the thing was malformed');
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body.title).toBe('Bad Request');
    expect(body.detail).toBe('the thing was malformed');
    expect(body.status).toBe(400);
  });

  it('an unexpected error becomes a generic 500 that leaks nothing', async () => {
    app.get('/explode', async () => {
      throw new Error('secret internal detail: db password is hunter2');
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/explode' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.title).toBe('Internal Server Error');
    // The internal message must NOT appear in the response.
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});

describe('logging discipline', () => {
  it('declares the never-log field list (sensitive material guard)', () => {
    // A guard test: if someone removes a field from the never-log list, this
    // fails loudly. The list is the documented contract.
    for (const f of ['passphrase', 'recoveryCode', 'share', 'ciphertext', 'sessionToken']) {
      expect(NEVER_LOG_FIELDS).toContain(f);
    }
  });
});
