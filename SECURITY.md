# Security policy

Truecairn is a zero-knowledge digital continuity platform: owners encrypt
everything client-side, and the server stores only ciphertext, salts, public
keys, and sealed boxes. Findings that break that boundary — any way for the
server, a log line, a notification, or another user to see plaintext content
or secrets — are the highest-severity class of report.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability"). That channel reaches the
maintainers directly and keeps the report private while we fix it.

You can also email the security contact published in the app
(`security@truecairn.app`, see the in-app **/security/disclosure** page for
the full coordinated-disclosure policy). We aim to acknowledge reports within
3 business days.

Please:

- Give us a reasonable window to investigate and fix before any public
  disclosure.
- Do not access, modify, or destroy data that is not your own test data —
  create disposable accounts for testing.
- Never include real secrets (passphrases, recovery codes, vault content) in
  a report.

## Scope notes

- The threat model lives in `docs/04`–`docs/17` (with the consolidated public
  model + AI additions in `docs/THREAT-MODEL.md`); the crypto architecture in
  `docs/18`. Reports that identify a gap between those documents and the
  implementation are especially valuable.
- **Key distribution is owner-verified, not server-asserted.** The server tells
  a client which public keys belong to a contact, so on its own that is an
  assertion by the party best placed to lie about it (docs/15 Path E — a data
  path, invisible to reproducible builds, since no code changes). Owners compare
  a safety number with each contact out of band and the client pins it; sealing
  a release share requires a matching pin. Reports that find a path which seals
  key material to an *unpinned* or *changed* contact key, or that let the server
  forge or transplant a pin, are in scope and high value.
- The production guards in `apps/api/src/config.ts` and
  `packages/audit/src/keys.ts` (refusing ephemeral secrets) and the
  fail-closed release gates are intentional invariants — anything that lets
  a release advance below threshold or without diverse consensus is a bug.

## The mobile app (write-only capture)

The Flutter client at `apps/mobile` can **add** to a vault and can never read
one. It holds the owner's X25519 capture *public* key and no secret key material
at all: new items are sealed with `crypto_box_seal`, which destroys the ephemeral
secret it used, so the device cannot decrypt even the item it just sent. The
matching secret half is derived from the master key and only ever exists in a
browser. The design, and the threat-model delta for a device that can write, are
in `docs/34`.

Reports we would especially like here: any path by which the app could decrypt
something, persist plaintext (it keeps only `{sentAt, tier, kind,
attachmentCount}`), or produce a check-in from anything other than a deliberate
tap. Those three are pinned by `test/crypto/no_sealed_box_open_test.dart`,
`test/no_plaintext_receipt_test.dart` and
`test/no_passive_check_in_test.dart` / `test/no_capture_check_in_test.dart` — a
change that flips one of those is a bug, and a way to make one pass while the
property is false is a finding.

Note one deliberate, documented limitation rather than a vulnerability: a capture
that has not been **filed** on the web is sealed to a master-derived key that no
release ceremony reconstructs, so it does not participate in a release. Both
clients state this where the owner can see it.

## AI subsystem

The AI is **metadata-only and add-safety-only** — see `docs/AI.md`. Reports that
demonstrate the AI exceeding its documented authority are high severity:

- reaching vault content, a passphrase, a key, a share, or any field outside the
  `AI_CONTEXT_ALLOWLIST` (`apps/api/src/ai/context.ts`);
- emitting a **forward** engine event (anything other than the fail-closed
  `review_required`), advancing a ceremony, or skipping a gate;
- getting an unvalidated model output to reach an action (bypassing the
  deny-by-default output gate in `packages/ai-authority`);
- an `actor='ai'` audit row carrying a non-allowlisted event type.

## Voice channel & the deepfake-suppression attack (design-gated, no code yet)

A future voice verification channel (design: `docs/27-cv4-voice-design.md`)
would face a threat unique to voice: a **cloned voice saying "I'm fine"**. If
any voice response could count as a check-in, an adversary who controls or
answers the owner's phone could keep the vault sealed forever — a suppression
attack as damaging as a wrongful release. The ratified defence is
**evidence-not-authentication** (CV plan D4, already enforced for every CV
channel): a call outcome — answered, keypress, no-answer — is recorded as
provider-proven *evidence* in the Continuity Report and is never wired to a
check-in or any engine transition. Only an authenticated app check-in moves the
engine. Reports demonstrating any notification-channel response (voice or
otherwise) advancing or suppressing engine state are high severity.

> **Mailbox note (pre-launch):** `security@truecairn.app` must be a live, monitored
> inbox before this policy is advertised publicly.
