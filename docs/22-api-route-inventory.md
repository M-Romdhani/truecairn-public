# 22 — API route inventory

Every route the API (`apps/api`) serves, its authentication gate, whether it is a
**delayed sensitive action** (7-day cooldown before it applies), and its
rate-limit class. This is both a security-review artifact and the contract the
client wires against.

Source of truth: `apps/api/src/app.ts` (registration) and `apps/api/src/routes/*`.
If you add a route, add its row in the same PR.

**The TABLE is authoritative, not any total quoted in prose.** Earlier revisions
of this page carried three different hand-maintained totals, none of them the
table's. They are gone: a count nobody updates is worse than no count, so the
only number stated here is the one you can get by counting the rows.

To reconcile it yourself, count the registrations in non-test source:

```bash
files=$(grep -rlE "\b(app|scope)\.(get|post|put|patch|delete|head|options)\(" \
  apps/api/src --include="*.ts" | grep -v '\.test\.ts')
grep -Eo "\b(app|scope)\.(get|post|put|patch|delete|head|options)\(" $files | wc -l
```

Both identifiers must be counted. Three routes register on a `scope` rather than
on `app`, because they live inside the raw-body plugin scope that preserves the
exact bytes their signature is verified over — a bare `app.` enumeration misses
them and the number will look wrong:

| Registered via | Route | Why it is scoped |
|---|---|---|
| `scope.post` | `/v1/notifications/webhook/:provider` | Raw body — Svix / `X-Twilio-Signature` / `X-Hub-Signature-256` HMAC |
| `scope.get` | `/v1/notifications/webhook/:provider` | Provider `hub.challenge` verification handshake |
| `scope.post` | `/v1/billing/webhook/lemonsqueezy` | Raw body — LemonSqueezy HMAC |

If that count disagrees with the number of rows below, a route was added or
removed without its row. **It currently does: 118 registrations against 117
rows.** The gap is stated rather than quietly corrected, because inventing a
number that reconciles today is how this page drifted before. Treat the table as
complete for everything it lists and as one row short until that is chased down.

## Gate glossary

| Gate | Meaning |
|---|---|
| *(none)* | No auth — public or pre-account. |
| `requireSession` | Valid login-session cookie. |
| `owner` | `requireVaultOwner` — the account holds master-key material (a contact-only account ⇒ 409). |
| `writableGate` | The engine state permits vault writes (not frozen by a release/returning state) and the target item is live. |
| `requireContactEnrolled` | The target contact has proven its keys (status enrolled/active). |
| `tierMovePrecondition` | The destination tier is valid for the move. |
| `requireStepUp(a)` | Fresh second factor **plus** an Ed25519 master-passphrase signature over the canonical payload bound to action `a`. |
| `requireFreshSecondFactor` | Fresh second factor **only** — no challenge/signature (the lighter gate for cancel-release / revoke-others). |
| `HMAC` | Signature verification over the raw request body; no session. |
| `participant` | Route-level authorization inside the handler: the caller must be the ceremony's owner, an enrolled affirming contact, or an enrolled recipient of THAT ceremony — everyone else 404 (no existence disclosure). Release-material reads additionally 403 before the ceremony reaches `reconstructing` (fail closed). |

**Delayed (7-day)** = the handler enqueues via `requestSensitiveAction` →
`sensitive_actions`; the worker applies it after the cooldown. Distinct from
**step-up immediate** routes, which also require step-up but apply synchronously.

## Rate-limit classes

| Class | Rule |
|---|---|
| `login-ip` | 30 failed attempts / IP / 5 min ⇒ 429 (checked before any credential lookup). |
| `login-account` | 5 failed attempts / account / 15 min ⇒ `account_status='locked'` for 1 h ⇒ 403 (also enqueues a `security_alert`). |
| `checkin` | 60 check-ins / user / hour ⇒ 429. |
| `channel-codes` | 6 verification-code issues / user / hour ⇒ 429 (add + re-send share it). |
| `ai-*` | Fixed-window per user AND per IP (`AI_RATE_*`, docs/21); over ⇒ 429 with `retryAfterSeconds` (or a silent deterministic fallback where noted). |
| `none` | Gated by session / step-up / HMAC instead. |

