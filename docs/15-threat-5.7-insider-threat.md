# 15 — Threat 5.7: Insider Threat (Platform Employee)

A platform employee with operational access abuses it.

## 5.7.1 Description

An employee of the platform with operational access to infrastructure, code, or databases. The employee has decided to abuse their access, either acting alone, in collusion with an external party, or under coercion.

Subdivided by role per `06-threat-model-actors.md` section 3.4 (engineering, support, security/incident response).

## 5.7.2 Capabilities

- Infrastructure access
- Ability to query operational databases (read ciphertext, read metadata: account existence, login times, engine state transitions, audit logs)
- Ability to deploy code (potentially backdoored)
- Ability to read support tickets and user-reported information
- Ability to observe but not decrypt — because keys are not on the server, by the zero-knowledge design

## 5.7.3 What the insider cannot do, by architectural design

- **Decrypt vault contents.** Server holds ciphertext only. Per-item keys are derived from the user's passphrase and contact shares. None on the server in plaintext.
- **Forge audit log entries.** Log is signed with a key derived from the user's passphrase. The server can append entries (necessary for operation) but cannot create entries that verify under the user's verification key. A user returning to find a forged entry will discover the forgery because the signature won't verify.
- **Forge contact affirmations.** Affirmations are signed by the contact's own key, which is derived from the contact's passphrase plus device binding. The server routes affirmations but cannot manufacture them.
- **Release the outer-layer key prematurely.** Outer-layer release is gated by the engine's state machine, which is observable and signed. A user can verify, from any device, what state the engine is in and what cooldowns are pending. A malicious release would be visible in the state log.

## 5.7.4 Attack goals

- (a) Exfiltrate user data for sale or use
- (b) Target a specific high-value user for content access
- (c) Backdoor the platform code to weaken the zero-knowledge guarantee for future use
- (d) Comply with an unlawful internal directive to violate user trust

## 5.7.5 Attack paths

### Path A — bulk data exfiltration
Insider copies the database. Gets ciphertext, metadata, and audit logs. Without keys, the ciphertext is opaque. The metadata may have value (user identities, contact graphs, engine states) — this is a privacy harm but not a confidentiality breach of vault contents.

We treat metadata protection as a separate privacy posture, not part of the zero-knowledge guarantee.

### Path B — targeted access
Insider attempts to obtain a specific user's vault. They can read the user's ciphertext but cannot decrypt. They would need to additionally compromise the user's passphrase or contact shares, which they cannot do from a platform position alone. Collapses to either threat 5.1 or 5.4 with an insider as the external attacker — same defenses apply.

### Path C — code backdoor
Insider ships malicious code that, for example, weakens the KDF parameters for new users, sends the user's passphrase to a logging endpoint, or modifies the outer-layer release logic.

**This is the most dangerous insider path because it can defeat the cryptographic guarantees for users who enroll after the backdoor ships.**

### Path D — unlawful directive
Management or legal pressures the insider to violate user trust. The insider faces a choice between compliance and resistance.

The architecture should make compliance impossible where possible, so that the insider can honestly answer "the system does not permit this."

### Path E — key substitution (a DATA path, not a code path)

Added 2026-08-09, after an audit found it live in the shipped product. Paths A–D
were all this section had for four documents, and every one of them is about
code, infrastructure, or process. None of them is about the server serving
*different bytes than it was given*. That omission is why the gap survived in a
codebase otherwise disciplined about this exact class of problem: the checklist
had no line for it, so nobody checked.

**The path.** The server distributes contact public keys. The owner's client
seals release shares to whatever bytes it receives. An insider runs:

```sql
UPDATE contacts SET contact_x25519_pubkey = <a key we hold the secret for>
WHERE id = <target>;
```

The owner's client — genuine, published, reproducibly built, behaving exactly as
written — then seals the share to the insider's key.

**Why the possession proof does not stop it.** Enrolment challenges the contact
to sign an Ed25519 nonce and unseal an X25519 one. But the server *issues* that
challenge and *verifies* the response. It therefore proves that whoever
submitted the keys holds the matching secrets — for the keys the server chose to
challenge. It is a statement the server makes to itself. It carries no
information to the owner, who is the only party whose belief about "whose key is
this" matters.

**What it costs, by tier.** Worth stating precisely, because one tier holds:

| Tier | Scheme | Substitutions needed | Outcome |
|---|---|---|---|
| S1 | tier key sealed directly to one contact | **one** | The S1 tier key in plaintext. Total loss of the tier. |
| S2 | 2-of-3 Shamir over the tier key | **two** | The S2 tier key. Total loss of the tier. The release passphrase is a *fallback* share here, not a mandatory factor, so two contact shares reach the threshold alone. |
| S3 | nested: `K = shamirCombine(contact shares) XOR s3Mask(releaseShare)` | any number | **Holds.** The mask is Argon2id over the release passphrase, which never reaches the server. Contact shares alone reconstruct the masked value and fail `validateTierKeyCheck`. |

S3 survives because docs/24 made the passphrase a *mandatory* factor rather than
an alternative one. That was aimed at contact collusion; it closed this too. The
pattern is the general lesson — a factor the server structurally cannot hold
defends against every attack that runs through the server, including ones nobody
enumerated.

