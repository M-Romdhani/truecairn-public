# Truecairn — AI Guardian Implementation Plan

**Status:** Ratified (see Ratification record below)
**Owner:** Med
**Executor:** Claude Code (any current model — see §12 Execution Protocol)
**Scope:** Give the AI a crucial, trusted role in Truecairn without weakening the product's core promises.

## Ratification record (2026-07-04)

- **D1–D6 ratified as written** by the owner.
- **D7 (licensing) deferred** until the T1 open-source publication work actually
  begins. Nothing in Phases 0–3 depends on it.
- **Branch amendment:** all phases are developed on the single session branch
  `claude/truecairn-ai-guardian-bc45l3` (supersedes §12's branch-per-phase naming;
  commits stay small and task-scoped).
- **§3.1 path amendment:** the authority chokepoint lives in a new shared package
  `packages/ai-authority` (not `apps/api/src/ai/authority.ts`) because the worker
  imports only from `packages/*`, never from `apps/api`. Both the API and the
  Phase 3 guardian worker import it; the ESLint fence is scoped accordingly.
  Guarantees, guards, and tests are unchanged.

## 0. How to use this document

This plan is written to be executed by an AI coding agent across multiple
sessions, possibly by different models. It is deliberately self-contained: every
phase has explicit contracts, file paths, acceptance criteria, and verification
commands. No phase depends on conversational context that isn't written down here.

Executor rules (read before writing any code):

1. Read `CONTRIBUTING.md` at the repo root first, then this document in full.
   Its invariants win over anything ambiguous here.
3. Work phase by phase, in order. A phase's feature flag stays `false` until
   every acceptance criterion in that phase is checked off and the phase's
   security checklist (§11) passes.
4. After every task: `pnpm -r typecheck` (zero errors), the targeted test suite
   for touched packages, and before any phase is declared done: `pnpm test`
   (full workspace) + `pnpm audit --prod` (must report no known vulnerabilities).
5. Stop and ask the owner rather than proceed if a change would touch any of:
   `packages/engine/src/transitions*` or engine state definitions,
   `packages/ceremony` state machine or its 403 gates, `packages/crypto`,
   session/step-up logic, or the logging redaction in `apps/api/src/logging.ts`.
   This plan never requires modifying those; if it seems to, the plan has been
   misread.
6. Follow existing repo patterns exactly: JSON-Schema route bodies with
   `additionalProperties: false`; `FOR UPDATE SKIP LOCKED` for worker batch
   processors; audit appends inside the same transaction as the state they
   describe; fail-soft AI seams (a generator interface with a fake for tests);
   constant-time comparison for any secret material.

## 1. Non-negotiable product invariants (the trust pillars)

These are the reasons people will trust Truecairn. Every task in this plan must
preserve all five; several tasks exist purely to make them externally verifiable.

**P1 — Client-side encryption.** Vault content is encrypted on the client
(XChaCha20-Poly1305; keys derived via Argon2id; Shamir for social recovery;
nested envelopes for S3). The server stores ciphertext and the metadata needed
to operate. Nothing in this plan sends plaintext, passphrases, keys, or shares
to the server — including to any AI provider.

**P2 — Zero-knowledge architecture.** The server-side AI may only ever see what
the server already sees: an explicitly allowlisted subset of metadata (§3.2).
Any AI capability over decrypted content is client-side only, opt-in, and lives
in Phase 4 — it never becomes a server feature.

**P3 — Deterministic, fail-closed release machinery.** The engine and ceremony
state machines remain the sole authorities over release. The AI gains exactly
one engine capability: emitting `review_required` (the fail-closed direction).
It can never emit `release_review_verification_passed`, advance a ceremony,
unlock material, or skip a gate. This is the asymmetric authority principle:
AI may add safety, never remove it. Worst case of a hallucination or prompt
injection is a dismissible false alarm.

**P4 — Open-source clients.** The web client and the crypto packages it depends
on are published source, buildable by anyone, with the deployed build verifiable
against the repo (§10). The AI features ship with their client code equally open.

**P5 — Honest security documentation.** What the AI can see, what it can do,
what it can never do, which provider/model runs it, and how to turn it off —
all written down publicly, accurate to the code, before each capability is
enabled (§10).

A change that cannot satisfy all five does not ship, regardless of how useful it is.

## 2. Decisions baked into this plan (ratified 2026-07-04)

