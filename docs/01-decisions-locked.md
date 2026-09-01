# 01 — Locked Decisions

Three decisions that every other document depends on. Each is committed but reversible — changing one requires re-reading the affected threats and updating the crypto architecture.

## Decision 1: Persona-zero

**Founder + crypto holder professional.**

Phase 1 users are freelancers, founders, creators, remote workers, developers, and crypto holders. Phase 2 brings in families. Phase 3 brings in small businesses.

The reasoning: this audience *tolerates* security friction. They will accept writing a passphrase on paper and storing it offsite. They will accept a seven-day delay on resetting a trusted contact. A family-first persona would churn on that friction and force a weaker security model.

Starting with founders and crypto holders means the security model gets to be as strong as it needs to be. Phase 2 inherits a battle-tested engine that we soften the UX around, rather than retrofitting security onto a permissive base.

### Default S3 contents for this persona

- Crypto seed phrases
- Hardware wallet recovery sheets
- Business handover playbooks
- "If I'm gone, here is how the company keeps running" document

### Default S2 contents

- Operational credentials
- Infrastructure access
- Sensitive legal documents

### Default S1 contents

- Contact lists
- Subscription cancellations
- "Please tell these people I'm gone" notification list

## Decision 2: Trust model

**True zero-knowledge, with explicit recovery tradeoffs.**

The server holds ciphertext and metadata only. It never sees plaintext vault contents, never sees the release-only passphrase, never holds keys that can decrypt anything on its own.

This is the only trust model that matches the audience. A crypto founder will immediately ask "what happens if you get subpoenaed?" and the answer has to be "we hand over ciphertext we cannot decrypt."

### Hard consequences we accept

- **No server-side search** of vault contents. Client-side encrypted search indices can be added later if needed.
- **No "I forgot my passphrase" reset flow** for the release-only passphrase. Recoverable only via the user's own backup of the paper.
- **Memory Archive future messages** get restructured. They work, but delivered as encrypted blobs that the recipient's key unwraps at a scheduled time. Server routes ciphertext, doesn't read it.

## Decision 3: Shamir scheme for release

**S3: passphrase-MANDATORY nested scheme — the release passphrase AND any 2 of 3 trusted contacts — with a separate temporal gate held by the platform.** (Implemented per docs/24; supersedes the original flat 3-of-4.)

The release passphrase's Argon2id evaluation is a one-time-pad **mask** over the S3 tier key, and three trusted contacts hold a **2-of-3 Shamir split of the *masked* key**:

1. Personal trusted contact (spouse, sibling, adult child, etc.)
2. Professional trusted contact (lawyer, cofounder, accountant, etc.)
3. Recovery / second diverse-role contact

plus the **release-only passphrase** (Argon2id-derived from the paper) as the mandatory mask — NOT a counted contact share.

Reconstruction requires any **two** of the three contact shares (which recover only the masked secret) **AND** the release passphrase (the mask) to recover the tier key. "Lose any one contact" still holds. Independent of this, the ciphertext is wrapped in an **outer encryption layer** whose key is held server-side and released only after the cooldown ladder completes and no cancel signal arrives.

### What this defends

Colluding trusted contacts — even all three — recover only the masked secret and **cannot** reach the S3 tier key without the owner's offline release passphrase. The anti-collusion guarantee is cryptographic (the mandatory mask), not a procedural deterrent. The platform's role is "I gate when the ceremony can run," not "I contribute a share." (A hardware-key share factor remains a future option — docs/24 Option 4 — and is not yet wired.)

### For S2 release

**2-of-3 among human/knowledge factors** (any contact + passphrase + hardware-key-or-second-contact), same outer-layer temporal gate.

**Collusion trade-off (accepted — docs/24, Option A).** In the shipped all-contacts configuration, two **diverse-role** S2 contacts can reconstruct S2 without the release passphrase. We accept this for S2 — the less-catastrophic tier, where recoverability matters more. **S3** closes this gap cryptographically via the nested, passphrase-mandatory scheme (docs/24); S2 relies on the procedural defenses (diverse-role, cross-contact notification, signed audit log, anomaly detection, cooldown ladder).

### For S1 release

Any one contact's affirmation plus the outer-layer key. S1 stays soft by design — recovery instructions and operational continuity items should be reachable.

### What this costs us

**If the user loses the passphrase paper AND is unreachable, the S3 vault is genuinely unrecoverable** — the passphrase is S3's mandatory mask. **S2 survives passphrase loss** (its 2 diverse-role contacts reconstruct without it; only the +1 fallback is lost). No "contact support" path for S3. We say this loudly at onboarding and require the user to confirm understanding twice — at enrollment and again seven days later — before the engine arms.

**At release time the surviving contacts have to coordinate.** If the spouse and the lawyer hate each other, release is harder. We mitigate with a release-orchestration flow in the app, but coordination friction is real and is the cost of resisting collusion.

**The platform is a load-bearing party in the release ceremony.** If the platform goes out of business, S2 and S3 release breaks. We commit to an open-source escape hatch — the worker code that holds and releases the outer-layer key is open-source, and the encrypted outer-layer keys are exportable to the user so a successor party can run the release if the platform is gone.

## Open decisions

These are not yet locked and should be made before launch:

- **Jurisdiction.** Switzerland, Iceland, Estonia, or other. Affects ToS, legal posture, and marketing claims. **Blocks most other legal work — see `docs/31-legal-readiness.md`**, which collects the engineering-side input and the product-specific questions for counsel (release-on-silence vs. proof of death, succession-law collision, erasure vs. the append-only audit chain).
- **Hardware-key vendor support.** YubiKey is the obvious default; whether to support others at launch.
- **Premium-tier pricing.** Affects which features (scheduled absence beyond N days, hardware-key support, designated verifier in V2) are gated.
- **Anti-cohabitant verification.** The release-only passphrase is mandatory; hardware key is opt-in premium. This is the working assumption but worth revisiting after user research.
