# AI subsystem — operations runbook

For the on-call operator. How to turn the AI subsystem off in a hurry, flip each
capability, read what the AI actually did, and work an incident. Everything here is
env-var + SQL; there is no AI-specific admin console by design.

Design context (`docs/AI.md`, `CONTRIBUTING.md`): the AI can only ever **add** safety
(emit the fail-closed `review_required` signal, or enqueue a **vetoable**
tightening); it can never remove a control, advance the engine forward, or read
plaintext. So the worst an AI misfire can do is create noise (extra reminders,
spurious review pauses, rejected proposals) — never silent data loss or an
unsafe release. The runbook reflects that: the kill switch is about stopping
noise and cost, not containing a breach of the zero-knowledge boundary.

## Where it runs

| Capability | Flag (default) | Service | Notes |
|---|---|---|---|
| Master switch | `AI_ENABLED` (**true**) | **API + worker** | Off ⇒ every AI surface degrades to its empty/disabled state; vault/engine/ceremonies untouched. |
| Proposer (readiness + proposals) | `AI_PROPOSER_ENABLED` (false) | **API** | Dashboard proposal cards, `GET /v1/ai/readiness`. |
| Bounded autonomy | `AI_AUTONOMY_ENABLED` (false) | **worker** | Also needs the **per-user opt-in** (Settings). Never below the user's floor. |
| Guardian | `AI_GUARDIAN_ENABLED` (false) | **worker** | Pauses an in-progress release to `review_required`. |

Because the flags are read separately by the API and the worker, **set the same
value on both services and restart each.** A flag flipped only on the API leaves
the worker running the old value (and vice-versa).

Model credentials: `GOOGLE_SERVICE_ACCOUNT_JSON` (raw or base64 service-account
key). If absent or invalid, model calls simply don't happen and every AI surface
degrades to unavailable — the app keeps working.

## Kill switch (fastest → most surgical)

**Stop all AI immediately.** On **both** the API and the worker service:

```
AI_ENABLED=false
```

then restart both. Within one deploy every AI surface returns its disabled state
(assistant/briefing/plan/readiness/proposals empty), the worker's autonomy and
guardian sweeps no-op, and no model calls are made. Nothing else changes: check-ins,
the release ladder, ceremonies, vault CRUD are all independent of this flag.

**Turn off one capability** instead of everything — flip just that flag (e.g.
`AI_AUTONOMY_ENABLED=false` on the worker) and restart that service.

**Stop AI for one user** without touching global flags: set their opt-out.

```sql
-- Turns off every AI feature for one account (assistant, proposals, autonomy,
-- guardian narration). Their safety machinery is unaffected. This is the same
-- flag the owner controls at Settings → "Turn off AI for my account".
UPDATE users SET ai_opt_out = true WHERE id = $1;
```

**Cost blowout, not a safety issue** — clamp spend without disabling features:
set `AI_DAILY_TOKEN_BUDGET` (global) and/or `AI_USER_DAILY_TOKEN_BUDGET` on the
API **and** worker. When a day's tokens cross the budget the circuit breaker trips
(records `ai_breaker_tripped` once) and further AI calls short-circuit until
UTC-midnight rollover. With no budget set, the breaker never trips.

## Reading what the AI did

Every AI action is an append on the same per-user hash-chained audit log as
everything else, always with `actor = 'ai'`. It never contains a raw prompt, model
output text, or any content — only template id + version, salted prompt hash,
output hash, model id, and token counts (D6).

```sql
-- Everything the AI has done for one user, newest first.
SELECT server_timestamp, event_type, event_payload
FROM audit_log
WHERE user_id = $1 AND actor = 'ai'
ORDER BY seq DESC
LIMIT 100;
```

Event types (`packages/ai-authority/src/audit-events.ts`) and what each means:

| `event_type` | Meaning |
|---|---|
| `ai_proposal_created` | A safety proposal was surfaced to the owner. |
| `ai_proposal_decided` | Owner approved / rejected, or it expired — with the decider. |
| `ai_autonomous_enqueued` | A vetoable tightening entered the owner's pending list. |
| `ai_autonomous_vetoed` | Owner cancelled an AI-enqueued action before it applied. |
| `ai_review_signal_emitted` | The guardian paused a release to `review_required` (the one engine signal AI can emit). |
| `ai_output_rejected` | Deny-by-default validation discarded model output (didn't match schema). |
| `ai_breaker_tripped` | The cost circuit breaker opened. |
| `ai_config_changed` | An AI setting changed. |

```sql
-- Cost / volume for a day (user_id IS NULL is the global rollup).
SELECT day, user_id, tokens_in, tokens_out, calls
FROM ai_usage_daily
WHERE day = CURRENT_DATE
ORDER BY calls DESC;
```

A row with a forward engine event under `actor = 'ai'` is **impossible by
construction** (the chokepoint + the permanent asymmetry invariant test forbid it).
If you ever see one, that is a P1 integrity finding — treat the audit chain as
authoritative and escalate (`SECURITY.md`).

## Incident playbooks

**"The AI is spamming reminders / proposing things that make no sense."**
Noise, not a breach. Turn off the offending capability (`AI_AUTONOMY_ENABLED=false`
or `AI_PROPOSER_ENABLED=false`) on the worker/API and restart. Pull the user's
`actor='ai'` audit rows to see what fired and why. Re-enable after tuning
(`GUARDIAN_*` thresholds, the autonomy frequency caps) once understood.

**"A release got paused for review and the owner says it shouldn't have."**
Working as designed — the guardian **adds** a review gate, it cannot release. The
pause is a `dispute_raised`/`review_required` state the owner (or the normal
consensus flow) resolves; the AI cannot advance past it. Confirm with the
`ai_review_signal_emitted` row (which detector, which features). If the detector is
too aggressive, raise the relevant `GUARDIAN_*` threshold and restart the worker.

**"Costs are spiking."** Set/lower `AI_DAILY_TOKEN_BUDGET` on API + worker,
restart. Confirm the breaker tripped via `ai_breaker_tripped` and the
`ai_usage_daily` totals. This throttles spend without disabling the product.

**"Model is misbehaving / suspected prompt-injection or model drift."** Flip
`AI_ENABLED=false` on both services first (stops all model calls), then run the
live model gate from the repo before re-enabling:

```
pnpm exec tsx scripts/ai-live-eval.ts
```

Re-enable only if there are **zero `LEAKED-ACTION` lines** (every adversarial
prompt's output is inert) and the golden line shows `gate=accept`. A `LEAKED-ACTION`
is a blocker — keep AI off and escalate. This gate exists precisely for model-drift.

**"Suspected boundary breach (content/secret in an AI path)."** This should be
structurally impossible (`docs/CRYPTO.md` zero-knowledge boundary; the context
allowlist ships only counts/enums/cadence, never titles or names). Flip
`AI_ENABLED=false` everywhere, preserve the audit log, and escalate as a security
incident (`SECURITY.md`) — do not attempt to "clean up" the audit chain; its
tamper-evidence is the forensic record.

## Re-enabling after an incident

1. Land and deploy any threshold/config fix.
2. Run `scripts/ai-live-eval.ts` — require zero `LEAKED-ACTION`.
3. Re-enable the **narrowest** flag that was off (per-capability before master).
4. Set the flag identically on API and worker; restart both.
5. Watch `actor='ai'` audit rows + `ai_usage_daily` for the first sweep cycle.

## Related

- `docs/AI.md` — subsystem design, full flag/threshold reference.
- `docs/CRYPTO.md` / `SECURITY.md` — the zero-knowledge boundary the AI sits behind.
