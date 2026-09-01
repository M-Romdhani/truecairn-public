# 07 — Threat 5.1: Malicious Trusted Contact

The flagship threat. Most likely real-world failure mode. Establishes the template all other threats follow.

## 5.1.1 Description

A trusted contact, listed by the user in good faith, intentionally exploits the platform's inactivity-detection workflow to gain access to vault contents during a period when the user is alive, well, and would not consent to release.

The attack does not require technical sophistication; it exploits the engine's normal behavior, weaponizing the user's temporary unreachability.

Distinguished from device compromise (5.2) and account compromise (5.4) by its actor: the contact themselves is the adversary, acting on their own credentials and intent.

**It is the single most likely wrongful-release scenario the platform will face in its operating lifetime.**

## 5.1.2 Attack scenarios

### Scenario A — separating spouse
User enrolled their spouse as full executor four years ago, during a happy marriage. The marriage has deteriorated. The user travels to a country with limited connectivity for a two-week conference. The spouse, knowing the user's check-in cadence, simply waits out the inactivity threshold and ignores the engine's escalation pings on the user's behalf.

### Scenario B — disgruntled cofounder
User designated the cofounder as business-continuity contact two years ago. The relationship has fractured. The user takes a week of unannounced personal leave. The cofounder triggers manual inactivity escalation (claiming concern), waits the cooldown, and gains release of business assets to operate the company without the user's involvement.

### Scenario C — impatient heir
User designated their adult child as heir three years ago. The child has fallen into financial trouble. The user is briefly hospitalized for a planned procedure. The child initiates escalation, hopes the cooldown expires before the user is discharged.

**Shared pattern:** the attacker is patient, has time on their side, has partial knowledge of the user's life and habits, and has plausible legitimate reasons to be in contact with the user's home, devices, or accounts.

## 5.1.3 Impact

By stage reached:

- **S1 release:** recovery instructions disclosed. Moderate damage; underlying accounts still require their own credentials. Recoverable through external password resets and account-recovery flows.
- **S2 release:** identity documents, financial accounts, legal documents released. Severe damage. Identity-theft and financial fraud become possible. Recoverable through fraud reversal at high time and stress cost.
- **S3 release:** crypto wallets and personal archive released. Irreversible. Crypto funds gone the moment the attacker has the seed. Personal archive cannot be unread.

**The platform's design must ensure the workflow cannot reach S3 without the user having had a clear opportunity to cancel.** S1 reaching an attacker is unfortunate; S3 reaching an attacker is product-ending.

## 5.1.4 Likelihood

Proxy data from adjacent domains:
- Divorce rates in launch markets range from a third to half of marriages over a lifetime. Not all divorces are adversarial, but a non-trivial fraction are.
- Cofounder disputes are a primary failure mode of early-stage companies.
- Family financial disputes around inheritance support an entire legal industry.

Across a user base of ten thousand users over five years, dozens will experience at least one contact transitioning from trustworthy to potentially adversarial.

**Likelihood classification: medium to high over five years of operation, low for any individual user-month.**

## 5.1.5 Existing mitigations

1. **Inactivity check-in stage.** Before any escalation, multiple channels. User can cancel in one tap.
2. **Cooldown after escalation.** 14-day default, 7-day floor, 60-day ceiling.
3. **Multi-channel notifications.** Email, SMS, push, optional phone call (premium).
4. **Cancel-from-any-verified-device.** Including old devices left at home.
5. **Staged release.** S1 → S2 → S3 spacing adds cooldown windows. Reaching S3 requires 42 days minimum.
6. **Diverse-role consensus for sensitive releases.** S3 requires multi-contact consensus across roles.
7. **Sensitive-action delays on engine-affecting settings.** Contact cannot shorten cooldown or remove other contacts. User changes go through 7-day cooldown.
8. **Audit log visibility.** Every escalation event logged. User sees it on return.
9. **Notification asymmetry.** Confirming active: one tap. Initiating release: weeks. The asymmetry favors the user.

## 5.1.6 Gaps

### Gap 1: Silent-retreat / no-signal users
A user genuinely unreachable for the entire cooldown cannot cancel through normal channels.

**Resolution:** scheduled-absence feature. User pre-authorizes absence up to N days during which escalation is paused.

**Open question:** maximum scheduled-absence window. 90 days seems reasonable for sabbatical.

