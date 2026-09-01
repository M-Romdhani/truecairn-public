import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { loggerOptions, NEVER_LOG_FIELDS } from './logging.js';

// 2026-08-07 audit, finding 10. The redaction paths are a BACKSTOP — the control
// that actually protects us is never logging request/response bodies at all
// (registerRequestLogging emits an explicit field list). These pin the backstop's
// reach so it is worth what it looks worth: pino's `*` matches exactly ONE level,
// so `*.passphrase` censored {a:{passphrase}} and sailed straight past
// {a:{b:{passphrase}}}.
//
// Driven through Fastify rather than pino directly: pino is not a direct
// dependency here (it arrives via Fastify), and this exercises the same logger
// the app actually builds rather than a lookalike.
function captureLog(obj: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  const app = Fastify({ logger: { ...loggerOptions, level: 'info', stream: sink } });
  app.log.info(obj, 'test');
  return out;
}

describe('log redaction depth', () => {
  it('censors a sensitive field nested several levels deep', () => {
    for (const depth of [1, 2, 3, 4]) {
      let node: Record<string, unknown> = { passphrase: 'SECRET-VALUE' };
      for (let i = 0; i < depth - 1; i++) node = { nested: node };
      const line = captureLog({ payload: node });
      expect(line, `depth ${depth}`).not.toContain('SECRET-VALUE');
      expect(line, `depth ${depth}`).toContain('[REDACTED]');
    }
  });

  it('covers every name in NEVER_LOG_FIELDS, not just the one we thought of', () => {
    for (const field of NEVER_LOG_FIELDS) {
      const line = captureLog({ payload: { inner: { [field]: 'SECRET-VALUE' } } });
      expect(line, field).not.toContain('SECRET-VALUE');
    }
  });

  it('leaves ordinary fields alone', () => {
    const line = captureLog({ payload: { inner: { itemCount: 4 } } });
    expect(line).toContain('4');
    expect(line).not.toContain('[REDACTED]');
  });
});
