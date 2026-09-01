# 26 — Continuity Verification

**Status:** CV-0.0 + CV-0 + CV-1 implemented (this document is both the
ratified plan and the as-built record); CV-2/CV-3/CV-4 are contract-driven
follow-ons. Flags default **off** everywhere (D8).
**Owner:** Med. Ratified 2026-07-13 (scope, channel-enrolment inclusion,
AI-narration deferral, doc placement).

---

## 1. What this is

Between "the owner went quiet" and "trusted contacts are asked to affirm a
release", Truecairn used to make a single email attempt to a single channel
(`pickPrimaryChannel`: oldest verified, one delivery per state entry). The most
consequential decision in the product was preceded by the least effort the
system ever made to reach anyone.

Continuity Verification turns that silence into a documented, owner-configured,
multi-channel verification effort whose evidence is preserved tamper-evidently
and shown to the humans who must decide. The owner defines the rules — which
channels, how many attempts, whether AI-assisted channels are allowed at all —
and the system faithfully executes them. Affirming contacts no longer see just
"the timer expired"; they see *we tried every channel this person configured,
this many times, here is exactly what happened*.

**What it is not.** Not a new decision-maker: the engine's deterministic timers
remain the only thing that advances the ladder; the report is evidence, never a
verdict. Not surveillance: we record what providers prove (delivered, bounced)
and the one fact that matters (no check-in followed) — never opens or reads.
Not a new engine stage: it lives entirely inside the check-in/escalation window
that already exists. And not an AI feature: everything in the committed scope
is deterministic; any future AI-assisted channel is one *optional* channel the
owner must explicitly enable.

## 2. Decisions (ratified)

- **D1 — No new engine state.** The verification blitz runs *during*
  `check_in_pending` and `escalation_pending`; the report is generated at
  ceremony creation. The engine transition table has zero behavioural diffs.
- **D2 — No open/read tracking, ever.** Report lines are `delivered` /
  `bounced` / dead-lettered plus "no check-in followed". No pixels, no read
  receipts, on any channel — a public commitment (§6), enforced mechanically
  by a source-scanning test (`packages/notifications/src/no-open-tracking.test.ts`).
  The delivery webhook deliberately treats provider `opened` events as
  un-modelled.
- **D3 — Deterministic outcome, no confidence scores.** The report `outcome` is
  a closed enum computed by rule (`computeOutcome`). *(Amended at
  ratification:)* AI narration is **deferred entirely** — the report is plain
  deterministic text, and `packages/ai-authority` has a zero diff in this
  work. If narration is ever wanted, it is a separate owner-approved change to
  the capability map.
- **D4 — Channel responses are evidence, never authentication.** No response on
  any CV channel acts as a check-in or advances/blocks anything (this is what
  neutralises the voice-deepfake *suppression* attack: a cloned "I'm fine"
  could only ever produce a report line). A real check-in remains the
  authenticated app action it is today. Holds by construction: the cadence
  sweep only writes delivery rows.
- **D5 — Voice is deferred behind a design gate.** CV-4 may not begin until a
  dedicated, owner-approved design doc exists (bare script, DTMF-first, consent
  law review, provider choice). Conversational AI voice is a further separate
  escalation, considered only if users ask.
- **D6 — Report visibility.** Recipients of a ceremony (holders and designated
  beneficiaries) and the owner may fetch the frozen report; everyone else gets
  404 with no existence disclosure. The owner may always see their live
  verification status.
- **D7 — Naming and framing.** The feature is **Continuity Verification**.
  Deterministic outreach is the substance; AI voice, if it ever ships, is one
  optional channel within it, never the headline.
- **D8 — Defaults preserve today's behaviour.** `CV_FANOUT_ENABLED` and
  `CV_REPORT_ENABLED` default off; flags-off is byte-for-byte pre-CV
  (regression-tested at the bridge seam and by the absent cadence config).

## 3. As built (this branch)

