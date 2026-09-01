// API runtime configuration. Read once at startup. The API does NOT connect to
// the database in the 3.0 scaffold — `databaseUrl` is carried so 3.1 (auth)
// can wire the client without re-plumbing config.

import { createHash, randomBytes } from 'node:crypto';
import { createBlobStore, EnvKekProvider, GcpKmsClient, KmsKekProvider, type BlobStore, type KekProvider } from '@truecairn/vault';
import { canonicalHostFrom } from './canonical-host.js';

export const APP_VERSION = '0.0.0'; // keep in sync with package.json

export interface ApiConfig {
  port: number;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  nodeEnv: string;
  databaseUrl: string | undefined;
  webauthnRpId: string;
  webauthnRpName: string;
  webauthnOrigin: string;
  // Native app origins allowed to assert against the same RP ID (docs/35 §3).
  // Deliberately NOT an `*_ENABLED` capability flag: its value is a signing-key
  // fingerprint, an auth transport detail, not a feature with public-page
  // semantics. Empty by default ⇒ verification is unchanged.
  webauthnNativeOrigins: string[];
  // Versioned server KEKs that encrypt TOTP secrets at rest. `currentId` wraps
  // new secrets; `byId` also holds prior KEKs so a rotation is a background
  // re-encrypt-on-verify, not a forced re-enrol. (Shares the secrets-manager
  // lane flagged for SERVER_AUDIT_SIGNING_KEY in docs/19.)
  totpKeks: TotpKekSet;
  // Pepper for hashing client IPs in auth_attempts / anomaly detection — never
  // store a raw IP. Same secrets-manager lane; ephemeral-with-warning in dev.
  ipHashPepper: Uint8Array;
  // The platform KEK seam that wraps the per-tier OUTER-LAYER keys at rest
  // (PHASE3_3 §c). The API needs this to apply/remove the outer temporal-gate
  // wrap on store/fetch during ACTIVE — the outer key is NOT a confidentiality
  // key (the inner wraps still need the master passphrase), so KEK access doesn't
  // widen plaintext exposure. A KekProvider: env-backed (OUTER_LAYER_KEK, the
  // default) or HSM-backed (GCP Cloud KMS via OUTER_LAYER_KEK_PROVIDER=gcp-kms),
  // where the KEK never enters process memory (Phase 5, docs/18 §outer-layer).
  outerLayerKeks: KekProvider;
  // Vault size limits. A struct, not constants, so Pro/Team tiers lift them via
  // config rather than a code change (PHASE3_3 Q7).
  vaultLimits: VaultLimits;
  // Local-disk base directory for attachment blobs (PHASE3_3 Q5b). Retained for
  // the local backend + visibility; the routes go through `blobStore`.
  attachmentsDir: string;
  // The attachment blob backend (backlog #3): local disk (default) or an
  // S3-compatible object store, selected by ATTACHMENTS_BACKEND. Decouples the
  // API from a shared local disk so it can run separately from the worker.
  blobStore: BlobStore;
  // Shared secret the provider-delivery webhook (POST /v1/notifications/webhook/
  // :provider) HMAC-verifies each callback against (PHASE3_5 §d). Undefined ⇒ the
  // route is not mounted (no secret, nothing to verify against — fail closed).
  notificationsWebhookSecret: string | undefined;
  // Release-ceremony time windows (CEREMONY_COMPLETION). CONFIG-DRIVEN so the E2E
  // can compress them via env without any test-mode branch in the processor/
  // bridges. syncWindow = affirmation-collection deadline; revocationWindow =
  // per-affirmation tentative→committed take-back. Defaults: 48h each.
  ceremonyWindows: { syncWindowMs: number; revocationWindowMs: number };
  // Directory of the built SPA (apps/web/dist). Set ⇒ the API serves it
  // same-origin with an index.html fallback for client routes — the deploy
  // shape (docs/23) where one origin keeps WebAuthn + SameSite cookies whole.
  // Unset (dev/tests/CI) ⇒ no static serving; the vite dev server / preview
  // owns the frontend.
  webDistDir: string | undefined;
  // Behind a reverse proxy / PaaS edge (Railway, a load balancer): trust
  // X-Forwarded-* so request.ip and the https detection see the client, not
  // the proxy. Off by default — only enable where a trusted proxy ALWAYS
  // rewrites those headers, or clients could spoof them.
  trustProxy: boolean;
  // The header the trusted edge writes with the real client address — in
  // production `cf-connecting-ip`, which Cloudflare overwrites on every proxied
  // request. Every per-IP control keys on this. Unset ⇒ the socket peer is used,
  // which behind an edge means one shared bucket (safe, but not per-client).
  // X-Forwarded-For is never consulted: its leftmost entry is client-supplied,
  // which is the QA 2026-08-26 F1 defect. See `auth/client-ip.ts`.
  //
  // Only meaningful while the origin is unreachable except through that edge —
  // set this together with `originGuardSecret`, not on its own.
  clientIpHeader: string | undefined;
  // Shared secret the trusted edge injects on every request (Cloudflare
  // Transform Rule → `x-truecairn-origin-guard`). Set ⇒ requests arriving
  // without it are refused 403 before routing, which is what makes
  // `clientIpHeader` unforgeable. Unset ⇒ the guard is not installed at all.
  // Never set this before the edge rule exists: it would lock out every visitor.
  originGuardSecret: string | undefined;
  // AI continuity-briefing config. OPTIONAL — unlike a
  // durable KEK, an absent AI credential DISABLES the feature, never crashes prod
  // (the briefing is advisory; the dashboard degrades without it). `enabled` is
  // true only when the chosen backend has what it needs.
  aiBriefing: AiBriefingConfig;
  // Continuity Verification (docs/26). Gates the owner's LIVE verification-
  // status view; the frozen per-ceremony report needs no flag here (with the
  // worker's CV_REPORT_ENABLED off no report rows exist and the route 404s
  // naturally). Default off (D8) — flags-off is byte-for-byte pre-CV.
  cvReportEnabled: boolean;
  // AI narration of the frozen Continuity Report (Gap plan G-1). Display-only
  // prose stored BESIDE the sealed payload; off (default) keeps report
  // responses byte-identical to pre-narration behaviour. Requires the AI
  // generator (aiBriefing credential + AI_ENABLED) to actually produce text —
  // absent, the deterministic template stands, exactly as when off.
  cvNarrationEnabled: boolean;
  // Onboarding welcome email (CV-brand pass). Sent once when a user verifies
  // their first email channel. Default true (the owner asked for it); flip off
  // to suppress. Requires a configured email provider to actually deliver.
  welcomeEmailEnabled: boolean;
  // Write-only vault capture from the phone (docs/34). Default OFF: with it off
  // the capture routes are never registered, so the API is byte-for-byte
  // pre-capture and a phone build pointed at production is told the server does
  // not accept captures rather than being handed a half-built path.
  vaultCaptureEnabled: boolean;
  // Billing (LemonSqueezy, docs/28). All optional — absent ⇒ the webhook route
  // is not mounted and checkout returns 404, so the app runs free-only (no paid
  // upgrades) rather than crashing. `webhookSecret` verifies X-Signature;
  // `checkout*` are the hosted LS checkout URLs we redirect the owner to (the
  // dollar amounts live in LemonSqueezy, never here).
  billing: {
    webhookSecret: string | undefined;
    checkoutProMonthly: string | undefined;
    checkoutProAnnual: string | undefined;
    // The store's stable billing page — where a subscriber CANCELS. Unset ⇒
    // /v1/billing/status returns null and no manage link renders.
    customerPortalUrl: string | undefined;
    // Whether LemonSqueezy TEST-MODE webhook events are honoured. Off by
    // default so a stray test event cannot entitle a real account once the
    // store is live; live events are never gated by it (billing/webhook.ts).
    allowTestMode: boolean;
  };
  // The exact public origin of this API (scheme+host, no trailing slash) —
  // Twilio's webhook signature is computed over the full URL it called, so
  // verification needs it verbatim. Falls back to the WebAuthn origin (the
  // single-origin deploy shape makes them identical).
  publicBaseUrl: string;
  // The canonical public HOST, for suppressing crawling of the duplicate site
  // served on api.truecairn.app (canonical-host.ts). Derived ONLY from an
  // explicitly-set PUBLIC_BASE_URL — deliberately NOT from publicBaseUrl above,
  // whose localhost fallback would make every deployed host look non-canonical
  // and noindex the apex. `undefined` ⇒ apply no host restriction at all.
  canonicalHost: string | undefined;
  // Twilio auth token — used here ONLY to verify X-Twilio-Signature on the
  // status webhook (the worker holds it for sending). Absent ⇒ the twilio
  // webhook branch rejects everything (fail closed). SMS only: WhatsApp moved
  // to Meta directly (CV-3), so SMS and WhatsApp no longer share a vendor.
  twilioAuthToken: string | undefined;
  // Meta app secret — verifies X-Hub-Signature-256 on the WhatsApp Cloud API
  // status webhook. A DIFFERENT credential from the send-side access token, with
  // a different lifetime. Absent ⇒ the meta webhook branch rejects (fail closed).
  metaAppSecret: string | undefined;
  // The token Meta echoes back in its GET subscription handshake. Absent ⇒ the
  // handshake rejects, so the webhook can never be registered unverified.
  metaVerifyToken: string | undefined;
  // VAPID public key, served to the SPA so it can subscribe this browser for
  // web push (CV-2). Public by definition; absent ⇒ the push enrolment UI
  // stays hidden.
  vapidPublicKey: string | undefined;
  // AI Guardian guardrails (plan docs/25 §4). The master kill switch, the
  // per-phase capability flags, the cost circuit-breaker budgets, and the AI-route
  // rate-limit ceilings. All defaults are SAFE: the master preserves today's
  // assist/briefing behaviour, every capability phase is off, budgets are
  // unbounded until an operator sets them. NONE of these may refuse boot — an AI
  // misconfiguration degrades the AI, never the vault (plan §9).
  ai: AiControlsConfig;
}

