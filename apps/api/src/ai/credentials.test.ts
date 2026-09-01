import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeGoogleCredentials } from './credentials.js';

// Capture what the function writes to each raw stream. Railway (and most PaaS)
// tag everything on stderr as ERROR severity, so stream choice IS the severity.
function captureStreams(fn: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => (out.push(String(chunk)), true));
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => (err.push(String(chunk)), true));
  try {
    fn();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out: out.join(''), err: err.join('') };
}

// Each successful call now writes into its OWN mkdtemp directory (audit F-2: no
// fixed, predictable path), so the tests read the resulting location from the env
// rather than assuming a path, and clean up that directory afterwards.
let written: string | undefined;

afterEach(() => {
  // Only remove paths WE created under the temp dir — never the clobber test's
  // fake '/an/existing/path.json'.
  if (written !== undefined && written.startsWith(tmpdir())) {
    try {
      rmSync(dirname(written), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  written = undefined;
});

describe('materializeGoogleCredentials', () => {
  it('writes the SA JSON to a private 0600 temp file and points ADC at it', () => {
    const env: NodeJS.ProcessEnv = {
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account","project_id":"p1"}',
    };
    materializeGoogleCredentials(env);
    written = env['GOOGLE_APPLICATION_CREDENTIALS'];
    expect(written).toBeDefined();
    expect(existsSync(written as string)).toBe(true);
    expect(
      (JSON.parse(readFileSync(written as string, 'utf8')) as { project_id: string }).project_id,
    ).toBe('p1');
    // audit F-2: the key file must be owner-only (0600).
    expect(statSync(written as string).mode & 0o777).toBe(0o600);
  });

  it('accepts base64-encoded JSON (Railway-safe) and writes the decoded key', () => {
    const decoded = '{"type":"service_account","project_id":"p2"}';
    const env: NodeJS.ProcessEnv = {
      GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(decoded).toString('base64'),
    };
    materializeGoogleCredentials(env);
    written = env['GOOGLE_APPLICATION_CREDENTIALS'];
    expect(written).toBeDefined();
    expect(
      (JSON.parse(readFileSync(written as string, 'utf8')) as { project_id: string }).project_id,
    ).toBe('p2');
  });

  it('rejects a web-UI-corrupted raw paste like `"{` (fail-soft)', () => {
    const env: NodeJS.ProcessEnv = { GOOGLE_SERVICE_ACCOUNT_JSON: '"{' };
    materializeGoogleCredentials(env);
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined();
  });

  it('is a no-op when the var is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    materializeGoogleCredentials(env);
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined();
  });

  it('does not clobber an explicit GOOGLE_APPLICATION_CREDENTIALS', () => {
    const env: NodeJS.ProcessEnv = {
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}',
      GOOGLE_APPLICATION_CREDENTIALS: '/an/existing/path.json',
    };
    materializeGoogleCredentials(env);
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBe('/an/existing/path.json');
  });

  it('is fail-soft on malformed JSON (no throw, ADC not set)', () => {
    const env: NodeJS.ProcessEnv = { GOOGLE_SERVICE_ACCOUNT_JSON: 'not valid json' };
    expect(() => materializeGoogleCredentials(env)).not.toThrow();
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined();
  });

  // A healthy boot must not log as an error (2026-07-18): the success notice went
  // to stderr, which Railway renders as a red "error" every deploy.
  it('writes the success notice to stdout, never stderr', () => {
    const env: NodeJS.ProcessEnv = {
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account","project_id":"p3"}',
    };
    const { out, err } = captureStreams(() => materializeGoogleCredentials(env));
    written = env['GOOGLE_APPLICATION_CREDENTIALS'];
    expect(out).toContain('Vertex credentials materialized');
    expect(err).toBe('');
  });

  // The one genuinely degraded path (AI can't authenticate) stays on stderr so an
  // operator actually notices the misconfiguration.
  it('writes the malformed-JSON warning to stderr, never stdout', () => {
    const env: NodeJS.ProcessEnv = { GOOGLE_SERVICE_ACCOUNT_JSON: 'not valid json' };
    const { out, err } = captureStreams(() => materializeGoogleCredentials(env));
    expect(err).toContain('neither valid JSON nor base64');
    expect(out).toBe('');
  });
});