### Gap 2: Verification challenges the spouse can pass
A cohabiting spouse has access to user's email, security questions, backup devices.

**Resolution:** see `09-anti-cohabitant-decision.md`. Release-time verification must include at least one factor the attacker plausibly cannot satisfy.

### Gap 3: Diverse-role consensus precise meaning
Per `01-decisions-locked.md`: S3 requires 3-of-4 among (personal contact, professional contact, passphrase, hardware-key-or-second-professional). Personal and professional contacts must be of different roles.

**Open question:** whether recovery-contact role counts toward consensus. Current answer: no, it is intentionally low-authority.

### Gap 4: Cancellation when devices are inaccessible
User's devices stolen, broken, or in attacker's possession.

**Resolution:** physical recovery code generated at enrollment, printed/written and stored offline. Entering it at any new device immediately verifies that device for cancellation purposes only.

**Open question:** how to onboard users to actually print and store the code.

### Gap 5: Cooldown floor
14-day default is a proposal. Floor: 7 days, no exceptions. Premium can extend to 90.

### Gap 6: A contact could block a release forever (closed 2026-08-07)
This threat model reads a malicious contact as someone who wants a release to
happen *too early*. The inverse — a contact who wants it never to happen — was
not considered, and was reachable.

`POST /v1/ceremonies/:id/dispute` correctly halts a release for owner review, and
that asymmetry is deliberate: a false "the owner is alive" costs one delay, a
false release is irreversible. But it was **unbounded**. The owner's only exit
from `review_required` is `resolve-review`, which costs them a fresh second
factor, and nothing stopped a contact from immediately pushing the engine back —
including a contact whose ceremony had ended months earlier, since affirmation
rows outlive their ceremony forever. One contact could hold an owner's vault
hostage indefinitely, at no cost to themselves, and the owner had no way to
override it.

Closed by bounding rather than narrowing, so no protection was lost: a dispute is
**idempotent per affirmation** (`disputed_at`, migration 0057) and is refused once
the ceremony is terminal. A contact who genuinely believes the owner is alive can
still dispute *every fresh release attempt* — a new ceremony creates a new
affirmation row — and still needs no affirmation status to do it, because the
contact most likely to know the owner is alive is precisely the one who has not
affirmed.

Deliberately NOT done: gating dispute on affirmation status. A contact who
revoked a tentative affirmation and later learns the owner is alive must still be
able to say so; blocking them would remove safety and prevents no attack, since a
contact who simply never revokes can do exactly the same thing.

## 5.1.7 Required actions before launch

1. Decide and document the consensus-eligible role set. (Closes Gap 3.)
2. Implement scheduled-absence feature. (Closes Gap 1.)
3. Require release-time verification with at least one anti-cohabitant factor. (Closes Gap 2.)
4. Implement physical recovery code for cancellation. (Closes Gap 4.)
5. Decide and document the cooldown floor: 7 days minimum, 14 days default. (Closes Gap 5.)
6. Add behavioral telemetry for early detection of manual contact-initiated escalation.
7. Add post-release report visible to the user with full audit trail.

## 5.1.8 Residual risk

After mitigations, what remains:

The committed-attacker-with-cohabitation scenario can still inflict:
- S1 release of recovery instructions, possibly operational playbooks.
- Information about the structure of the user's digital life.
- Substantial emotional and practical disruption.

The committed attacker cannot reasonably achieve:
- S3 release without the user being absent for 42+ days AND the attacker having both their own credentials and the release-time anti-cohabitant factor AND a second consenting contact of a different role.
- Modification of the release matrix, cooldown floor, or contact roster taking effect before the user can revert.
- Use of platform staff or operators as accomplices.

**Accepted residual risk:** S1-level wrongful releases at a low but non-zero rate. Primary remediation: rapid detection (audit log on return), post-event review, S1 contents not catastrophic when disclosed.

**Unaccepted risk:** any path to S3 wrongful release. If identified during development or production, treat as launch-blocking or service-stopping incident.

## 5.1.9 Open issues to track

- Cooldown floor reasoning needs better data than intuition. Consider user study.
- Anti-cohabitant verification factor selection is usability/security tradeoff that needs prototyping.
- Scheduled-absence feature interacts with billing and may need tier-gating to prevent abuse as engine-disable mechanism.
- International variations: in some jurisdictions, an estranged spouse may have legal access regardless of platform mitigations. Document, don't fight.
