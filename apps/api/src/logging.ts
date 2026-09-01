import type { FastifyInstance } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';

// Request-logging discipline, established in 3.0 and inherited by every Phase 3
// endpoint.
//
// WHAT WE LOG, per request (onResponse): request id, method, url (path only),
// status code, response time. Nothing else by default.
//
// WHAT WE NEVER LOG — this is a hard rule. None of the following may appear in
// any log line, ever:
//   - master / release / recovery passphrases or any passphrase field
//   - backup recovery codes
//   - Shamir shares (wrapped or unwrapped) and tier/item/outer-layer keys
//   - vault ciphertext or plaintext payloads
//   - session tokens, cookies, Authorization headers
//   - WebAuthn private material
//
// We do NOT log request bodies. Fastify's default request log already omits
// bodies; we keep it that way and add header redaction as defense in depth.
// If a future endpoint needs to log anything derived from a body, it must
// log only non-sensitive, explicitly-chosen fields — never the body object.

export const NEVER_LOG_FIELDS = [
  'passphrase',
  'masterPassphrase',
  'releasePassphrase',
  'recoveryCode',
  'share',
  'wrappedShare',
  'ciphertext',
  'plaintext',
  'sessionToken',
  'token',
  'password',
] as const;

// Pino redaction paths: censor sensitive request headers, and — as defense in
// depth — any of the never-log field names if they ever appear under a logged
// `body` object.
export const loggerOptions: PinoLoggerOptions = {
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      ...NEVER_LOG_FIELDS.map((f) => `req.body.${f}`),
      // Pino's `*` matches exactly ONE level, so `*.passphrase` censored
      // {a:{passphrase}} and missed {a:{b:{passphrase}}} (2026-08-07 audit,
      // finding 10). Pino cannot express arbitrary depth, so the realistic
      // nesting depths are enumerated instead.
      //
      // This is a BACKSTOP, and it is worth being clear that it is: the control
      // that actually protects us is never logging request/response bodies at all
      // (registerRequestLogging below emits an explicit field list). Nothing
      // currently logs a nested object containing these names. This is here for
      // the future call site that does.
      ...NEVER_LOG_FIELDS.flatMap((f) => [`*.${f}`, `*.*.${f}`, `*.*.*.${f}`, `*.*.*.*.${f}`]),
    ],
    censor: '[REDACTED]',
  },
};

// Structured per-request completion log with only safe fields. Replaces relying
// on Fastify's default res log so the shape is explicit and auditable.
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url.split('?')[0], // path only; never log query strings
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      'request.completed',
    );
    done();
  });
}