export interface ServerKek {
  id: string;
  key: Uint8Array;
}

export interface KekSet {
  currentId: string;
  byId: Map<string, ServerKek>;
}

// Retained name for the TOTP keyring (structurally identical to KekSet).
export type TotpKek = ServerKek;
export type TotpKekSet = KekSet;

export interface VaultLimits {
  maxItemContentBytes: number;
  maxAttachmentBytes: number;
  maxUserTotalBytes: number;
  // docs/34 §4. Deliberately far below maxAttachmentBytes: a capture is ONE
  // AEAD message, so the sending phone holds plaintext and ciphertext at the
  // same time. A ceiling a phone cannot allocate is a ceiling that loses the
  // thing someone was trying to save.
  maxCaptureBytes: number;
}

export interface AiBriefingConfig {
  enabled: boolean;
  backend: 'vertex' | 'api';
  model: string;
  project: string | undefined;
  location: string | undefined;
  apiKey: string | undefined;
}

// Per-scope, per-hour ceilings for the AI routes (plan §4 task 0.1). Each scope
// has independent per-user and per-IP-hash ceilings; the window is shared. These
// gate MODEL CALLS, not HTTP hits — a cached briefing serve consumes nothing.
export interface AiRateLimits {
  windowMs: number;
  assistPerUser: number;
  assistPerIp: number;
  briefingPerUser: number;
  briefingPerIp: number;
  guardianExplainPerUser: number;
  guardianExplainPerIp: number;
  narrationPerUser: number;
  narrationPerIp: number;
}