**D1.** Asymmetric authority is enforced in three layers — type system, a single
runtime chokepoint, and permanent invariant tests — plus an `actor` column on
audit events for forensics. (§3.1)

**D2.** Guardian anomaly detection is deterministic-first. Statistical/rule
detectors decide; the LLM only writes the human-readable explanation. The
guarding path stays deterministic, matching the product promise. (§7)

**D3.** Server AI remains metadata-only permanently. Content-aware AI =
client-side inference or explicit per-request consent, Phase 4, default off. (§8)

**D4.** Every AI-initiated mutation routes through the existing sensitive-actions
pipeline (delayed, vetoable, audited). No new mutation path is created for the
AI. (§6)

**D5.** Per-user AI opt-out plus a global kill switch plus a spend/error circuit
breaker ship in Phase 0, before the AI gains any capability beyond today's
assist/briefing. (§4)

**D6.** AI prompts are never persisted. Audit records store template id +
version, a salted hash of the rendered prompt, output hash, model id, token
counts — enough for forensics without creating a second copy of user metadata.
(§3.4)

**D7.** Licensing for published repos: client + crypto packages under a
permissive license (MIT or Apache-2.0), server license at owner's discretion
(AGPL-3.0 is the conventional choice for hosted-service protection).
**DEFERRED to T1** — owner decision pending.

## 3. Architecture: the four load-bearing pieces

Everything in Phases 1–3 is built on these. They are Phase 0 deliverables.

### 3.1 The authority chokepoint — `packages/ai-authority` (amended path)

One module owns every side effect the AI can cause. Nothing else in
`apps/api/src/ai/**` or the guardian worker imports the engine, ceremony, or
sensitive-actions packages directly — enforced by an ESLint
`no-restricted-imports` rule scoped to those directories.

```ts
// The complete universe of AI capabilities. Adding to these unions is a
// security-review event (§11), not a refactor.
export type AiEngineSignal = 'review_required';           // the ONLY engine event
export type AiProposalKind =                              // Tier 1 (owner approves)
  | 'tighten_checkin_schedule' | 'draft_contact_message'
  | 'suggest_metadata_recategorization' | 'flag_readiness_gap';
export type AiAutonomousKind =                            // Tier 2 (veto window)
  | 'send_reminder_nudge' | 'tighten_checkin_schedule';
```

Runtime guards inside the chokepoint (defense-in-depth beneath the types):
`AI_ALLOWED_ENGINE_EVENTS = new Set(['review_required'])` checked before any
`signalEngine` call; an action-kind registry where each kind carries
`safety_direction: 'closed' | 'neutral'` — a kind whose effect loosens
protection (e.g., relaxing a check-in schedule) may exist only as a Tier 1
proposal, never Tier 2. The chokepoint writes the audit event and the
rate/budget accounting in the same transaction as the effect.

### 3.2 The context builder — `apps/api/src/ai/context.ts`

A single function assembles everything any AI prompt may contain, by explicit
field allowlist (schema-pick, not object spread): counts and tiers of vault
items, item titles (length-capped, control-chars stripped), contact roles and
display names (same treatment), engine state name, check-in cadence, ceremony
status names. Nothing else — no ciphertext, no key material fields, no emails,
no IP hashes, no session data. A unit test snapshots the allowlist; adding a
field fails the test until the test (and the public AI transparency doc, §10)
is updated in the same commit. This is the technical anchor for P2 and for the
transparency page's "what the AI can see" list.

User-controlled strings enter prompts only via this builder, wrapped in clearly
delimited data blocks, with the system prompt stating they are data, not
instructions. The real injection defense remains §3.3: text can't do anything.

### 3.3 Structured outputs, deny-by-default

Every AI output that influences behavior is JSON, validated against a strict
schema (same JSON-Schema style as the routes: closed enums, bounded numbers,
`additionalProperties: false`, length-capped strings). Free text exists only in
display-only fields rendered as React text (already auto-escaped). Validation
failure ⇒ the output is discarded, an `ai_output_rejected` audit event is
written, and the feature fails soft. There is no code path from unvalidated
model text to any action.

### 3.4 AI audit events

New audit event types riding the existing hash chain, appended transactionally
by the chokepoint: `ai_proposal_created`, `ai_proposal_decided`
(approved/rejected/expired, decider), `ai_autonomous_enqueued`,
`ai_autonomous_vetoed`, `ai_review_signal_emitted`, `ai_output_rejected`,
`ai_breaker_tripped`, `ai_config_changed`. Payloads follow D6 (hashes and ids,
never raw prompts) and must pass the existing logging-redaction tests extended
to these fields. Add an `actor` discriminator (`owner | worker | ai`) so the
chain can prove, forensically, that no `ai` actor ever emitted a forward event.

