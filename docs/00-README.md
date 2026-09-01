# Continuity Platform — Design & Threat Model

This folder contains the complete design thinking for a Digital Continuity Platform, structured as separate documents for easier navigation, editing, and handoff to implementation tools.

## Reading order

1. **`01-decisions-locked.md`** — The three foundational decisions (persona, trust model, Shamir scheme). Read first; everything else depends on these.
2. **`02-state-machine.md`** — The continuity engine's state diagram, all nine states and transitions.
3. **`03-release-policy-matrix.md`** — Which vault categories release to which contact types at which stage.
4. **`04-threat-model-scope-and-trust.md`** — Sections 1 and 4 of the threat model: what's in scope and what we trust.
5. **`05-threat-model-assets.md`** — Section 2 of the threat model: tiered classification of what we protect.
6. **`06-threat-model-actors.md`** — Section 3 of the threat model: who can act on the system.
7. **`07-threat-5.1-malicious-contact.md`** — The flagship threat: malicious trusted contact.
8. **`08-threat-5.1-attack-tree.md`** — Visual attack tree for threat 5.1.
9. **`09-anti-cohabitant-decision.md`** — The verification factor design decision.
10. **`10-threat-5.2-account-compromise.md`** — Attacker has the user's session.
11. **`11-threat-5.3-notification-failure.md`** — Environmental: notifications fail silently.
12. **`12-threat-5.4-contact-compromise.md`** — Attacker has a contact's account.
13. **`13-threat-5.5-false-inactivity.md`** — User is just traveling.
14. **`14-threat-5.6-collusion.md`** — Two contacts conspire.
15. **`15-threat-5.7-insider-threat.md`** — A platform employee goes rogue.
16. **`16-threat-5.8-legal-coercion.md`** — Subpoenas and state actors.
17. **`17-residual-risk.md`** — The honest accounting of what we don't guarantee.
18. **`18-crypto-architecture.md`** — The cryptographic spec for implementation.
19. **`19-implementation-handoff.md`** — Build order and next steps.

Later documents (added as the build progressed; not part of the original
handoff bundle):

- **`20`–`22`** — server-side credential storage, the environment-variable
  contract, and the API route inventory.
- **`24`** — the collusion-threshold decision (the nested, passphrase-mandatory S3).
- **`25`** — the AI Guardian plan (public summary in `AI.md`, ops in `RUNBOOK-AI.md`).
- **`26`** — Continuity Verification.
- **`28`** — billing.

## Documents that are not in this mirror

This repository is a curated export. The documents below are operational,
pre-decisional, or about work that has not shipped, and none of them is
load-bearing for a claim made on Truecairn's public pages. Publishing them would
hand a reader an operations map rather than a security argument.

**Other documents here still cite them by number. Those citations are accurate —
the files simply live elsewhere, and a dangling reference is deliberate rather
than a broken link.**

- **`19`** — the implementation handoff: build order and working plan.
- **`23`** — the deployment topology, services and redeploy mechanics.
- **`27`** — the design-gated CV-4 voice channel, including a vendor cost model.
  No code exists and nothing public claims voice does.
- **`29`** — the human rehearsal protocol for the release path.
- **`30`** — the scoping packet for a third-party security audit, including a
  prioritised known-weaknesses table. No audit has been commissioned; `/security`
  says so publicly and that stays true until one has.
- **`31`** — an engineering brief for counsel on an undecided jurisdiction. Not
  legal advice, not written by a lawyer.
- **`32`**, **`34`**, **`35`** — the Flutter client, write-only vault capture and
  mobile passkey sign-in. Undistributed; `apps/mobile` is not in this mirror either.
- **`33`** — domain and edge configuration as actually performed.
- **`36`**–**`38`** — AI activation QA, operator continuity, and the release
  readiness gate table.
- **`39`**–**`40`** — device-cloud testing, carrier provisioning, i18n planning.
- **`41`** — the manifest governing what appears in this mirror.
- **`history/`** — snapshots of past internal audits.
- **`PROGRESS.md`** — the append-only build log. Referenced throughout `25`, `26`
  and `AI.md` as the place sign-off is recorded.

If you think something excluded here **is** load-bearing for a public claim, that
is a finding — please report it (`SECURITY.md`).

## Status

This is v0 of the design. All decisions in `01-decisions-locked.md` are committed but reversible. Threats are written against the locked decisions; changing a decision requires re-reading the affected threats.