export interface AiControlsConfig {
  // Master kill switch (AI_ENABLED). Default true — preserves today's
  // assist/briefing. When false EVERY AI surface returns the defined disabled
  // response and no model call is ever made (the Railway one-flip incident
  // switch, docs/RUNBOOK-AI).
  enabled: boolean;
  // Per-phase capability flags (plan §4 task 0.3). All default false; a phase's
  // flag flips true only once its acceptance criteria + §11 checklist pass.
  proposerEnabled: boolean;
  autonomyEnabled: boolean;
  guardianEnabled: boolean;
  // Cost circuit-breaker budgets (plan §4 task 0.2). undefined ⇒ unbounded.
  // When set, exceeding the global or per-user daily token budget trips the
  // breaker: advisory surfaces go unavailable, the guardian falls back to its
  // deterministic explanation template. The vault/engine/ceremonies are
  // untouched by a tripped breaker.
  dailyTokenBudget: number | undefined;
  userDailyTokenBudget: number | undefined;
  rateLimits: AiRateLimits;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const rawLevel = (env['LOG_LEVEL'] ?? 'info').toLowerCase();
  const logLevel = (LOG_LEVELS as readonly string[]).includes(rawLevel)
    ? (rawLevel as ApiConfig['logLevel'])
    : 'info';
  const nodeEnv = env['NODE_ENV'] ?? 'development';
  // In production a missing server secret must be a refusal to start, not an
  // ephemeral key behind a stderr line: an ephemeral OUTER_LAYER_KEK makes every
  // newly stored vault item unreadable after a restart, and an ephemeral
  // TOTP_KEK invalidates every enrolled second factor. Dev/test keep the
  // generate-with-warning convenience.
  const requireDurableSecrets = nodeEnv === 'production';

