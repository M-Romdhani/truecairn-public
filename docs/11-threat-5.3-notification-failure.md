# 11 — Threat 5.3: Notification Failure

Environmental threat. The system itself wrongfully releasing because the user is actually active but the platform cannot reach them.

## 5.3.1 Description

Not an attacker per se — this is the environmental threat. The "attacker" is entropy: a dead phone, a changed email provider, a spam filter that ate the check-in, a carrier outage, a country-level network block, a user who switched jobs and lost the work email they registered with three years ago.

From the user's perspective, this is a false release. From the platform's perspective, this is a reputational kill-shot: "the app released my vault while I was on vacation."

## 5.3.2 Capabilities

None — this isn't an adversarial actor. But the consequence is identical to an attack: the engine progresses through CHECK_IN_PENDING → ESCALATION_PENDING → RELEASE_REVIEW while the legitimate user is alive, healthy, and oblivious.

## 5.3.3 Failure path

1. User goes inactive on the platform (didn't open the app, didn't respond to check-in).
2. Platform sends check-in notification through registered channels.
3. All channels silently fail to deliver, or deliver to dead inboxes.
4. User does not see the check-in.
5. Timer expires. Engine progresses to ESCALATION_PENDING.
6. Trusted contacts notified that user appears inactive.
7. Cooldown begins.
8. User still does not notice (channels still dead).
9. RELEASE_REVIEW begins.
10. Release ceremony completes. S1 contents released. S2/S3 follow if contacts coordinate.

## 5.3.4 Attack tree (re-framed)

Root: engine wrongfully progresses to release because user did not receive any check-in notification.

System must fail at: primary channel delivery AND every fallback channel delivery AND every trusted-contact attempt-to-reach-the-user-by-other-means AND the user's own self-check-in habits AND the dashboard-visible state on any device the user happens to open.

## 5.3.5 Mitigations

### Multi-channel redundancy with delivery confirmation
Engine sends check-ins through every registered channel — email, SMS, push, in-app banner — and records delivery success per channel. If a channel returns a hard failure (bounce, unsubscribe, unreachable), engine marks that channel dead and notifies through other channels.

**If every channel fails to deliver, engine does not progress to ESCALATION_PENDING. Instead it enters NOTIFICATION_STALLED state.** In NOTIFICATION_STALLED, engine waits for any channel to be reconfirmed before resuming — at which point the full check-in window is re-armed from that moment, so a user who was unreachable for days is not handed an already-expired deadline.

**Corrected 2026-07-25 — the stall is bounded, not indefinite.** This document
previously said total notification failure "pauses the engine indefinitely", and
offered a trusted-contact attestation as the second way out. Both were wrong, in
opposite directions:

- **The attestation does not exist and should not.** Contacts are deliberately
  not approached before a release ceremony opens (docs/02 §4), so a contact has
  no way to learn the owner is unresponsive and would never know to attest.
  Adding it would mean disclosing the owner's silence to contacts on every false
  positive, and would hand a cohabitant (docs/09) a lever to suppress a
  legitimate release. Note also that it would have added little here: in
  NOTIFICATION_STALLED the engine is *already* frozen, so "the user is alive"
  changes nothing.
- **Pausing indefinitely is not actually the safe choice.** It is fail-safe
  against a wrongful release and, in exchange, guarantees a wrongful
  NON-release. Channel failure is *correlated* with the owner dying — a dead
  person's mailbox starts bouncing, their number is recycled, push subscriptions
  expire — so the exact scenario this product exists for was the one where it
  silently did nothing forever, with nobody alive to notice. Threat 5.3 is
  supposed to protect a *living* user from a notification outage; it should not
  quietly become a guarantee that a dead one is never released.

The engine now stalls for `notification_stall_max_days` (default 30, per-user)
and then resumes the ladder at ESCALATION_PENDING. That is not a shortcut to
release: escalation still accepts a one-tap check-in the moment any channel
recovers, the full escalation cooldown still burns before RELEASE_REVIEW, and the
real gate was never the notification — it is the ceremony consensus, which
requires a diverse above-threshold affirmation and remains disputable throughout.
Channel recovery always takes precedence over the bound.

### Trusted-contact pre-release reach-out, not just notification
Before ESCALATION_PENDING progresses to RELEASE_REVIEW, engine instructs trusted contacts to actively attempt to contact the user out-of-band — call, visit, ask mutual friends. The contact must affirm "I have attempted to reach the user and could not" before the cooldown timer can start.

This is not just a notification, it's a human verification step. If even one contact says "I just talked to them yesterday, they're fine, they're traveling," the engine reverts to ACTIVE.

### Periodic channel-health pings
Every 30 days during Active state, engine sends a low-friction "tap to confirm channel is alive" message through each channel. If a channel doesn't get a tap for two consecutive health pings, that channel is flagged stale and the user is notified through other channels to either reconfirm it or remove it. Stale channels do not count toward redundancy requirement.

### Mandatory minimum channel diversity
At enrollment, user must register at least three channels of different types (email + SMS + push, not three email addresses). Engine refuses to arm if channel diversity is insufficient.

For premium users, add a **physical channel** — a postcard sent to a registered address before any release. The postcard takes a week, but it's a channel genuinely orthogonal to digital failure modes.

### Calendar-aware inactivity
User can pre-register travel windows or scheduled-absence periods. During registered windows, inactivity threshold extends automatically and the engine raises the bar for progressing — multiple consecutive missed check-ins are required instead of one.

### Out-of-band reconfirmation requirement before any release
Before any actual cryptographic release ceremony (not just contact notification — the actual key-share-combination step), engine requires at least one contact to physically verify the user is gone.

- For **S1**: digital affirmation is sufficient.
- For **S2 and S3**: requires a higher bar — either a death certificate uploaded by the contact, a contact-to-contact video call where both contacts affirm together, or a designated-verifier flow (V2).

**Notification failure alone cannot cause S2 or S3 release — it can at worst cause S1 release.**

## 5.3.6 Residual risk

The user lives alone, has no close contacts who actively check on them, all notification channels die simultaneously, and trusted contacts are reachable but lazy — they get the "user appears inactive" notification, click "yes proceed" without verifying, and the cooldown runs.

In this scenario, S1 can wrongfully release. S2 and S3 cannot, because they require contacts to perform physical verification, and we audit-log who affirmed what. If a contact later turns out to have lied about verifying, the audit log is evidence.

S1 wrongful release in this scenario is accepted, with the mitigation that S1 contents are deliberately the soft tier (subscription list, "please tell these people" notes — embarrassing if leaked, not catastrophic).

## 5.3.7 Crypto architecture implications

- The "physical verification by contact" step needs to be cryptographically bound to the release ceremony. Each contact signs their affirmation with their own key (the same key holding their Shamir share), and the signature is included in the release audit log. A contact cannot later deny they affirmed, and a contact who affirms falsely is legally exposed.
- The NOTIFICATION_STALLED state needs to be added to the state machine. See `02-state-machine.md` — it is state 3 in the updated nine-state model.
