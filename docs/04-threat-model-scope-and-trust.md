# 04 — Threat Model: Scope and Trust Assumptions

This corresponds to sections 1 and 4 of the threat model document.

## 1. Scope

### 1.1 What this document covers

This document analyzes the threat surface of the Continuity Engine — the subsystem responsible for detecting user absence, escalating through trusted contacts, and conditionally releasing vault contents over time.

In scope:
- The state machine governing transitions from Active through Full Release, and all paths back to Active.
- The release policy matrix (which vault categories release to which contact types at which stage).
- The verification, notification, and cooldown subsystems that gate every transition.
- The audit log that records every event the engine emits.
- Sensitive-action delays on settings that affect the engine itself.

### 1.2 What this document does NOT cover

- **Cryptographic primitives.** We assume AES-256-GCM, Argon2id, and the chosen public-key scheme are sound. See `18-crypto-architecture.md` for the spec; threats against the math itself belong in a separate cryptographic review.
- **Underlying account security.** The platform stores recovery references. The actual user accounts (Gmail, bank portals, exchanges, hosting providers) live outside our control.
- **Legal authority of release.** The platform releases information. It does not adjudicate inheritance, probate, or contested estates.
- **Contact integrity post-release.** Once a contact has decrypted vault content on their own device, that data is theirs to leak, lose, or misuse.
- **Physical security of contact devices.** We assume reasonable consumer devices. State-level adversaries with physical access to a contact's hardware are out of scope for V1.

### 1.3 Trust boundaries

Five boundaries cross the system. Every threat is something crossing one of these incorrectly.

1. **User ↔ platform.** Crossed correctly when authentication is valid, device is recognized, and the action is non-sensitive or has cleared its delay window.
2. **Platform ↔ contact.** Crossed correctly only when the engine has reached the appropriate release stage and the contact's identity has been re-verified at release time.
3. **Platform ↔ notification channels.** Email, SMS, push. Crossed correctly when at least one redundant channel succeeds.
4. **Operator ↔ platform internals.** Crossed correctly when operators can observe operational metadata but cannot decrypt user content.
5. **Legal ↔ platform.** Crossed correctly when the platform can demonstrate, technically, that it cannot produce decrypted content even under compulsion.

### 1.4 What "correct behavior" means

Two failure modes pull in opposite directions:

- **False positive (wrongful release):** Engine releases to a contact when the user is alive and would not authorize. Damage proportional to release stage and asset tier. Catastrophic at S3 with Tier A assets.
- **False negative (failed release):** User becomes genuinely unreachable and the engine never releases. Damage proportional to operational dependence on locked content. Catastrophic for survivors who depend on Tier D recovery instructions.

Every mitigation is evaluated against both. A mitigation that perfectly prevents false positives but doubles false negatives is not necessarily an improvement.

The engine errs toward preventing false positives by default — because they are irreversible and the user has explicitly opted in to staged release — but the residual false-negative risk must be measured and minimized, not ignored.

### 1.5 Scope evolution

This is V0. Covers the V1 launch surface: individual user, personal and business continuity, no AI-assisted features, no institutional integrations.

Each feature added post-launch requires this document updated before the feature ships. New trust boundaries demand new sections, not appendices.

## 4. Trust assumptions

The engine's correctness depends on a small set of assumptions being true. Every threat is, at root, an attack on one of these.

### 4.1 Cryptographic assumptions

We assume the following and treat violations as out of scope:

- The chosen symmetric cipher (XChaCha20-Poly1305) is computationally infeasible to break.
- The chosen KDF (Argon2id with documented parameters) makes brute force economically infeasible.
- The chosen public-key scheme (X25519) is sound and correctly implemented.
- Hardware random number generation on the user's device produces sufficient entropy.
- TLS 1.3 between client and server is not compromised.

If any of these are violated, the threat model is moot. We rely on standard library implementations (libsodium) and document versions in `18-crypto-architecture.md`.

### 4.2 Device assumptions

We assume:
- The user's enrolled devices are not actively compromised by malware capable of exfiltrating private keys.
- The user's biometric or PIN-based device unlock is not trivially bypassable.
- Trusted contacts use reasonable consumer-grade devices.

We do NOT assume:
- That any single device remains under the user's control forever.
- That the user's primary email account at any given moment is secure.

### 4.3 Contact assumptions

The most consequential section. The platform's safety depends heavily on what we are and are not willing to assume.

We assume:
- Contacts are real people, not adversaries planted by the user themselves.
- The user has chosen contacts in good faith at enrollment.
- Any given contact may, over time, become adversarial — through relationship breakdown, account compromise, coercion, or simple greed. **The platform must remain safe even when one or two contacts are adversarial**, provided the others are not.

