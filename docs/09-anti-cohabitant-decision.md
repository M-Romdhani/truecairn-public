# 09 — Design Decision: The Anti-Cohabitant Verification Factor

This is Gap 2 from threat 5.1, the keystone of the entire defense.

## The problem

A spouse, cofounder, or adult child living with the user typically has access to:
- The user's email (shared accounts, known passwords)
- The user's primary devices (often unlocked or with known PINs)
- Answers to security questions (they know the user's life)
- Physical mail (one-time codes sent to the home address)

Standard verification — "we sent a code to your email" or "answer a security question" — fails completely against this attacker.

We need a factor the attacker **cannot satisfy even with full cohabitation access**.

## The three options

### Option A: Hardware security key

User registers a YubiKey or similar at enrollment. Release-time verification requires the key.

**Strengths:**
- Cryptographically strong
- Hard to defeat with cohabitation alone
- Security-tech audience loves it

**Weaknesses:**
- Most users don't own one
- Hardware keys get lost
- Expensive to ship as default
- Brutal usability for the eventual non-technical contact who is meant to access content

**Failure mode:** user loses key, locks themselves out forever.

### Option B: Release-only passphrase

At enrollment, the user creates a passphrase used exclusively for release-time verification. Never used elsewhere. Written on paper, stored physically away from the home (safety deposit box, parent's house, lawyer's office).

At release time, the contact must enter the passphrase.

**Strengths:**
- Cheap, universal
- Doesn't require hardware
- Offsite storage breaks cohabitation

**Weaknesses:**
- Depends entirely on the user actually storing the paper somewhere the attacker can't reach
- Users will fail at this
- The passphrase can be guessed, photographed, or compelled

**Failure mode:** user stores it in their desk at home, attacker reads it.

### Option C: Designated verifier contact

A specific person, not a thing, is the verification factor. At release time, that person is contacted independently — phone call, video verification, in-person — and must affirm the release.

This person is NOT one of the standard trusted contacts; they have no other role.

**Strengths:**
- Humans are robust verification factors
- A verifier in another country, barely knowing the spouse, cannot be cohabitation-attacked
- Can adapt to context ("she sounds like she's under duress")

**Weaknesses:**
- Requires the user to maintain a relationship with someone over years
- That person can die, become unreachable, or refuse
- Introduces a human in the loop with all the cost that implies

**Failure mode:** verifier becomes unreachable when actually needed.

## Locked decision: hybrid, defaulting to B with optional A

### For all users
**Release-only passphrase (Option B) is mandatory at enrollment.**

The onboarding flow shows the user the passphrase, requires them to confirm they have stored it offline, and asks them to confirm again seven days later. Without this, the engine cannot be armed.

### For users who want stronger protection
**A hardware key (Option A) can be added as an additional factor for S3 release only.**

Premium feature. Stacks on top of the passphrase, not in place of it.

### Option C → V2
Designated verifier becomes a V2 feature, possibly enterprise tier, because it adds operational complexity that doesn't pay off at the individual user scale.

## Why this configuration

**The passphrase is universal.** Every user, no exceptions, no hardware purchases. The act of writing it down and storing it physically forces a moment of deliberate engagement with the release event, which is itself security-positive. Storing it offline breaks the cohabitation model because the home is no longer a sufficient operating environment for the attacker.

**The hardware-key add-on serves the high-value-target audience.** Founders with significant crypto, users in adversarial jurisdictions, anyone for whom the passphrase alone feels insufficient. They opt in. They accept the lockout risk.

**Both factors can be reset** by the user during Active state through a sensitive-action delay (seven days). A lost passphrase isn't catastrophic — the user resets it, waits a week, and can rearm.

## The failure mode this leaves open

If a user stores the passphrase carelessly (in the bedside drawer, in a `passwords.txt` file, taped to the back of the monitor), the entire defense collapses.

The platform cannot enforce careful storage. We can only make the prompt at enrollment vivid enough that users take it seriously: a setup flow that explicitly says "this paper is the difference between protected and not — store it somewhere your spouse, your cofounder, and your children cannot reach."

Some users will ignore that. Some will store it well. Both outcomes are acceptable in the aggregate, because **the option of strong storage is what the platform sells**.

## Onboarding implications

The onboarding flow for this decision needs care:

1. **At signup:** explain why the release-only passphrase is different from the master passphrase.
2. **Display passphrase ONCE.** Generate it client-side (so the server never sees it), present it for the user to write down, require them to type it back to confirm.
3. **Storage prompt:** explicitly list good storage locations (safety deposit box, lawyer's office, parent's house in a sealed envelope) and bad ones (home desk, password manager, photo on phone).
4. **7-day confirmation:** after a week, prompt the user "did you store the passphrase paper safely? show me where it is by typing back the first three words."
5. **Cannot arm engine without confirmation.** If the user skips the 7-day confirmation, the engine remains disarmed and the vault remains accessible only via the master passphrase.

This is the most security-critical UX in the entire product. It deserves dedicated design attention.