**CV-0.0 — channel enrolment (added at ratification; the plan's missing
foundation).** Verification found that *no production code path created a
`notification_channels` row at all* — owner notices were silently skipped in
production. Shipped: `GET/POST /v1/settings/channels`,
`POST /v1/settings/channels/:id/verify`, `DELETE /v1/settings/channels/:id`
(session-gated, cross-user 404, issuance volume-limited), with a hashed-at-rest
6-digit code round-trip whose plaintext rides once in the delivery's
`payload_params` and is nulled on send. The `channel_verification` purpose is
the ONE purpose whose body carries a per-delivery value; templates remain the
single place bodies are produced. Settings gained a channels card. Unverified
channels remain unselectable everywhere (pinned by test). Migration `0044`.

**CV-0 — foundations.** Migration `0045`:

- `channel_preferences` — the owner-defined matrix (channel × purpose class:
  `owner_verification` / `owner_notices` / `contact_notices`). **Absent row =
  enabled**: untouched accounts keep today's behaviour; a row only ever opts a
  channel *out* of a class (this is also the org compliance switch).
  `GET/PUT /v1/settings/channels/preferences`. The matrix is enforced for
  `owner_verification` (the CV fanout) now; class-aware selection for routine
  notices is a documented follow-on (§5).
- `continuity_reports` — the frozen snapshot, one per ceremony. `payload` is
  **TEXT** (the exact serialized bytes), because the audit chain anchors
  sha256 over those bytes and jsonb would re-order keys and break
  verifiability.
- `ContinuityReportPayload` + the outcome enum in `@truecairn/shared`, with a
  shape-pinning test: adding or removing a payload key fails the build until
  §6 of this document moves in the same commit.
- `buildContinuityReport` (`packages/notifications/src/continuity-report.ts`) —
  a deterministic read model over deliveries, channel health, and engine
  history. `sent` without webhook confirmation is *indeterminate*: never
  counted as delivered, never as unreachable. Outcomes:
  `channels_unconfigured`, `unreachable_all_channels`,
  `partial_delivery_no_checkin`, `delivered_no_checkin`.

**CV-1 — fanout + the frozen report.**

- `apps/worker/src/cv-cadence.ts`: waves across matrix-enabled verified
  channels while the owner is in `check_in_pending`/`escalation_pending`,
  spacing `CV_ATTEMPT_SPACING_HOURS` (default 24), cap
  `CV_MAX_ATTEMPTS_PER_CHANNEL` (default 3). The engine transition's own
  one-shot notice is wave 0 and is untouched; the sweep only adds waves.
  Idempotent under concurrency: `FOR UPDATE SKIP LOCKED` per owner + a partial
  unique index on `(user, purpose, channel, cv_episode_at, cv_wave)`.
- The ceremony-creation bridge takes an optional `ContinuityReportPort`
  (wired by the worker only when `CV_REPORT_ENABLED`): snapshot + audit append
  (`ceremony.continuity_report_attached`, hash only) ride the ceremony's own
  creation transaction. Create-once + unique(ceremony_id) make re-runs no-ops.
- Routes: `GET /v1/ceremonies/:id/continuity-report` (D6-gated, serves the
  snapshot, never a recompute) and `GET /v1/engine/verification-status`
  (owner live view, flag-gated).
- Web: `ContinuityReportPanel` on the ceremony portal and the engine
  dashboard — plain-text deterministic rendering with the no-tracking line.
- The misleading internal `payloadSummary` `'Notifying trusted contacts'` on
  the escalation effect was corrected to `'Urging the owner to check in'`
  (the delivery goes to the owner; the string is internal-only and never
  sent — the ratified one-line exception to the transitions stop-and-ask
  zone).

## 4. Deferred phases

- **CV-2 — SMS + Web Push adapters.** Mechanical, contract-driven: mirror
  `ResendEmailAdapter` (injectable fetch, timeout, delivery-row-id idempotency
  key, `retryable` classification, webhook correlation), add a per-type
  verification flow (SMS: code round-trip — already channel-agnostic; push:
  probe acknowledgement), reuse the bare templates verbatim. **External clock
  to start early:** US A2P 10DLC registration.