*(Observability only: 200 failures / IP / hour records one `ip.sustained_abuse`
security event — log-only, does not change the 429.)*

---

## Public — no session (11)

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| GET | `/health` | none | — | none |
| GET | `/ready` | none | — | none |
| GET | `/health/worker` | none (liveness probe — no user data; DB-backed worker heartbeat, migration 0052) | — | none |
| GET | `/v1/status` | none (public status page source — the REDUCED projection of `/v1/ops/system`: check ids/enums + measured availability only; no counts, versions, key ids or free text. 30s server-side cache + `Cache-Control`, so it cannot amplify against the KEK probe.) | — | none (cached) |
| POST | `/v1/auth/register/options` | none | — | none |
| POST | `/v1/auth/register/verify` | none | — | none |
| POST | `/v1/auth/login/options` | none | — | none |
| POST | `/v1/auth/login/verify` | none | — | `login-ip` |
| POST | `/v1/auth/login/password` | none | — | `login-ip` + `login-account` |
| POST | `/v1/notifications/webhook/:provider` | **HMAC** (Resend: Svix or raw; Twilio: `X-Twilio-Signature`; Meta: `X-Hub-Signature-256`) | — | none |
| GET | `/v1/notifications/webhook/:provider` | **shared token** (Meta only: echoes `hub.challenge` on a constant-time `hub.verify_token` match; every other provider 404s) | — | none |
| POST | `/v1/billing/webhook/lemonsqueezy` | **HMAC** (`X-Signature`; mounted only when the secret is configured) | — | none |

## Session — auth + account (16)

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| POST | `/v1/auth/logout` | `requireSession` | — | none |
| POST | `/v1/auth/sessions/revoke-others` | `requireSession, requireFreshSecondFactor` | — | none |
| POST | `/v1/auth/step-up/second-factor` | `requireSession` | — | throttled (hardening pass) |
| POST | `/v1/auth/step-up/webauthn/options` | `requireSession` | — | none |
| POST | `/v1/auth/totp/confirm` | `requireSession` | — | none |
| POST | `/v1/auth/hardware-key/register/options` | `requireSession` | — | none |
| GET | `/v1/account/key-material` | `requireSession` | — | none |
| POST | `/v1/account/key-material` | `requireSession` (create-once enrollment provisioning) | — | none |
| GET | `/v1/account/me` | `requireSession` | — | none |
| POST | `/v1/account/profile` | `requireSession` (display metadata only — audit records WHICH fields, never values) | — | none |
| POST | `/v1/account/locale` | `requireSession` (display metadata; own route so a language switch cannot clobber a name edit — docs/40) | — | none |
| GET | `/v1/account/audit` | `requireSession` (owner-scoped; returns the canonical inputs + hashes + signatures so the chain can be verified OFF-server) | — | none |
| GET | `/v1/ops/system` | `requireSession` + `OPS_ADMIN_EMAILS` allowlist (route NOT REGISTERED when unset; non-admin ⇒ 404, never 403). Aggregate system health + account totals (registered / registered-today / active / armed, integers only) — no user data. `queues` and `alerts` are **nullable**: null = could not be counted/read, never zeros or `[]`. | — | none |
| GET | `/v1/ops/health-series` | `requireSession` + `OPS_ADMIN_EMAILS` allowlist (same gate as `/v1/ops/system` — same operational intelligence, spread over 24h). The COMPOSITE release-path severity per 5-minute bucket + the check id that drove it; `status_samples` stores no per-check history, so there is no per-check series to serve. An unsampled bucket is `null` (unavailable), never omitted. | — | none |
| GET | `/v1/account/audit/verify` | `requireSession` (owner-scoped; server-asserted chain check — labelled `assurance: server_asserted`, since a malicious server would also rewrite this answer) | — | none |
| GET | `/v1/account/usage` | `requireSession` | — | none |
| POST | `/v1/account/sensitive-actions/cancel` | `requireSession` | — | none |

