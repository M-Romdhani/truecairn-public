# CV adapter contract

**Status:** current. This is the checklist a new notification transport must
satisfy to become a Continuity Verification channel. CV-2 (SMS, Web Push) and
CV-3 (WhatsApp) were built to it; a future adapter (a different SMS provider, a
mobile-push service, CV-4 voice) fills in the same blanks.

The seam is small on purpose: a channel is one interface
(`NotificationProvider` in `packages/notifications/src/types.ts`) plus a few
wiring points. If a new transport needs anything outside this list, stop —
that is a design change, not an adapter.

## 1. Implement `NotificationProvider`

```ts
interface NotificationProvider {
  readonly channelType: NotificationChannelType; // 'email' | 'sms' | 'push' | 'whatsapp' | …
  readonly name: string;                         // provider id, e.g. 'twilio-sms'
  send(input: SendInput): Promise<SendResult>;
}
```

- **`send` never constructs the body.** It receives `{ destination, subject,
  body, purpose, templateVariables?, idempotencyKey }` and transmits it
  verbatim. Content discipline lives in `templates.ts` — an adapter that
  formats its own message can leak. (SMS, WhatsApp, and push carry no subject
  line; drop it, don't invent one.)
- **Pre-approved-template transports.** Some channels will not carry your text
  at all: WhatsApp requires a Meta-approved template referenced by name, filled
  by positional variable. Two rules keep that inside the contract rather than
  around it. (a) The variables come from `renderTemplate` via
  `SendInput.templateVariables` — the adapter selects a template, it never
  composes one, so the copy still has exactly one home. (b) The mapping and the
  approved text live in the repo (`whatsapp-templates.ts`) with a test that
  re-derives the text from `renderTemplate`; copy that lives only in a vendor
  console can drift silently, and nothing at runtime would notice. Keep that
  module **provider-agnostic** — it survived WhatsApp's move from Twilio to
  Meta's Cloud API untouched in substance, which is the sign the seam is in the
  right place.
- **A transport that cannot say it must not pretend it did.** If no template
  covers a message, raise a permanent `ProviderError` *before* the network
  call. Do not degrade to a free-text send the provider will accept and the
  platform will drop: `sent` for a message that never arrived is worse than a
  dead-letter, because the dead-letter is visible in the Continuity Report and
  on `/status` while the silent drop is visible nowhere.
- **`idempotencyKey` is the delivery-row id.** Pass it to the provider's
  idempotency mechanism if one exists (Resend's `Idempotency-Key` header). If
  the provider has none (Twilio), that is acceptable: the delivery processor's
  stuck-`sending` reclaim re-sends with the same key, and the bare templates
  make a rare duplicate harmless. Document the gap in the adapter.
- **10-second timeout** on the outbound call (`AbortSignal.timeout(10_000)`) so
  a hung provider cannot stall the worker loop.
- **`providerMessageId`** in the result must be whatever the status webhook
  will correlate on later (Resend `id`, Twilio `sid`). If the transport has no
  async callback (Web Push), return a value derived from the delivery id so the
  row stays unique and correlatable.

## 2. Classify failures with `ProviderError(message, retryable)`

- `retryable: true` for transient failures — 5xx, 429, timeouts, transport
  errors. The processor backs off and retries.
- `retryable: false` for permanent failures — a bad address, a 4xx rejection, a
  gone push subscription (404/410). The processor dead-letters immediately.
- Getting this wrong is a real bug: a permanent failure marked retryable wastes
  the retry ladder; a transient one marked permanent loses a reachable channel.

## 3. Verification round-trip (so `verified` means *proven reachable*)

Every channel type enrols through the SAME route family
(`apps/api/src/routes/channels.ts`) and the same hashed-code round-trip. A new
type needs:

- **Destination validation + normalization** in `normalizeDestination` (email
  regex, E.164 for phone, subscription-JSON canonicalization for push). Return
  `null` for anything invalid — the round-trip is the real check, but transport
  sanity keeps garbage out.
- The verification code travels **through the channel itself** (email body, SMS
  text, push notification). This is automatic: the enrolment route enqueues a
  `channel_verification` delivery and `renderTemplate` injects the code. Your
  adapter just sends it like any other delivery.
- Add the type to `ENROLLABLE_TYPES` and the route's JSON-schema enum.

The load-bearing invariant: **only verified, non-removed channels are ever
selected** for notices (`pickPrimaryChannel`, `enqueueSecurityAlert`, and the
CV cadence's `eligibleChannels` all filter on it). An unconfigured adapter can
never mint a verified channel of its type, because its verification code never
sends — it dead-letters honestly.

## 4. Status webhook (delivered/bounced correlation), if the transport has one

- Add a provider branch to `apps/api/src/routes/notifications-webhook.ts`.
- **Verify the signature over the raw body BEFORE parsing** — fail closed. Each
  provider's scheme differs (Resend: Svix or the raw-body HMAC; Twilio:
  `X-Twilio-Signature` HMAC-SHA1 over URL + sorted params; Meta:
  `X-Hub-Signature-256` HMAC-SHA256 keyed by the app secret). A provider whose
  secret is not configured must reject (401), never fall through.
- **A registration handshake is not an exemption from that.** Meta verifies
  ownership with a `GET` carrying `hub.challenge`, which we echo only when
  `hub.verify_token` matches. The challenge is attacker-supplied: echoing it
  unconditionally turns the endpoint into a reflector, so a mismatch is 401 and
  no echo.
- **Map only what the provider actually proved.** A status meaning "we accepted
  it" or "we forwarded it" is not delivery — Meta's `sent` and Twilio's `sent`
  are both no-ops here. Only a status that proves arrival becomes `delivered`.
  Inflating acceptance into delivery puts an unproven fact in the Continuity
  Report, which is the failure this whole channel family was fixed for.
- Map only **terminal** statuses to `delivered` / `bounced`; acknowledge
  everything else 200 with no state change. `applyDeliveryWebhook` is
  idempotent on `providerMessageId`.
- **Never map an open/read signal.** Resend `email.opened`, WhatsApp `read` →
  no read-state is ever recorded (docs/26 D2; the `no-open-tracking.test.ts`
  gate enforces it). WhatsApp `read` may map to `delivered` (it proves the
  message reached the device) and nothing more.
- If the transport has NO callback (Web Push), deliveries stay `sent` —
  indeterminate in the Continuity Report, honest, never inflated to delivered.

## 5. Wire it in the worker

Register the adapter in `apps/worker/src/main.ts` gated on its own env
credentials, with a `log.warn` when unset (exactly like the email/SMS/push
blocks). **A missing credential disables that channel with a log line — it must
never make the worker refuse boot** (docs/26 §5).

**Do not put a second channel type behind a vendor that already carries one.**
docs/04 §4.4 assumes any single channel can fail; two types sharing an account,
a credential pair, an API host or a signing scheme are one channel wearing two
names, and they fail together in exactly the situation the second exists for.
CV-3 learned this the expensive way — SMS and WhatsApp both rode Twilio until
WhatsApp moved direct to Meta's Cloud API. When a vendor offers you a second
channel type it already has a transport for, that convenience is the thing to
refuse. This is a threat-model constraint, so consolidating later is a
threat-model change, not a cleanup. **The rule outlives the example:** WhatsApp
is withdrawn from enrolment as of 2026-08-01 (docs/26 §CV-3), and if it returns
it must not return behind Twilio.

## 6. Tests (mirror `packages/notifications/src/adapters.test.ts`)

- Unit: transport mapping (URL, auth, addressing), retryable classification,
  malformed-input handling — through the injectable seam (fetch, or the
  library call for push).
- Route: verification round-trip works; unverified channels are never selected;
  webhook delivered/bounced correlation + signature rejection.
- The channel appears correctly in the Continuity Report.

## 7. Docs

Add the channel + its env vars to `.env.example`, `docs/21`, and `docs/26 §4`.
State any provider-imposed external clock (SMS: US A2P 10DLC registration;
WhatsApp: Meta template approval) as an ops step, not a code blocker — but be
precise about what "not a blocker" means. It means the clock must not stop the
build or the boot. It does not mean the send can proceed without it: WhatsApp's
template approval gates each message individually, and the honest behaviour
before it lands is a dead-letter, not a plain-body send that reports success.