  // The session cookie's Secure flag is derived from WEBAUTHN_ORIGIN's scheme
  // (auth-password.ts, auth-webauthn.ts) rather than from NODE_ENV, so a single
  // mistyped env var — production behind a TLS-terminating proxy, WEBAUTHN_ORIGIN
  // left as http:// — silently issued session cookies WITHOUT Secure, and nothing
  // said a word (2026-08-07 audit, finding 9). Assert it here instead, matching
  // how this file already refuses ephemeral OUTER_LAYER_KEK/TOTP_KEK/IP_HASH_PEPPER
  // and a sub-floor revocation window in production: a config that cannot be
  // right should stop the boot, not degrade the transport.
  const webauthnOrigin = env['WEBAUTHN_ORIGIN'] ?? 'http://localhost:3001';
  if (requireDurableSecrets && !webauthnOrigin.startsWith('https://')) {
    throw new Error(
      `WEBAUTHN_ORIGIN must be https:// in production (got '${webauthnOrigin}'); ` +
        'the session cookie derives its Secure flag from this value',
    );
  }

  return {
    port: parsePort(env['PORT'], 3001),
    host: env['HOST'] ?? '0.0.0.0',
    logLevel,
    nodeEnv,
    databaseUrl: env['DATABASE_URL'],
    // WebAuthn relying-party config. rpId is the registrable domain (no scheme/
    // port); origin is the exact client origin the assertion must come from.
    // Dev defaults; production sets these explicitly.
    webauthnRpId: env['WEBAUTHN_RP_ID'] ?? 'localhost',
    webauthnRpName: env['WEBAUTHN_RP_NAME'] ?? 'Truecairn',
    webauthnOrigin,
    webauthnNativeOrigins: parseOriginList(env['WEBAUTHN_NATIVE_ORIGINS']),
    totpKeks: resolveTotpKeks(env['TOTP_KEK'], env['TOTP_KEK_PREVIOUS'], requireDurableSecrets),
    ipHashPepper: resolveIpPepper(env['IP_HASH_PEPPER'], requireDurableSecrets),
    outerLayerKeks: resolveOuterKekProvider(env, requireDurableSecrets),
    vaultLimits: {
      maxItemContentBytes: parseBytes(env['VAULT_MAX_ITEM_CONTENT_BYTES'], 256 * 1024),
      maxAttachmentBytes: parseBytes(env['VAULT_MAX_ATTACHMENT_BYTES'], 100 * 1024 * 1024),
      // A global HARD ceiling only; the effective per-user budget is the smaller
      // of this and the user's PLAN storage cap (docs/28). Default sits at the
      // top plan (5 GB) so it never silently undercuts a paid account.
      maxUserTotalBytes: parseBytes(env['VAULT_MAX_USER_TOTAL_BYTES'], 5 * 1024 * 1024 * 1024),
      maxCaptureBytes: parseBytes(env['VAULT_MAX_CAPTURE_BYTES'], 16 * 1024 * 1024),
    },
    attachmentsDir: env['ATTACHMENTS_DIR'] ?? 'attachments',
    blobStore: createBlobStore(env),
    notificationsWebhookSecret: emptyToUndefined(env['NOTIFICATIONS_WEBHOOK_SECRET']),
    ceremonyWindows: resolveCeremonyWindows(env, requireDurableSecrets),
    webDistDir: emptyToUndefined(env['WEB_DIST_DIR']),
    trustProxy: env['TRUST_PROXY'] === 'true' || env['TRUST_PROXY'] === '1',
    // Lower-cased: Node presents header names lower-cased, and an operator who
    // writes `CF-Connecting-IP` should not get a silently-never-matching lookup.
    clientIpHeader: emptyToUndefined(env['CLIENT_IP_HEADER'])?.toLowerCase(),
    originGuardSecret: emptyToUndefined(env['ORIGIN_GUARD_SECRET']),
    cvReportEnabled: parseBoolFlag(env['CV_REPORT_ENABLED'], false),
    cvNarrationEnabled: parseBoolFlag(env['CV_NARRATION_ENABLED'], false),
    welcomeEmailEnabled: parseBoolFlag(env['WELCOME_EMAIL_ENABLED'], true),
    vaultCaptureEnabled: parseBoolFlag(env['VAULT_CAPTURE_ENABLED'], false),
    billing: {
      webhookSecret: emptyToUndefined(env['LEMONSQUEEZY_WEBHOOK_SECRET']),
      checkoutProMonthly: emptyToUndefined(env['LEMONSQUEEZY_CHECKOUT_PRO_MONTHLY']),
      checkoutProAnnual: emptyToUndefined(env['LEMONSQUEEZY_CHECKOUT_PRO_ANNUAL']),
      // Where a subscriber cancels. The STORE's stable billing page, not the
      // per-subscription `urls.customer_portal` LemonSqueezy puts on every
      // webhook: that one is a signed link that expires, so storing it would
      // hand someone a dead URL on the day they reach for it — the recovery-code
      // failure mode, rebuilt. This link is good forever and the customer
      // authenticates with their own email.
      customerPortalUrl: emptyToUndefined(env['LEMONSQUEEZY_CUSTOMER_PORTAL_URL']),
      // Deliberately NOT derived from NODE_ENV. Production is live long before
      // the store is, so the pre-launch test purchase has to happen against the
      // production deployment — and a NODE_ENV-derived guard would refuse
      // exactly that, which is the failure this guard exists to prevent, moved
      // one step earlier. Explicit, and unset after the switchover.
      allowTestMode: parseBoolFlag(env['LEMONSQUEEZY_TEST_MODE'], false),
    },
    publicBaseUrl:
      emptyToUndefined(env['PUBLIC_BASE_URL']) ?? env['WEBAUTHN_ORIGIN'] ?? 'http://localhost:3001',
    // The raw variable, NOT publicBaseUrl — see the field comment and
    // canonical-host.ts. Absent ⇒ undefined ⇒ no suppression anywhere.
    canonicalHost: canonicalHostFrom(emptyToUndefined(env['PUBLIC_BASE_URL'])),
    twilioAuthToken: emptyToUndefined(env['TWILIO_AUTH_TOKEN']),
    metaAppSecret: emptyToUndefined(env['WHATSAPP_CLOUD_APP_SECRET']),
    metaVerifyToken: emptyToUndefined(env['WHATSAPP_CLOUD_VERIFY_TOKEN']),
    vapidPublicKey: emptyToUndefined(env['VAPID_PUBLIC_KEY']),
    aiBriefing: resolveAiBriefing(env),
    ai: resolveAiControls(env),
  };
}