## Session — contacts (7)

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| GET | `/v1/contacts` | `requireSession` | — | none |
| POST | `/v1/contacts` | `requireSession` (free-plan contact cap ⇒ 402, docs/28) | — | none |
| POST | `/v1/contacts/accept` | `requireSession` (one-time invite token in body) | — | none |
| POST | `/v1/contacts/enroll/options` | `requireSession` | — | none |
| POST | `/v1/contacts/enroll/verify` | `requireSession` | — | none |
| POST | `/v1/contacts/cancel-invite` | `requireSession` | — | none |
| POST | `/v1/contacts/key-pin` | `requireSession` | — | none |

## Session — engine (6)

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| GET | `/v1/engine/status` | `requireSession` | — | none |
| GET | `/v1/engine/release-progress` | `requireSession` (owner-scoped; metadata only — statuses, roles, timestamps, owner-encrypted labels; never key material) | — | none |
| POST | `/v1/engine/check-in` | `requireSession` | — | `checkin` |
| POST | `/v1/engine/arm` | `requireSession` (enrolled-contact prerequisite) | — | none |
| POST | `/v1/engine/snooze` | `requireSession` | — | none |
| POST | `/v1/engine/cadence` | `requireSession` + `requireStepUp('change_inactivity_threshold')` | 7d (`change_inactivity_threshold`) | none |
| GET | `/v1/engine/verification-status` | `requireSession` (flag: `CV_REPORT_ENABLED`, else 404) | — | none |

## Session — notification channels (docs/26; 6 here + 1 delayed below)

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| GET | `/v1/settings/channels` | `requireSession` | — | none |
| POST | `/v1/settings/channels` | `requireSession` (paid types pro-gated ⇒ 402) | — | `channel-codes` |
| POST | `/v1/settings/channels/:id/verify` | `requireSession` (attempt-bounded, code burns on exhaustion) | — | none |
| DELETE | `/v1/settings/channels/:id` | `requireSession` — **UNVERIFIED channels only**; a verified channel ⇒ 409 (`channel-removal-requires-stepup`) pointing at the sensitive lane | — | none |
| GET | `/v1/settings/channels/preferences` | `requireSession` | — | none |
| PUT | `/v1/settings/channels/preferences` | `requireSession` (the matrix can only NARROW selection; check-in/escalation/security-alert are exempt at selection time — the safety floor) | — | none |

## Session — billing (docs/28; 2)

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| GET | `/v1/billing/status` | `requireSession` | — | none |
| GET | `/v1/billing/checkout/:plan` | `requireSession` (404 when unconfigured) | — | none |

## Ceremonies — session + participant authorization (15)

