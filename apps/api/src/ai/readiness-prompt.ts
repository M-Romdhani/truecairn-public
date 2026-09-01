import { DEFAULT_LOCALE, type Locale } from '@truecairn/shared';
import type { ReadinessGap, ReadinessGapCode, ReadinessReport } from './readiness.js';

// ── Readiness explanation (plan §5) ───────────────────────────────────────────
//
// The deterministic scorer decides the gaps; the LLM only turns them into a
// friendly paragraph. These per-gap templates are the FAIL-SOFT fallback (used
// when AI is off / opted-out / breaker-tripped) AND the material the LLM is asked
// to rephrase — the model never sees anything but these closed codes + numbers.

const GAP_TEMPLATE: Record<ReadinessGapCode, string> = {
  no_vault_items: 'Your vault is empty — add at least one item so there is something to pass on.',
  no_enrolled_contacts:
    'You have no enrolled contacts — invite and enrol at least one trusted person.',
  s1_beneficiary_unset:
    'Your S1 (personal) tier has items but no designated beneficiary to receive them.',
  s2_coverage_insufficient:
    'Your S2 tier needs at least 2 contacts holding shares before it can be reconstructed.',
  s3_coverage_insufficient:
    'Your S3 tier needs at least 2 contacts holding shares before it can be reconstructed.',
  s2_role_diversity_unsatisfiable:
    'Your S2 contacts all share one role — a release needs at least two different roles, so add a contact in another role.',
  s3_role_diversity_unsatisfiable:
    'Your S3 contacts all share one role — a release needs at least two different roles, so a single-role group can never reconstruct it. Add a contact in another role.',
  s2_passphrase_slot_unset:
    'Your S2 tier has no release-passphrase fallback recorded — set it so you have a second way in.',
  engine_not_armed:
    'You have items and contacts but the engine is not armed yet — arm it to start watching for inactivity.',
  checkin_overdue: 'Your check-in is overdue — confirm you are active to keep the release paused.',
  stale_items: 'Some vault items have not been updated in a long time — review them for accuracy.',
  no_verified_channel:
    'Your engine is running but you have no verified way to be contacted — add and verify a notification channel. Until you do, a check-in request cannot reach you, and the engine reads that silence as inactivity.',
  contact_key_unconfirmed:
    'Some enrolled contacts have a security code you have not confirmed yet. Until you confirm it with them directly — by phone or in person, not through this app — they cannot be given a share of your release.',
};

// ── The same sentences in Spanish (docs/40 Phase 4) ─────────────────────────
//
// THE FALLBACK IS THE PATH MOST PEOPLE ARE ON, so it is translated rather than
// left to the model. This paragraph is what the dashboard shows whenever the AI
// is off, opted out, rate-limited or broken — which for an owner who turned AI
// off in Settings is every single time. Leaving it English would mean the one
// readiness sentence a privacy-minded Spanish owner ever sees is in the wrong
// language.
//
// THE CONSEQUENCE CLAUSE SURVIVES TRANSLATION. The rule these sentences encode
// (QA 2026-08-11 §3, and the note on READINESS_SYSTEM_INSTRUCTION below) is that
// where a sentence says what happens to the owner if they do nothing, that
// clause is the payload — a blocker compressed into a to-do item is the failure
// this surface exists to prevent. Two here carry one and must keep it:
// `no_verified_channel` ("a check-in request cannot reach you, and the engine
// reads that silence as inactivity") and `contact_key_unconfirmed` ("they cannot
// be given a share of your release"). A translation that tidies either into a
// bare instruction has reintroduced the defect in another language.
const GAP_TEMPLATE_ES: Record<ReadinessGapCode, string> = {
  no_vault_items:
    'Tu bóveda está vacía: añade al menos un elemento para que haya algo que transmitir.',
  no_enrolled_contacts:
    'No tienes ningún contacto inscrito: invita e inscribe al menos a una persona de confianza.',
  s1_beneficiary_unset:
    'Tu nivel S1 (personal) tiene elementos pero no hay ninguna persona designada para recibirlos.',
  s2_coverage_insufficient:
    'Tu nivel S2 necesita al menos 2 contactos con partes antes de poder reconstruirse.',
  s3_coverage_insufficient:
    'Tu nivel S3 necesita al menos 2 contactos con partes antes de poder reconstruirse.',
  s2_role_diversity_unsatisfiable:
    'Todos tus contactos de S2 comparten el mismo rol: una liberación necesita al menos dos roles distintos, así que añade un contacto con otro rol.',
  s3_role_diversity_unsatisfiable:
    'Todos tus contactos de S3 comparten el mismo rol: una liberación necesita al menos dos roles distintos, así que un grupo de un solo rol nunca podrá reconstruirlo. Añade un contacto con otro rol.',
  s2_passphrase_slot_unset:
    'Tu nivel S2 no tiene registrado el respaldo con frase de liberación: configúralo para tener una segunda vía de acceso.',
  engine_not_armed:
    'Tienes elementos y contactos, pero el motor todavía no está activado: actívalo para que empiece a vigilar la inactividad.',
  checkin_overdue:
    'Tu confirmación está vencida: confirma que sigues activo para mantener la liberación en pausa.',
  stale_items:
    'Hace mucho que no se actualizan algunos elementos de la bóveda: revísalos para comprobar que siguen siendo correctos.',
  no_verified_channel:
    'Tu motor está en marcha pero no tienes ninguna vía verificada para que te contactemos: añade y verifica un canal de notificación. Hasta que lo hagas, una solicitud de confirmación no puede llegarte, y el motor interpreta ese silencio como inactividad.',
  contact_key_unconfirmed:
    'Algunos contactos inscritos tienen un número de seguridad que todavía no has confirmado. Hasta que lo confirmes con ellos directamente —por teléfono o en persona, no a través de esta aplicación— no se les puede entregar una parte de tu liberación.',
};

