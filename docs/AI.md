# Truecairn AI — transparency

This page is the honest, code-accurate account of what the AI in Truecairn can
see, what it can do, and what it can **never** do. It is kept in lockstep with the
code: the "what it can see" list below mirrors `AI_CONTEXT_ALLOWLIST` in
`apps/api/src/ai/context.ts`, and the snapshot test there fails if the two drift.

Status: **Phases 0–3 all shipped**, and **enabled in production on 2026-08-06** —
guardrails (Phase 0), the readiness proposer (Phase 1), bounded autonomy
(Phase 2), and the Guardian (Phase 3). The three capability flags
(`AI_PROPOSER_ENABLED` / `AI_AUTONOMY_ENABLED` / `AI_GUARDIAN_ENABLED`) still
default **off** in code; they are set `true` on the production service by owner
decision. Note what each flip actually exposes: the proposer is the only one with
an immediate visible effect, since autonomy stays inert until a user opts in AND
sets a floor, and the guardian only evaluates in release-relevant engine states.
**`CV_NARRATION_ENABLED` was enabled the same day** — a separate (CV) track, and
likewise inert until a release ceremony exists AND a recipient opens its report.
Operations (kill switch, flags, incident steps): `docs/RUNBOOK-AI.md`. The
user-facing summary of this page ships in-app at **`/security/ai`**, and every AI
surface links to it.

## The one guarantee that matters

**The AI can only add safety, never remove it.** Its sole engine capability is to
raise `review_required` — the fail-closed signal that *pauses* a release and asks
for human review. It can never authorise a release, advance a ceremony, unlock
key material, or skip a gate. The worst case of a hallucination or a prompt
injection is a dismissible false alarm — never a wrongful release.

This is enforced in three layers (`packages/ai-authority`):

1. **Types** — the capability unions (`AiEngineSignal = 'review_required'`) make a
   forward engine event unrepresentable.
2. **Runtime chokepoint** — `assertAllowedEngineSignal` throws for any signal but
   `review_required`; every AI side effect flows through one module, and an
   ESLint-equivalent import fence (`apps/api/src/ai/authority-fence.test.ts`)
   stops any AI code path from reaching the engine/ceremony/sensitive-actions
   packages directly.
3. **Permanent tests** — `asymmetry.test.ts` enumerates *every* engine event and
   asserts only `review_required` is reachable; a grep gate fails if
   `release_review_verification_passed` ever appears in AI code.

## What the AI can see

The server-side AI is **metadata-only**. It sees exactly the fields the context
builder assembles — counts, closed-enum values, and cadence numbers your own
dashboard already shows:

- **Engine:** current state name, previous state name, inactivity-threshold days,
  check-in timeout days, next scheduled check-in time.
- **Vault:** total item count, and item counts per tier (S1/S2/S3).
- **Contacts:** total, enrolled, and pending counts, and counts per role
  (personal / professional / recovery).
- **Ceremony:** the status *names* of any in-progress release ceremony.
- **Language:** which interface language you chose, if you chose one.

That is the complete list (`AI_CONTEXT_ALLOWLIST`). It contains **no** free text.

### Why your language is on that list

Because it reaches a prompt, and the rule for that list is about what a prompt
may contain — not about what the model reasons over. Your language is a
*direction to the model about its answer*, not information about your account:
it is used to say "write this reply in Spanish", and nothing else.

We list it anyway, for two reasons. Anything that reaches a prompt is on the
list or it is a bug, with no judgement calls about which entries "count". And it
is the only value in the list derived from something you set, so it is the one
place where a prompt could in principle carry text you supplied. It cannot: the
value is one of a fixed handful of language codes, checked against that set both
where it is read and again where it is written into the instruction, so there is
no string of yours for it to carry.

**Your language never changes what the AI is allowed to say.** The rules it runs
under — never ask for a passphrase, never say a tier is recoverable when it is
not, never advance a release — stay in one language and are not translated. Only
the answer is. If the model cannot answer in your language it answers in English
rather than refusing: losing the translation is better than losing the finding.

### What it can never see

- Your **vault contents** — encrypted client-side; the server only stores
  ciphertext.
- Your **item titles** and **contact display names** — these are **ciphertext**
  server-side (`title_ciphertext`, `display_label_ciphertext`). The server has no
  plaintext for them, so they cannot enter a prompt. (This is a deliberate
  strengthening over an early plan draft that listed them as visible — on this
  architecture they simply are not.)
