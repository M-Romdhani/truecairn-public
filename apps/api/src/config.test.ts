import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

// The AI Guardian guardrail config (plan docs/25 §4/§9). The load-bearing
// properties: SAFE defaults, a master kill switch, per-phase flags off, unbounded
// budgets until opted-in, and — critically — NO input here may throw at boot.
describe('config: AI controls', () => {
  // A minimal durable-secret set so loadConfig() doesn't need production guards;
  // NODE_ENV defaults to development so ephemeral KEKs are allowed.
  const base = { TOTP_KEK: Buffer.alloc(32, 7).toString('base64') };

  it('defaults preserve today behaviour: master on, all phases off, budgets unbounded', () => {
    const { ai } = loadConfig(base);
    expect(ai.enabled).toBe(true);
    expect(ai.proposerEnabled).toBe(false);
    expect(ai.autonomyEnabled).toBe(false);
    expect(ai.guardianEnabled).toBe(false);
    expect(ai.dailyTokenBudget).toBeUndefined();
    expect(ai.userDailyTokenBudget).toBeUndefined();
  });

  it('AI_ENABLED accepts the permissive off spellings', () => {
    for (const off of ['false', '0', 'no', 'off', 'FALSE', 'Off']) {
      expect(loadConfig({ ...base, AI_ENABLED: off }).ai.enabled).toBe(false);
    }
    for (const on of ['true', '1', 'yes', 'on']) {
      expect(loadConfig({ ...base, AI_ENABLED: on }).ai.enabled).toBe(true);
    }
    // Garbage falls back to the default (true), never throws.
    expect(loadConfig({ ...base, AI_ENABLED: 'maybe' }).ai.enabled).toBe(true);
  });

  it('per-phase flags are opt-in true', () => {
    const { ai } = loadConfig({
      ...base,
      AI_PROPOSER_ENABLED: 'true',
      AI_AUTONOMY_ENABLED: '1',
      AI_GUARDIAN_ENABLED: 'on',
    });
    expect(ai.proposerEnabled).toBe(true);
    expect(ai.autonomyEnabled).toBe(true);
    expect(ai.guardianEnabled).toBe(true);
  });

  it('budgets: positive ints parse, zero/negative/garbage stay unbounded (never 0)', () => {
    expect(loadConfig({ ...base, AI_DAILY_TOKEN_BUDGET: '500000' }).ai.dailyTokenBudget).toBe(500000);
    // A 0 or invalid budget must NOT resolve to 0 (which would wedge AI off) —
    // it means "unbounded".
    expect(loadConfig({ ...base, AI_DAILY_TOKEN_BUDGET: '0' }).ai.dailyTokenBudget).toBeUndefined();
    expect(loadConfig({ ...base, AI_DAILY_TOKEN_BUDGET: '-5' }).ai.dailyTokenBudget).toBeUndefined();
    expect(loadConfig({ ...base, AI_DAILY_TOKEN_BUDGET: 'lots' }).ai.dailyTokenBudget).toBeUndefined();
  });

  it('rate-limit ceilings default sensibly and override via env', () => {
    const def = loadConfig(base).ai.rateLimits;
    expect(def.windowMs).toBe(3_600_000);
    expect(def.assistPerUser).toBe(20);
    expect(def.assistPerIp).toBe(60);

    const over = loadConfig({ ...base, AI_RATE_ASSIST_PER_USER: '5', AI_RATE_WINDOW_MS: '60000' })
      .ai.rateLimits;
    expect(over.assistPerUser).toBe(5);
    expect(over.windowMs).toBe(60_000);
  });

  it('a ceiling of ZERO means zero, not the default (audit finding 7)', () => {
    // The parser was borrowed from byte SIZES, where 0 is meaningless, and
    // rejected it — so an operator setting AI_RATE_ASSIST_PER_USER=0 to hard-block
    // assist during an incident silently got 20. A fail-OPEN, in the direction
    // nobody thinks to re-check.
    const cfg = loadConfig({ ...base, AI_RATE_ASSIST_PER_USER: '0', AI_RATE_NARRATION_PER_IP: '0' });
    expect(cfg.ai.rateLimits.assistPerUser).toBe(0);
    expect(cfg.ai.rateLimits.narrationPerIp).toBe(0);
    // A genuinely invalid value still falls back — a typo must not stop the boot.
    expect(loadConfig({ ...base, AI_RATE_ASSIST_PER_USER: 'lots' }).ai.rateLimits.assistPerUser).toBe(20);
    expect(loadConfig({ ...base, AI_RATE_ASSIST_PER_USER: '-5' }).ai.rateLimits.assistPerUser).toBe(20);
  });

  it('never refuses boot on a bad AI value (AI config is fail-soft, not fail-closed)', () => {
    expect(() =>
      loadConfig({
        ...base,
        AI_ENABLED: 'garbage',
        AI_DAILY_TOKEN_BUDGET: 'NaN',
        AI_RATE_ASSIST_PER_USER: '-1',
      }),
    ).not.toThrow();
  });
});

