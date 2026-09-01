# 16 — Threat 5.8: Legal and State-Actor Coercion

Subpoenas, warrants, state actors. The threat the zero-knowledge guarantee most directly addresses.

## 5.8.1 Description

A government, intelligence service, court, regulator, or similarly resourced entity with legal authority to compel platform action. Includes:
- Domestic law enforcement with subpoenas or warrants
- Foreign governments demanding data on their citizens or political opponents
- Regulatory bodies enforcing data-localization or backdoor mandates
- Hybrid actors using legal process as cover for intelligence operations

**The founder/crypto-holder audience will ask about this on the first day.** The answer has to be defensible.

## 5.8.2 Capabilities

- Subpoena power for metadata
- Warrants for content (which return ciphertext only)
- Gag orders preventing the platform from notifying the user
- National Security Letters or equivalent that compel disclosure without judicial review
- The ability to compel platform operators directly, including imprisonment of non-compliant operators in jurisdictions where this is legal
- The ability to compel hardware or service providers in the platform's supply chain (cloud providers, CDN, payment processors)

## 5.8.3 What the state actor can obtain by lawful order

- **Metadata:** account existence, registration date, registered country, payment information, login times, IP addresses, engine state transitions (in metadata form). All logged for operational reasons and we will hand it over when legally required.
- **Ciphertext:** the encrypted vault contents. We hand this over when legally required.
- **Audit logs:** in their signed form.
- **Communication metadata:** who notified whom, when.

## 5.8.4 What the state actor cannot obtain by lawful order

- **Vault plaintext.** The platform does not have it. We cannot produce what we do not possess. A court can order us to produce plaintext; we can demonstrate, technically, that we are incapable of compliance.
- **The user's passphrase.** The platform never sees it.
- **Contact shares in usable form.** The platform never sees them in unwrapped form.
- **The outer-layer key in the absence of legitimate engine state.** The outer-layer key is held server-side, but it is only meaningful in combination with the human-factor shares. Producing the outer-layer key to a state actor without the corresponding shares yields nothing.

## 5.8.5 Attack paths

### Specific user surveillance
Lawful order to the platform for ciphertext and metadata. Platform complies with what it has. State actor receives ciphertext they cannot decrypt and metadata that may have intelligence value.

### Coercion of decryption
State actor orders platform to weaken the zero-knowledge architecture, ship a backdoor, or hand over a master key. Collapses to threat 5.7 (insider threat with state-level pressure). Defenses are the same: reproducible builds, multi-party code signing, transparency reports.

### Coercion of the user directly
State actor compels the user to produce their passphrase under threat of imprisonment or violence. **Outside the platform's threat model** — no software architecture can defend against rubber-hose attacks on the keyholder. We document this explicitly.

### Coercion of contacts directly
State actor compels contacts to affirm a release and contribute their shares. Same as user coercion — outside the platform's threat model.

### Mandated key escrow
A jurisdiction passes a law requiring the platform to hold keys in escrow for government access. Per the architecture, the platform does not have decryptable keys to escrow. Compliance with such a law would require rebuilding the platform's architecture, which is detectable by users and which we commit publicly not to do.

**If we are legally compelled to do so, the platform leaves that jurisdiction.**

## 5.8.6 Mitigations

### Zero-knowledge architecture
Primary defense. We cannot be compelled to produce what we do not possess.

### Jurisdictional choice
Initial incorporation in a jurisdiction with strong protections for cryptographic services and limited backdoor mandates. We document our jurisdiction and the legal protections it provides. We commit to leaving jurisdictions that mandate cryptographic backdoors.

**Decision pending** — see `01-decisions-locked.md` open decisions section.

### Transparency reporting
Periodic public reports on the volume and nature of legal demands received, to the extent legally permissible. Where gag orders prevent reporting on specific demands, the transparency report's structure (e.g., a warrant canary) provides indirect signal.

### User notification of legal demands where permitted
When we receive a lawful demand for a user's data, and we are not prohibited from notifying the user, we notify the user. This gives the user the opportunity to seek legal counsel and contest the demand.

### Open-source escape hatch
The release-ceremony worker code is open-source. If we are compelled to shut down the platform, the user's encrypted data and the procedure for completing a release can continue without us. The platform's survival is not a single point of failure for the user's continuity guarantee.

### Documentation of incapacity
Clear, public documentation of what we can and cannot produce under legal order. Serves three functions:
1. Informs users at enrollment
2. Informs courts evaluating orders against us
3. Informs employees of their own legal exposure if they are asked to do something the architecture does not permit

## 5.8.7 Residual risk

A sufficiently powerful state actor can:

1. Compel us to log new user enrollments in a way that captures their passphrases or shares going forward, requiring us to ship malicious client code that users would have to detect through reproducible builds.
2. Compel us to hand over all metadata we possess, which has intelligence value.
3. Compel us to leave a jurisdiction or shut down, which harms users without violating their data confidentiality.
4. Compel users or contacts directly through their own legal exposure or coercion, which is outside our architectural defense.

We accept all of these as residual risks and document them.

**The platform is not a defense against a determined state actor operating against the user personally.** The platform IS a defense against bulk surveillance, against routine subpoenas, against state-actor fishing expeditions, and against most plausible legal-process attacks.

We will say this plainly.

## 5.8.8 Crypto architecture implications

The architecture is what it is. The legal exposure shapes how we operate the architecture (jurisdictional choices, transparency practices, escape hatches) more than how we build it.