- Item **categories** — free text you typed; excluded from prompts.
- Passphrases, private keys, Shamir shares, recovery codes — never leave your
  browser.
- Emails, IP addresses / hashes, session tokens.

The only free text the model ever receives is a question **you** type into the
in-app assistant. Even then, model text can't *do* anything: every output that
influences behaviour is JSON validated deny-by-default (closed enums, bounded
numbers, length caps, no unknown fields), so an injected instruction is inert.

## What the AI can do

| Capability | Tier | Status | Notes |
|---|---|---|---|
| Setup plan, help assistant, draft-invite | advisory | **on** (needs a Gemini credential) | Read-only; fail-soft; metadata-only. |
| ~~Dashboard briefing~~ (`GET /v1/briefing`) | advisory | **retired from the UI 2026-08-07** | Duplicated the readiness explanation on the same screen with less behind it (free prose, no deterministic fallback). The dashboard no longer calls it — pinned by a web test asserting no request is made. The route and its table still exist; deleting them (plus a drop migration and docs/22) is a follow-on. |
| Continuity-readiness report (`GET /v1/ai/readiness`) | advisory | **on** (`AI_PROPOSER_ENABLED`) | Deterministic score + typed gaps; the LLM only rewrites the explanation (template fallback). Drives the dashboard readiness ring and the "continuity checkups" list; on `disabled`/error the SPA keeps its own count-based estimate. |
| Continuity-readiness proposals (owner approves) | Tier 1 proposal | **on** (`AI_PROPOSER_ENABLED`, Phase 1) | AI suggests; a human decides. In Phase 1 a decision RECORDS the owner's choice and performs no server mutation; execution of accepted suggestions is the owner's existing gated flow. |
| Bounded autonomy (reversible, safety-neutral/closed) | Tier 2 | **on** (`AI_AUTONOMY_ENABLED`) + per-user opt-in, Phase 2 | Enters the existing sensitive-actions pipeline (delay + veto + audit); state changes are per-user opt-in + floored, so the flag alone changes nothing. |
| Guardian anomaly signal (`review_required`) | engine (fail-closed) | **on** (`AI_GUARDIAN_ENABLED`, Phase 3) | Deterministic detectors decide; the signal only ever PAUSES a release. Evaluated only in release-relevant engine states. |
| Continuity-Report narration (plain-language explanation for ceremony recipients) | advisory | **on** (`CV_NARRATION_ENABLED`, Gap plan G-1) | Explains, never decides. Input is the frozen metadata-only report; output is one length-capped text field (deny-by-default), stored BESIDE the sealed payload. Absent/failed ⇒ deterministic template. Inert until a release ceremony exists AND a recipient reads its report. |

Nothing that touches tiers, contacts, thresholds, ceremonies, or key material —
or that loosens any protection — can ever be autonomous.

### Continuity-Report narration (Gap plan G-1)

When a release ceremony opens, its recipients see the frozen Continuity Report —
provider-proven delivery evidence with a rule-computed outcome. With
`CV_NARRATION_ENABLED`, the report panel also carries a short AI-written
plain-language reading of that same evidence. The hard edges:

- **Beside, never inside.** Narration lives in nullable columns next to the
  sealed payload; the payload bytes and their audit-anchored hash are untouched
  (the snapshot-immutability test passes unmodified).
- **Explains, never decides.** The outcome stays the closed enum; the prompt
  forbids speculation, death claims, and advice to affirm or refuse.
- **The release path makes no AI calls.** Narration is generated lazily on the
  recipient-gated READ path in the API — the worker (the sole release driver)
  and the ceremony package are AI-free by import-fence test, so no AI outage or
  hostile output can touch ceremony creation or the release ladder.
- **Every guard applies.** The owner's `ai_opt_out` governs (it is their
  account's evidence), plus the kill switch, `ai_narration` rate ceilings, and
  the cost breaker. Output is schema-validated (one capped text field,
  `additionalProperties: false`); a rejection audits `ai_output_rejected`
  (`actor=ai`) and stores nothing.
- **Generated at most once** per report (fill-only-NULL), then served verbatim.

### Proposals (Phase 1)

