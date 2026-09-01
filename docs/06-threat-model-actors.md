# 06 — Threat Model: Actors

This corresponds to section 3 of the threat model document.

## 3.1 What we mean by "actor"

An actor is any entity that can interact with the platform, intentionally or otherwise, in ways that affect the engine's state or the assets it protects.

Actors include people, automated systems, and abstract entities (the legal system, the cryptographic adversary). Each has a set of capabilities, legitimate interests, and ways they could harm the system.

"The attacker" is not a single actor — it is several distinct adversaries with different capabilities and motivations.

## 3.2 The user

The primary actor. Broadest legitimate access and the broadest ability to misconfigure.

**Capabilities:**
- Full read and write to their own vault during Active state.
- Configuration of trigger settings, contact roster, and release policy customizations (each subject to sensitive-action delays).
- Cancellation of any in-progress engine workflow from any verified device.
- Manual triggering of release on themselves.

**Concerns:**
- The user can lock themselves out by configuring overly aggressive triggers or losing all enrolled devices.
- The user can endanger themselves by choosing untrustworthy contacts; the platform cannot evaluate this choice.
- The user can be coerced into configuration changes. Cooldowns on sensitive actions are partly a defense against coercion.

The platform must remain safe even when the user makes mistakes, but cannot remain safe against a user actively self-sabotaging or under sustained coercion.

## 3.3 The trusted contacts

Each contact is a distinct actor with role-specific capabilities. See `03-release-policy-matrix.md` for role definitions.

**Capabilities common to all roles:**
- Receive notifications during inactivity escalation.
- Respond to verification challenges during release review.
- Eventually decrypt and access content scoped to their role and stage.

**Capabilities NO contact role has:**
- Modify trigger settings on the user's behalf.
- Modify the release policy matrix.
- Add, remove, or re-scope other contacts.
- Override the cooldown timer.
- Cancel an in-progress workflow on behalf of the user. Only the user can cancel.

**Concerns:**
- A contact's intentions can change over the years between enrollment and release.
- A contact's account or device can be compromised independent of the contact's own integrity.
- A contact may collude with another contact to falsify the conditions for release.
- A contact may simply be unreachable when release-time verification is required.

The platform treats every contact as potentially adversarial in the architectural sense (the system must remain safe if any single contact is hostile) while treating contacts as legitimately trusted in the operational sense.

## 3.4 The platform operators

Anthropic-side staff with infrastructure access.

- **Engineering:** can deploy code, query operational databases, observe metrics. Cannot decrypt user content. Can read metadata: account existence, login times, engine state transitions, audit logs.
- **Support:** can read user-reported information and operational metadata. Cannot decrypt user content.
- **Security / incident response:** during a confirmed incident, may have temporary expanded access for forensic purposes. Every expansion is logged, reviewed, and time-limited.

**Concerns:**
- An individual operator could go rogue or be compromised.
- Operators are subject to legal compulsion.
- Operators can observe metadata that, in aggregate, reveals information about users.

## 3.5 The attacker, in flavors

"The attacker" is not one actor. Different flavors have different capabilities, motivations, and mitigations.

### 3.5.1 The opportunistic external attacker
Generic remote adversary scanning for compromised credentials. No specific knowledge of the target.
- Defended by standard application security plus authentication hygiene.

### 3.5.2 The targeted external attacker
Remote adversary with specific knowledge of the user or assets. May know the user holds significant crypto, runs a particular business, or has been involved in a public dispute.
- Defended by multi-factor authentication, sensitive-action delays, multi-contact consensus, and the fact that the platform never holds the keys.

### 3.5.3 The malicious insider (contact)
A trusted contact who has decided to harm the user — separating spouse, disgruntled cofounder, impatient heir. Has legitimate role-based access to some platform information but is attempting to gain more.

**This is the most consequential adversary in V1. Most real-world wrongful-release events will come from this flavor.**

Defended by: never granting any single contact authority over release, cancel-from-any-device, multi-channel notifications, sensitive-action delays on settings changes, identity re-verification at release time.

### 3.5.4 The malicious insider (operator)
Platform employee who has decided to abuse access. Less likely than contact insider but with potentially broader impact.

Defended by: client-side encryption (so they cannot decrypt user content even with full DB access), code review and access logs, separation of duties.

### 3.5.5 The colluding pair
Two or more actors working together to defeat a single-actor mitigation. Most commonly two contacts colluding to fake the user's death.

Defended by: diverse-role consensus (two spouses cannot consent; a spouse plus a lawyer can), audit trails, multi-channel verification.

### 3.5.6 The state-level adversary
Government, intelligence service, or similarly resourced entity with legal authority or technical capability to compel disclosure.

Defended by: client-side encryption (platform cannot comply technically), transparency reports, warrant canary if applicable.

Out of scope for active mitigation in V1 beyond architectural ones. The platform is not designed to resist a determined state actor; it is designed to ensure that compliance with a lawful order does not, by itself, produce plaintext.

## 3.6 The legal system

Not an attacker in the adversarial sense, but an actor with power to compel.

**Capabilities:**
- Subpoena platform metadata.
- Order account preservation, suspension, or transfer.
- Adjudicate inheritance disputes the platform may have anticipated incorrectly.

**Platform's posture:** comply with lawful orders for metadata; technically incapable of complying with orders for plaintext above Tier D; document inheritance-related design decisions in ToS.

## 3.7 The notification providers

Third-party services (email, SMS, push) that the platform depends on. Not adversarial but failure-prone.

Treated as untrusted channels for confidentiality (no sensitive content sent over notification channels — only "open the app") but trusted as best-effort delivery mechanisms with redundancy.

## 3.8 Mapping actors to capabilities

| Actor | Read encrypted content | Read metadata | Modify engine state | Cancel workflow |
|---|---|---|---|---|
| User | Yes, their own | Yes, their own | Yes, with delays on sensitive actions | Yes, from any verified device |
| Contact (any role) | Only after their stage releases | Limited, role-scoped | No | No |
| Operator (engineering) | No | Yes, operational metadata | Yes, via deploys; logged | No |
| Operator (support) | No | Limited, ticket-scoped | No direct | No |
| External attacker | No, if controls hold | No, if controls hold | No, if controls hold | No |
| Insider contact | Their stage only | Their role scope | No | No |
| State actor (lawful) | No, architecturally | Yes, on order | No | No |

This table is the contract the architecture must enforce. Every threat is an attempt to violate one cell.