// AI Guardian guardrails (plan docs/25 §4/§9). Every value here has a SAFE
// default and NONE may refuse boot — an AI misconfiguration must degrade the AI,
// never the vault. The master AI_ENABLED defaults true (today's assist/briefing);
// the per-phase capability flags default false; the budgets are unbounded until
// an operator opts into a ceiling.
function resolveAiControls(env: NodeJS.ProcessEnv): AiControlsConfig {
  const hour = 60 * 60 * 1000;
  return {
    enabled: parseBoolFlag(env['AI_ENABLED'], true),
    proposerEnabled: parseBoolFlag(env['AI_PROPOSER_ENABLED'], false),
    autonomyEnabled: parseBoolFlag(env['AI_AUTONOMY_ENABLED'], false),
    guardianEnabled: parseBoolFlag(env['AI_GUARDIAN_ENABLED'], false),
    dailyTokenBudget: parseOptionalPositiveInt(env['AI_DAILY_TOKEN_BUDGET']),
    userDailyTokenBudget: parseOptionalPositiveInt(env['AI_USER_DAILY_TOKEN_BUDGET']),
    rateLimits: {
      windowMs: parseNonNegativeInt(env['AI_RATE_WINDOW_MS'], hour, 'AI_RATE_WINDOW_MS'),
      assistPerUser: parseNonNegativeInt(env['AI_RATE_ASSIST_PER_USER'], 20, 'AI_RATE_ASSIST_PER_USER'),
      assistPerIp: parseNonNegativeInt(env['AI_RATE_ASSIST_PER_IP'], 60, 'AI_RATE_ASSIST_PER_IP'),
      briefingPerUser: parseNonNegativeInt(env['AI_RATE_BRIEFING_PER_USER'], 30, 'AI_RATE_BRIEFING_PER_USER'),
      briefingPerIp: parseNonNegativeInt(env['AI_RATE_BRIEFING_PER_IP'], 90, 'AI_RATE_BRIEFING_PER_IP'),
      guardianExplainPerUser: parseNonNegativeInt(env['AI_RATE_GUARDIAN_EXPLAIN_PER_USER'], 30, 'AI_RATE_GUARDIAN_EXPLAIN_PER_USER'),
      guardianExplainPerIp: parseNonNegativeInt(env['AI_RATE_GUARDIAN_EXPLAIN_PER_IP'], 90, 'AI_RATE_GUARDIAN_EXPLAIN_PER_IP'),
      // Narration is generated at most once per ceremony report (fill-only-NULL),
      // so the ceiling only bounds retry storms after failures.
      narrationPerUser: parseNonNegativeInt(env['AI_RATE_NARRATION_PER_USER'], 10, 'AI_RATE_NARRATION_PER_USER'),
      narrationPerIp: parseNonNegativeInt(env['AI_RATE_NARRATION_PER_IP'], 30, 'AI_RATE_NARRATION_PER_IP'),
    },
  };
}

