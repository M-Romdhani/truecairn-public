import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createClient, schema, type Database } from '@truecairn/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';

describe('GET /ready (no database configured)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it('reports not_ready with 503 when there is no DB', async () => {
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready' });
  });
});

const url = process.env['DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;
type Sql = ReturnType<typeof createClient>['sql'];

describeIfDb('GET /ready (database reachable)', () => {
  let app: FastifyInstance;
  let db: Database;
  let sql: Sql;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports ready with 200 when the DB answers', async () => {
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' }, { db, sql });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });
});

// The worker is the sole release driver: if it dies, nothing releases and
// nothing escalates, while /health and /ready both stay green because the API
// and database are fine. This probe is the only thing that can tell a human.
describeIfDb('GET /health/worker (the release driver is the thing that can die quietly)', () => {
  let app: FastifyInstance;
  let db: Database;
  let sql: Sql;

  beforeAll(() => {
    const conn = createClient({ url: url! });
    db = conn.db;
    sql = conn.sql;
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });
  afterEach(async () => {
    await app.close();
  });

  const boot = (): void => {
    app = buildApp({ ...loadConfig({}), logLevel: 'silent' }, { db, sql });
  };
  const setTick = async (workerId: string, at: Date, errors = 0): Promise<void> => {
    await db
      .insert(schema.workerHeartbeats)
      .values({ workerId, lastTickAt: at, lastTickMs: 5, consecutiveErrors: errors })
      .onConflictDoUpdate({
        target: schema.workerHeartbeats.workerId,
        set: { lastTickAt: at, consecutiveErrors: errors },
      });
  };

  it('503s when NO worker has ever ticked — silence must not read as healthy', async () => {
    await sql`TRUNCATE worker_heartbeats`;
    boot();
    const res = await app.inject({ method: 'GET', url: '/health/worker' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('down');
  });

  it('200s on a fresh tick', async () => {
    await sql`TRUNCATE worker_heartbeats`;
    await setTick('w-fresh', new Date());
    boot();
    const res = await app.inject({ method: 'GET', url: '/health/worker' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', workerId: 'w-fresh' });
  });

  it('503s on a stale tick — this is the alert that matters', async () => {
    await sql`TRUNCATE worker_heartbeats`;
    await setTick('w-stale', new Date(Date.now() - 30 * 60 * 1000));
    boot();
    const res = await app.inject({ method: 'GET', url: '/health/worker' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'down', reason: 'worker heartbeat is stale' });
  });

  it('reads the FRESHEST worker — one live instance is enough to drive releases', async () => {
    await sql`TRUNCATE worker_heartbeats`;
    await setTick('w-dead', new Date(Date.now() - 60 * 60 * 1000));
    await setTick('w-live', new Date());
    boot();
    const res = await app.inject({ method: 'GET', url: '/health/worker' });
    expect(res.statusCode).toBe(200);
    expect(res.json().workerId).toBe('w-live');
  });

  it('surfaces alive-but-broken (ticking, but every batch throwing)', async () => {
    await sql`TRUNCATE worker_heartbeats`;
    await setTick('w-sick', new Date(), 17);
    boot();
    const res = await app.inject({ method: 'GET', url: '/health/worker' });
    expect(res.statusCode).toBe(200);
    expect(res.json().consecutiveErrors).toBe(17);
  });

  it('does NOT drag /ready down — a dead worker must not depool a healthy API', async () => {
    await sql`TRUNCATE worker_heartbeats`;
    await setTick('w-dead', new Date(Date.now() - 60 * 60 * 1000));
    boot();
    const worker = await app.inject({ method: 'GET', url: '/health/worker' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(worker.statusCode).toBe(503);
    // Restarting or depooling the web service would fix nothing here.
    expect(ready.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
  });
});
