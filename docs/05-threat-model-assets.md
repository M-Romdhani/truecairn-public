# 05 — Threat Model: Assets

This corresponds to section 2 of the threat model document.

## 2.1 What we mean by "asset"

An asset is anything the platform stores or controls whose unauthorized disclosure, unauthorized modification, or unavailability would harm the user, their contacts, or the platform itself.

Assets are ranked by sensitivity, where sensitivity is a function of two properties:
- **Disclosure damage:** how bad it is if an unauthorized party reads this.
- **Withholding damage:** how bad it is if a legitimate party cannot access this when they need to.

These are not symmetric. Some assets are catastrophic when disclosed but trivial when withheld (a personal letter). Others are catastrophic when withheld but minor when disclosed (recovery instructions for a Gmail account — leaked, the attacker still has to compromise Gmail; never delivered, the survivor's life seizes up).

The tier system below ranks assets by worst-case combined damage, with disclosure weighted more heavily because disclosure is irreversible while withholding is sometimes recoverable through external channels.

## 2.2 Tier A — catastrophic on disclosure

Assets in this tier, if disclosed to an unauthorized party, cause irreversible damage that cannot be repaired through any external system.

- **Crypto wallet material:** seed phrases, private keys, hardware wallet recovery codes, wallet derivation paths. A single disclosure event is permanent and total; funds are gone the moment an attacker has the seed.
- **Personal archive content:** letters, voice recordings, video messages, private journals intended for specific recipients. Disclosure to the wrong audience violates intimacy in a way no other asset does.
- **Master encryption keys:** any key material that, if disclosed, would decrypt other vault content. These should not exist in plaintext on the server under any circumstance.

Tier A assets release only at S3, only after diverse-role consensus, only after the full cooldown ladder has completed. Encrypted client-side with keys never visible to operators.

## 2.3 Tier B — severe on disclosure

Assets in this tier, if disclosed, cause significant damage that is sometimes recoverable through external systems but at high cost in time, money, and stress.

- **Identity documents:** passport scans, driver's license images, national ID numbers, birth certificates. Powerful inputs to identity-theft attacks; recoverable but painful.
- **Financial account references:** bank account numbers, brokerage logins, insurance policy details, tax records. Damage bounded by financial-institution fraud protection in most jurisdictions, but disruption is months long.
- **Legal documents:** wills, contracts, ownership records, signed agreements. Disclosure can influence inheritance disputes, contract negotiations, ongoing litigation.

Tier B assets release at S2, after the first cooldown ladder has completed and the engine has confirmed no cancellation. Client-side encrypted.

## 2.4 Tier C — moderate on disclosure, high on withholding

Assets in this tier, if disclosed, cause manageable damage; but if withheld during a real continuity event, they cause significant operational disruption.

- **Operational playbooks:** business SOPs, infrastructure documentation, vendor contacts, payroll procedures, client lists. Disclosure damage is competitive (a rival learns how the business runs); withholding damage is existential (the business stops).
- **Asset inventory:** list of subscriptions, domains, SaaS tools, cloud providers, social accounts. Disclosure damage is minor; withholding damage is high (survivors don't know what to cancel, renew, or transfer).

Tier C is split. Asset inventory releases at S1 because the disclosure cost is low and the operational value of early access is high. Operational playbooks release at S1 only to the cofounder/business-partner role and never to non-business contacts.

## 2.5 Tier D — low on disclosure, catastrophic on withholding

Recovery instructions are their own tier.

Disclosed: they tell an attacker that a Gmail account exists and how the 2FA is structured — useful but not sufficient to compromise anything on its own.

Withheld: they prevent survivors from doing anything at all. No email access, no password resets, no entry into any other system.

Recovery instructions release at S1 to nearly every contact category. They are the platform's first deliverable in a real continuity event and the single most important thing it does for survivors.

They are also the asset most likely to be unnecessarily over-protected by engineers with a security mindset. This document explicitly argues against doing so.

## 2.6 Platform-internal assets

Beyond user content, the platform itself holds operational assets:

- **Audit logs:** immutable record of every engine event. Stored append-only with cryptographic chaining.
- **User authentication material:** password hashes, passkey public keys, recovery codes.
- **Subscription and billing data:** payment processor references, plan history.
- **Release policy matrix configurations:** per-user customizations. Modifications are themselves sensitive actions, gated by cooldown.

Not the focus of this document but listed so they are not forgotten.

## 2.7 What is NOT an asset for our purposes

- **Decrypted plaintext on contact devices after release.** Once a contact has decrypted content, it leaves the platform's protection. This is by design.
- **User behavior metadata aggregated for analytics.** We do not collect this in a form that would qualify as an asset under this threat model. Privacy posture, not security posture.
- **The user's emotional state and decisions.** The platform stores user choices but is not responsible for whether those choices were wise.

## 2.8 Asset-to-tier-to-stage summary

| Asset category | Tier | Release stage (default) |
|---|---|---|
| Crypto material | A | S3 |
| Personal archive | A | S3 |
| Identity documents | B | S2 |
| Financial accounts | B | S2 |
| Legal documents | B | S2 (S1 to lawyer) |
| Operational playbooks | C | S1 (business role only) |
| Asset inventory | C | S1 |
| Recovery instructions | D | S1 |

This is the canonical reference. The release policy matrix in `03-release-policy-matrix.md` elaborates the *who* axis on top of this *what* axis.