// A boolean env flag: 'false'/'0'/'no'/'off' are false, 'true'/'1'/'yes'/'on'
// are true, anything else (incl. unset/empty) falls back to `fallback`. Kept
// permissive so an operator flipping AI_ENABLED=0 on Railway works as expected.
function parseBoolFlag(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

// An optional positive-int env value: undefined when unset/empty/invalid, so a
// budget left unset means "unbounded" rather than "zero" (which would wedge AI
// off entirely). Distinct from parseBytes, which always resolves to a number.
function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// AI briefing is an OPTIONAL external integration, resolved like the notifications
// creds (NOT like a durable KEK): if the chosen backend lacks what it needs the
// feature is simply disabled — never a production startup failure.
//
// THE DEFAULT IS THE DIRECT GEMINI API (2026-08-25). It used to be Vertex, on the
// reasoning that one product satisfied two XPRIZE Stage-One gates at once. That
// programme is no longer being pursued, and it was the only argument for Vertex
// that was not technical — so what is left is the technical comparison, which
// Vertex lost on this project, in production:
//
//   `gemini-3.7-flash` AND `gemini-3.5-flash` both returned 404 NOT_FOUND from
//   locations/us-central1. The 3.x family is served on Vertex's `global`
//   location only, and `global` carries no data residency. So on Vertex the
//   real choice was "no data residency" or "no current model" — and the 2.5
//   family, the one thing that did work there, retires 2026-10-16.
//
// The direct API serves those models with no regional matrix, and needs ONE key
// instead of a project + a location + a service-account JSON materialised to a
// 0600 temp file at boot (see ai/credentials.ts, now dormant).
//
// THE PRIVACY PROPERTY IS THE BILLING TIER, NOT THE BACKEND NAME. On a
// billing-enabled key Google does not train on prompts or responses — the same
// guarantee Vertex gives. On a FREE key it does: submitted content may be used to
// improve Google's products and human reviewers may annotate it. Truecairn sends
// metadata only (AI_CONTEXT_ALLOWLIST — counts, tiers, enums, cadence; never
// content, titles, names or keys), so the exposure is small either way, but the
// distinction is the thing to re-check when a key is rotated. See docs/AI.md.
//
// THE VERTEX BRANCH IS KEPT, NOT DELETED. It costs nothing and turns the next
// provider or regional surprise into a one-variable rollback instead of a revert.
// Vertex credentials still come from ADC (GOOGLE_APPLICATION_CREDENTIALS).
function resolveAiBriefing(env: NodeJS.ProcessEnv): AiBriefingConfig {
  const backend = env['GEMINI_BACKEND'] === 'vertex' ? 'vertex' : 'api';
  const model = emptyToUndefined(env['GEMINI_MODEL']) ?? 'gemini-3.7-flash';
  const project = emptyToUndefined(env['GOOGLE_CLOUD_PROJECT']);
  const location = emptyToUndefined(env['GOOGLE_CLOUD_LOCATION']) ?? 'us-central1';
  const apiKey = emptyToUndefined(env['GEMINI_API_KEY']);
  const enabled = backend === 'vertex' ? project !== undefined : apiKey !== undefined;
  return { enabled, backend, model, project, location, apiKey };
}

function emptyToUndefined(raw: string | undefined): string | undefined {
  return raw !== undefined && raw !== '' ? raw : undefined;
}

// Comma-separated exact origins (docs/35 §3). Blank entries are dropped rather
// than passed through: an empty string is a wildcard-shaped value to hand a
// verifier, and a trailing comma in a deploy variable must not become one.
function parseOriginList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function parseBytes(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Counts, unlike sizes, have a meaningful ZERO — and for a rate ceiling it is the
// most important value an operator can set (2026-08-07 audit, finding 7).
// parseBytes was written for sizes, where 0 is meaningless, and was then reused
// for the AI ceilings: setting AI_RATE_ASSIST_PER_USER=0 to hard-block assist
// during an incident fell through to the fallback of 20, silently, with no
// warning logged. An operator believed AI was blocked while it was serving 20
// calls per window — a fail-OPEN, in the direction nobody would check.
//
// An unparseable value still falls back (a typo should not take the boot down),
// but it now says so on stderr rather than vanishing.
function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isInteger(n) && n >= 0) return n;
  process.stderr.write(
    `[config] ${name}='${raw}' is not a non-negative integer; falling back to ${fallback}\n`,
  );
  return fallback;
}