**Why the reproducible build does not help.** This is the part that makes Path E
worse than it first looks, and the reason it needs its own entry rather than a
footnote under Path C. `docs/BUILDING.md` and `/security/build` exist to counter
Path C: they let a user confirm the client they are running is the client we
published. Path E changes no code. **The bundle digest is unchanged.** A user who
diligently rebuilds the client and compares hashes gets a clean result while
their shares are sealed to someone else's key — which is worse than no assurance,
because it is false assurance delivered by the exact mechanism we point at when
we ask people to trust us.

**Mitigation (shipped 2026-08-09).** A safety number the owner and contact
compare over a channel we do not carry, and a pin that makes an unconfirmed or
changed key unusable:

1. Both parties see a 30-digit code derived from `BLAKE2b-256(lp(domain) ||
   lp(x25519) || lp(ed25519))`. The owner's screen computes it from what the
   server served; the contact's from keys their own master key derives. Both
   keys are covered, so a partial substitution — a genuine signing key paired
   with a swapped sealing key — moves the number too.
2. The owner's confirmation is pinned: the confirmed key bytes, sealed under
   their S1 tier key with AAD binding `(owner, contact)`. The server stores
   ciphertext for a key it does not hold, so it cannot forge a pin or move one
   between rows. It *can* delete one, which fails closed to "unverified" and
   blocks sealing.
3. Sealing takes a `VerifiedContactKey` token that only the pin check can mint
   (`apps/web/src/contacts/key-pin.ts`). The gate is in the type system, at
   every call site, rather than in a check somebody remembers to write — the
   original guard was `x25519Pubkey !== null` under a comment reading "never
   seal to an unverified key", and the distance between what it said and what it
   tested is the whole finding.

**Residual, stated honestly.** This mitigation has a human failure rate. An
owner who clicks "the codes match" without making the call has verified nothing,
and we cannot detect that. A contact reading the code back over a chat window the
server relays has verified nothing either — a server that can change one screen
can change the other. The copy on both screens says "by phone or in person" and
says why; that is the best a client can do. What the change buys is not
certainty. It is that the attack now requires deceiving two people who can talk
to each other, instead of one `UPDATE`.

Two further options were considered and not taken:

- *Have the contact sign their X25519 key with their Ed25519 key.* Redundant
  here. Enrolment already proves possession of both, and the safety number
  already covers both, so a consistent swap of the pair moves the number either
  way. It would add a second mechanism for something already closed.
- *Extend the S3 nested mask to S2.* This is the structural fix rather than the
  procedural one, and it needs no human to compare anything. It also makes the
  release passphrase **mandatory** for S2 recovery, which changes what happens
  when a user forgets it — a product decision about recoverability, not an
  engineering one. Left open deliberately; see docs/17.

## 5.7.6 Mitigations

### Zero-knowledge architecture
Primary defense against (a) and (b). Server cannot decrypt, and no individual employee can change this without shipping new code the user would have to accept on their client.

We document explicitly: the security guarantee is enforced by the math, not by trust in Anthropic-side staff.

### Mandatory code review and signed releases
All production code requires multi-person review. Production deployments are signed by multiple keys; no single employee can ship to production alone. Signing keys held by separate parties. Defends against (c).

### Reproducible builds and client-side code transparency
The client application (web and mobile) is built reproducibly, and build hashes are published. Users can, in principle, verify that the code running on their device matches the published source.

We do not expect typical users to verify this, but **the option to verify is what makes the guarantee real**. A backdoor shipped in the client would be visible to anyone checking.

### Separation of duties on infrastructure
Database access, code deployment, and key management are separated. No single role has all three.

Security incident response team can, during a confirmed incident, gain temporary expanded access, but every such expansion is logged, time-limited, and reviewed.

### Operational metadata minimization
Server logs what it needs to operate and no more. Login geography, engine states, signed audit-log hashes are necessary. Detailed user behavior, content metadata, and inferred preferences are not collected. Retention windows are short.

Compromise of the server yields less than it could.

### Warrant canary and transparency reporting
Periodically publish a statement that the platform has not received certain classes of legal demands or unlawful internal directives. Cessation of the canary is itself information.

We accept the costs of this practice.

### Whistleblower path
Internal mechanism for employees to report unlawful directives without going through management. Set up before the first incident, not after.

## 5.7.7 Residual risk

An insider with code-deployment capability, willing to subvert code review (through collusion with another reviewer, through compromise of review tools, or through working at a startup small enough that review is theatrical), can ship a backdoor that defeats zero-knowledge for future enrollments.

We accept this risk and mitigate it by:
1. Keeping the team small enough that everyone knows everyone, which makes collusion socially expensive
2. External security audits at major releases
3. Reproducible builds so motivated users can verify their client
4. Being transparent in marketing that no security architecture is stronger than its operational integrity

For users who consider this residual risk unacceptable, we document an "advanced mode" in which the user can verify build hashes manually before each client update. We do not expect most users to use this. We expect the security-paranoid subset of the founder/crypto-holder audience to appreciate that it exists.

## 5.7.8 Crypto architecture implications

The reproducible-build and code-signing requirements are operational, not cryptographic. The audit log signing scheme already provides forgery detection.

**The architectural principle to carry forward:** no server-side capability should depend on operator goodwill. If a feature requires the server to be trustworthy, the feature is wrong.

Path E was a live violation of that sentence, in this document, for the whole
period the sentence was in it. Contact key distribution was a server-side
capability that depended entirely on operator goodwill. Worth keeping as a
standing caution: a principle stated in a threat model does not audit the code.
The paths list is the thing that gets checked against implementations, so a
principle with no path under it is decoration. When adding a capability, ask
which path covers it — and if the honest answer is "none of them", that is the
finding.
