import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 2026-07-18 production stall regression. libsodium (@truecairn/crypto) loads
// asynchronously and MUST be initialised before any crypto op; the API does this
// in app.ts's onReady hook. The worker entrypoint (main.ts) originally did NOT,
// so the ONE worker path that touches libsodium — the set_vault_item_tier outer-
// layer re-wrap — threw "initCrypto() must be awaited before calling crypto
// operations" on every tick, failing three tier-moves invisibly for 15h. Nothing
// else in the tick uses libsodium, so the loop looked healthy.
//
// The integration tests for the tier-move handler pass because their harness
// calls initCrypto() in beforeAll — exactly why they never caught the missing
// entrypoint init. This source scan pins the entrypoint invariant directly: the
// worker MUST await initCrypto() before it starts the loop. A "fix" that drops
// the call reopens the stall.

const mainSrc = readFileSync(
  fileURLToPath(new URL('./main.ts', import.meta.url)),
  'utf8',
);

describe('worker entrypoint initialises libsodium before the loop', () => {
  it('imports initCrypto from @truecairn/crypto', () => {
    expect(mainSrc).toMatch(/import\s*\{[^}]*\binitCrypto\b[^}]*\}\s*from\s*'@truecairn\/crypto'/);
  });

  it('awaits initCrypto() before calling runLoop()', () => {
    const initAt = mainSrc.indexOf('await initCrypto()');
    const loopAt = mainSrc.indexOf('runLoop(');
    expect(initAt, 'main.ts must await initCrypto()').toBeGreaterThanOrEqual(0);
    expect(loopAt, 'main.ts must call runLoop()').toBeGreaterThanOrEqual(0);
    expect(initAt).toBeLessThan(loopAt);
  });
});
