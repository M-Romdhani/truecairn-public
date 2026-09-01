# 14 — Threat 5.6: Multi-Contact Collusion

Two or more legitimate contacts conspire against the user. This is the threat the entire Shamir scheme is designed to defeat.

## 5.6.1 Description

Two or more legitimate trusted contacts who deliberately conspire against the user. Unlike 5.4 (contact compromise), the contacts are not victims — they are the attackers, acting on their own credentials and intent.

Most realistic scenarios:
- An estranged spouse and an adult child team up against a parent
- A cofounder and a lawyer team up against a founder
- An heir and a family friend team up against a person they expect to inherit from

**This is the threat that the entire Shamir scheme is designed to defeat.** If 5.6 is reachable easily, the architecture has failed.

## 5.6.2 Capabilities

Combined capabilities of the colluding parties. Two contacts can:
- Affirm a release on schedule
- Contribute two shares to a reconstruction
- Satisfy diverse-role consensus if their roles are diverse
- Time their actions to coincide

They cannot, on their own:
- Shorten cooldowns
- Suppress notifications to the user (those go through channels the contacts don't control)
- Produce the release-only passphrase (held physically off-site)
- Produce a hardware-key share (held physically by the user)

## 5.6.3 Attack path

1. Two contacts of diverse roles (personal + professional) agree to conspire.
2. Wait for a real inactivity event, or wait for the user to enter a predictable absence.
3. Both contacts affirm release when prompted by the engine.
4. Both contacts contribute their shares to the reconstruction ceremony.
5. Wait out the cooldown without triggering cancel signals visible to the user.
6. Attempt reconstruction.

## 5.6.4 Attack tree

Root: colluding contacts reach S2 or S3 release.

**For S2:** the shipped scheme is a *flat* 2-of-3 `{contact, contact, passphrase}`, so two **diverse-role** contacts hold the threshold outright — they reconstruct S2 with no further factor. This collusion path is **accepted** for S2 (docs/24 Option A; see 5.6.5); the bar against it is procedural (diverse-role, notification, audit, anomaly, cooldown), not a cryptographic short-by-one.

Under the Option 2 Shamir scheme, the platform's outer-layer key is **not a share**; it's a temporal gate that releases regardless of who initiated the ceremony. It's available to any legitimate ceremony including a malicious one, but it doesn't reduce the human-factor threshold.

**For S3:** the nested scheme (docs/24) splits the *masked* tier key 2-of-3 across the contacts, with the release passphrase as a mandatory one-time-pad mask. Colluding contacts — even all three — recover only the masked secret; reaching the S3 tier key additionally requires the release passphrase, which returns to 5.1 (a cohabitant attack on the passphrase paper). There is no contacts-only S3 path.

## 5.6.5 Mitigations

### The Shamir threshold itself
The primary defense, **for S3**. Under the nested S3 scheme (docs/24) the release passphrase is a mandatory one-time-pad mask over a 2-of-3 contact split: colluding contacts recover only the masked secret and remain short the passphrase no matter how patiently they wait. Patience cannot manufacture the missing factor.

**S2 caveat (docs/24, Option A — accepted).** The shipped S2 is a *flat* 2-of-3 `{contact, contact, passphrase}`: any two of the three shares suffice, so two **diverse-role** colluding S2 contacts CAN reach S2 without the passphrase. The owner accepts this trade-off for S2 (recoverability over collusion-hardness); the cryptographic "short by one" guarantee above is an **S3** property, not an S2 one. The procedural defenses below (diverse-role, notification, audit, anomaly, cooldown) still raise the bar for S2.

### Diverse-role enforcement
Two contacts of the same role (two spouses, two cofounders) cannot affirm together at all. The role check at affirmation time prevents same-role pairs from contributing two shares.

The conspiracy must span both personal and professional life — a higher coordination bar.

### Cross-contact notification
When contact A affirms, contact B (the colluding partner) is notified, but so are all other contacts on the user's roster. A third contact, not in on the conspiracy, sees "spouse and lawyer have both affirmed release" and can flag the ceremony as suspicious.

This depends on the user having more than two contacts, which we recommend strongly at enrollment.

### Audit log of affirmations
The conspiracy is recorded. Even if the release succeeds, the user (if they survive) or their estate has a permanent, cryptographically signed record of who affirmed when. Creates legal exposure for the colluders and acts as a deterrent.

### User-side anomaly notification
If two affirmations arrive within a short window (hours, not days), engine raises the suspicion threshold for the ceremony — additional cooldown, additional cancel windows, additional verification requirements.

Coordinated affirmation is itself a signal.

### Cooldown ladder spreads out the attack
Colluders must remain coordinated and unwavering across the full cooldown ladder. The longer the timeline, the more chances for one colluder to back out, for the user to return, or for a third contact to notice.

## 5.6.6 Residual risk

Colluding contacts cannot reach **S3** by collusion alone — the nested scheme (5.6.5) keeps the release passphrase a mandatory mask. **S2 is the accepted exception:** two diverse-role contacts reach S2 without the passphrase (docs/24 Option A).

They can also reach S1 (a single contact's affirmation plus the temporal gate).

They can additionally reach **S3** by colluding AND executing a cohabitant attack to obtain the passphrase paper (5.1). This combined attack requires three coordinated capabilities: two complicit diverse-role contacts, defeat of physical security on the passphrase paper, and patience across the cooldown.

**We accept that a sufficiently determined and well-positioned conspiracy can succeed.** The architectural goal is to make conspiracy visible and expensive, not impossible. A conspiracy that requires three independent compromises and weeks of coordination, with permanent audit trails for legal action, is a conspiracy that will be deterred in most realistic cases.

The platform is not designed to defeat state-level conspiracies; it is designed to defeat opportunistic and relational ones.

## 5.6.7 Crypto architecture implications

None new beyond what Option 2 already specified. The diverse-role check at affirmation time, the cross-contact notification protocol, and the cooldown ladder are all already in the design.
