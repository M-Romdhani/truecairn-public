# 02 — Continuity Engine State Machine

The state machine governs how the engine moves a user from normal Active operation through to vault release. Originally seven states; expanded to nine after threats 5.3 and 5.5 surfaced gaps.

## Nine states

### 1. ACTIVE

Normal state. User healthy and engaged. Full control of vault, contacts, settings.

**Allowed actions:** modify vault, add contacts, update workflows, configure triggers.

**Exit conditions:**
- Inactivity threshold exceeded → CHECK_IN_PENDING
- Manual trigger by user → CHECK_IN_PENDING (skip check-in if user explicitly initiates)
- Pre-registered absence window expires → CHECK_IN_PENDING

### 2. CHECK_IN_PENDING

System suspects inactivity. User asked to confirm they are active.

**System actions:** send push notification, email, SMS through every registered channel.

**Exit conditions:**
- User confirms via any channel → ACTIVE
- User snoozes → ACTIVE with shortened next-check-in
- All channels report hard delivery failure → NOTIFICATION_STALLED
- Timeout expires (default 7 days) → ESCALATION_PENDING

### 3. NOTIFICATION_STALLED (added from threat 5.3)

The engine cannot reach the user through any channel. Hard delivery failures across the board.

**System actions:** continue retrying, alert support team for manual investigation, do *not* progress to escalation while the stall bound holds.

**Exit conditions:**
- Any channel reconfirmed → CHECK_IN_PENDING, with the full check-in window re-armed from now (a user unreachable for days gets the whole window, not an instantly-expired deadline)
- The stall bound expires (`notification_stall_max_days`, default 30) → ESCALATION_PENDING

A total notification failure is usually a system problem rather than a user-gone
problem, so the engine stalls rather than progressing — **but not forever.**

**Why the bound exists (corrected 2026-07-25).** Stalling indefinitely was
fail-safe against a wrongful release and, in exchange, guaranteed a wrongful
NON-release. Channels failing is *correlated* with the owner dying: a dead
person's mailbox starts bouncing, their number is recycled, push subscriptions
expire. So the precise scenario this product exists for — the owner is genuinely
gone — was the scenario in which the engine silently did nothing forever, with
nobody alive to notice. Sustained total unreachability is itself evidence.

The bound resumes the ladder at ESCALATION_PENDING, deliberately **not** as a
shortcut to release: that state still accepts a one-tap check-in if any channel
recovers, it burns the full escalation cooldown before RELEASE_REVIEW, and the
real gate against a false release was never the notification — it is the ceremony
consensus, which still requires a diverse above-threshold affirmation and can be
disputed at any point. Channel recovery always takes precedence over the bound.

**Note:** earlier revisions of this document listed "trusted contact manually
attests user is alive → ACTIVE" as an exit here. That was never implemented, and
should not be: contacts are deliberately not approached before a release ceremony
opens (see §4), so a contact has no way to learn the owner is unresponsive and
would never know to attest. See the note under §4.

### 4. ESCALATION_PENDING

Trusted contacts notified. Cooldown timer starts.

**System actions:** urge the OWNER to check in on their own channels, and increase monitoring.

**Restrictions:** NO access released yet. This is critical.

**Exit conditions:**
- User confirms via any channel → ACTIVE (with audit log entry). The check-in requires a deliberate acknowledgment in this state, so a one-tap cannot silently clear an escalation.
- Dispute triggered by any party → REVIEW_REQUIRED
- Cooldown expires (default 14 days) → RELEASE_REVIEW

**Contacts are NOT approached here (corrected 2026-07-25).** Earlier revisions of
this document said contacts are notified at this stage and could "attest the user
is alive → ACTIVE". Neither is true, and the divergence was found in the
2026-07-25 audit: every engine notification is addressed to the owner's own
channels, and contacts are first approached at RELEASE_REVIEW, when a ceremony
opens. That is a deliberate product decision, not an oversight — telling several
people "we think X may have died" on a false positive (the owner is simply on a
hiking trip) is alarming, hard to take back, and changes the product's social
contract before any release is actually in progress.

Consequently there is **no `contact_attests_alive` capability**, and the engine
event of that name is not emitted by anything. Reintroducing it would first
require deciding to disclose the owner's unresponsiveness to contacts
pre-ceremony, and would hand a cohabitant (docs/09) a lever for suppressing a
legitimate release. If that decision is ever revisited, both consequences have to
be designed for explicitly.

