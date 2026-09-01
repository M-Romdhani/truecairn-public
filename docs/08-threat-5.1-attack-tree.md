# 08 — Attack Tree for Threat 5.1

Visual decomposition of how a malicious contact reaches each release stage, and which mitigations block each branch.

## How to read this

**Root goal:** Attacker (malicious trusted contact) achieves wrongful release of vault contents.

The tree reads top-down. Each node is a sub-goal the attacker must achieve. Branches are alternative ways to achieve that goal. The deeper the tree, the more conditions must hold simultaneously. Mitigations attach to specific nodes — if the mitigation works, that node is blocked, and any path requiring it is dead.

## Tree structure

```
ROOT: Wrongful release achieved
│
├── Reach S1 release (Recovery, ops, inventory)
│   └── Suppress user response for 14 days, all channels
│       ├── User unreachable (travel, retreat, hospital)
│       │   └── Mitigation: scheduled absence feature
│       └── Block channels (email, SMS, devices)
│           ├── Mitigation: redundant channels
│           └── Mitigation: physical recovery code
│
├── Reach S2 release (Identity, financial, legal)
│   └── All S1 conditions PLUS
│       └── Pass verification at release review
│           ├── Pass identity challenge as the contact
│           └── Defeat anti-cohabitant factor
│               └── Mitigation: release-only passphrase (offsite)
│
└── Reach S3 release (Crypto, personal archive)
    └── All S2 conditions PLUS
        └── Second contact consents
            ├── Recruit accomplice from different role
            │   └── Mitigation: diverse-role consensus
            └── Wait 21 days (no mitigation needed; time favors user)
```

## What this reveals

### The S1 branch is the thinnest defense
Only two real mitigations stand between an attacker and S1 contents (scheduled absence, redundant channels). S1 wrongful releases will happen. The architecture deliberately accepts this — S1 contents are the least catastrophic — but S1 is the soft spot.

### The anti-cohabitant factor is the single most important node
It sits on the critical path to S2 and S3. If weak, the upper structure collapses. If strong, S2 and S3 become genuinely hard to reach.

This is why `09-anti-cohabitant-decision.md` exists as its own document.

### Diverse-role consensus is on the critical path to S3 only
Doesn't need to be perfect — even moderately effective consensus, combined with everything stacked beneath it, makes S3 wrongful release impractical.

### No mitigation directly on the "wait 21 days" node
Waiting is the attacker's problem, not yours. Time, paradoxically, is on the user's side here — the longer the attack takes, the more chances the user has to detect it through audit logs, notifications, or other contacts noticing.

## The bar in plain language

To release crypto and the personal archive (S3), the attacker needs the S2 conditions met (which requires the S1 conditions met, which requires suppressing the user's response for fourteen days through both unreachability and channel-blocking) **and** they need to defeat the anti-cohabitant verification factor **and** they need to recruit a second consenting contact of a different role **and** they need to wait an additional twenty-one days during which the user has multiple cancel windows.

Each "and" multiplies difficulty.

The path from "I'm an angry spouse" to "I have your crypto seed phrase" requires roughly six independent things to go right for the attacker and wrong for the user. This is what the security architecture is buying you.

## Implementation checklist derived from this tree

Every leaf-level mitigation must exist in code for the tree's defenses to hold:

- [ ] Scheduled-absence feature with max-N-day windows (Gap 1 of threat 5.1)
- [ ] Mandatory minimum channel diversity at enrollment (≥3 channels of different types)
- [ ] Physical recovery code generation and storage verification flow
- [ ] Release-only passphrase derivation and offsite-storage prompt
- [ ] Anti-cohabitant factor enforcement at release time
- [ ] Diverse-role consensus algorithm with role-category checking
- [ ] Cross-contact notification when any contact affirms
- [ ] Cooldown ladder with floors (S1 → S2 → S3)
- [ ] Audit log entry on every contact-initiated escalation
- [ ] Sensitive-action delay on any change to release-relevant settings