const GAP_TEMPLATES: Partial<Record<Locale, Record<ReadinessGapCode, string>>> = {
  es: GAP_TEMPLATE_ES,
};

const ALL_CHECKS_PASSED: Partial<Record<Locale, string>> = {
  es: 'Tu configuración de continuidad parece completa: todas las comprobaciones de preparación han pasado.',
};

// The deterministic explanation text for a gap (never throws, always available).
export function templateExplanation(gap: ReadinessGap, locale: Locale = DEFAULT_LOCALE): string {
  return GAP_TEMPLATES[locale]?.[gap.code] ?? GAP_TEMPLATE[gap.code];
}

// A deterministic overall explanation: the top gaps, most severe first, as plain
// sentences. This is what the dashboard shows when the LLM is unavailable.
export function deterministicReadinessExplanation(
  report: ReadinessReport,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (report.gaps.length === 0) {
    return (
      ALL_CHECKS_PASSED[locale] ??
      'Your continuity setup looks complete — every readiness check passed.'
    );
  }
  const ordered = [...report.gaps].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1,
  );
  return ordered
    .slice(0, 5)
    .map((g) => templateExplanation(g, locale))
    .join(' ');
}

// The CONSEQUENCE rule below is load-bearing, not style guidance (QA 2026-08-11 §3).
//
// It was severity-based until 2026-08-12 — blockers must keep their consequence,
// warnings could be compressed freely — and QA found the edge that showed the
// wrong axis had been chosen. `contact_key_unconfirmed` is a warning whose
// consequence is *they cannot hold a share of your release*, and the live model
// duly dropped it to "confirm it with them directly". Severity ranks how badly a
// setup is broken; it does not rank how much the owner needs to know what happens
// if they ignore the sentence. Those came apart the first time a warning carried a
// real consequence.
//
// So the rule now keys off the TEXT: if the supplied sentence states a
// consequence, it survives. That is self-maintaining — a new gap whose template
// names a consequence is covered the day it is added, with no second decision to
// remember — and it leaves genuinely consequence-free lines (`stale_items`:
// "review them for accuracy") freely compressible, which is what keeps the
// instruction from degrading into "never shorten anything".
//
// Without it this instruction optimises for brevity and next-actions, and a
// compressing rephrase drops the consequence clause first — which is the whole
// payload of a blocker. Observed live on production: the `no_verified_channel`
// template says "a check-in request cannot reach you, and the engine reads that
// silence as inactivity"; the model rendered it as "add and verify a notification
// channel so we can contact you", as item one of a four-item to-do list, in the
// same register as "set a release passphrase". A reader of that paragraph could not
// tell their engine was armed and unreachable.
//
// A blocker means a release could not complete, or could complete wrongly. Turning
// that into a chore is not a wording preference — it is the failure this surface
// exists to prevent, and it is the surface docs/38 §5 lists as never having been
// evaluated against the live model.
export const READINESS_SYSTEM_INSTRUCTION =
  "You are Truecairn's continuity-readiness explainer. You are given a readiness " +
  'SCORE and a list of gap CODES with numbers (never any private content). Write 2–4 ' +
  'short, plain-language sentences telling the owner what to do next, most important ' +
  'first. Do not invent gaps that are not listed. Do not mention scores as percentages ' +
  'unless helpful. Return prose only — no JSON, no markdown, no lists. ' +
  'CRITICAL: wherever a supplied sentence states a CONSEQUENCE — what happens to the ' +
  'owner if they do nothing — you must keep it. Rephrase it freely; never drop it, ' +
  'and never compress such a gap into a bare instruction. This applies to warnings ' +
  'as well as blockers: a warning can carry a consequence that matters just as much. ' +
  'Only a sentence that states no consequence at all may be shortened to its action. ' +
  'And never reduce a gap marked (blocker) to one item in a to-do list — say what it ' +
  'stops from working.';

// The prompt carries ONLY the score + closed gap codes + their numeric detail —
// no titles, no names, no content. The template sentences are included as guidance
// the model may rephrase.
export function buildReadinessPrompt(report: ReadinessReport): string {
  const lines = report.gaps.map((g) => {
    const detail = g.detail ? ` ${JSON.stringify(g.detail)}` : '';
    return `- ${g.code} (${g.severity}${g.tier ? `, ${g.tier}` : ''})${detail}: ${templateExplanation(g)}`;
  });
  return [
    `Readiness score: ${report.score}/100.`,
    report.gaps.length === 0 ? 'No gaps.' : 'Gaps:',
    ...lines,
    '',
    'Explain what the owner should do next.',
  ].join('\n');
}