// The revocation window is a PUBLIC promise (48h on the marketing/transparency
// pages). QA 2026-07-21 D5 caught a demo deployment running the CI E2E value
// (1s) — contacts effectively could not revoke. Production boots must refuse a
// compressed window unless the operator explicitly acknowledges a drill.
describe('config: ceremony-window production floor', () => {
  const prod = {
    NODE_ENV: 'production',
    TOTP_KEK: Buffer.alloc(32, 7).toString('base64'),
    IP_HASH_PEPPER: Buffer.alloc(16, 9).toString('base64'),
    OUTER_LAYER_KEK: Buffer.alloc(32, 5).toString('base64'),
    // Required in production since 2026-08-07 (audit finding 9) — the session
    // cookie's Secure flag is derived from this value's scheme.
    WEBAUTHN_ORIGIN: 'https://truecairn.app',
  };

  it('defaults to 48h windows', () => {
    const { ceremonyWindows } = loadConfig({ TOTP_KEK: prod.TOTP_KEK });
    expect(ceremonyWindows.syncWindowMs).toBe(48 * 60 * 60 * 1000);
    expect(ceremonyWindows.revocationWindowMs).toBe(48 * 60 * 60 * 1000);
  });

  it('production refuses a non-https WEBAUTHN_ORIGIN (audit finding 9)', () => {
    // The session cookie's Secure flag is derived from this value's scheme, not
    // from NODE_ENV — so behind a TLS-terminating proxy a single mistyped env var
    // silently issued session cookies without Secure, and nothing said a word.
    // This file already refuses ephemeral KEKs and a sub-floor window in
    // production; a transport downgrade belongs in the same class.
    expect(() => loadConfig({ ...prod, WEBAUTHN_ORIGIN: 'http://truecairn.app' })).toThrow(
      /must be https:\/\/ in production/,
    );
    // Absent is equally wrong: the default is http://localhost:3001.
    const { WEBAUTHN_ORIGIN: _drop, ...noOrigin } = prod;
    expect(() => loadConfig(noOrigin)).toThrow(/must be https:\/\/ in production/);
    // Dev keeps the localhost convenience.
    expect(() => loadConfig({ TOTP_KEK: prod.TOTP_KEK })).not.toThrow();
  });

  it('production refuses a sub-hour revocation window', () => {
    expect(() => loadConfig({ ...prod, CEREMONY_REVOCATION_WINDOW_MS: '1000' })).toThrow(
      /below the production floor/,
    );
  });

  it('production accepts a compressed window only with the explicit drill acknowledgement', () => {
    const cfg = loadConfig({
      ...prod,
      CEREMONY_REVOCATION_WINDOW_MS: '1000',
      ALLOW_COMPRESSED_CEREMONY_WINDOWS: 'true',
    });
    expect(cfg.ceremonyWindows.revocationWindowMs).toBe(1000);
  });

  it('dev/test keep the compressed-window convenience (CI runs at 1s)', () => {
    const cfg = loadConfig({ TOTP_KEK: prod.TOTP_KEK, CEREMONY_REVOCATION_WINDOW_MS: '1000' });
    expect(cfg.ceremonyWindows.revocationWindowMs).toBe(1000);
  });
});