- **CV-3 — WhatsApp. WITHDRAWN from enrolment 2026-08-01; code retained, dormant.**
  Additive `whatsapp` enum value + Business API adapter. Read receipts are
  deliberately ignored (D2). **External clock:** Meta template approval — and that
  clock did not merely slip, it **stopped**.

  > **Why it is withdrawn.** Meta refuses to let this WABA create
  > `truecairn_channel_verification`: *"Ce compte WhatsApp Business n'a pas
  > l'autorisation de créer un modèle de message."* Eight of the nine
  > `truecairn_*` templates are approved and **Active** — and that buys nothing,
  > because the missing one is the template that gates enrolment itself (see the
  > `channel_verification` note below: no channel verifies without it, and every
  > other WhatsApp notice presupposes a verified channel). Offering the type would
  > send a user — a *paying* user, since it sits behind the Personal plan — into a
  > flow that cannot complete.
  >
  > **What withdrawal does and does not touch.** New enrolment is refused by
  > `WITHDRAWN_CHANNEL_TYPES` (`apps/api/src/billing/entitlement.ts`) at both the
  > picker and the route. Existing verified rows are **grandfathered, never
  > re-gated** (docs/28), which is why `whatsapp` stays in `PRO_CHANNEL_TYPES` —
  > that set drives the downgrade sweep, not availability. The adapter, the
  > template map, the drift test and the vendor separation are **unchanged**: this
  > removes the offer, not the capability. Restore = approve the template at Meta,
  > set `WHATSAPP_CLOUD_*`, delete the constant's entry. Candidate causes to check
  > first, both recorded by the 2026-08-01 audit §3: **no payment method set** on
  > the WABA, and the Meta app still in **Development mode**.
  - **WhatsApp goes DIRECT to Meta's Cloud API, not through Twilio**
    (July 2026), and that separation is the point. §4.4 of docs/04 assumes any
    single channel can fail or be intercepted and that we never depend on one.
    Routing SMS and WhatsApp through one vendor made that assumption false by
    **correlated failure**: one account, one credential pair, one API host and
    one webhook signing scheme meant a Twilio outage, a suspended account or a
    leaked auth token took both channels at once — in precisely the situation
    the second channel exists for. Twilio now carries SMS only.
    `WhatsappCloudAdapter` posts JSON to
    `graph.facebook.com/v21.0/<phone-number-id>/messages` with a bearer token,
    `to` as bare E.164 digits, and template identity by NAME. Its status
    callbacks arrive on a separate branch with a separate signing scheme
    (`X-Hub-Signature-256`, keyed by the Meta app secret) — so the two channels
    now share no credential, host, or verification path. **A future
    consolidation onto one vendor is a threat-model change, not a cleanup.**
  - **`TwilioMessagingAdapter` keeps its WhatsApp branch and its tests.**
    Nothing constructs it for `whatsapp` any more; it stays so the move is
    reversible without archaeology.
  - **Meta's `sent` status is a NO-OP, not a delivery.** `delivered` and `read`
    both map to `delivered` (D2: `read` records that the message reached the
    device and nothing more — there is no read state to set). `failed` maps to
    `bounced`. `sent` means the message left Meta toward the device and does
    **not** prove arrival, so it moves nothing: the row stays `sent`, which the
    Continuity Report scores *indeterminate*. Recording it as delivered would
    put an unproven fact in the report — the same error class as the plain-body
    send this channel was fixed for, and the same rule the Twilio branch and
    Web Push already follow.
  - **Business-initiated sends carry an approved template, not our text**
    (July 2026, shipped one pass before the move off Twilio and unchanged by
    it). The adapter originally sent the rendered body as free text, which
    works only in a vendor sandbox or inside a 24h customer-service window.
    Every send of ours is business-initiated (the recipient never messages us
    first), so outside those the transport returns success and **Meta silently
    drops the message** — the delivery row reads `sent`, the phone stays quiet.
    A notification that reports success without arriving is the worst failure
    mode this product has (docs/11 threat 5.3). Free text is never sent on this
    channel: the Cloud API adapter transmits `type: "template"` with a name,
    a language, and positional body parameters, and nothing else.
  - **Fail closed, never fall back.** A WhatsApp send whose purpose has no
    usable template — no template name, purpose deliberately unmapped, or
    variables that do not match what Meta approved — raises a **permanent**
    `ProviderError` *before* the network call. It dead-letters, which the
    Continuity Report and `/status` already read as "did not arrive". Falling
    back to free text would convert a visible misconfiguration into an
    invisible one. The Cloud API does reject an unknown template name rather
    than dropping the message, but that is the provider's behaviour to change;
    the pre-flight check is ours.
  - **The purpose→template map is in the repo**
    (`packages/notifications/src/whatsapp-templates.ts`), including the exact
    body text submitted to Meta. WhatsApp is the only channel whose copy lives
    outside this repo, so drift would otherwise be unobservable: a test
    re-derives every approved body from `renderTemplate` and fails the build if
    the two diverge. The bare templates are reproduced character for character,
    but that no longer means the copy was untouched: two bodies were **rewritten
    to satisfy Meta's category classifier** (see the category bullet below), and
    the rewrite landed in `templates.ts` so every channel still says one thing.
    That module is
    provider-agnostic and survived the move off Twilio unchanged in substance:
    which template a purpose uses and what it says are product decisions, not
    vendor ones. Template identity is now a **name we choose** rather than a
    per-account SID the vendor mints, so it is repo config, not env — paired
    with an explicit language constant, since Meta treats name+language as one
    identity and an `en`-approved template cannot be sent as `en_US`.
  - **Nine templates, not eleven.** The three ceremony notices share one
    (their bodies are identical by design — which stage a ceremony reached is
    not something transport should reveal, and three approvals would hand an
    interceptor a distinguisher we withheld). `channel_verification` is the
    only one with a variable (`{{1}}` = the code).
  - **Meta's category classifier drove the copy, not the reverse** (July 2026).
    A template is submitted under a category and the reviewer re-categorises
    whatever does not match. Two of the nine were refused as UTILITY and offered
    only MARKETING: `check_in` ("Open Truecairn to confirm you are active.") and
    `health_probe`, its equally terse sibling. The pattern is consistent — the
    classifier accepts a message naming a specific account event and rejects one
    that only says "open the app". Our notices are terse **by design** (PHASE3_5
    §g withholds detail so the transport reveals nothing), and that is precisely
    what made them read as re-engagement.

    **MARKETING is not an available answer for an engine notice.** A recipient
    can switch marketing off per account, and since April 2025 Meta does not
    deliver marketing templates to US numbers at all (error `131049`). Either
    one turns a continuity ping into a message that reports fine and never
    arrives — docs/11 threat 5.3 rebuilt one layer down, on the two notices whose
    whole job is catching a silent owner. So the category was held and the copy
    moved: both bodies now name the notification's own kind ("This is a Truecairn
    account status notification…"). `check_in` passed as UTILITY on first
    submission with that wording.

    The reword landed in `templates.ts`, so **email and SMS carry it too**. A
    WhatsApp-only fork would have broken the one-body-per-purpose rule the drift
    test rests on in order to hide a sentence that leaks nothing — the sender is
    already named "Truecairn". One consequence worth naming: the copy for a
    mapped purpose is now versioned at the vendor as well as in git. Editing it
    desynchronises the repo from an approved template until Meta re-approves, and
    the drift test cannot see that (both repo halves move together), so the exact
    bodies are additionally pinned as literals in `whatsapp-templates.test.ts`.
  - **`plan_downgraded` lost its upsell, because on that one the classifier was
    right** (owner-ratified 2026-07-31). Meta refused it as UTILITY and offered
    only MARKETING, exactly as with `check_in` — but the diagnosis is the
    opposite. `check_in` was a terse safety notice misread as re-engagement;
    this body genuinely ended with a promotional call to action ("To add new
    premium channels again, open Truecairn and upgrade."), and no reframing makes
    a request to upgrade anything other than marketing. So the sentence was
    dropped rather than reworded. The body's stated job — the safety promise that
    nothing you rely on was turned off — is untouched, and the upgrade path
    survives where it belongs: the Settings downgrade banner, which names the
    residual paid channels and links to `/plans` behind sign-in.

    Worth separating from the other two cases when reading this section: Meta's
    classifier being wrong about a bare safety notice and right about an upsell
    are different findings, and only the first justifies moving copy to satisfy
    it. Email and SMS lose the sentence as well, since the copy stays unforked.
  - **`escalation` is refused as UTILITY and NOT yet resolved** (open as of
    2026-07-31 — recorded here so it is not mistaken for shipped). Meta offers
    only MARKETING for "Your account looks inactive. Open Truecairn to confirm
    you are here." This is the sharpest instance of the problem: unlike
    `plan_downgraded` there is nothing promotional to remove, and unlike
    `check_in` the body **already** names a specific account state, so the
    "name the notice's kind" fix that worked there is not obviously available.
    It also matters most — `escalation_request` is one of the two
    channel-matrix-EXEMPT safety-floor notices, so a WhatsApp that cannot carry
    it goes silent during `escalation_pending`, which is precisely the window CV
    exists for. A reword is proposed and not yet ratified; no code has
    landed, and the repo still carries the original wording.
  - **`channel_verification` goes AUTHENTICATION, reversing the UTILITY decision**
    (owner-ratified July 2026 — **implemented**). The original reasoning was that
    AUTHENTICATION replaces our body with Meta's own fixed wording plus a
    copy-code button, and that this code proves a channel reaches you rather than
    granting access to anything. Meta refused it as UTILITY regardless, and this
    is the template that gates **all** WhatsApp enrolment — no channel verifies
    without it — so appealing would have blocked the entire channel for as long
    as the appeal ran. AUTHENTICATION is also exempt from the MARKETING delivery
    pause above.
    - **2026-08-01: it could not be created at all.** Meta rejects creation of
      this template on permission grounds, not category grounds, so the
      AUTHENTICATION reversal was never the binding constraint. Because it gates
      every other WhatsApp notice, the channel is withdrawn (see CV-3 above).
      This entry stays as the ratified design for when creation is unblocked.

    **What it cost, stated plainly.** Authentication template content is not
    editable. With the "security recommendation" toggle ON (which we want), Meta's
    body is exactly `{{1}} is your verification code. For your security, do not
    share this code.` So **"Enter it in the app to confirm this channel." is
    gone**, and this is now the one purpose whose WhatsApp text differs from its
    email and SMS text — those keep our own wording, unchanged. It is therefore
    also the one entry the drift test cannot pin against `renderTemplate`; it is
    pinned as a golden literal instead, with the carve-out documented in the test
    and scoped by category, plus a companion test asserting exactly one
    authentication template exists so the exception cannot widen unnoticed.

    **Code delivery is "Copy code", not autofill — and that was not a choice.**
    Zero-tap and one-tap autofill both require an Android package name and an
    11-character app signature hash in the console, and the form will not submit
    without them. Our code is typed into the web app, and `apps/mobile` is
    undistributed, so autofill is *unavailable* to us rather than merely
    unchosen. Recorded because a future reader would otherwise assume the basic
    option was picked out of laziness; it should not be revisited without a
    shipped Android build to bind it to.

    **Wire format, since the category changes it.** An authentication send
    carries a button component alongside the body, repeating the same code:
    `{"type":"button","sub_type":"url","index":"0","parameters":[{"type":"text","text":"<CODE>"}]}`.
    Two traps, both surfacing as a 400 at send time rather than at approval:
    `sub_type` is `url`, **not** `copy_code` (that is the MARKETING coupon
    feature, which renders a similar button and is rejected here), and `index` is
    the string `"0"`. The category itself is now repo-owned config on each
    template rather than knowledge living only in the console — it was a category
    re-classification that nearly reached production unnoticed, so the field that
    drives the payload and the field that records the decision are the same one.

    > The mothballed `TwilioMessagingAdapter` WhatsApp branch predates this and
    > was deliberately not updated: Twilio's Content API models authentication
    > templates as their own content type rather than as ContentVariables, so
    > reinstating that path would need this one purpose re-solved. The other
    > eight are unaffected. Named rather than guessed at, since it cannot
    > currently be tested.
  - **`welcome` is deliberately unmapped.** It is twelve lines with a numbered
    setup list, and no approved template could carry it; truncating it to fit
    would be inventing copy. It is email-only by construction (enqueued in
    `apps/api/src/routes/channels.ts` on the first verified EMAIL channel), so
    the case is unreachable — and fails closed rather than arriving as a
    different message if that ever changes. `contact_invitation` is unmapped
    for the older reason: it has no producer at all.
- **CV-4 — Voice.** Blocked by D5. DTMF-first, evidence-only, maximally bare
  script (whoever answers may not be the owner).
- **AI narration of the report** — SHIPPED (July 2026, Gap plan G-1) behind
  `CV_NARRATION_ENABLED` (default off; off = byte-identical responses).
  Explains, never decides: input is the frozen payload only (no new context
  fields — the allowlist snapshot is untouched), output is one length-capped
  text field validated deny-by-default at the chokepoint
  (`NARRATION_OUTPUT_SPEC`), stored in nullable columns BESIDE the sealed
  payload (migration 0051) so the anchored hash and the immutability test are
  untouched. Generated lazily on the recipient-gated READ path under every AI
  guard (owner opt-out, `ai_narration` rate scope, breaker, kill switch);
  fill-only-NULL = generate-once. Deliberate deviation from the original
  attach-time sketch: the worker — the sole release driver — makes NO AI
  calls, pinned by an import-fence test
  (`apps/worker/src/ai-free-release-path.test.ts`), which is the strongest
  form of "narration can never block a release".
- **Matrix enforcement for `owner_notices`/`contact_notices`** — SHIPPED
  (July 2026). The purpose→class map is `routineNoticeClass` in
  `@truecairn/shared` (pinned by a shared test): `engine_state_change`,
  `sensitive_action_notice` and `plan_downgraded` honour the owner's matrix;
  the ceremony purposes honour the CONTACT's own matrix. The check-in/
  escalation blitz and `security_alert` are deliberately EXEMPT at selection
  time — the safety floor a preference row can never silence (the
  `owner_verification` class continues to govern only the CV cadence's extra
  fanout waves). Enforced in `DbChannelLookup.pickPrimaryChannel`, the
  sensitive-actions notice fanout, and the ceremony recipient resolvers.
- **Step-up for channel removal** — SHIPPED (July 2026). Removing a VERIFIED
  channel is now the `remove_channel` sensitive action (step-up + 7-day
  delay, cancellable from the Engine page; the doomed channel still carries
  the notice per docs/10-threat-5.2). Unverified channels — never selected
  for notices — keep one-click removal. **Matrix disable stays session-gated**:
  with the selection-time exemptions above, a stolen session flipping matrix
  cells can no longer silence check-ins or security alerts, which was the
  attack that made step-up worth considering.

## 5. Cross-cutting rules

Config in `.env.example` + `docs/21` (§Continuity Verification): no CV variable
may refuse boot; a missing adapter credential disables that channel with a log
line. Migrations additive only. Testing: unit (matrix defaults, outcome rule),
route tests on real Postgres with cross-user checks, idempotency/concurrency
tests for the sweep, flags-off regression, the D2 source-scan gate, and the
audit chain must verify with the new event types
(`notification_channel.added/verified/removed/preference_set`,
`ceremony.continuity_report_attached`).

## 6. Public commitments (what a reader of this repo can hold us to)

1. **We never track whether you open or read anything.** Report lines are
   provider-proven facts — delivered, bounced, dead-lettered — plus the one
   fact that matters: whether an authenticated check-in followed. No tracking
   pixels, no read receipts, on any channel, ever. Enforced by a build-failing
   source scan, not just policy.
2. **The report never contains addresses, content, names, or scores.** Its
   exact shape is pinned by a test that fails when this section and the schema
   drift apart. The one judgement-shaped field is a closed, rule-computed
   enum.
3. **No response to a verification message can act as a check-in.** Checking
   in remains an authenticated action in the app. This is what makes
   impersonating the owner to a verification channel useless in both
   directions — it can neither trigger nor suppress a release.
4. **Humans decide; timers advance; the report only informs.** The evidence
   shown to contacts is frozen at ceremony creation and its hash is anchored
   in the tamper-evident audit chain — what they read is what was recorded.
5. **Every channel is opt-in and every class is owner-controlled.** Absent
   configuration means today's behaviour. An organisation can strip any
   channel from any purpose class. **AI is entirely optional everywhere it
   could ever appear**: the committed scope contains none, and any future
   AI-assisted channel (voice) or narration requires the owner to explicitly
   enable it — on top of the existing per-user `ai_opt_out` and the
   default-off `AI_*` capability flags.
