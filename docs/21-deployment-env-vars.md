# 21 — Environment variable contract

Every environment variable the **API** (`apps/api`) and **worker**
(`apps/worker`) read, what each is for, and — the part that matters for the
security model — **what happens when it is absent**.

That last column is the reason this page is public. Several of Truecairn's
claims reduce to "the process refuses to do the unsafe thing when a secret is
missing", and this is where that behaviour is written down per variable, next to
the code that implements it. A reader checking whether the product fails closed
should not have to infer it from `config.ts` alone.

This is the contract, not a deployment procedure: the values themselves, the
platform they are set on, rotation mechanics and the production topology are
operational and are not published.

Source of truth: `apps/api/src/config.ts` (`loadConfig`), `apps/worker/src/main.ts`,
and `packages/audit/src/keys.ts` (`resolveServerSigner`). Defaults shown are the
literal fallbacks in those files.

## How to read "If missing"

- **fail-closed** — the feature/route is disabled or the process refuses to do
  the unsafe thing. Safe by default.
- **degraded** — the process runs, but with a weaker or ephemeral substitute
  (usually announced by a loud `stderr` warning).
- **throws / exits** — the process cannot start.
- **default** — a built-in fallback is used; fine for dev, often wrong for prod.

## Must-set-and-persist before production

These are the secrets whose loss or rotation breaks already-stored data or
identity. They are durable by nature, and the production boot guard refuses to
start on an ephemeral substitute for any of them — that refusal is the invariant,
and this table is what it protects:

| Variable | Why it must persist |
|---|---|
| `TOTP_KEK` | Wraps TOTP secrets at rest; a new value orphans every enrolled TOTP secret. |
| `OUTER_LAYER_KEK` | Wraps the per-tier outer temporal-gate keys; a new value makes already-stored vault items un-unwrappable at the outer layer. **API and worker must share the same value.** |
| `SERVER_AUDIT_SIGNING_KEY` | The Ed25519 audit-log signing identity; absent ⇒ a fresh key per restart. **API and worker MUST share the same value** — a mismatch silently breaks cross-process sensitive-action applies (the worker's apply links `audit_id_terminal` → `audit_log.id` and into the per-user hash chain), not just signature verifiability. |
| `NOTIFICATIONS_WEBHOOK_SECRET` | HMAC secret the delivery webhook verifies; must match the value configured at the provider. |
| `DATABASE_URL` | Connection to the durable store that holds everything above. |

Rotation without re-enrolment is supported through the matching `*_PREVIOUS`
slots documented below, which hold the prior key so material not yet re-wrapped
still unwraps. The operational procedure for performing one is not published.

---

## Database

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `DATABASE_URL` | API, worker | Postgres connection string (`postgresql://…`). | **API: degraded** — runs DB-less: `/health` answers, `/ready` reports not-ready, every session/data route fails closed. **Worker: exits(1).** | Value must be correct + stable; the DB it points at is the durable store. |

## Cryptographic keys & secrets

All KEKs are 32 raw bytes, base64-encoded. The `*_PREVIOUS` slots are optional and
hold only the prior key, kept to unwrap material not yet re-wrapped after a rotation.

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `TOTP_KEK` | API | Current server KEK encrypting TOTP secrets at rest. | **degraded** — ephemeral key + loud warning; TOTP secrets do not survive a restart (users must re-enrol). | **Yes.** |
| `TOTP_KEK_PREVIOUS` | API | Prior TOTP KEK (rotation only). | no-op (single-key ring). | While any secret is still wrapped under it. |
| `OUTER_LAYER_KEK` | API, worker | Current platform KEK wrapping the per-tier outer-layer keys (temporal gate). Not a confidentiality key — inner wraps still need the master passphrase. | **degraded** — ephemeral key + loud warning; outer wraps written before restart can't be removed (items unreadable at the outer layer). Worker: empty ring ⇒ `set_vault_item_tier` re-wraps fail + retry (never applies under a wrong key). | **Yes — identical in API and worker.** |
| `OUTER_LAYER_KEK_PREVIOUS` | API, worker | Prior outer-layer KEK (rotation only). | no-op. | While any tier key is still wrapped under it. |
| `OUTER_LAYER_KEK_PROVIDER` | API, worker | Selects the outer-layer KEK seam: unset/`env` (default — KEK in env, above) or `gcp-kms` (HSM-backed — Cloud KMS holds the KEK; wrap/unwrap are KMS calls; no raw KEK in env/process). docs/18 §outer-layer. | defaults to `env`. | Identical in API and worker. |
| `OUTER_LAYER_KMS_KEY` | API, worker | When `OUTER_LAYER_KEK_PROVIDER=gcp-kms`: the Cloud KMS cryptoKey resource (`projects/P/locations/L/keyRings/R/cryptoKeys/K`). Auth is ADC (same `GOOGLE_APPLICATION_CREDENTIALS`/`GOOGLE_SERVICE_ACCOUNT_JSON` as Vertex). | with `gcp-kms` set: API refuses to start; worker logs + tier-moves fail+retry. | **Yes — identical in API and worker.** `OUTER_LAYER_KEK` is then NOT required. |
| `IP_HASH_PEPPER` | API | Pepper for hashing client IPs in `auth_attempts` / anomaly signals (never a raw IP at rest). base64, ≥16 bytes decoded. | **degraded (silent, acceptable)** — ephemeral random; only cross-restart continuity of rate-limit windows (minutes) is lost. | Optional (recommended for stable rate-limit buckets). Never log it. |
| `SERVER_AUDIT_SIGNING_KEY` | API, worker | Ed25519 private key (PKCS8/base64) that signs audit-log entries. | **degraded** — a new signer is minted each start (its public key is auto-registered so prior entries still verify, but the identity changes every restart and the private key is not persisted) + loud warning. | **Yes — identical in API and worker.** Load-bearing beyond verifiability: the worker's sensitive-action applies write `audit_log` entries that the action rows FK to (`audit_id_terminal`) and link into the per-user hash chain — separate keys/identities silently break cross-process applies. |

## WebAuthn (passkeys + hardware keys)

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `WEBAUTHN_RP_ID` | API | Relying-party ID = the registrable domain (no scheme/port). | default `localhost` — **wrong in prod**; passkeys bound to the wrong RP fail to register/assert. | Must be **stable** (it is bound into stored credentials; changing it breaks existing passkeys). |
| `WEBAUTHN_ORIGIN` | API | Exact client origin an assertion must come from. **Also derives the session cookie's `Secure` flag**, so since 2026-08-07 a production boot with a non-`https://` value THROWS rather than silently issuing a non-Secure cookie (audit finding 9). | default `http://localhost:3001` — **wrong in prod**; production now refuses to boot rather than accepting it, and assertions from the real origin would be rejected anyway. | Stable. |
| `WEBAUTHN_RP_NAME` | API | Display name shown by the authenticator. | default `Truecairn`. | Cosmetic. |
| `WEBAUTHN_NATIVE_ORIGINS` | API | Comma-separated **extra exact origins** a native client may assert from, appended to `WEBAUTHN_ORIGIN` (docs/35 §3). Android's Credential Manager sends `android:apk-key-hash:<base64url(sha256(signing cert))>`, which is not an https origin and can never be inferred — derive it with `node scripts/android-passkey-identity.mjs <fingerprint>`. | **absent ⇒ byte-identical to before it existed** (the verifier gets the same lone origin string). Mobile passkey sign-in then fails closed: the server rejects every assertion from the app. | Stable, and it IS the app's signing identity — rotate the keystore, rotate this value. Must be kept in step with `sha256_cert_fingerprints` in `/.well-known/assetlinks.json`, which gates the same thing from the OS side. |

## Notifications

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `RESEND_API_KEY` | worker | API key for the Resend email provider. | **degraded (honest-fail)** — no email provider registered ⇒ email deliveries dead-letter as `no_provider_configured` (never a silent success) + warning. | Secret; stable. |
| `NOTIFICATIONS_FROM` | worker | `From:` address for outbound email. Required *with* `RESEND_API_KEY`. | as above — email disabled until both are set. | Stable. |
| `NOTIFICATIONS_WEBHOOK_SECRET` | API | Secret the delivery webhook (`POST /v1/notifications/webhook/:provider`) verifies each callback against. Two accepted schemes under this one value, chosen by the arriving headers: **Svix** (what Resend sends in production — set this to the endpoint's `whsec_…` signing secret from the Resend dashboard; signatures over `id.timestamp.body`, ±5 min replay bound) or the `x-truecairn-signature` raw-body HMAC (ops/relay path). | **fail-closed** — the webhook route is **not mounted**; delivered/bounced callbacks aren't processed (channel health then reflects only send-time success). | **Yes** — for production Resend it IS the endpoint's `whsec_…` secret. |

## Continuity Verification (docs/26)

All default-off; with both flags off, notification behaviour is byte-for-byte
what it was before CV existed (docs/26 D8). No CV variable may refuse boot.

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `CV_FANOUT_ENABLED` | worker | Enable the cadence sweep: repeated verification waves to every matrix-enabled verified channel while the owner is in `check_in_pending`/`escalation_pending`. Wave responses are evidence only, never a check-in (D4). | default `false` — no waves; only the entry one-shot notice. | No. |
| `CV_REPORT_ENABLED` | worker + API | Worker: freeze an audit-anchored Continuity Report onto each release ceremony at creation. API: expose the owner's live `GET /v1/engine/verification-status`. Set on **both** services or neither. | default `false` — no reports attached, live view 404s. | No. |
| `CV_NARRATION_ENABLED` | API | AI plain-language narration of the frozen Continuity Report, generated lazily on the recipient-gated read path (the worker makes no AI calls) and stored beside the sealed payload. Needs the AI generator (Gemini credential + `AI_ENABLED`). Optional ceilings `AI_RATE_NARRATION_PER_USER` / `AI_RATE_NARRATION_PER_IP`. | default `false` — report responses byte-identical to pre-narration. | No. |
| `CV_ATTEMPT_SPACING_HOURS` | worker | Gap between waves on one channel (wave 1 fires this long after state entry). | default `24`. | No. |
| `CV_MAX_ATTEMPTS_PER_CHANNEL` | worker | Sweep-issued waves per channel per episode (the entry one-shot is not counted). | default `3`. | No. |
| `WELCOME_EMAIL_ENABLED` | API | One-time branded welcome email on a user's first verified email channel. | default `true` — set `false` to suppress; needs a working email provider to deliver. | No. |
| `VAULT_CAPTURE_ENABLED` | API | Write-only vault capture from the Flutter app (docs/34): the `/v1/vault/captures` family plus `GET /v1/vault/capture-key`. The phone seals a new item to the owner's X25519 capture PUBLIC key and can never read one back; the owner files it on the web. **`PUT /v1/account/capture-key` is deliberately NOT gated by this** — the key is a public value, and publishing it early means flipping the flag on later strands nobody. | default `false` — the routes are not registered, so the API is byte-for-byte pre-capture. | No. |
| `VAULT_MAX_CAPTURE_BYTES` | API | Per-capture ceiling. | default `16777216` (16 MiB). | Tuning. Deliberately far below `VAULT_MAX_ATTACHMENT_BYTES`: a capture is ONE AEAD message, so the sending phone holds plaintext and ciphertext at once. |

## Billing (LemonSqueezy, docs/28)

All optional; absent ⇒ the app runs **free-only** (no paid upgrades) and never
refuses boot. Prices and plan definitions live in the LemonSqueezy dashboard,
never in env or code — env only carries the webhook secret and the hosted
checkout URLs.

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `LEMONSQUEEZY_WEBHOOK_SECRET` | API | Secret the billing webhook (`POST /v1/billing/webhook/lemonsqueezy`) verifies `X-Signature` (hex HMAC-SHA256 over the raw body) against. | **fail-closed** — the webhook route is **not mounted**; subscriptions never update, so everyone stays on the free plan. | **Yes** — the LemonSqueezy webhook signing secret. |
| `LEMONSQUEEZY_CHECKOUT_PRO_MONTHLY` | API | Hosted checkout URL for the Pro monthly variant. The API appends the buyer's user id + email as checkout custom data. | checkout for that plan returns 404; the upgrade button errors. | Stable. |
| `LEMONSQUEEZY_CHECKOUT_PRO_ANNUAL` | API | Hosted checkout URL for the Pro annual variant. | as above. | Stable. |
| `LEMONSQUEEZY_CUSTOMER_PORTAL_URL` | API | The store's stable billing page (`https://<store>.lemonsqueezy.com/billing`) — where a subscriber **cancels** or updates a card. Returned as `customerPortalUrl` from `/v1/billing/status` for anyone holding a subscription row (including a lapsed or cancelled one — that is who needs it), and rendered as "Manage subscription". Deliberately NOT the per-subscription `urls.customer_portal` on the webhook payload: that is a signed link that expires, so persisting it would hand someone a dead URL on the day they reach for it. | no manage link renders — and "Cancel anytime", promised on the checkout page and `/upgrade`, has no route in the product; cancelling means finding the LemonSqueezy receipt email. | Stable. |
| `LEMONSQUEEZY_TEST_MODE` | API | Accept LemonSqueezy **test-mode** webhook events. Every payload carries `meta.test_mode`; with this unset a test-mode event is **ignored** and recorded as a `billing_test_mode_event_ignored` security event, so once the store is live a stray test event (a replay, a sandbox still pointed at the production endpoint, a mis-set dashboard URL) cannot entitle a real account. **LIVE events are never gated by this** — real money always entitles, because a silent entitlement failure after a real charge is a refund and an apology, not a bug report. Deliberately not derived from `NODE_ENV`: the pre-launch test purchase is made in test mode against the live deployment, and a `NODE_ENV`-derived guard would refuse exactly that. | default `false` — test-mode events ignored. | No. Set it for the pre-launch test purchase, unset it at the switchover. |

### CV channel adapters (CV-2 SMS + push, CV-3 WhatsApp)

Each adapter is disabled-with-a-log-line when its credentials are absent; none
may refuse boot. An unconfigured type also cannot mint a verified channel (its
verification code never sends). External clocks — US A2P 10DLC registration
(SMS) and Meta template approval (WhatsApp) — are ops steps, not code blockers.

**SMS and WhatsApp deliberately do not share a vendor.** Twilio carries SMS;
WhatsApp goes direct to Meta's Cloud API. docs/04 §4.4 assumes any single
channel can fail, and two channel types behind one account, one credential pair
and one API host are one channel wearing two names — an outage, a suspension or
a leaked token took both at once, in exactly the situation the second channel
exists for. Consolidating them again would re-open that gap; it is a threat-model
change, not a cleanup.

A WhatsApp notice with no approved template must never fall back to free text —
the transport accepts one and Meta drops it, which would report success for a
message nobody received. It dead-letters instead, named in the delivery's
`last_error`.

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `PUBLIC_BASE_URL` | API + worker | Public origin of the API (scheme+host, no trailing slash). Twilio signs its status webhook over the exact URL it called, so verification needs it verbatim; the worker builds the StatusCallback URL from it. | falls back to `WEBAUTHN_ORIGIN` (identical in the single-origin deploy). | Stable. |
| `TWILIO_ACCOUNT_SID` | worker (send) | Twilio account SID. | **degraded** — sms + whatsapp deliveries dead-letter. | Stable. |
| `TWILIO_AUTH_TOKEN` | API (verify) + worker (send) | Twilio auth token. The API uses it ONLY to verify `X-Twilio-Signature` on the status webhook; the worker sends with it. | **degraded** — twilio webhook branch rejects (fail closed); sends dead-letter. | Secret; stable. |
| `TWILIO_SMS_FROM` | worker | A2P-registered sending number for SMS (CV-2). | **degraded** — sms channel disabled. | Stable. |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | worker | Meta Cloud API phone-number id (numeric, from WhatsApp Manager — not the phone number). | **degraded** — whatsapp channel disabled. | Stable. |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | worker (send) | Bearer token for the Cloud API. **Must be a System User permanent token** — a token generated in the app dashboard expires after 24h and surfaces as a 401 on the next send, i.e. the channel dies silently overnight. | **degraded** — whatsapp channel disabled. | Secret; **rotate deliberately, never let it lapse**. |
| `WHATSAPP_CLOUD_APP_SECRET` | API (verify) | Meta app secret — verifies `X-Hub-Signature-256` on the status webhook. A different credential from the access token, with a different lifetime. | **degraded** — the meta webhook branch rejects (fail closed); WhatsApp deliveries never leave `sent`, so the Continuity Report scores them indeterminate. | Secret; stable. |
| `WHATSAPP_CLOUD_VERIFY_TOKEN` | API (verify) | The token echoed back in Meta's `GET` subscription handshake. Any high-entropy string, also pasted into the Meta dashboard. | the handshake rejects, so the webhook cannot be registered. | Secret; stable. |

**WhatsApp template names are not environment variables.** Unlike a per-account
SID, we choose the name at creation time, so template identity lives in
`packages/notifications/src/whatsapp-templates.ts` (nine names, approved in `en`
— Meta treats name+language as one identity, so an `en_US` approval will not
send). Create each in the Meta dashboard with the body text from that file,
copied verbatim; a drift test fails the build if it stops matching what the
other channels send. Submit `truecairn_channel_verification` as
**AUTHENTICATION** — the owner ratified reversing the original UTILITY decision
on 2026-07-31, because Meta refused UTILITY for it anyway, that one template
gates *all* WhatsApp enrolment (so an appeal blocks the whole channel while it
runs), and AUTHENTICATION is exempt from the marketing pause. The cost is that
Meta fixes the wording, so this is the one purpose whose WhatsApp text
legitimately differs from its email and SMS text. This paragraph instructed the
opposite until 2026-08-01; the template entry and `.env.example` were corrected
on 2026-07-31 and this one was missed.
| `VAPID_PUBLIC_KEY` | API + worker | VAPID public key for web push (CV-2). The API serves it to the SPA; the worker signs with it. Public by definition. | **degraded** — push UI hidden; push deliveries dead-letter. | Stable. |
| `VAPID_PRIVATE_KEY` | worker | VAPID private key. | **degraded** — push disabled. | Secret; stable. |
| `VAPID_SUBJECT` | worker | VAPID contact (`mailto:` or origin URL). | default `mailto:security@truecairn.app`. | No. |

## AI features (Vertex AI / Gemini)

The AI features are OPTIONAL and fail-soft: with none of these set the LLM
features are disabled and the app runs normally. Prompts carry metadata only
(see `docs/AI.md`; ops: `docs/RUNBOOK-AI.md`). The LLM surfaces (briefing,
assistant, invite drafter, planner, readiness explanation) are **API-only**; the
**worker** makes no model calls but reads the AI *flags* below for its autonomy
and guardian sweeps — a flag flipped on one service and not the other is a
misconfiguration.

### Model provider

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `GEMINI_BACKEND` | API | `api` (default — the Gemini API directly, one key) or `vertex` (through Google Cloud, kept as the rollback path). **The privacy property is the BILLING TIER, not the backend**: a free key permits training on prompts, a billing-enabled one does not. | default `api`. | No. |
| `GOOGLE_CLOUD_PROJECT` | API | GCP project for the Vertex backend. Unset in production since 2026-08-25 — documented because the vertex branch is still in the code, and `docs-truth.test.ts` requires every env var the code reads to be discoverable in `.env.example`. | **fail-closed** — Vertex backend stays disabled (AI features off). | Stable. |
| `GOOGLE_CLOUD_LOCATION` | API | Vertex region. | default `us-central1`. | No. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | API | Service-account key, as **raw JSON or base64-of-JSON** (base64 dodges web-UI quote/newline mangling); decoded + written to a `0600` temp file at boot so Vertex ADC (`GOOGLE_APPLICATION_CREDENTIALS`) can read it — Railway injects secrets as env, not files. GCP auth infra, **not** a zero-knowledge secret; never logged. Skipped if `GOOGLE_APPLICATION_CREDENTIALS` is already a real file path. | Vertex auth fails at call time ⇒ AI features fail-soft. | Secret; stable. |
| `GEMINI_API_KEY` | API | AI-Studio key for the `api` backend (testing path; an AI-Studio key alone is not a Google Cloud product). | **fail-closed** — `api` backend disabled. | Secret; stable. |
| `GEMINI_MODEL` | API | Gemini model id. Changing it requires a clean `scripts/ai-live-eval.ts` run first (docs/AI.md §provider). **The thinking control follows the model family** — see `thinkingControlFor()` in `apps/api/src/ai/gemini.ts`; a 3.x model silently ignores the 2.5 control. | default `gemini-3.7-flash`. | No. |

### AI controls (docs/25 — kill switch, capability flags, budget)

All parsed permissively (`0/false/off/no` ⇒ off) so an operator flipping a flag
in the Railway UI behaves as expected. **Set identically on API and worker.**

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `AI_ENABLED` | API, worker | **Master kill switch.** Off ⇒ every AI surface returns its disabled state, zero model calls, worker AI sweeps no-op. Vault/engine/ceremonies unaffected. | default `true` (preserves the pre-plan assist/briefing behaviour). | No — but keep API and worker identical. |
| `AI_PROPOSER_ENABLED` | API | Phase 1: readiness report explanation + proposal generation/inbox. | default `false` (**fail-closed**). | No. |
| `AI_AUTONOMY_ENABLED` | worker | Phase 2: the autonomy sweep (still requires the **per-user opt-in** + floor in Settings). | default `false` (**fail-closed**). | No. |
| `AI_GUARDIAN_ENABLED` | worker | Phase 3: the guardian sweep (deterministic detectors → `review_required`). | default `false` (**fail-closed**). | No. |
| `AI_DAILY_TOKEN_BUDGET` | API, worker | Deployment-wide daily token budget; crossing it trips the cost breaker (AI fails soft `unavailable` until UTC midnight; `ai_breaker_tripped` audited once). **Gates FREE accounts only** — paid accounts are bounded by their own budget alone, so no account can be switched off by another's spend (`PLAN_LIMITS.aiGatedByGlobalBudget`). The usage row it measures still counts every account, because `packages/ops` reads it as the AI health series. | unset ⇒ **no global breaker**. | No. |
| `AI_USER_DAILY_TOKEN_BUDGET` | API | Per-account daily token budget (checked before the deployment-wide one), **scaled by the plan's `PLAN_LIMITS.aiTokenBudgetMultiplier`** — free ×1, Personal ×3. | unset ⇒ no per-user breaker, on any plan. | No. |

### AI rate limits (per route class, fixed window)

| Variable | Used by | Purpose | Default |
|---|---|---|---|
| `AI_RATE_WINDOW_MS` | API | Window for all AI rate classes. | `3600000` (1 h) |
| `AI_RATE_ASSIST_PER_USER` / `AI_RATE_ASSIST_PER_IP` | API | `ai_assist` class: assistant, draft-invite, plan. Exceeding ⇒ 429 + `retryAfterSeconds`. | `20` / `60` |
| `AI_RATE_BRIEFING_PER_USER` / `AI_RATE_BRIEFING_PER_IP` | API | `ai_briefing` class: briefing + the readiness explanation (readiness itself never 429s — over-limit falls back to the deterministic template). | `30` / `90` |
| `AI_RATE_GUARDIAN_EXPLAIN_PER_USER` / `AI_RATE_GUARDIAN_EXPLAIN_PER_IP` | API | `ai_guardian_explain` class (guardian narration reads). | `30` / `90` |

### Guardian detector thresholds (worker; docs/AI.md §detectors)

| Variable | Purpose | Default |
|---|---|---|
| `GUARDIAN_AFFIRMATION_THRESHOLD` / `GUARDIAN_AFFIRMATION_WINDOW_MIN` | `affirmation_velocity` (severity 2, bypasses cooldown): ≥ N committed affirmations within the window during a ceremony. | `3` / `5` |
| `GUARDIAN_FAILED_AUTH_THRESHOLD` / `GUARDIAN_FAILED_AUTH_WINDOW_MIN` | `failed_auth_during_release` (severity 1): ≥ N failed auth attempts within the window while a release is in progress. | `5` / `15` |
| `GUARDIAN_COOLDOWN_DAYS` | Hysteresis: at most one automatic review per user per period (severity-2 bypasses). | `7` |

## Vault limits (tuning)

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `VAULT_MAX_ITEM_CONTENT_BYTES` | API | Max item content size. | default `262144` (256 KiB). | Tuning; keep consistent across API instances. |
| `VAULT_MAX_ATTACHMENT_BYTES` | API | Max single attachment size. | default `104857600` (100 MiB). | Tuning. |
| `VAULT_MAX_USER_TOTAL_BYTES` | API | Global HARD ceiling on per-user storage; the effective budget is the smaller of this and the user's PLAN cap (docs/28). | default `5368709120` (**5 GiB**) — deliberately the top plan's figure so it never silently undercuts a paid account. | Tuning. **Do not pin this to 1 GiB**: this table said `1073741824` until 2026-08-01, and an operator who copied it would have capped every Pro user at a fifth of the 5 GB they are sold. |
| `ATTACHMENTS_BACKEND` | API, worker | Attachment blob backend: `local` or `s3`. | default `local`. | Must match between API + worker. |
| `ATTACHMENTS_DIR` | API, worker | `local` backend: base dir for attachment ciphertext blobs. | default `attachments`. | `local` only: the **directory contents** must persist (durable volume) and the path must be the **same** for API (writes) and worker (purges). |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | API, worker | `s3` backend: S3-compatible target (AWS S3 / R2 / B2 / MinIO). | **all five required** when `ATTACHMENTS_BACKEND=s3` (startup throws otherwise). | Same values for API + worker. The secret key is durable + sensitive. |
| `S3_FORCE_PATH_STYLE` | API, worker | `s3` URL style: path-style (`true`, default) vs virtual-hosted (`false`). | default `true` (R2/MinIO/most). | Set `false` for AWS S3 virtual-hosted. |

## Process / worker tuning

| Variable | Used by | Purpose | If missing | Persist |
|---|---|---|---|---|
| `PORT` | API | Listen port. | default `3001`. | No. |
| `HOST` | API | Listen address. | default `0.0.0.0`. | No. |
| `LOG_LEVEL` | API | `fatal\|error\|warn\|info\|debug\|trace\|silent`. | default `info` (invalid ⇒ `info`). | No. |
| `NODE_ENV` | API | Runtime environment label. | default `development`. | No. |
| `AUDIT_MODE` | worker | `signed` (real Ed25519 chain) or `log` (unsigned dev stub). | default `signed`. **Prod must be `signed`/unset** — `log` writes no cryptographic audit. | No. |
| `WORKER_POLL_INTERVAL_MS` | worker | Poll loop interval. | default `10000`. | No. |
| `WORKER_BATCH_SIZE` | worker | Rows claimed per tick. | default `50`. | No. |
| `WORKER_ID` | worker | Identity for the DB-backed liveness row (migration 0052) read by `GET /health/worker`. The DB heartbeat is **always on** — it is the floor beneath `HEARTBEAT_URL`, so a deployment that configured no external monitor still cannot end up with no watchdog on its release driver. Note this catches a *different* failure from `scripts/start-railway.sh`'s `wait -n`: that restarts the container when a process **dies**, whereas a worker that is alive but **wedged** (hung mid-tick) keeps the process up and releases silently stop. The heartbeat proves ticks, not process existence. | default: the container hostname. | No. |
| `OPS_ADMIN_EMAILS` | API | Comma-separated account emails allowed to read `GET /v1/ops/system` (the operations centre, `/admin/system`). **Unset ⇒ the routes are not registered at all** — absent rather than 403, so an unused dashboard is not an attack surface and leaks no operational intelligence. An authenticated non-admin also gets 404, not 403, so the endpoint's existence is not confirmable. Read-only aggregate health plus account totals (how many accounts exist / are active / have armed the engine — three integers computed by aggregate, with no per-account row and no way to look one up): no writes, no user lookup, no impersonation, and no user data in the response (pinned by `ops.test.ts`). The totals are composed by the route, never by `collectSystemStatus`, so they cannot reach the public `/status` projection or the worker's health sampler. | default unset — no ops surface. | No. |
| `BACKUPS_LAST_VERIFIED_RESTORE` | API + worker | Date of the last **verified restore** — an ISO day (`2026-08-10`) or full timestamp — recorded by the operator from a completed **restore** drill (docs/23 §Restore drill log, and the drill record at the repo root — docs/29 is the separate ceremony drill). Drives the `backups` tile on `/admin/system` and its **state** on the public `/status` page: `ok` while fresh, `degraded` once past the quarterly cadence (`RESTORE_ATTESTATION_STALE_AFTER_DAYS`, 92 days, in `packages/ops`), `unknown` when unset. Deliberately a **date, not a boolean**: "backups are on" is unverifiable from here and would never expire, whereas "a restore completed on this date" is checkable against a drill record and goes stale on its own — which is the only reason an operator-supplied value is allowed to render green at all. A future or unparseable value is treated as **no attestation**, never as verified. It never claims anything about the snapshots themselves; those are platform-managed and not observable from the application. Set it on the API service (which serves both status surfaces); the worker reads it only so its in-memory status object matches, and `backups` is not release-critical, so it cannot move the composite or the published availability figure. | default unset — the tile reads `unknown`, exactly as it did before the variable existed. | No. |
| `AUDIT_VERIFY_INTERVAL_MS` | worker | How often to verify audit chains (bounded, round-robin — a rotation cadence, not a full scan). A chain that fails to verify is logged at ERROR as `worker.audit_chain_broken`; **alert on that log line**. Never appends to the audit log (extending a broken chain buries the evidence). `0` disables. | default `3600000` (1h). | No. |
| `CEREMONY_SYNC_WINDOW_MS` | API + worker | Affirmation-collection deadline (ms). | default `172800000` (48h). | No. |
| `CEREMONY_REVOCATION_WINDOW_MS` | API + worker | Per-affirmation revocation window (ms) — a **public 48h promise**. In production the API + worker refuse to boot with a value under 1h unless `ALLOW_COMPRESSED_CEREMONY_WINDOWS=true`. | default `172800000` (48h). | No. |
| `ALLOW_COMPRESSED_CEREMONY_WINDOWS` | API + worker | Escape hatch for a deliberately compressed production drill: permits a sub-1h `CEREMONY_REVOCATION_WINDOW_MS` that would otherwise refuse boot. | default unset — the sub-hour-window guard is active. | No. |
| `WEB_DIST_DIR` | API | Built-SPA directory served same-origin (docs/23) — the single origin WebAuthn's `rpId` and the `SameSite=Strict` session cookie both depend on. A **relative** value is resolved against the working directory first (which is `apps/api` under the production `pnpm --filter @truecairn/api start`, so the documented `../web/dist` works) and then against the repo root, so the equally reasonable `apps/web/dist` works too. A value matching neither throws at boot naming both paths tried, rather than surfacing as fastify-static's `"root" path … must exist`. An absolute path avoids the question. | default unset — no static serving; every unknown path is a problem+json 404 and the SPA must be hosted elsewhere (a second origin, which breaks passkeys). | No, but it must match how the service is started. |
| `DRILL_ACCOUNTS` | `scripts/ceremony-drill.ts` | Comma-separated allowlist of email addresses the drill harness may advance down the release ladder (docs/29). **Unset or empty is a refusal, not permission**, and there is no "all accounts" mode — one allowlisted account per invocation. Advancing the wrong one sends real escalation notices to a real person's trusted contacts. | default unset — the script refuses to run. | No. Set it for the drill, unset it afterwards, alongside `ALLOW_COMPRESSED_CEREMONY_WINDOWS`. |
| `DRILL_ALLOW_PRODUCTION` | `scripts/ceremony-drill.ts` | Fourth acknowledgement, required only when `NODE_ENV=production`. A drill account should not live in production; this exists because "the drill database" and "the production database" have looked identical from a shell prompt before. | default unset — the script refuses under `NODE_ENV=production`. | No. |

---