## 4. Phase 0 — Guardrails first (mandatory before any new capability)

Nothing in Phases 1–3 starts until all of Phase 0 is merged and green. Phase 0
also hardens the AI endpoints that already exist (assist, briefing) — closing
the rate-limit gap found in the July 2026 audit.

Tasks:

**0.1 Rate limits.** Extend the existing fixed-window limiter
(`apps/api/src/auth/rate-limit.ts`) with scopes `ai_assist`, `ai_briefing`,
`ai_guardian_explain` — per-user and per-IP-hash ceilings, config-driven
defaults (e.g., 20/user/hour assist; tune later). Apply to all existing and
future AI routes. Include tests mirroring the existing rate-limit tests.

**0.2 Budget + circuit breaker.** `ai_usage_daily` counter table (day, user_id
nullable, tokens_in, tokens_out, calls). The chokepoint and the existing
generator record usage. Env `AI_DAILY_TOKEN_BUDGET` (global) and
`AI_USER_DAILY_TOKEN_BUDGET`; exceeding either trips a breaker: advisory
features return a defined `{ status: 'unavailable' }`, guardian LLM explanations
fall back to a deterministic template. Breaker state changes emit
`ai_breaker_tripped`. The vault, engine, ceremonies, and auth must be fully
functional with the breaker tripped — proven by tests.

**0.3 Kill switch + per-user opt-out.** Env `AI_ENABLED` (master) and per-phase
flags `AI_PROPOSER_ENABLED`, `AI_AUTONOMY_ENABLED`, `AI_GUARDIAN_ENABLED` — all
default `false` except the master, which defaults to today's behavior.
Missing/invalid `GEMINI_API_KEY` disables AI features with a boot log line; it
never blocks boot (AI config is the one place `config.ts` stays permissive).
Add `ai_opt_out` (boolean, default false) to user settings + route + UI toggle;
when set, no LLM call ever includes that user's context (deterministic guardian
detectors still run — they are not AI and are documented as such).

**0.4** Authority chokepoint + context builder + output validation as specified
in §3, including the ESLint import fence.

**0.5 Asymmetry invariant tests** (permanent, style of `hardening.test.ts`):
enumerate every engine event; assert the chokepoint throws for all but
`review_required`; attempt each forbidden effect through every public seam of
the AI module; assert audit `actor='ai'` rows can only carry allowlisted event
types.

**0.6 Injection corpus + eval harness.** `packages/ai-evals` (or
`apps/api/src/ai/evals/`): fixture vaults whose item titles and contact names
contain adversarial payloads ("ignore previous instructions…", schema-shaped
JSON, HTML/script, oversized strings, RTL/control chars). CI runs the corpus
against a `FakeGenerator` (deterministic) asserting: schema-violating outputs
rejected, no forbidden effect reachable, injected instructions inert. A separate
`scripts/ai-live-eval.ts` runs the same corpus + golden cases against the real
model on demand and reports drift — required before any model/provider change
(§11).

**0.7 Docs stubs** created now, filled per phase: `docs/AI.md` (transparency),
`SECURITY.md`, `docs/THREAT-MODEL.md` (§10).

Acceptance criteria — Phase 0:

- [ ] All AI routes 429 correctly under the new scopes; tests prove per-user and per-IP limits.
- [ ] Breaker trips at budget and everything non-AI keeps working (test with breaker forced on).
- [ ] `AI_ENABLED=false` ⇒ all AI endpoints return the defined disabled response; full test suite still green.
- [ ] `ai_opt_out=true` ⇒ zero LLM calls contain that user's context (assert via FakeGenerator capture).
- [ ] Asymmetry tests in place and green; ESLint fence active; context-builder allowlist snapshot test green.
- [ ] Injection corpus green in CI; live-eval script runs and produces a report.
- [ ] New audit event types verified by the existing chain-integrity test; redaction tests extended and green.
- [ ] `pnpm -r typecheck` zero errors; `pnpm test` all green; `pnpm audit --prod` clean.

## 5. Phase 1 — AI as proposer (crucial role, zero authority)

The AI reads allowlisted metadata, produces structured proposals, and a human
decides. Flag: `AI_PROPOSER_ENABLED`.

Deliverables:

**1.1** `ai_proposals` table (migration): `id uuid pk, user_id fk, kind text,
payload jsonb, status text check in (proposed, approved, rejected, expired,
executed), source text check in (assist, guardian), model_id text,
prompt_template_id text, prompt_hash text, output_hash text, created_at,
decided_at, expires_at`. Index `(user_id, status)`. Proposals expire (default
14 days) via a small worker sweep.

**1.2 Continuity readiness score.** Deterministic scorer (`packages/engine`
adjacent or `apps/api/src/ai/readiness.ts`) over metadata: per-tier contact
coverage vs threshold, role diversity satisfiable, check-in cadence health,
stale items, unconfigured beneficiaries. Output: score + typed gap list (e.g.,
`{ kind: 'flag_readiness_gap', gap: 's3_role_diversity_unsatisfiable' }` — the
exact case from the audit conversation: one contact in a single role can never
satisfy S3 diversity). The LLM renders the explanation text only. Route
`GET /v1/ai/readiness`, cached like the briefing.

**1.3 Proposal generation.** Extend assist/briefing prompts to emit optional
proposals in the structured-output envelope (§3.3). Proposal payloads are
schema-per-kind. Examples shipped in this phase: `tighten_checkin_schedule`
(bounded: may only shorten intervals, never lengthen), `draft_contact_message`
(text payload, display-only until owner sends),
`suggest_metadata_recategorization`, `flag_readiness_gap`.

**1.4 Decision surface.** `GET /v1/ai/proposals`,
`POST /v1/ai/proposals/:id/decision { approve | reject }`. Approval of any
proposal whose execution is a sensitive action goes through the existing
step-up flow and then enters the existing sensitive-actions pipeline as if the
owner initiated it (the AI merely pre-filled it). Rejection requires nothing.
Web UI: a proposals inbox + inline cards on the dashboard; all AI text rendered
as plain text; every card carries the standing disclosure line (§10).

**1.5 Audit:** every lifecycle step emits the §3.4 events.

Acceptance criteria — Phase 1:

- [ ] Readiness score returns correct gaps on fixture vaults (golden tests, incl. the S3 role-diversity case).
- [ ] A proposal can be created, listed, approved (with step-up where applicable), rejected, and expires on schedule — route tests for each, including authorization (user A cannot see or decide user B's proposals).
- [ ] Approving a proposal executes only through existing owner paths (sensitive-actions / normal routes); grep-level and test-level proof that no proposal kind has a bespoke mutation path.
- [ ] Injection corpus extended with proposal-shaped attacks; still green.
- [ ] `docs/AI.md` updated with proposer capabilities before the flag is enabled anywhere real.

## 6. Phase 2 — Bounded autonomy through the sensitive-actions pipeline

The AI may enqueue a small set of reversible, safety-neutral-or-closed actions
that execute automatically unless the owner vetoes during the delay window.
Flag: `AI_AUTONOMY_ENABLED`.

Design constraints (hard): only kinds registered `safety_direction: 'closed' |
'neutral'`; everything enters the existing sensitive-actions pipeline (delay,
notification, veto, audit) — the AI gets no new execution machinery; per-kind
frequency caps (e.g., max one autonomous schedule tightening per 30 days);
owner notification on enqueue names the AI as initiator.

Shipped kinds (initial): `send_reminder_nudge` (extra check-in reminder when a
miss looks likely — neutral, rate-capped), `tighten_checkin_schedule` within
owner-configured bounds (closed direction). Explicitly excluded from autonomy
forever: anything touching tiers, contacts, thresholds, ceremonies, key
material, or loosening any protection — those remain Tier 1 proposals at most.

Acceptance criteria — Phase 2:

- [ ] Autonomous actions appear in the standard pending-actions UI, are vetoable, and veto works (tests).
- [ ] A `safety_direction: 'open'`-registered kind is rejected by the chokepoint at enqueue (test).
- [ ] Frequency caps enforced and tested; notifications name the AI initiator.
- [ ] Kill switch/opt-out/breaker all suppress autonomy (tests for each).
- [ ] Full-workspace tests green; `docs/AI.md` autonomy section published before enabling.

## 7. Phase 3 — The Guardian: fail-closed anomaly signal

The crucial-role capstone: Truecairn actively watches for signs that a release
is proceeding when it shouldn't, and can only slow things down. Flag:
`AI_GUARDIAN_ENABLED`.

Detectors are deterministic (D2). A new worker module
(`apps/worker/src/guardian.ts` + `packages/` home if shared), following the
existing processor pattern (`FOR UPDATE SKIP LOCKED`, per-batch error
isolation), computes per-user signals on a schedule: check-in cadence deviation
(missed-then-burst, sudden device/IP-hash novelty using the existing peppered
hashes — novelty comparison only, no de-anonymization), unusual-hour step-up
failures spike, affirmation velocity anomalies during a ceremony (many
affirmations in minutes from novel IP-hash clusters), activity resembling
coercion patterns the owner pre-registered (optional duress heuristics —
owner-configured only).

Response path: when a detector crosses its threshold, the chokepoint emits
`review_required` (the one allowed engine event), notifies the owner through
existing channels with a deterministic explanation template — the LLM may
rewrite the explanation for clarity (metadata-only, opt-out-respecting) but
never influences the decision — and writes `ai_review_signal_emitted` with
detector id, feature values, and threshold. Hysteresis: per-user cooldown
(default: one automatic review per 7 days) unless a severity-2 detector fires
(ceremony-time anomalies), which bypasses cooldown. Every threshold is config,
listed in `docs/AI.md`.

Why this design honors P3: the release ladder can be paused by statistics,
never advanced by them; a false positive costs the owner one dismissal; a true
positive stops a wrongful release. The LLM sits strictly on the narration side
of the line.

Acceptance criteria — Phase 3:

- [ ] Golden detector tests: fixture histories that must fire and near-miss histories that must not (both directions matter — flag-spam erodes trust).
- [ ] `review_required` emission goes through the chokepoint; asymmetry tests re-run green; audit trail complete.
- [ ] Cooldown/hysteresis tested; severity-2 bypass tested.
- [ ] Guardian runs correctly with LLM disabled (breaker/kill/opt-out): deterministic template used, signal still emitted.
- [ ] Deploy-overlap safety: two concurrent workers produce no duplicate signals (SKIP LOCKED + idempotency test).
- [ ] `docs/AI.md` + `docs/THREAT-MODEL.md` updated with detector list and thresholds before enabling.

## 8. Phase 4 (optional, later) — Client-side AI over vault contents

Out of scope until Phases 0–3 are shipped and stable. Recorded here so the
boundary is explicit: any AI over decrypted content runs client-side after
unlock — local/in-browser inference by default; a cloud call only with explicit
per-request consent UI that names the destination, and never through
Truecairn's server as a plaintext proxy. Server code never gains a
decrypted-content code path (P1/P2). Design doc required before implementation;
treat as a separate project.

## 9. Cross-cutting engineering standards

New env/config (all optional, safe defaults): `AI_ENABLED` (default true —
preserves current assist/briefing), `AI_PROPOSER_ENABLED=false`,
`AI_AUTONOMY_ENABLED=false`, `AI_GUARDIAN_ENABLED=false`,
`AI_DAILY_TOKEN_BUDGET`, `AI_USER_DAILY_TOKEN_BUDGET`, `AI_RATE_*` overrides,
guardian thresholds `GUARDIAN_*`. Document each in `.env.example` with the same
commented style as existing entries. None may cause `config.ts` to refuse boot.

Migrations: `ai_proposals`, `ai_usage_daily`, `user settings ai_opt_out`, audit
`actor` column (with backfill default `owner`/`worker` as derivable, `ai` only
newly written). Follow existing migration numbering and idempotency style.

Testing matrix (each phase adds, never replaces): unit (chokepoint, context
builder, scorer, detectors) · route tests on real Postgres in the existing
TRUNCATE style, including cross-user authorization checks on every new route ·
invariant tests (asymmetry, allowlist snapshot, redaction) marked as permanent ·
eval corpus (fake in CI, live on demand) · concurrency tests for worker modules.

CI additions: eval corpus job; ESLint fence; a grep gate that fails if
`release_review_verification_passed` appears anywhere under `apps/api/src/ai/**`
or the guardian module.

Monitoring/ops: structured (redacted) counters for AI calls, rejects, breaker
state, guardian fires; a `docs/RUNBOOK-AI.md` page: how to trip the kill switch
on the deployment, how to read `ai_` audit events, incident steps for suspected
prompt-injection or model misbehavior (disable flag → preserve audit slice →
run live-eval → postmortem).

## 10. Trust & transparency workstream (runs in parallel, gates enablement)

This workstream is how P4/P5 become real. Items marked (gate) must exist before
the corresponding phase flag turns on in production.

**T1. Open-source publication.** Public repo(s) for the web client and
`packages/{crypto,client-crypto,keys(client-relevant parts)}` at minimum;
monorepo-public is simpler if acceptable. Fix the `SiteFooter.tsx`
`TODO: real repo URL`. License per D7 (owner decision). Contribution +
code-of-conduct + release-tagging hygiene.

**T2. Verifiable builds (client).** Lockfile-pinned, documented reproducible
build (`docs/BUILDING.md`); publish per-release artifact hashes; recommended:
GitHub Actions provenance/SLSA attestation on the built bundle so anyone can
match the served client to a tagged commit.

**T3. `SECURITY.md`** (gate for Phase 1): disclosure policy, response SLA,
scope, the `security@truecairn.app` mailbox (audit note: create the real
mailboxes first), safe-harbor language.

**T4. `docs/THREAT-MODEL.md`** (gate for Phase 3): existing model (already
largely in `CONTRIBUTING.md`) made public, plus the AI subsystem additions — prompt
injection via metadata strings, model drift, provider compromise,
cost-exhaustion, authority-escalation attempts — each mapped to the §3 control
that answers it.

**T5. `docs/CRYPTO.md`:** the exact primitives and parameters
(XChaCha20-Poly1305, Argon2id parameters, Shamir GF(256), nested S3 envelopes,
KEK layering) extracted from internal docs into a public, reviewable spec.

**T6. `docs/AI.md`** — the AI transparency page (gate for every phase): the
exact context-builder allowlist ("what the AI can see"), the capability table
per tier ("what it can do"), the asymmetry guarantee ("what it can never do,
and the code+tests that enforce it"), provider/model disclosure and change log,
prompt-retention statement (D6), the opt-out and kill switch, guardian detector
list + thresholds. Written in plain language; kept in lockstep with the
allowlist snapshot test.

**T7. In-app disclosure:** a consistent one-line badge on every AI surface —
"AI can only add safety checks, never remove them. It sees item names and
settings, never your encrypted content." linking to `docs/AI.md`.

## 11. Security review checklist (run at the end of every phase)

1. Asymmetry: invariant tests green; grep gate green; manual attempt to reach a
   forward engine event through every new seam fails.
2. Zero-knowledge: context-builder snapshot unchanged or consciously amended +
   `docs/AI.md` updated in the same commit; redaction tests cover all new
   log/audit fields; no new plaintext path.
3. Injection: corpus green, including new phase-specific attack shapes;
   live-eval run against the current model with report attached.
4. Authorization: every new route has cross-user tests;
   proposals/decisions/vetoes scoped to session user.
5. Abuse economics: rate limits + budgets cover every new endpoint; breaker
   behavior re-verified.
6. Degradation: kill switch, opt-out, breaker, and missing-API-key paths all
   tested for this phase's features; core vault flows unaffected in all four
   states.
7. Docs: `docs/AI.md` and threat model updated; in-app disclosure present on
   new surfaces.
8. Gates: `pnpm -r typecheck` zero errors, full `pnpm test` green,
   `pnpm audit --prod` clean, migrations apply on a fresh DB
   (`pnpm db:migrate` from zero).
9. Model change (whenever provider/model id changes, any phase): run live-eval,
   compare against last report, require explicit owner sign-off before
   switching the config.

## 12. Execution protocol for Claude Code (model-agnostic)

- The plan assumes nothing about which model executes it. All judgment calls
  that matter are pre-made in §2; if a genuinely new decision arises, add it to
  §2 as a proposal, mark it `UNRATIFIED`, ask the owner, and do not build on it
  meanwhile.
- Branching (amended): all phases on `claude/truecairn-ai-guardian-bc45l3`.
  Conventional commits. Small, verifiable commits — each leaves typecheck green.
- Never disable, skip, or weaken an existing test to make progress. If an
  existing test fails, that is the task.
- The five stop-and-ask triggers in §0 rule 5 apply for the whole project.

## 13. Definition of done (global)

Phases 0–3 merged and flag-enabled in production; all §11 checklists recorded;
trust workstream T1–T7 live (real repo URL, real mailboxes, published docs);
the July 2026 audit's open items closed (AI rate limiting — Phase 0;
footer/mailbox placeholders — T1/T3); full workspace green under
`pnpm -r typecheck`, `pnpm test`, `pnpm audit --prod`; and a stranger reading
only the public repo + docs can correctly answer: what can the AI see, what can
it do, what can it never do, and how would I verify that?
