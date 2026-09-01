import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initCrypto } from '@truecairn/crypto';
import * as keys from '@truecairn/keys';
import { generateEnrollmentMaterial } from './enrollment.js';
import type { KeyMaterial } from './material.js';
import * as session from './session.js';

const enc = new TextEncoder();
const pw = (s: string): Uint8Array => enc.encode(s);

// One enrollment shared across tests (each is a production-params Argon2id, so
// generating once keeps the suite quick). The material is ciphertext-only and
// safe to reuse; the passphrase is re-encoded fresh per unlock (unlock zeroizes
// the buffer it's handed).
const PASSPHRASE = 'session-test-passphrase';
let material: KeyMaterial;

beforeAll(async () => {
  await initCrypto();
  material = generateEnrollmentMaterial(pw(PASSPHRASE)).material;
});

afterEach(() => {
  session.lock();
  session.configureAutoLock({ idleMs: session.DEFAULT_IDLE_MS });
  vi.useRealTimers();
});

describe('crypto session (PHASE4 C1)', () => {
  it('starts locked; unlock makes it usable; lock makes operations throw', () => {
    expect(session.isUnlocked()).toBe(false);
    expect(() => session.signWithUserKey(new Uint8Array([1]))).toThrow(/locked/);

    session.unlock(pw(PASSPHRASE), material);
    expect(session.isUnlocked()).toBe(true);
    const sig = session.signWithUserKey(new Uint8Array([1, 2, 3]));
    expect(sig).toHaveLength(64); // Ed25519 detached signature

    session.lock();
    expect(session.isUnlocked()).toBe(false);
    expect(() => session.withTierKey('s1', () => 1)).toThrow(/locked/);
  });

  it('zeroizes the passphrase buffer it is handed (plaintext-lifetime discipline)', () => {
    const buf = pw(PASSPHRASE);
    expect(buf.some((b) => b !== 0)).toBe(true);
    session.unlock(buf, material);
    expect(buf.every((b) => b === 0)).toBe(true); // wiped the instant the KEK was derived
  });

  it('lock zeroizes the in-memory master key buffer (the same buffer, in place)', () => {
    // Capture the exact master-key buffer the session holds (spyOn calls through
    // and records the real return value).
    const spy = vi.spyOn(keys, 'unwrapMasterKeyByPassphrase');
    session.unlock(pw(PASSPHRASE), material);
    expect(spy.mock.results).toHaveLength(1);
    const masterKey = spy.mock.results[0]!.value as Uint8Array;
    expect(masterKey).toHaveLength(32);
    expect(masterKey.some((b) => b !== 0)).toBe(true); // live while unlocked

    session.lock();
    expect(masterKey.every((b) => b === 0)).toBe(true); // memzero'd on lock
    spy.mockRestore();
  });

  it('rejects a wrong passphrase and holds nothing', () => {
    expect(() => session.unlock(pw('not-the-passphrase'), material)).toThrow();
    expect(session.isUnlocked()).toBe(false);
  });

  it('enforces the auto-lock idle bounds (1 min .. 60 min)', () => {
    expect(() => session.configureAutoLock({ idleMs: 30_000 })).toThrow(/idleMs/);
    expect(() => session.configureAutoLock({ idleMs: 2 * 60 * 60_000 })).toThrow(/idleMs/);
    expect(() => session.configureAutoLock({ idleMs: 60_000 })).not.toThrow();
    expect(() => session.configureAutoLock({ idleMs: 60 * 60_000 })).not.toThrow();
  });

  it('auto-locks after the idle timeout, zeroizing the key and firing onLock', () => {
    vi.useFakeTimers();
    const onLock = vi.fn();
    session.configureAutoLock({ idleMs: session.MIN_IDLE_MS, onLock });
    session.unlock(pw(PASSPHRASE), material);
    expect(session.isUnlocked()).toBe(true);

    // Just before the deadline: activity re-arms the timer (no lock yet).
    vi.advanceTimersByTime(session.MIN_IDLE_MS - 1);
    session.noteActivity();
    vi.advanceTimersByTime(session.MIN_IDLE_MS - 1);
    expect(session.isUnlocked()).toBe(true);
    expect(onLock).not.toHaveBeenCalled();

    // Cross the (re-armed) deadline with no activity: auto-lock fires once.
    vi.advanceTimersByTime(1);
    expect(session.isUnlocked()).toBe(false);
    expect(onLock).toHaveBeenCalledTimes(1);
  });
});
