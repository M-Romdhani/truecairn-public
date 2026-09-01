import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Railway (and most PaaS) inject secrets as env vars, not files — but Vertex AI's
// Application Default Credentials wants a service-account KEY FILE. Bridge the gap:
// if GOOGLE_SERVICE_ACCOUNT_JSON holds the raw key JSON and an explicit
// GOOGLE_APPLICATION_CREDENTIALS path isn't already set, write the JSON to a private
// temp file and point ADC at it. Called once at API startup, before any Vertex call.
//
// The SA key is GCP-auth INFRA, not a zero-knowledge secret (no vault content,
// passphrase, key, or share), so a container-local 0600 temp file is acceptable and
// never crosses CLAUDE.md invariant #1; it is never logged. Fail-soft: malformed
// JSON logs a one-line warning and is skipped (Vertex then can't authenticate, so
// the AI features fail-soft at call time).
export function materializeGoogleCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env['GOOGLE_SERVICE_ACCOUNT_JSON'];
  if (raw === undefined || raw.trim() === '') return;
  // Don't clobber an explicit credentials file (e.g. a real ADC path in dev).
  const existing = env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (existing !== undefined && existing !== '') return;

  // Accept EITHER raw JSON or base64-encoded JSON. PaaS variable editors (e.g.
  // Railway's web UI) corrupt values containing quotes/braces/newlines, so base64
  // — a blob of [A-Za-z0-9+/=] with none of those — is the reliable carrier. The
  // base64 alphabet never starts with '{', so the discriminator is unambiguous;
  // a corrupted raw paste (e.g. `"{`) decodes to garbage and is rejected below.
  const trimmed = raw.trim();
  const json = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');

  try {
    JSON.parse(json);
  } catch {
    process.stderr.write(
      '[ai] GOOGLE_SERVICE_ACCOUNT_JSON is neither valid JSON nor base64-of-JSON; Vertex credentials not configured\n',
    );
    return;
  }

  // Write into a FRESH per-process private directory and create the file
  // EXCLUSIVELY (audit F-2). The old code wrote to a FIXED path
  // (tmpdir()/truecairn-gcp-sa.json): on a shared host a pre-planted symlink could
  // redirect the write, or a pre-existing world-readable file could keep loose
  // permissions (writeFileSync follows symlinks and won't re-chmod an existing
  // file). mkdtemp makes a 0700 directory with a random, unguessable name, and the
  // 'wx' flag (O_CREAT|O_EXCL) refuses to follow a symlink or reuse an existing
  // file — so the key lands in a fresh owner-only (0600) file every time.
  const dir = mkdtempSync(join(tmpdir(), 'truecairn-gcp-'));
  const path = join(dir, 'sa.json');
  writeFileSync(path, json, { mode: 0o600, flag: 'wx' });
  env['GOOGLE_APPLICATION_CREDENTIALS'] = path;
  // SUCCESS notice → stdout (info), NOT stderr. This runs before the pino logger
  // exists, so it uses raw stream writes; Railway (and most PaaS) tag everything on
  // stderr as ERROR severity, so writing this here made a healthy boot log a red
  // "error" every deploy. Keep it on stdout — only the malformed-JSON path above is
  // a real problem and stays on stderr.
  process.stdout.write('[ai] Vertex credentials materialized from GOOGLE_SERVICE_ACCOUNT_JSON\n');
}