Proposals are generated **deterministically** from the readiness gaps and bounded
rules — the LLM does not invent them, so a prompt injection cannot manufacture a
proposal. Each proposal's payload is validated deny-by-default (closed enums,
bounded ints, capped strings); `tighten_checkin_schedule` may only ever SHORTEN a
check-in interval (a validation invariant). Proposal kinds:

- `flag_readiness_gap` — surfaces a blocking readiness gap (e.g. an S3 group that
  shares one role and so can never satisfy release diversity).
- `tighten_checkin_schedule` — suggests a shorter check-in interval (shorten-only).
- `draft_contact_message`, `suggest_metadata_recategorization` — display-only.

Creating a proposal audits `ai_proposal_created` (`actor=ai`); the owner's
approve/reject audits `ai_proposal_decided` (`actor=owner`); a lapsed proposal is
swept to `expired` after 14 days (`actor` defaults to owner). A decision performs
no server-side mutation in Phase 1 — the AI has zero execution authority.

### Bounded autonomy (Phase 2)

The AI may enqueue a **small** set of reversible actions on your behalf — each
through the **existing** sensitive-actions / notification machinery (no new
execution path) and each **fully vetoable** during its delay window. Decisions are
deterministic (no model output → no injection surface).

Autonomy is **off by default and per-user opt-in.** State-changing autonomy is
additionally floored: in Settings → *AI autonomy* you enable it and set a check-in
floor the AI may never shorten below. Kinds:

- `send_reminder_nudge` (neutral) — an extra check-in reminder when a miss looks
  likely (a check-in within 3 days or overdue). Notification-only, capped 1/week.
- `tighten_checkin_schedule` (closed) — shortens your inactivity interval *toward
  your floor* (never below it, never lengthens) via `change_inactivity_threshold`
  in the sensitive-actions pipeline (a 7-day veto window), capped 1/30 days, never
  stacked on a pending change.

Every enqueue is `ai_autonomous_enqueued` (`actor=ai`); the owner's notice names
the AI as initiator; a pending AI action is badged in the Engine page so you can
veto it. **Suppressed by every gate:** `AI_ENABLED=false`, `AI_AUTONOMY_ENABLED=false`,
per-user opt-out, per-user opt-in off, and the cost breaker. Anything touching
tiers, contacts, thresholds beyond your floor, ceremonies, or key material is
**never** autonomous — those stay Tier-1 proposals at most, and a
protection-*loosening* kind is rejected by the chokepoint at enqueue.

## Provider & model

- **Provider:** Google Gemini, called directly (default) — or through Google
  Cloud Vertex AI, which is retained as the rollback path.
- **Prompts are not used for training.** That property comes from the account
  being on a **billing-enabled** tier, not from which backend is selected: on a
  free key Google may use submitted content to improve its products, including
  human review. Re-check the tier when a key is rotated.
- **Model:** `gemini-3.7-flash` (configurable via `GEMINI_MODEL`).
- Changing the provider or model requires running `scripts/ai-live-eval.ts`
  against the new model and recording owner sign-off in `PROGRESS.md` first.

## Noticing when the model stops answering

Every AI call site is fail-soft, which is right — a dead model must never break
the vault, the engine or a release — but it means an outage is SILENT: the prose
across readiness, briefing, assist and narration quietly reverts to its template
and nothing says why.

`ai_usage_daily` therefore counts failures as well as successes (migration 0058),
and `/admin/system` carries an **AI subsystem** tile:

| Observed | Tile |
|---|---|
| any call succeeded today | ok |
| calls attempted today, all failed | **degraded** |
| a capability flag on, no model credential resolved | **degraded** — every AI surface is silently serving its template |
| nothing succeeded in 7 days, and calls were attempted | **degraded** — what a retired model or a revoked credential looks like |
| nothing attempted today | unknown — an idle day is not evidence of health |
| `AI_ENABLED=false`, or no credential and no capability enabled | unknown — off on purpose, not a fault |

Health can only ever be *inferred* here, because the honest proof that a model
answers is a model call and this tile must not make one (it is read on a 15s
admin refresh, and the release worker samples the same collector while pinned
AI-free). So the state turns on **today's** usage alone — a success three days ago
is not evidence of health now — while the tile's text always names the model, the
capabilities currently switched on, and when the model last answered within the
past 7 days. Before 2026-08-11 it reported today's counters and nothing else,
which on a quiet day was indistinguishable from a subsystem with no credential at
all. `scripts/ai-live-eval.ts` remains the only thing that actually proves the
credential end to end.

