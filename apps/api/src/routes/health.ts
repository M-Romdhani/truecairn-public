import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../config.js';

// The example endpoint that sets the route + native-JSON-Schema convention for
// Phase 3. Every route declares its response (and, later, body/params/query)
// as JSON Schema in `schema`; Fastify validates and serializes against it, and
// the schema doubles as the source for an OpenAPI export if we ever want one.
//
// /health is intentionally DB-free so it is always answerable and the scaffold
// test needs no database. A DB-backed readiness probe arrives with the DB
// wiring in 3.1.

export function healthRoutes(app: FastifyInstance): void {
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'version', 'uptimeSeconds'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              version: { type: 'string' },
              uptimeSeconds: { type: 'number' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
}