// The affirmation revocation window is a PUBLIC safety promise (the marketing
// and transparency pages say 48 hours). A compressed value is legitimate for
// tests and demo drills — the CI E2E runs at 1s — but a production boot with a
// sub-hour window would silently break the promise (QA 2026-07-21 found a demo
// deployment running the CI value: contacts had ~1.5s to change their mind).
// Production refuses a window under an hour unless the operator explicitly
// acknowledges compression (ALLOW_COMPRESSED_CEREMONY_WINDOWS=true, for
// deliberately compressed staging drills). Same fail-closed posture as the
// durable-secret guards above.
const REVOCATION_WINDOW_PRODUCTION_FLOOR_MS = 60 * 60 * 1000;

function resolveCeremonyWindows(
  env: NodeJS.ProcessEnv,
  requireDurable: boolean,
): { syncWindowMs: number; revocationWindowMs: number } {
  const windows = {
    syncWindowMs: parseBytes(env['CEREMONY_SYNC_WINDOW_MS'], 48 * 60 * 60 * 1000),
    revocationWindowMs: parseBytes(env['CEREMONY_REVOCATION_WINDOW_MS'], 48 * 60 * 60 * 1000),
  };
  const compressionAcknowledged = env['ALLOW_COMPRESSED_CEREMONY_WINDOWS'] === 'true';
  if (
    requireDurable &&
    !compressionAcknowledged &&
    windows.revocationWindowMs < REVOCATION_WINDOW_PRODUCTION_FLOOR_MS
  ) {
    throw new Error(
      `CEREMONY_REVOCATION_WINDOW_MS=${windows.revocationWindowMs} is below the production floor ` +
        `(${REVOCATION_WINDOW_PRODUCTION_FLOOR_MS} ms): contacts must get real time to revoke an ` +
        'affirmation. Set ALLOW_COMPRESSED_CEREMONY_WINDOWS=true only for a deliberately compressed drill.',
    );
  }
  return windows;
}

function resolveIpPepper(b64: string | undefined, requireDurable = false): Uint8Array {
  if (b64 !== undefined && b64 !== '') {
    const raw = Buffer.from(b64, 'base64');
    if (raw.length < 16) throw new Error('IP_HASH_PEPPER must decode to at least 16 bytes');
    return new Uint8Array(raw);
  }
  if (requireDurable) {
    throw new Error('IP_HASH_PEPPER must be set in production (refusing an ephemeral pepper)');
  }
  // Ephemeral is acceptable for the IP pepper: it only affects cross-restart
  // continuity of rate-limit windows (minutes), not durable secrets. No warning
  // spam — unlike the audit/TOTP keys, a fresh value here loses nothing material.
  return new Uint8Array(randomBytes(32));
}

