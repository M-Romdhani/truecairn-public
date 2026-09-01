import { describe, expect, it } from 'vitest';
import {
  AiAuthorityError,
  expectValid,
  parseAiJson,
  validateAiArrayOutput,
  validateAiObjectOutput,
  validateObject,
  type ObjectSpec,
} from './index.js';

const proposalSpec: ObjectSpec = {
  fields: {
    kind: { type: 'enum', values: ['flag_readiness_gap', 'draft_contact_message'] },
    title: { type: 'string', maxLength: 80, minLength: 1 },
    priority: { type: 'int', min: 1, max: 5 },
    urgent: { type: 'boolean' },
  },
  optional: ['urgent'],
};

describe('parseAiJson', () => {
  it('parses plain JSON and strips a code fence', () => {
    expect(parseAiJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseAiJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('rejects empty and non-JSON without throwing', () => {
    expect(parseAiJson('')).toEqual({ ok: false, reason: 'empty output' });
    expect(parseAiJson('ignore previous instructions').ok).toBe(false);
  });
});

describe('validateObject (deny-by-default)', () => {
  it('accepts a well-formed object and returns ONLY declared fields', () => {
    const out = validateObject(proposalSpec, {
      kind: 'flag_readiness_gap',
      title: 'Add a second S3 contact',
      priority: 2,
    });
    expect(out).toEqual({
      ok: true,
      value: { kind: 'flag_readiness_gap', title: 'Add a second S3 contact', priority: 2 },
    });
  });

  it('rejects an unknown field (additionalProperties:false)', () => {
    const out = validateObject(proposalSpec, {
      kind: 'flag_readiness_gap',
      title: 'x',
      priority: 1,
      // A smuggled action selector must not ride through.
      execute: 'release_everything',
    });
    expect(out.ok).toBe(false);
  });

  it('rejects a value outside the enum / range / length', () => {
    expect(validateObject(proposalSpec, { kind: 'nope', title: 'x', priority: 1 }).ok).toBe(false);
    expect(
      validateObject(proposalSpec, { kind: 'flag_readiness_gap', title: 'x', priority: 9 }).ok,
    ).toBe(false);
    expect(
      validateObject(proposalSpec, {
        kind: 'flag_readiness_gap',
        title: 'x'.repeat(81),
        priority: 1,
      }).ok,
    ).toBe(false);
  });

  it('rejects a missing required field but allows a missing optional', () => {
    expect(validateObject(proposalSpec, { kind: 'flag_readiness_gap', title: 'x' }).ok).toBe(false);
    expect(
      validateObject(proposalSpec, { kind: 'flag_readiness_gap', title: 'x', priority: 1 }).ok,
    ).toBe(true);
  });

  it('rejects non-objects and arrays', () => {
    expect(validateObject(proposalSpec, 'string').ok).toBe(false);
    expect(validateObject(proposalSpec, [1, 2]).ok).toBe(false);
    expect(validateObject(proposalSpec, null).ok).toBe(false);
  });
});

describe('array + convenience wrappers', () => {
  it('validates a bounded array, rejecting the whole thing on one bad element', () => {
    const good = validateAiArrayOutput(
      proposalSpec,
      '[{"kind":"flag_readiness_gap","title":"a","priority":1}]',
      3,
    );
    expect(good.ok).toBe(true);
    const bad = validateAiArrayOutput(
      proposalSpec,
      '[{"kind":"flag_readiness_gap","title":"a","priority":1},{"kind":"bogus","title":"b","priority":1}]',
      3,
    );
    expect(bad.ok).toBe(false);
  });

  it('rejects an over-long array', () => {
    const items = Array.from({ length: 4 }, () => '{"kind":"flag_readiness_gap","title":"a","priority":1}');
    expect(validateAiArrayOutput(proposalSpec, `[${items.join(',')}]`, 3).ok).toBe(false);
  });

  it('validateAiObjectOutput parses + validates in one call', () => {
    const out = validateAiObjectOutput(
      proposalSpec,
      '```json\n{"kind":"draft_contact_message","title":"hi","priority":3}\n```',
    );
    expect(out.ok).toBe(true);
  });

  it('expectValid throws AiAuthorityError on a rejection', () => {
    expect(() => expectValid(validateAiObjectOutput(proposalSpec, 'garbage'))).toThrow(
      AiAuthorityError,
    );
  });
});
