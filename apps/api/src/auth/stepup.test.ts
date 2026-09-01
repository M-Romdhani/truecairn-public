import { beforeAll, describe, expect, it } from 'vitest';
import {
  ed25519Sign,
  ed25519Verify,
  generateEd25519Keypair,
  initCrypto,
} from '@truecairn/crypto';
import { buildStepUpSigningInput } from './stepup.js';

beforeAll(async () => {
  await initCrypto();
});

const USER_ID = '11111111-2222-3333-4444-555555555555';

describe('buildStepUpSigningInput (canonical, reuses audit lp/uuid16/canonicalJson)', () => {
  it('is deterministic for identical inputs', () => {
    const ch = new Uint8Array(32).fill(7);
    const a = buildStepUpSigningInput(USER_ID, 'register_hardware_key', ch, { x: 1 });
    const b = buildStepUpSigningInput(USER_ID, 'register_hardware_key', ch, { x: 1 });
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });

  it('starts with the version byte and the domain-tag length prefix', () => {
    const out = buildStepUpSigningInput(USER_ID, 'a', new Uint8Array(32), {});
    expect(out[0]).toBe(0x01);
    // lp(domain) — 4-byte big-endian length of "truecairn.stepup.v1" (19).
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(0);
    expect(out[4]).toBe(19);
  });

  it('changes if the action type changes (binds the action)', () => {
    const ch = new Uint8Array(32).fill(1);
    const a = buildStepUpSigningInput(USER_ID, 'register_hardware_key', ch, {});
    const b = buildStepUpSigningInput(USER_ID, 'totp_setup', ch, {});
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it('changes if the challenge changes (binds the attempt)', () => {
    const a = buildStepUpSigningInput(USER_ID, 'x', new Uint8Array(32).fill(1), {});
    const b = buildStepUpSigningInput(USER_ID, 'x', new Uint8Array(32).fill(2), {});
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it('changes if the action params change (binds the body)', () => {
    const ch = new Uint8Array(32).fill(1);
    const a = buildStepUpSigningInput(USER_ID, 'x', ch, { nickname: 'yubikey' });
    const b = buildStepUpSigningInput(USER_ID, 'x', ch, { nickname: 'other' });
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it('produces bytes an Ed25519 keypair can sign and verify', () => {
    const kp = generateEd25519Keypair();
    const payload = buildStepUpSigningInput(USER_ID, 'x', new Uint8Array(32).fill(3), { a: 1 });
    const sig = ed25519Sign(payload, kp.secretKey);
    expect(ed25519Verify(sig, payload, kp.publicKey)).toBe(true);
    const tampered = buildStepUpSigningInput(USER_ID, 'x', new Uint8Array(32).fill(4), { a: 1 });
    expect(ed25519Verify(sig, tampered, kp.publicKey)).toBe(false);
  });
});
