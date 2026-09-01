# 12 — Threat 5.4: Contact Compromise

Attacker has compromised a trusted contact's account. Contact is unwitting.

## 5.4.1 Description

An attacker who compromises one or more trusted contacts (not the user). The contact is unwitting — their email is hacked, their device is stolen, their phone is SIM-swapped, or they're socially engineered. The attacker controls the contact's account on the platform but the contact themselves is alive, well, and unaware.

## 5.4.2 Capabilities

While authenticated as the contact, the attacker can:
- See release notifications addressed to the contact
- See the contact's Shamir share (if stored in the contact's account — which we will deliberately not do, see mitigations)
- Affirm release events on behalf of the contact
- Vote in diverse-role consensus on behalf of the contact
- Modify the contact's notification preferences

The attacker **cannot**:
- Trigger an inactivity event by themselves (they don't have the user's account)
- But once an inactivity event is in progress (legitimately or via threat 5.5), the attacker can push it forward by affirming on behalf of the contact

## 5.4.3 Attack paths

### Path A — opportunistic participation
1. Compromise contact account.
2. Wait for legitimate inactivity event.
3. When engine asks the contact to affirm and contribute their share, affirm and redirect released contents to attacker-controlled destination.

### Path B — multi-contact collusion (multi-step)
1. Compromise contact A.
2. Compromise contact B (independently — different roles per diverse-role requirement).
3. Trigger or wait for inactivity event.
4. Both compromised contacts affirm and contribute their shares.
5. Combined with the platform outer-layer key release (after time), reach 2-of-3 threshold for S2.
6. For S3, additionally need the release-only passphrase share, which requires compromising the user's passphrase paper (separate threat 5.1).

## 5.4.4 Attack tree

Root: attacker releases vault contents by impersonating one or more contacts.

Attacker must: compromise a contact account AND survive the contact's own out-of-band notification of the affirmation AND have the share in a form the attacker can use AND, for S2/S3, combine with shares from other independently-compromised contacts AND/OR the passphrase share AND the platform outer-layer key release.

## 5.4.5 Mitigations

### Shares are not stored in contact accounts (critical)
Each contact's Shamir share is encrypted with a key derived from the contact's own passphrase plus a hardware-bound device key — not the contact's login credential. The contact's platform account holds ciphertext of their share.

To use the share in a release ceremony, the contact must enter their personal passphrase on a device that has been registered as theirs via a hardware-binding ceremony. Compromising the contact's email or platform login does not yield the share — the attacker also has to compromise the contact's device and the contact's passphrase.

Same defense pattern we use for the user, applied to contacts.

### Out-of-band affirmation notifications to the contact through every channel
When a contact affirms a release, every notification channel registered for that contact lights up: "You just affirmed a release for [user]. If this wasn't you, click here to revoke immediately."

Revocation is instantaneous — the affirmation is removed from the ceremony, and the ceremony cannot complete without re-affirmation. The revocation window is 48 hours, during which the ceremony pauses.

### Contact-to-contact cross-notification
When contact A affirms, contact B (and all other contacts on the release ceremony) are notified: "Contact A has affirmed the release. Do you recognize this as expected?"

Any contact can flag the affirmation as suspicious, which moves the ceremony into REVIEW_REQUIRED.

### Diverse-role enforcement at affirmation, not just at enrollment
Diverse-role requirement is checked at the moment of affirmation, not just at enrollment. If at affirmation time both affirming contacts turn out to be personal (because the professional contact was removed or replaced without sufficient delay), the ceremony stalls.

### Contact-account sensitive-action delay
Contacts have their own sensitive-action delays. Changing a contact's notification channels, passphrase, registered device — all have a seven-day delay with out-of-band notification, just like the user's account. SIM-swap attackers cannot immediately use the new SIM to vote in a release ceremony; they have to survive a seven-day window during which the contact will likely discover the compromise.

### Hardware-bound device requirement for premium-tier contacts
For S3 release, contacts must be on devices that have completed a hardware-binding ceremony at enrollment. SIM-swap or password phishing alone is insufficient — attacker needs the contact's specific device.

For S2, hardware binding is recommended but not required (TOTP-on-a-separate-device fallback allowed). For S1, no hardware binding required.

### Release ceremony requires synchronous-ish participation
All affirming contacts must affirm within a 14-day window of the first affirmation, otherwise the ceremony resets. Prevents slow-burn attacks where the attacker compromises contacts one at a time over months.

## 5.4.6 Residual risk

Under Option 2 Shamir scheme (3-of-4 humans + temporal gate):

If an attacker simultaneously compromises two independently-roled contacts, including their devices and passphrases, and the user is genuinely inactive (or 5.5 false-inactivity is in play), and the contacts do not notice the affirmation notifications within 48 hours, **S1 release is reachable**.

Reaching S2 requires defeating both the contact shares AND the passphrase share (a separate cohabitant attack, threat 5.1).

Reaching S3 requires additionally defeating the hardware-key share or compromising a second independently-roled contact.

The outer-layer temporal gate further means even three compromised shares cannot release until the platform's cooldown completes without cancellation — the same window during which the legitimate user can detect and stop the attack.

**5.4 alone reaches S1 worst-case.** We accept this.

## 5.4.7 Crypto architecture implications

- Contact shares need their own KDF chain (contact passphrase + device key).
- The release ceremony protocol needs a notion of "affirmation revocation window" — affirmations are not committed to the ceremony until 48 hours after they are made. Ceremony has its own state machine with a "tentative" phase before "committed."
- Contact-to-contact cross-notification requires that each contact's identifier (email or push token routed through the server) is known to the server. That metadata is not zero-knowledge-protected and never was. The shares themselves remain zero-knowledge.

## 5.4.8 Notes on family-tier implications

The contact-side hardware-binding ceremony is friction. For founder/crypto-holder persona, this is fine — their contacts are also relatively sophisticated.

**For Phase 2 (families), this will need rethinking.** A non-technical grandmother as a contact cannot complete a hardware-binding ceremony unaided. Flag for V2.
