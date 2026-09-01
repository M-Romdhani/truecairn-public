# 13 — Threat 5.5: False Inactivity

User is just traveling, in a hospital, on retreat. The platform must not release.

## 5.5.1 Description

Again not an attacker — this is the user themselves, accidentally. The user is alive, healthy, and reachable in principle, but has gone somewhere or done something that suppresses their normal engagement with the platform for longer than the inactivity threshold.

They are on a silent meditation retreat, hiking the Pacific Crest Trail, in a country with internet restrictions, in a hospital sedated for a planned surgery, switched their primary phone and forgot the platform was on the old one, in prison awaiting trial.

## 5.5.2 Capabilities

Same as 5.3 in terms of consequence — the engine progresses, contacts are notified, release ceremony begins. But unlike 5.3, the channels *are* working — the user just isn't receiving or responding because of their physical situation.

## 5.5.3 Failure path

1. User enters extended silent/unreachable period (legitimately, on purpose or by circumstance).
2. Check-in fires. User does not see it because they're not checking phones/email.
3. Timer expires. Engine progresses normally through the states.
4. Contacts get notified, attempt to reach user, fail.
5. Release ceremony begins because contacts assume the worst.
6. User returns from retreat / discharged from hospital / released from custody to find their vault has been released.

## 5.5.4 Attack tree (re-framed)

Root: engine releases content during a legitimate-but-extended user absence.

System must fail at: pre-registered absence accommodation AND extended-window threshold logic AND contact judgment about whether to affirm AND user's ability to detect-and-cancel on partial return.

## 5.5.5 Mitigations

### Pre-registered absence windows
User can declare upcoming absences with start and end dates. During registered windows:
- Inactivity threshold is extended (e.g., to twice the user's declared absence length)
- Engine raises the affirmation bar — contacts must affirm with explicit acknowledgment that "yes, the user told me they would be away, and the absence has now exceeded the declared window significantly"

### Trusted-contact judgment as a feature, not a bug
When a contact is asked to affirm, the affirmation interface explicitly asks: "Do you have any reason to believe the user is alive and merely unreachable? (e.g., planned travel, retreat, hospitalization)" with options to delay the ceremony by 30, 60, or 90 days.

**A single contact selecting "delay" pauses the ceremony.** Contacts who have any context at all about the user's life can prevent false release without needing to provide proof.

### Graceful re-entry detection
The instant the user logs in from any device, engine moves to RETURNING state. Pauses any in-flight release ceremony. Requires user to re-authenticate with passphrase to confirm they are actually them and they are actually back.

User returning from a hike and opening the app sees a prominent "we thought you were gone, please confirm you're back" banner. Single confirmation reverts everything.

**The release ceremony is reversible up to the moment the actual cryptographic key combination happens**, which is the final step.

### Increased thresholds at higher tiers
State machine progresses slower toward higher-tier releases:
- S1 can release after the base threshold.
- S2 requires an additional 7 days beyond that.
- S3 requires an additional 14 days beyond S2.

A user gone for a true emergency 90-day situation still has time on the S3 side, even if S1 has progressed.

### Calendar integration as opt-in
For users who integrate calendar with the platform, scheduled events tagged "travel" or "unreachable" automatically extend the threshold. Opt-in because it has metadata implications, but meaningful UX improvement.

### Default thresholds are deliberately long
The default inactivity threshold for first-time users is 90 days, not 30. The check-in cascade lasts another 30 days. The S1 cooldown is another 14. So a brand-new user with default settings doesn't see S1 release until ~134 days of total silence.

We will let users shorten these but the **defaults are forgiving**. Most users will not change defaults.

### Silence the system itself is enforcing does not count (added 2026-08-07)

Everything above treats false inactivity as *accidental* — the user's own
circumstances suppress their engagement. A source audit on 2026-08-07 found the
adversarial variant, which this section did not anticipate: **an attacker can
manufacture the silence.**

Account lockout is triggered by five failed password attempts in 15 minutes,
keyed on the **email address supplied in the request body** over an
unauthenticated route. Knowing a victim's address was therefore enough to lock
them out for an hour at a time, indefinitely renewable at five requests per hour;
one IP could sustain it against roughly 70 accounts without tripping the per-IP
ceiling. `requireSession` rejected every route for a locked account — including
check-in, the owner's only way to say they are alive — while the worker's
inactivity clock kept running. Passkey-only accounts were equally lockable (a
no-password account still reaches the lock counter through the reject path), and
the one-hour expiry was cleared only by the password login route, so such an
owner stayed locked well past the hour with nothing they could reach to lift it.

This inverted 5.5's premise. The mitigations above all assume the user *could*
respond if they knew; here the system was refusing to let them.

Mitigated in two layers:

1. **Auth.** Check-in and engine status are served by
   `requireSessionAllowingLocked` — a locked account can still prove it is alive
   and see its own state, while the vault, contacts, settings and sensitive
   actions stay locked. The lock exists to slow credential *guessing* and those
   routes accept no credentials, so the brute-force defence is unchanged. A
   verified passkey assertion now releases the lock outright (proof of possession
   means the holder is not the guesser), and an elapsed lock self-heals on any
   authenticated request rather than waiting for one specific route.
2. **Engine.** A lock in force stalls the ladder at the inactivity deadline and
   at the check-in timeout instead of advancing, on the same reasoning as the
   notification stall: silence only carries information if the owner could have
   broken it. **Bounded** by `notification_stall_max_days` — because a lock is
   attacker-controllable and renewable, an unbounded stall would trade a wrongful
   release for a guaranteed wrongful non-release and hand any stranger a
   permanent veto on that owner's release.

The pattern worth carrying forward: any mechanism that can prevent an owner from
responding must either exempt the liveness path or stall the ladder, and if it
stalls, the stall must be bounded.

## 5.5.6 Residual risk

A user who goes silent for over 134 days without pre-registering the absence, with no contacts who know about the absence, with all contacts willing to affirm without hesitation, can see S1 release.

S2 release requires additional 7 days plus contacts unwilling to delay.

S3 release requires additional 14 days beyond that.

We accept this — at 200+ days of unannounced silence with cooperative contacts, the engine releasing is closer to "doing its job" than "false positive." The user should pre-register absences; we will tell them this loudly.

## 5.5.7 Crypto architecture implications

None new. The mitigations are state machine and UX changes, not cryptographic.

The RETURNING state needs to be added to the state machine — see `02-state-machine.md`, state 9 in the updated nine-state model.
