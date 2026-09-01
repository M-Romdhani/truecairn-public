import { AiAuthorityError } from './capabilities.js';

// ── Deny-by-default structured-output validation (plan docs/25 §3.3) ──────────
//
// Every AI output that influences behaviour is JSON validated against a strict
// spec in the same closed style as the route bodies: closed enums, bounded
// numbers, length-capped strings, and additionalProperties:false (unknown keys
// REJECT). Validation failure ⇒ the output is discarded and the caller writes an
// `ai_output_rejected` audit event; there is NO code path from unvalidated model
// text to an action. Free text survives only in explicitly-declared display
// fields, which the caller renders as React text (auto-escaped) — never as
// markup, a URL, or an action selector.
//
// Hand-written (no ajv), matching the repo's existing parsePlanSteps style, so
// the package carries no runtime dependency and the validation is transparent.

export type FieldSpec =
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'string'; readonly maxLength: number; readonly minLength?: number }
  | { readonly type: 'int'; readonly min: number; readonly max: number }
  | { readonly type: 'boolean' };

export interface ObjectSpec {
  readonly fields: Readonly<Record<string, FieldSpec>>;
  // Fields not listed here reject the whole object (additionalProperties:false).
  // Every declared field is required unless named in `optional`.
  readonly optional?: readonly string[];
}

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

// Strip a stray ```json fence and parse. NEVER throws — a parse failure is a
// rejection, not an exception, so the fail-soft contract holds at every layer.
export function parseAiJson(text: string): ValidationOutcome<unknown> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  if (cleaned === '') return { ok: false, reason: 'empty output' };
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
}

function validateField(name: string, spec: FieldSpec, raw: unknown): ValidationOutcome<unknown> {
  switch (spec.type) {
    case 'enum':
      if (typeof raw !== 'string' || !spec.values.includes(raw)) {
        return { ok: false, reason: `field '${name}' is not one of the allowed values` };
      }
      return { ok: true, value: raw };
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, reason: `field '${name}' is not a string` };
      if (raw.length > spec.maxLength) {
        return { ok: false, reason: `field '${name}' exceeds maxLength ${spec.maxLength}` };
      }
      if (spec.minLength !== undefined && raw.length < spec.minLength) {
        return { ok: false, reason: `field '${name}' shorter than minLength ${spec.minLength}` };
      }
      return { ok: true, value: raw };
    }
    case 'int': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        return { ok: false, reason: `field '${name}' is not an integer` };
      }
      if (raw < spec.min || raw > spec.max) {
        return { ok: false, reason: `field '${name}' out of range [${spec.min}, ${spec.max}]` };
      }
      return { ok: true, value: raw };
    }
    case 'boolean':
      if (typeof raw !== 'boolean') return { ok: false, reason: `field '${name}' is not a boolean` };
      return { ok: true, value: raw };
  }
}

// Validate a plain object against a spec. Rejects on: non-object, any unknown key
// (additionalProperties:false), any missing required field, any field that fails
// its spec. Returns a fresh object containing ONLY the declared fields — nothing
// the model added rides through.
export function validateObject(
  spec: ObjectSpec,
  raw: unknown,
): ValidationOutcome<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'output is not a JSON object' };
  }
  const input = raw as Record<string, unknown>;
  const optional = new Set(spec.optional ?? []);

  for (const key of Object.keys(input)) {
    if (!(key in spec.fields)) {
      return { ok: false, reason: `unexpected field '${key}' (additionalProperties:false)` };
    }
  }

  const out: Record<string, unknown> = {};
  for (const [name, fieldSpec] of Object.entries(spec.fields)) {
    if (!(name in input)) {
      if (optional.has(name)) continue;
      return { ok: false, reason: `missing required field '${name}'` };
    }
    const result = validateField(name, fieldSpec, input[name]);
    if (!result.ok) return result;
    out[name] = result.value;
  }
  return { ok: true, value: out };
}

// Convenience: parse text then validate against an object spec, in one step.
export function validateAiObjectOutput(
  spec: ObjectSpec,
  text: string,
): ValidationOutcome<Record<string, unknown>> {
  const parsed = parseAiJson(text);
  if (!parsed.ok) return parsed;
  return validateObject(spec, parsed.value);
}

// Validate a bounded JSON array of objects (e.g. a proposal list). `maxItems`
// caps the array; any element that fails its spec rejects the WHOLE output (a
// deny-by-default array never yields a partially-trusted list).
export function validateAiArrayOutput(
  elementSpec: ObjectSpec,
  text: string,
  maxItems: number,
): ValidationOutcome<Record<string, unknown>[]> {
  const parsed = parseAiJson(text);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return { ok: false, reason: 'output is not a JSON array' };
  if (parsed.value.length > maxItems) {
    return { ok: false, reason: `array exceeds maxItems ${maxItems}` };
  }
  const out: Record<string, unknown>[] = [];
  for (const element of parsed.value) {
    const result = validateObject(elementSpec, element);
    if (!result.ok) return result;
    out.push(result.value);
  }
  return { ok: true, value: out };
}

// Guard used where a validated value is a hard precondition (the value should
// already have been checked; this converts a rejection into the fail-closed
// exception for call sites that treat an invalid output as a bug, not a soft
// path). Advisory surfaces should prefer the ValidationOutcome directly.
export function expectValid<T>(outcome: ValidationOutcome<T>): T {
  if (!outcome.ok) throw new AiAuthorityError(`AI output rejected: ${outcome.reason}`);
  return outcome.value;
}