All `requireSession` first; `participant` per the glossary. Release-material
reads (`shares`, `s1-envelope`, `release-salt`, `released-items`, `seal-context`)
**403 before `reconstructing`** — the fail-closed gates the negative tests pin.

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| GET | `/v1/ceremonies` | `requireSession` (own ceremonies as owner/contact/recipient) | — | none |
| GET | `/v1/ceremonies/:id` | `requireSession, participant` | — | none |
| POST | `/v1/ceremonies/:id/affirm/options` | `requireSession, participant` (affirming contact) | — | none |
| POST | `/v1/ceremonies/:id/affirm` | `requireSession, participant` + possession proof (Ed25519 over challenge) | — | none |
| POST | `/v1/ceremonies/:id/revoke` | `requireSession, participant` (affirming contact, inside the revocation window) | — | none |
| POST | `/v1/ceremonies/:id/dispute` | `requireSession, participant` — fail-closed: pauses into review. Deliberately needs no affirmation status (a contact who has not affirmed is the likeliest to know). Bounded since 2026-08-07: **idempotent per affirmation** (`disputed_at`, migration 0057) and refused once the ceremony is terminal | — | none (idempotency replaces it) |
| POST | `/v1/ceremonies/:id/recipient/ephemeral` | `requireSession, participant` (recipient registers a receiving device key) | — | none |
| GET | `/v1/ceremonies/:id/seal-context` | `requireSession, participant` | — | none |
| POST | `/v1/ceremonies/:id/seal-share` | `requireSession, participant` (affirmed holder re-seals to the recipient) | — | none |
| GET | `/v1/ceremonies/:id/shares` | `requireSession, participant`; **403 pre-reconstructing** | — | none |
| GET | `/v1/ceremonies/:id/s1-envelope` | `requireSession, participant`; **403 pre-reconstructing** | — | none |
| GET | `/v1/ceremonies/:id/release-salt` | `requireSession, participant`; **403 pre-reconstructing** | — | none |
| GET | `/v1/ceremonies/:id/released-items` | `requireSession, participant`; **403 pre-reconstructing** | — | none |
| POST | `/v1/ceremonies/:id/reconstructed` | `requireSession, participant` (recipient reports terminal success) | — | none |
| GET | `/v1/ceremonies/:id/continuity-report` | `requireSession, participant` (owner or enrolled recipient). With `CV_NARRATION_ENABLED` the response adds `narration` — AI text generated lazily under every AI guard (owner opt-out, `ai-narration` rate, breaker, kill switch); flag off ⇒ key absent, byte-identical | — | `ai-narration` (the lazy generation only; the report itself is never limited) |

## Vault + release composition — owner-gated, non-sensitive (9)

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| POST | `/v1/vault/items` | `requireSession, owner` (free-plan item cap ⇒ 402) | — | none |
| GET | `/v1/vault/items` | `requireSession, owner` | — | none |
| GET | `/v1/vault/items/:id` | `requireSession, owner` | — | none |
| PATCH | `/v1/vault/items/:id` | `requireSession, owner` | — | none |
| POST | `/v1/vault/items/:id/attachments` | `requireSession, owner, writableGate` (storage budget = min(plan, ceiling), atomic reservation) | — | none |
| PUT | `/v1/vault/items/:id/attachments/:attachmentId/bytes` | `requireSession, owner, writableGate` | — | none |
| GET | `/v1/vault/items/:id/attachments/:attachmentId` | `requireSession, owner` | — | none |
| GET | `/v1/vault/items/:id/attachments/:attachmentId/bytes` | `requireSession, owner` | — | none |
| POST | `/v1/release/passphrase-slot` | `requireSession, owner` (create-once S2 release-passphrase slot record; S3 has no slot — nested scheme, docs/24) | — | none |

## Vault capture — write-only from the phone (docs/34; 7, flag-gated)

Registered only when `VAULT_CAPTURE_ENABLED` is on; flags-off, none of them
exist and the API is byte-for-byte pre-capture. There is deliberately **no**
route that returns a capture's plaintext, because no such plaintext exists
server-side: what is stored is a key sealed to the owner and an opaque stream.

