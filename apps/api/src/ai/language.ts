import { schema, type Database } from '@truecairn/db';
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_LABELS,
  type Locale,
  type UserId,
} from '@truecairn/shared';
import { eq } from 'drizzle-orm';

// ── What language the AI answers in (docs/40 Phase 4) ───────────────────────
//
// THE INSTRUCTIONS STAY IN ENGLISH. ONLY THE ANSWER'S LANGUAGE CHANGES.
//
// That is the whole design, and it is a safety decision rather than a lazy one.
// Every system instruction on this codebase carries HARD RULES the model must
// not get wrong — never ask for a passphrase, never say S3 is recoverable
// without the release passphrase, never call the product a "dead man's switch".
// Translating those rules would put a mistranslation between us and a safety
// property, in a language nobody reviewing the diff reads. So the rules stay in
// one language and this appends a directive about the OUTPUT.
//
// A CLOSED ENUM, NEVER FREE TEXT, and this is the only reason it is safe to
// interpolate anything user-derived into a system instruction at all. `locale`
// is validated by isLocale() against LOCALES before it ever reaches here, and it
// comes from a CHECK-constrained database column (migration 0067), so the value
// is one of a handful of literals we wrote. If this ever takes a raw string —
// a header, a query parameter, a profile field — it becomes a prompt-injection
// vector with a direct line into the system instruction, which is exactly the
// class of thing packages/ai-authority exists to make impossible. Keep the
// parameter typed as Locale.
//
// EMPTY FOR THE SOURCE LANGUAGE, deliberately. Appending nothing means every
// prompt is byte-identical to what shipped for every user who has not chosen
// another language — so the existing prompt tests, the injection-eval harness,
// and the cached briefings all keep their exact inputs, and this change is
// provably inert until somebody picks a second language.
export function languageDirective(locale: Locale): string {
  // RE-VALIDATED HERE, not just at the callers, and the test that found this was
  // right to. The type says Locale; TypeScript is erased at runtime, and every
  // value that reaches this function began life as a database column read or a
  // JSON body. One `as` cast anywhere upstream and the interpolations below
  // would echo an attacker's string straight into a system instruction — the
  // single most sensitive string in the AI subsystem, and the one place the
  // chokepoint in packages/ai-authority cannot see.
  //
  // An unrecognised value is treated as "no preference", which degrades to the
  // source language: the same fail-closed direction the rest of the AI subsystem
  // takes, and a strictly better outcome than an answer in a language nobody
  // asked for.
  if (!isLocale(locale) || locale === DEFAULT_LOCALE) return '';
  const label = LOCALE_LABELS[locale];
  return (
    ` LANGUAGE: write your entire response in ${label} (${locale}). This applies to ` +
    'every part of the answer a person reads, including any headings, list labels ' +
    'and step numbers. ' +
    // The identifier carve-out, and it is load-bearing rather than tidy. The plan
    // surface returns {"kind","title","why"} where `kind` is a CLOSED enum the UI
    // maps to a deep link; a translated `kind` fails validation, the step is
    // dropped, and the dashboard card silently empties. Fail-soft hides it, which
    // is exactly why the instruction has to prevent it.
    'DO NOT TRANSLATE IDENTIFIERS. If your response is JSON, translate only the ' +
    'human-readable text values — never the field names, and never a value the ' +
    'instructions above list as a fixed set of allowed words. Leave product names, ' +
    'screen names and the tier codes S1/S2/S3 in their original form: they are ' +
    `labels the user sees in an interface that is also in ${label}. ` +
    'Keep every rule and constraint above exactly as stated; they govern what you ' +
    'may say, not which language you say it in. If you cannot answer in ' +
    `${label}, answer in English rather than refusing.`
  );
}

// The system instruction actually sent, for a given surface and language. One
// function so a new AI surface cannot quietly ship without the directive, and so
// the "source language appends nothing" property is asserted in one place.
export function systemInstructionFor(base: string, locale: Locale): string {
  return base + languageDirective(locale);
}

// The owner's stated language, read from the same column the web app and the
// email templates read (migration 0067). NULL means "never chose", which is not
// the same as choosing English — both answer in the source language today, and
// keeping them distinct is what lets a future default apply only to the former.
//
// A separate lookup rather than a field threaded through every metadata gatherer:
// this is a directive about the OUTPUT, not an input the model reasons over, and
// the surfaces that need it (assist, briefing, readiness, plan, draft-invite,
// narration) do not otherwise share a shape.
export async function aiLocale(db: Database, userId: UserId): Promise<Locale> {
  const [u] = await db
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return isLocale(u?.locale) ? u.locale : DEFAULT_LOCALE;
}