// Resolve the current TOTP KEK (TOTP_KEK) plus an optional prior one
// (TOTP_KEK_PREVIOUS, kept only to decrypt secrets not yet re-wrapped). Each
// KEK's id is derived from the key so config never has to name it. An absent
// current key is generated ephemerally with a loud warning — like
// SERVER_AUDIT_SIGNING_KEY, that means TOTP secrets do not survive a restart.
function resolveTotpKeks(
  current: string | undefined,
  previous: string | undefined,
  requireDurable = false,
): TotpKekSet {
  return resolveKeks(
    'totp',
    current,
    previous,
    '[totp] no TOTP_KEK set; generated an ephemeral key. TOTP secrets will not ',
    requireDurable,
  );
}

// The outer-layer KEK seam. Default: env-backed (OUTER_LAYER_KEK) via
// EnvKekProvider, under the same durable-secret guard as the other KEKs. With
// OUTER_LAYER_KEK_PROVIDER=gcp-kms it is HSM-backed — GCP Cloud KMS holds the KEK
// and wrap/unwrap become KMS calls, so no raw KEK lives in env/process and
// OUTER_LAYER_KEK is NOT required (the KMS key + ADC are the secret). The other
// KEKs (TOTP) + audit/pepper secrets remain env/secrets-manager lane. docs/18.
function resolveOuterKekProvider(env: NodeJS.ProcessEnv, requireDurable: boolean): KekProvider {
  if ((env['OUTER_LAYER_KEK_PROVIDER'] ?? '').toLowerCase() === 'gcp-kms') {
    const keyName = emptyToUndefined(env['OUTER_LAYER_KMS_KEY']);
    if (keyName === undefined) {
      throw new Error(
        'OUTER_LAYER_KMS_KEY must be set when OUTER_LAYER_KEK_PROVIDER=gcp-kms (the Cloud KMS cryptoKey resource name)',
      );
    }
    return new KmsKekProvider(new GcpKmsClient(keyName), keyName);
  }
  const kekSet = resolveKeks(
    'outer_layer',
    env['OUTER_LAYER_KEK'],
    env['OUTER_LAYER_KEK_PREVIOUS'],
    '[vault] no OUTER_LAYER_KEK set; generated an ephemeral key. Vault items will not ',
    requireDurable,
  );
  return new EnvKekProvider(kekSet);
}

// Resolve a current server KEK plus an optional prior one (kept only to unwrap
// material not yet re-wrapped). Each KEK's id is derived from the key so config
// never has to name it. An absent current key is generated ephemerally with a
// loud warning — like SERVER_AUDIT_SIGNING_KEY, that means the wrapped material
// does not survive a restart. `prefix` namespaces the id + the env name in the
// warning; `warnLead` is the lead of the dev warning (each lane phrases its own).
// With `requireDurable` (production) an absent key is a startup failure instead.
function resolveKeks(
  prefix: string,
  current: string | undefined,
  previous: string | undefined,
  warnLead: string,
  requireDurable = false,
): KekSet {
  const keks: ServerKek[] = [];
  if (current !== undefined && current !== '') {
    keks.push(toKek(prefix, current));
  } else {
    const envName = `${prefix.toUpperCase()}_KEK`;
    if (requireDurable) {
      throw new Error(`${envName} must be set in production (refusing to start on an ephemeral key)`);
    }
    const generated = Buffer.from(randomBytes(32)).toString('base64');
    process.stderr.write(
      `${warnLead}survive a restart. Persist this and set it in env:\n${envName}=${generated}\n`,
    );
    keks.push(toKek(prefix, generated));
  }
  if (previous !== undefined && previous !== '') keks.push(toKek(prefix, previous));

  const byId = new Map<string, ServerKek>();
  for (const k of keks) byId.set(k.id, k);
  return { currentId: keks[0]!.id, byId };
}

function toKek(prefix: string, b64: string): ServerKek {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error(`a ${prefix} KEK must decode to 32 bytes`);
  const key = new Uint8Array(raw);
  const id = `${prefix}-` + createHash('sha256').update(key).digest('base64url').slice(0, 12);
  return { id, key };
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}
