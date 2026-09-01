# 10 — Threat 5.2: Account Compromise

Attacker has the user's authenticated session but not their passphrase or shares.

## 5.2.1 Description

An attacker has gained authenticated access to the user's platform account during the Active state. They have the user's primary credential (passkey, password, or session token) but do not have the release-only passphrase paper, do not hold any Shamir share, and are not a registered trusted contact.

May have arrived via phishing, credential stuffing, malware on the user's device, or session hijack.

## 5.2.2 Capabilities

While authenticated as the user, the attacker can attempt to:
- Modify trusted contact list (add their own, remove legitimate ones)
- Modify inactivity threshold and check-in cadence
- Modify release policy matrix (move items between tiers)
- Modify the release-only passphrase (rotate to one the attacker knows)
- Trigger a manual release ceremony
- Exfiltrate ciphertext (useless without keys, but reveals metadata)

**Critical:** the attacker cannot directly decrypt vault contents from a compromised session because per-item encryption keys are derived from a master key wrapped by a passphrase-derived key, not the login credential. The login credential gets you into the dashboard but not into the plaintext.

## 5.2.3 Attack paths

### Path A — reconfiguration
1. Gain authenticated session.
2. Add attacker-controlled contact assigned to S2 or S3 with a Shamir share.
3. Remove or demote legitimate contacts.
4. Lower the inactivity threshold to minimum.
5. Disable the user's notification channels.
6. Wait for inactivity timer.
7. Receive release.

### Path B — passphrase rotation + manual release
1. Gain authenticated session.
2. Rotate release-only passphrase via reset flow.
3. Wait out the sensitive-action delay.
4. Trigger manual release with new passphrase and attacker-controlled contacts.

## 5.2.4 Attack tree (abbreviated)

For path A: gain session AND modify contacts without sensitive-action delay AND modify inactivity threshold without sensitive-action delay AND suppress out-of-band notification of changes AND survive the cancel window once inactivity fires.

For path B: gain session AND rotate passphrase without out-of-band notification AND survive sensitive-action delay AND trigger manual release AND control enough Shamir shares to reconstruct (which requires also compromising trusted contacts, putting them on threat 5.4).

## 5.2.5 Mitigations

### Sensitive-action delay on all engine-critical changes
Adding/removing contacts, changing contact tier assignment, lowering inactivity threshold, rotating the release-only passphrase, removing a notification channel — all of these are "sensitive actions" that take effect only after a seven-day delay during which the user receives out-of-band notifications through every registered channel, **including channels the attacker just tried to remove** (we send the "channel removal pending" notice to the channel being removed, before honoring the removal).

This single mitigation kills both path A and path B because the attacker cannot move fast enough to release before the user notices.

### Hardware-bound re-authentication for engine-critical changes
For premium users with a hardware key, sensitive actions require a hardware-key tap, not just session authentication. A session hijack alone is insufficient — the attacker also needs the physical key.

For free-tier users without hardware keys, we require re-entry of the login credential plus a TOTP code from a separate registered device.

### Out-of-band notification to all historical channels
When a sensitive action is initiated, we notify every channel the user has ever registered, not just current ones, for ninety days after deregistration. This blocks the attack pattern of "remove the user's real phone, add my own, then start the timer."

### Tamper-evident audit log visible in the dashboard
User, on returning, sees a hash-chained audit log of all sensitive actions. Log is signed with a key derived from the user's passphrase, so the server cannot forge entries. Every sensitive-action pending state is shown prominently with one-click cancel-and-revert.

### Anomaly detection on session geography and device fingerprint
Not a primary defense, but a notification trigger: a new device or country logging in raises a "verify this was you" notification through all channels.

### Notification of release-only passphrase rotation cannot be suppressed
Passphrase rotation flow notifies all registered channels AND all trusted contacts of the pending rotation. The attacker cannot remove contacts to suppress this notification because contact removals are themselves sensitive actions with their own delay and notifications.

This creates a notification graph the attacker cannot prune fast enough.

## 5.2.6 Residual risk

If the attacker compromises the account AND the user is genuinely unreachable for the entire seven-day sensitive-action delay (vacation off-grid, hospitalization, simultaneous compromise of all notification channels), the attacker can reconfigure the engine.

However, even in this worst case, the attacker still needs to defeat the Shamir threshold — they have a session, they have reconfigured contacts, but they still don't have three shares unless they also compromise the contacts (threat 5.4) and the release-only passphrase (which requires the physical paper).

**5.2 alone is insufficient to reach S3.** 5.2 can reach S1 in the worst case, which we accept by design.

## 5.2.7 Crypto architecture implications

- The release-only passphrase must derive a Shamir share, not just authenticate a session. Rotation of the passphrase invalidates the share — any release ceremony in progress using the old share fails. Good.
- Audit log signing key derived from passphrase, not stored server-side, so the server cannot forge entries even if compromised. Good.
- Sensitive-action delay implemented as server-side state with publicly-readable "pending actions" endpoint that the client polls — a compromised server cannot silently skip the delay because the client and user's other devices can independently verify it is being honored.