### 5. RELEASE_REVIEW

Final verification layer before any cryptographic release ceremony.

**Required actions:** contact identity re-verification, anti-cohabitant factor challenges, contact-to-contact cross-notification.

**Exit conditions:**
- Verification passes and contacts affirm → LIMITED_RELEASE
- Verification fails → REVIEW_REQUIRED
- User returns and authenticates → RETURNING

### 6. LIMITED_RELEASE (S1)

Stage 1 release. Recovery instructions, operational playbooks (business role), asset inventory.

**Restrictions:** does not include identity docs, financial accounts, crypto, or personal archive.

**Exit conditions:**
- Staged unlock timer expires (default 7 days from S1) → STAGED_RELEASE
- User returns → RETURNING

### 7. STAGED_RELEASE (S2)

Stage 2 release. Identity documents, financial accounts, legal documents.

**Restrictions:** does not include crypto material or personal archive.

**Exit conditions:**
- Staged unlock timer expires (default 14 days from S2) → FULL_RELEASE
- User returns → RETURNING

### 8. FULL_RELEASE (S3)

Stage 3 release. Crypto wallets, personal archive, all remaining content authorized for the contact's role.

**This is the terminal state for the release path.** Reached only after all gates have cleared.

### 9. RETURNING (added from threat 5.5)

User has logged in from any device during an in-progress release workflow. Engine pauses, requires user to re-authenticate with passphrase to confirm identity.

**System actions:** prominent "we thought you were gone, please confirm you're back" banner, pause all in-flight cooldowns.

**Exit conditions:**
- User confirms with passphrase → ACTIVE (full revert)
- User does not respond within 7 days → resume previous state

### Side state: REVIEW_REQUIRED

Manual human intervention. Used when disputes occur, conflicting signals, suspicious behavior, recovery anomalies.

Not on the main progression path. Reached from any state when something needs a human at the platform to look at it.

## The asymmetry principle

The most important property of this state machine: **cancellation is always easier than progression.**

- Confirming "I am active" takes one tap on any verified device.
- Initiating release takes weeks across multiple states with multiple cancel windows.

If you ever find yourself designing a feature where progression is faster than cancellation, you have broken the principle and the change is wrong.

## Cancel paths

From every monitoring or releasing state (CHECK_IN_PENDING, NOTIFICATION_STALLED, ESCALATION_PENDING, RELEASE_REVIEW, LIMITED_RELEASE, STAGED_RELEASE, RETURNING, REVIEW_REQUIRED), there is a direct path back to ACTIVE triggered by user confirmation. The user does not need to be on a specific device. They do not need to remember a complex flow. One tap reverts everything.

The only state without a cancel path is FULL_RELEASE, because by definition the cryptographic release has completed and contents are out. We cannot un-release content. This is why the cooldown ladder before FULL_RELEASE is deliberately long.

## What this state machine does NOT model

- The release ceremony's internal sub-states (tentative affirmation, committed affirmation, share contribution). See `18-crypto-architecture.md` for the ceremony protocol.
- The user's manual release flow (user knows they are dying and wishes to release immediately). This is a separate path.
- Account-compromise sensitive-action delays. These are gated by the account itself, not the engine state.
- Notification channel health pings. Background process, not engine state.
- The pre-arm state (`pre_active`). A freshly enrolled engine sits in `pre_active` until the owner explicitly arms it (`POST /v1/engine/arm`, which fires the `engine_armed` transition into ACTIVE — docs/01's arm confirmation). Arming is refused (`409 engine-arm-prerequisite`) until the owner has at least one ENROLLED contact: a contactless engine is fail-closed but useless — `release_review` could never reach consensus, so the switch would arm yet never be able to fire, leaving the owner falsely reassured. Monitoring — everything above — begins at ACTIVE.

## Numbers committed in this document

- Check-in timeout: 7 days
- Escalation cooldown: 14 days
- S1 → S2 timer: 7 days
- S2 → S3 timer: 14 days
- RETURNING grace window: 7 days
- NOTIFICATION_STALLED bound: 30 days (`notification_stall_max_days`)

Total time from start of CHECK_IN_PENDING to S3 release: minimum 42 days, default configurations.

These numbers are defaults and can be configured up by the user, with floors documented in `09-anti-cohabitant-decision.md` and `01-decisions-locked.md`.