`PUT /v1/account/capture-key` is the exception in this table — it is **not**
gated by the flag (the key is a public value, and publishing it early means
flipping the flag later strands nobody), which is why it is listed here rather
than in the auth/account section it otherwise belongs to.

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| PUT | `/v1/account/capture-key` | `requireSession` (seed-once; identical key ⇒ 204 no-op, different key ⇒ 409) | — | none |
| GET | `/v1/vault/capture-key` | `requireSession, owner` (409 `vault-capture-key-missing` until the owner unlocks on the web once) | — | none |
| POST | `/v1/vault/captures` | `requireSession, owner, writableGate` (plan item cap counts captures ⇒ 402; size ceiling ⇒ 413) | — | none |
| PUT | `/v1/vault/captures/:id/bytes` | `requireSession, owner, writableGate` (Content-Length must equal the declared size; atomic storage reservation) | — | none |
| GET | `/v1/vault/captures` | `requireSession, owner` (the filing queue: id, tier, size, createdAt — nothing else) | — | none |
| GET | `/v1/vault/captures/:id` | `requireSession, owner` (sealed key + nonce; openable only with the master-derived secret) | — | none |
| GET | `/v1/vault/captures/:id/bytes` | `requireSession, owner` | — | none |
| DELETE | `/v1/vault/captures/:id` | `requireSession, owner` (no step-up, no cooldown — a capture has never been under a tier key, so discarding one is not a vault deletion) | — | none |

## Step-up — fresh second factor, applied immediately (6)

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| POST | `/v1/auth/totp/setup` | `requireSession, requireStepUp(totp_setup)` | no | none |
| POST | `/v1/auth/password/set` | `requireSession, requireStepUp(password_set)` | no | none |
| POST | `/v1/auth/hardware-key/register/verify` | `requireSession, requireStepUp(register_hardware_key)` | no | none |
| POST | `/v1/vault/items/revert` | `requireSession, owner, writableGate, requireStepUp(revert_vault_item)` | no | none |
| POST | `/v1/engine/cancel-release` | `requireSession, requireFreshSecondFactor` | no | none |
| POST | `/v1/engine/resolve-review` | `requireSession, requireFreshSecondFactor` | no | none |
| POST | `/v1/engine/confirm-return` | `requireSession, requireFreshSecondFactor` | no | none |

## Step-up — delayed sensitive actions (7-day cooldown) (16)

These enqueue and apply after the cooldown; the owner is notified on every
channel (including one whose own removal is pending — docs/10-threat-5.2) and
can cancel during the window via `/v1/account/sensitive-actions/cancel`.

| Method | Path | Gate | Action type | Rate-limit |
|---|---|---|---|---|
| POST | `/v1/account/recovery-code/rotate` | `requireSession, owner, requireStepUp(...)` | `rotate_recovery_code` | none |
| POST | `/v1/account/master-passphrase/rotate` | `requireSession, owner, requireStepUp(...)` | `rotate_master_passphrase` | none |
| POST | `/v1/account/release-passphrase/rotate` | `requireSession, owner, requireStepUp(...)` | `rotate_release_passphrase` | none |
| POST | `/v1/account/hardware-keys/remove` | `requireSession, owner, requireStepUp(...)` | `remove_hardware_key` | none |
| POST | `/v1/account/delete` | `requireSession, owner, requireStepUp(...)` | `delete_account` | none |
| POST | `/v1/release/share-composition` | `requireSession, owner, requireStepUp(...)` | `change_share_composition` | none |
| POST | `/v1/contacts/shares` | `requireSession, requireContactEnrolled, requireStepUp(...)` | `add_contact` | none |
| POST | `/v1/contacts/remove` | `requireSession, requireStepUp(...)` | `remove_contact` | none |
| POST | `/v1/contacts/role` | `requireSession, requireStepUp(...)` | `change_contact_role` | none |
| POST | `/v1/contacts/rotate` | `requireSession, requireStepUp(...)` | `rotate_contact` | none |
| POST | `/v1/contacts/beneficiary` | `requireSession, requireContactDesignatable, requireStepUp(...)` | `designate_beneficiary` | none |
| POST | `/v1/contacts/beneficiary/remove` | `requireSession, requireStepUp(...)` | `remove_beneficiary` | none |
| POST | `/v1/vault/items/tier` | `requireSession, owner, writableGate, tierMovePrecondition, requireStepUp(...)` | `set_vault_item_tier` | none |
| POST | `/v1/vault/items/delete` | `requireSession, owner, writableGate, requireStepUp(...)` | `delete_vault_item` | none |
| POST | `/v1/vault/items/attachments/purge` | `requireSession, owner, writableGate, requireStepUp(...)` | `purge_attachment` | none |
| POST | `/v1/settings/channels/remove` | `requireSession, requireStepUp(...)` (VERIFIED channels; not AI-enqueueable — pinned by test) | `remove_channel` | none |