We do NOT assume:
- That a contact's intentions today match their intentions at enrollment.
- That a contact's account or device is secure throughout the life of their role.
- That contacts will cooperate with each other or with the platform during a release event.

**Consequence: single-contact authority is forbidden anywhere in the engine.** Every release-relevant decision requires either user confirmation, multi-contact consensus across diverse roles, or both.

### 4.4 Channel assumptions

We assume:
- Any single channel can fail or be intercepted. We never depend on one channel.
- The user provides at least two independent channels at enrollment. The engine refuses to arm otherwise.
- Channel addresses can change. Changes are themselves sensitive actions requiring delay.

**Independent means independent of the VENDOR, not just of the address.** Two channel types behind one provider — one account, one credential pair, one API host, one webhook signing scheme — are one channel wearing two names. They fail together on an outage, a suspended account or a leaked token, which is exactly when the second channel was supposed to help. The enrollable types today are **email (Resend), SMS (Twilio) and push (issued by the browser vendor)**: three types, three failure domains, no shared credential. **Consequence: a new channel type must not be added behind a vendor that already carries one, and consolidating two onto one vendor is a change to this section, not a deployment tidy-up.**

> **Where this rule came from, and why the example changed (2026-08-01).** SMS and WhatsApp both rode Twilio until July 2026, which made this section false by correlated failure; WhatsApp was moved direct to Meta's Cloud API to restore independence (docs/26 §4 CV-3). WhatsApp is now **withdrawn from enrolment** — Meta refuses to let the account create `truecairn_channel_verification`, and that template gates channel verification itself, so no WhatsApp channel can be created at all. The transport code, template map and vendor separation are retained and dormant (`WITHDRAWN_CHANNEL_TYPES` in `apps/api/src/billing/entitlement.ts`), so the move is not lost. The rule above is unchanged and still binding; only the worked example moved to the channels that actually exist. **If WhatsApp returns, it must NOT return behind Twilio** — that is precisely the consolidation this section forbids.

> **Implementation gap, recorded honestly (2026-07-30; partly closed 2026-08-01).** The arming clause above is NOT enforced in code. `POST /v1/engine/arm` requires at least one *enrolled contact*; it does not count channels or check their diversity, and neither does any other path — so the engine will arm on a single email channel, or on none. docs/11 §5.3's stronger version ("at least three channels of different types") is likewise unimplemented. The vendor-independence property described above is real and holds at the transport layer; the *enrolment-time gate* that would make the two-channel assumption true for every account does not exist yet. Until it does, this bullet describes intent, not behaviour.
>
> **What the 2026-08-01 audit found, and what was fixed.** The unenforced gate was worse than a missing guard, because the stall protection that exists to cover exactly this case was keyed on `totalChannels > 0`. A zero-channel account therefore satisfied "no channel is failing" and was the ONE configuration that never stalled: one broken channel paused the ladder, while no channels at all advanced it through `check_in_pending → escalation_pending → release_review` with zero notifications sent and zero pauses taken. Protection was monotonic in the wrong direction, for the account least able to notice. `packages/engine/src/transitions.ts` now treats zero channels as unreachable, so it stalls like any other total notification failure and is still released by the 30-day stall bound. **The arm-time gate remains unimplemented and is still the honest gap here**; the public `/security/threat-model` copy was corrected the same day to stop claiming it.

We do NOT assume:
- That a user who has not responded on one channel is unreachable on another.
- That a successful delivery means the user actually saw the notification.

### 4.5 Operator assumptions

We assume:
- Anthropic-side operators are trustworthy in the sense that they will not personally target users.
- Operators are NOT trustworthy in the sense that the system should technically permit them to decrypt content. They should not be in a position to do so even if they wanted to, especially not under legal or extortive pressure.

**Consequence: client-side encryption is non-negotiable** for any vault content above Tier D. Server-side decryption keys are an unacceptable design even with operator goodwill, because operator goodwill is not a property the platform can guarantee to users in writing.

### 4.6 Temporal assumptions

We assume:
- The user remains alive and reachable for some duration after configuring the engine.
- The user's stated activity patterns at enrollment remain a reasonable baseline.
- Time, as measured by the platform's clock, is monotonic and not subject to adversarial manipulation. Cooldown timers are server-authoritative.

### 4.7 What violation of these assumptions looks like

| Assumption violated | Threat |
|---|---|
| Device security | 5.2 Account compromise |
| Contact intentions stable | 5.1 Malicious contact |
| Single-contact authority sufficient | 5.6 Collusion |
| Channels reliable | 5.3 Notification failure |
| Channel addresses stable | 5.4 Contact compromise (SIM swap) |
| Operator goodwill sufficient | 5.7 Insider threat / 5.8 Legal coercion |
| User remains alive at enrollment | Configuration attack under coercion |
