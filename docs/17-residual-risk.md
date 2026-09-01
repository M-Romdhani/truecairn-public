# 17 — Residual Risk: The Honest Accounting

The explicit "what we have chosen not to fix and why" section. Lives at the end of the threat model. Read by three audiences: users at enrollment, engineers during implementation, courts during disputes.

## What we guarantee

### Confidentiality of S2 and S3 vault contents against the server
No platform operator, no infrastructure compromise, no legal order to the platform can produce plaintext of S2 or S3 contents. Enforced by client-side encryption with keys the server does not possess.

**Scope note added 2026-08-09.** This guarantee depends on the release shares
having been sealed to the *right people's* keys, which until 2026-08-09 the
product did not check — the server distributed contact public keys and the
client sealed to whatever it received (docs/15 Path E). One row update gave up
S1; two gave up S2. S3 held, because its release-passphrase mask is a factor the
server structurally cannot hold. The gap is closed by owner-confirmed safety
numbers and key pinning, with the residual recorded below.

### Detection of forgery in the audit log
The user can verify that audit log entries are authentic. A server that fabricates entries will produce signatures that do not verify.

### Multiple independent failure paths before any release
No single party can release vault contents. Releasing S2 requires defeating two independent factors plus surviving the temporal gate. Releasing S3 requires three independent factors plus the temporal gate. The user has cancel opportunities throughout.

### Cancel-from-any-verified-device with one tap
A legitimate user, on returning, can stop any in-flight release with a single action from any device that has ever been verified.

### Open-source escape hatch
If the platform disappears, the user's data remains decryptable by the legitimate parties (the user, the contacts, the passphrase paper) using publicly-available code.

## What we explicitly do NOT guarantee

### We do not guarantee that you will not lose your data
If you lose your passphrase paper and you become unreachable, S2 and S3 are unrecoverable. We will not help you recover them because we cannot. We will say this twice at enrollment and we will require explicit acknowledgment.

### We do not guarantee that your contacts will be available when needed
If your designated contacts die, become incapacitated, refuse to participate, or simply do not respond, your release ceremony stalls. We mitigate by encouraging you to maintain more contacts than the threshold requires, but we cannot make your contacts cooperate.

### We do not guarantee defense against rubber-hose attacks
If you or your contacts are compelled by physical violence or imprisonment to produce passphrases or shares, the platform cannot help. No cryptographic system can defend against the keyholder being coerced.

### We do not guarantee privacy of metadata
We log what we need to operate: account existence, login times, engine states, signed audit entries, payment information. This metadata is subject to lawful orders and may be compromised by infrastructure attacks. We minimize what we collect and retain, but we collect some, and what we collect is not zero-knowledge protected.

### We do not guarantee defense against state-level adversaries operating against you personally
A determined nation-state with subpoena power against you, your contacts, your service providers, and the platform simultaneously can defeat the platform's defenses by attacking multiple participants at once. The platform raises the cost of such an attack but does not make it impossible.

### We do not guarantee defense against a backdoored client
If a future version of the platform's client code is compelled or compromised, users who install that version are exposed. We mitigate by reproducible builds and signed releases, but verifying these requires user effort that most users will not undertake.

### We do not guarantee against user error in storing the passphrase paper
If you store the passphrase paper in your home, your cohabiting attacker can find it. If you store it in your safe deposit box, it is recoverable but slow. **The platform sells you the option of strong storage; the user must execute on it.**

### We do not guarantee against legitimate-but-rare false releases
S1 release can occur if the user is genuinely unreachable, all notification channels fail, and contacts affirm without verifying. We have made S1 the soft tier deliberately. S2 and S3 false release is architecturally difficult but not impossible at the boundary of multiple simultaneous failures.

This risk was knowingly *increased slightly* on 2026-07-25, and the trade is worth
stating plainly. Previously, total notification failure stalled the engine forever
— which removed this false-release path entirely and replaced it with a worse one:
because channel failure is correlated with the owner's death (bouncing mailbox,
recycled number, expired push subscriptions), the product would have silently
failed to release at all in exactly the case it exists for, with nobody alive to
notice. The stall is now bounded (`notification_stall_max_days`, default 30) and
resumes at ESCALATION_PENDING. We accept a marginally larger false-release surface
in exchange for removing a guaranteed false-NON-release. The consensus ceremony —
diverse, above-threshold, disputable — remains the actual gate in both cases.

### We do not guarantee that you actually compared the safety number
Sealing a release share to a contact requires you to confirm their security code
first, out of band. We cannot tell whether you did. A client can show you the
digits, tell you to use a phone call, refuse to proceed until you say they
matched, and pin the answer so an unannounced change later becomes an alarm —
all of which we do. It cannot know whether the call happened.

If you click "the codes match" without checking, you get the protection you had
before the feature existed: none against a server that substituted the key. And
if you compare the code over email or a chat app, you get nothing either, because
whoever can change what one screen shows you can change the other.

Two honest consequences follow. **For S1 and S2, your diligence is load-bearing**
— those tiers reach their threshold from contact keys alone, so a substituted key
that you waved through is sufficient to open them. **For S3 it is not**: the
nested release-passphrase mask (docs/24) is a factor the server cannot hold, so
S3 survives a substitution you failed to catch. That asymmetry is real and we
would rather state it than let the security-code screen imply all three tiers now
rest on the same footing.

We are considering extending the mandatory-passphrase construction to S2, which
would remove the dependence on human comparison there as well. It is not free:
it makes the release passphrase mandatory for S2 recovery, so forgetting it stops
being survivable. That is a decision about which failure we prefer, and we have
not made it yet.

### We do not provide legal authority for inheritance
The platform is a release mechanism, not a legal instrument. We deliver vault contents to designated contacts. Whether those contacts then have legal authority over the user's estate, business, or accounts is a matter for the underlying legal systems. **Pair us with a proper estate plan.**

### We do not guarantee operational continuity of the platform itself
We may go out of business. We may be acquired and acquired badly. We may make decisions that harm users. The open-source escape hatch is your protection. We commit to maintaining it for the life of the platform.

## What this list is for

This document is read by three audiences:

1. **The user, at enrollment** — who needs to decide whether to trust the platform with their continuity needs.
2. **The engineer, during implementation** — who needs to know which features are architectural commitments and which are best-effort.
3. **The court, during a dispute** — who needs to understand what the platform claimed to do and what it explicitly did not claim to do.

For all three audiences, the principle is the same: we say plainly what we do and what we do not.

Users who want a service that promises more should choose a different service. Users who can live with these explicit boundaries get a platform whose claims they can actually rely on.