It is **not release-critical** and is **not** on the public `/status` page: no
release has ever depended on a model call, so a degraded AI tile must never move
the published availability figure. The counters are integers only — no prompts,
no outputs, no content.

This used to matter on a clock: the default was `gemini-2.5-flash`, and the 2.5
family retires **2026-10-16** — a date that would have arrived as a silent
degradation, because every call site is fail-soft. The default is now
`gemini-3.7-flash`, which retires the deadline rather than tracking it. The
underlying point stands for whatever comes next: an empty `GEMINI_MODEL` resolves
to a floating alias, so the retirement of whichever family it names is a scheduled
outage nobody is paged for.

## Prompt retention

Prompts are **never persisted.** Audit records store a template id + version, a
salted hash of the rendered prompt, an output hash, the model id, and token
counts — enough for forensics, never a second copy of your metadata (D6). AI
audit events ride the same tamper-evident hash chain as everything else, stamped
`actor = ai`, and a permanent test proves an `ai` actor can only ever carry an
allowlisted AI event type.

## Turning it off

- **Per account:** Settings → *AI assistance* → *Turn off AI for my account*
  (`ai_opt_out`). When on, no AI feature ever runs for you and no prompt is ever
  built. Your safety machinery (check-ins, release ladder) is unaffected.
- **Whole deployment (operator):** set `AI_ENABLED=false` — every AI surface
  returns the disabled response with zero model calls.
- **Two capacity pools (2026-08-11).** AI is not a paid feature — every capability
  above runs on every plan — but capacity is split so one account cannot spend
  another's. A **paid** account is bounded only by its own daily budget (three
  times the free one), so the deployment-wide ceiling can never switch it off; a
  **free** account is bounded by its own budget *and* that shared ceiling. Before
  this, one heavy account could exhaust the shared pool and every other account's
  AI surfaces read `unavailable` for the rest of the UTC day, having spent nothing
  themselves. The safety machinery is untouched either way: check-ins, the release
  ladder and the Guardian never depend on a model call.
- **Cost breaker:** `AI_DAILY_TOKEN_BUDGET` / `AI_USER_DAILY_TOKEN_BUDGET` trip a
  breaker that fails AI soft (`unavailable`) while leaving the vault, engine,
  ceremonies, and auth fully functional.
- **Rate limits:** per-user and per-IP ceilings on every AI route.

## Guardian detectors (Phase 3)

The Guardian watches for a release proceeding when it shouldn't and can **only slow
it down**: when a detector crosses its threshold, it emits the one fail-closed
engine signal `review_required` through the chokepoint, which **pauses** the release
ladder for human review (`dispute_raised` → `review_required`). It can never
advance a release. A false positive costs the owner one dismissal; a true positive
stops a wrongful release.

The detectors are **deterministic statistics over metadata — not AI** — so they run
even for AI-opted-out users (they are a safety mechanism, not a feature; the AI
opt-out governs the LLM, and no LLM runs on the guardian decision path). They only
run while the engine is in a **release-relevant** state (`escalation_pending`,
`release_review`, `limited_release`, `staged_release`) — the guardian pauses
releases, it does not freeze healthy accounts.

| Detector | Severity | Fires when | Threshold (`GUARDIAN_*`) |
|---|---|---|---|
| `affirmation_velocity` | 2 (bypasses cooldown) | ≥ N committed affirmations within a short window during a ceremony (coordinated/coerced release) | `AFFIRMATION_THRESHOLD`=3 within `AFFIRMATION_WINDOW_MIN`=5 |
| `failed_auth_during_release` | 1 | ≥ N failed auth attempts within a window while a release is in progress | `FAILED_AUTH_THRESHOLD`=5 within `FAILED_AUTH_WINDOW_MIN`=15 |

**Hysteresis:** at most one automatic review per `GUARDIAN_COOLDOWN_DAYS` (default 7)
per user, **unless** a severity-2 (ceremony-time) detector fires, which bypasses the
cooldown. Emitting `review_required` writes `ai_review_signal_emitted` (`actor=ai`,
with detector id + feature values + threshold) and notifies the owner with a
deterministic template. Suppressed by `AI_GUARDIAN_ENABLED=false` and the master
`AI_ENABLED=false`.

Additional detectors (device/IP-hash novelty, owner-registered duress heuristics)
are anticipated by the framework and will be added here with their thresholds when
implemented.