## AI — session-gated, fail-soft (docs/25, docs/AI.md) (11)

Every AI route is behind `requireSession`, is governed by the `AI_ENABLED` kill
switch + per-user opt-out + the cost breaker (a suppressed call returns the
disabled/unavailable shape, never an error page), and **none is a sensitive
action** — nothing here mutates the engine, tiers, contacts, or key material.

| Method | Path | Gate | Delayed | Rate-limit |
|---|---|---|---|---|
| POST | `/v1/ai/assist` | `requireSession` | — | `ai-assist` |
| POST | `/v1/ai/draft-invite` | `requireSession` | — | `ai-assist` |
| GET | `/v1/ai/plan` | `requireSession` | — | `ai-assist` |
| GET | `/v1/briefing` | `requireSession` | — | `ai-briefing` (over-limit ⇒ cached/degraded briefing, no 429) |
| GET | `/v1/ai/readiness` | `requireSession` | — | `ai-briefing` for the LLM explanation only — over-limit falls back to the deterministic template; the route itself never 429s |
| GET | `/v1/ai/proposals` | `requireSession` | — | none (DB read) |
| POST | `/v1/ai/proposals/:id/decision` | `requireSession` | — | none (records the owner's approve/reject; **no server mutation**) |
| GET | `/v1/account/ai-settings` | `requireSession` | — | none |
| POST | `/v1/account/ai-opt-out` | `requireSession` | — | none |
| GET | `/v1/account/ai-autonomy` | `requireSession` | — | none |
| POST | `/v1/account/ai-autonomy` | `requireSession` | — | none (per-user autonomy opt-in + check-in floor) |

AI-*initiated* mutations (Phase 2 autonomy) do not get new routes: the worker
enqueues `change_inactivity_threshold` through the existing sensitive-actions
pipeline (7-day cooldown, badge + veto via the existing
`/v1/account/sensitive-actions/cancel`). Continuity-Report narration (G-1)
likewise adds no route — it rides the recipient-gated report GET above.

---

## Summary (proportions, not a total — the table above is the count)

- **12** public (3 health/ready/worker-liveness, 1 public status, 5 auth lanes — 3 rate-limited, 2 HMAC webhooks, 1 Meta subscription handshake).
- **15** session auth/account (incl. the 2 owner audit-chain routes and the flag-gated ops centre), **7** contacts, **5** engine (incl. the
  flag-gated CV live view), **6** channels, **2** billing.
- **15** ceremony-family routes (participant-authorized; release-material reads
  403 pre-`reconstructing`).
- **9** vault + release-composition owner-gated non-sensitive.
- **8** vault capture (docs/34) — 7 behind `VAULT_CAPTURE_ENABLED`, plus the
  ungated capture-key publish.
- **7** step-up-immediate (4 full step-up + 3 freshness-only: cancel-release,
  resolve-review and confirm-return — the three protective owner exits, all on
  the lighter gate so cancellation stays easier than progression).
- **16** delayed sensitive actions (step-up + 7-day cooldown), incl.
  `remove_channel` for verified channels.
- **11** AI routes (session-gated, fail-soft, none sensitive).

Every data/mutation route is behind `requireSession`; every key-material or
release-composition mutation is additionally behind `owner` + step-up; every
destructive or release-shape change is additionally **delayed**. The only
unauthenticated mutating surfaces are account registration/login (rate-limited)
and the two HMAC-verified webhooks. The AI surface adds **no** new mutation
authority: its only writes are the owner's own settings/decisions, AI-initiated
changes ride the existing delayed sensitive-action lane, and narration writes
only its own nullable display columns beside the sealed report.
