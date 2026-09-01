# 24 — The S2/S3 collusion threshold

**Status: DECIDED (owner) + IMPLEMENTED.** S3 uses a **passphrase-MANDATORY nested
scheme** — reconstruction needs the release passphrase **and any 2 of 3 contacts**
— so colluding contacts alone can never reach S3, while S3 keeps its "lose any one
contact" resilience. This is now wired end to end in production (see "Rollout"). **S2 — DECIDED: Option A (accept + document).** S2 stays flat
2-of-3 (the passphrase remains an optional fallback); the collusion trade-off (two
diverse-role contacts reach S2 without the passphrase) is ACCEPTED and documented,
not closed in code. The memo below records the original contradiction + options;
the chosen direction and its rollout are in "Chosen direction" and "Rollout".

Reversing part of locked Decision 3 (docs/01 §3) was explicitly authorised. `docs/14`
§5.6 and `docs/01` §3 are reconciled to this decision: the "short by one" guarantee
is an **S3** property (nested scheme); **S2** accepts the collusion trade-off.

## The contradiction

`docs/14` §5.6.5 states the headline anti-collusion guarantee:

> Two colluding contacts have 2 shares; the threshold is 3. They are short by one
> no matter how patiently they wait.

That is only true if the contacts can never hold ≥ threshold shares between them —
i.e., the remaining share(s) must be **non-contact** factors (the release
passphrase, a hardware key). But `docs/01` Decision 3 allows those slots to be
**additional contacts**:

- **S3** — "3-of-4": share #4 is "Hardware-key share (premium) **OR second
  professional contact** (free)."
- **S2** — "2-of-3 … (any contact + passphrase + **hardware-key-or-second-contact**)."

And the **shipped implementation** took the all-contacts shape as the default:

- `S2_THRESHOLD = 2`, shares `{contact₁, contact₂, releasePassphrase}` → **2-of-3**.
- `S3_THRESHOLD = 3`, shares `{contact₁, contact₂, contact₃, releasePassphrase}` → **3-of-4**.
- The owner-side split (`Contacts.tsx` / `splitAndSealTierShares`) assigns
  **exactly** 2 diverse contacts for S2 (3 for S3) plus the passphrase; the
  passphrase is the *reserved last* share — the **optional fallback** built in #1,
  not a required factor.

**Consequence:** the contact-holders alone equal the threshold. So:

- **2 colluding S2 contacts** of diverse roles reconstruct S2 **without** the
  release passphrase.
- **3 colluding S3 contacts** of diverse roles reconstruct S3 **without** the
  release passphrase.

`docs/14`'s "short by one" guarantee does **not** hold for the shipped
configuration. (`docs/14` §5.6.4 even assumes "for S2 … they have 2 of 3 … the
third must be the passphrase" — i.e. it assumed S2 was 3-threshold; `docs/01`
locked S2 at 2-of-3. The two locked/threat docs already disagree on S2's
threshold, independent of code.)

What still holds today: the **diverse-role** check (same-role pairs can't both
contribute), cross-contact notification, the signed affirmation audit log, the
cooldown ladder, and anomaly detection (`docs/14` §5.6.5). `docs/14` §5.6.6
already says the design *accepts* that a sufficiently determined conspiracy can
succeed — but it frames that as requiring a *third independent compromise*
(passphrase paper / hardware key), which the shipped all-contacts default does
not require.

## The trade-off

Making a **non-contact factor mandatory** (passphrase and/or hardware key inside
the threshold) restores docs/14's guarantee but makes that factor **load-bearing
for recovery**: if the owner loses the passphrase paper and is unreachable, S2/S3
become unrecoverable (docs/01 §"What this costs us" already accepts exactly this
for the passphrase). Keeping the **all-contacts** default maximises recoverability
(enough surviving contacts can release even if the passphrase is lost — and the #1
fallback is a true *fallback*) but weakens the collusion property to "diverse-role
+ visibility + audit," not "cryptographically short by one."

## Options

1. **Status quo — accept it, reconcile the docs.** Keep 2-of-3 / 3-of-4 with the
   passphrase optional. Update `docs/14` to state honestly that, in the
   all-contacts configuration, colluding diverse-role contacts *can* reach S2/S3,
   and that the "short by one" guarantee applies only to the
   passphrase/hardware-mandatory configuration. No code change.
   *Pro:* simplest, most recoverable, matches shipped behaviour. *Con:* the
   product's headline anti-collusion claim is weaker than `docs/14` reads today.

2. **Make a non-contact factor mandatory in the threshold** (recommended for S3
   at least). Re-shape the splits so contact-holders are always below threshold:
   e.g. **S3 = 2 contacts + passphrase (+ optional hardware), passphrase
   required**; optionally **S2 = 1 contact + passphrase, passphrase required**.
   Then colluding contacts max out at (threshold − 1) and cannot reconstruct
   without the offline factor. *Pro:* restores docs/14; aligns with the
   founder/crypto persona (docs/01 Decision 1) who *tolerates* the passphrase
   discipline. *Con:* passphrase loss ⇒ S2/S3 unrecoverable; the #1 "fallback"
   becomes the *primary* path. Code: change the tier thresholds/share counts +
   the assignment UI + reconcile the #1 fallback semantics.

3. **Owner choice per plan (a "collusion-hardened" toggle).** Default to the
   stronger Option-2 shape, let the owner opt into the all-contacts shape
   per tier with an explicit recoverability warning. *Pro:* serves both
   risk appetites. *Con:* most UX + code complexity; two code paths to test.

4. **Default the spare slot to a hardware key, not a second contact** (premium
   path from docs/01). Keep 2-of-3 / 3-of-4 but make the threshold-meeting slot a
   **hardware-key** share by default rather than an extra contact, so contacts
   alone stay below threshold. *Pro:* matches docs/01's premium intent, keeps the
   threshold numbers. *Con:* requires the hardware-key share path (schema type
   exists; the assignment flow does not yet build it) and a hardware key per user.

## Recommendation

For the launch persona (docs/01 Decision 1 — founders/crypto holders who accept
storing a passphrase offsite), **Option 2 for S3** (passphrase mandatory in the
S3 threshold) is the best fit: S3 is the catastrophic, irreversible tier
(`docs/07` — "S3 reaching an attacker is product-ending"), so its anti-collusion
property should be cryptographic, not procedural. **S2** can reasonably stay
Option 1 (accept + document) given it is less catastrophic and more
recoverability-sensitive — or move to Option 2 if you want uniformity. Whatever
is chosen, **`docs/01` and `docs/14` must be reconciled to match** so the threat
model and the locked decision stop contradicting each other and the code.

## If/when a direction is chosen, the work

- **Option 1:** edit `docs/14` (and a note in `docs/01`) only.
- **Option 2/4:** change `S{2,3}_THRESHOLD` / `S{2,3}_SHARES` /
  `RELEASE_SHARE_INDEX_*` in `packages/keys`, the split + assignment validation
  (`Contacts.tsx`, `splitAndSealTierShares`), the property tests
  (`ceremonies-shares.test.ts`), and the #1 fallback’s framing; for Option 4 also
  build the hardware-key assignment flow. Then reconcile `docs/01` + `docs/14`.
- **Option 3:** all of the above behind a per-tier owner setting + schema for the
  choice.

## Chosen direction (nested S3)

A one-time-pad layer over a 2-of-3 contact split:

```
mask   = Argon2id evaluation of the release passphrase (32 bytes, the
         ReleasePassphraseShare value, index byte dropped)
C      = S3_tier_key XOR mask
contact shares = Shamir 2-of-3 over C   (no passphrase share among them)

reconstruct: C = Shamir-combine(any 2 of 3 contact shares); key = C XOR mask
```

- Colluding contacts recover only `C`, which is independent of the tier key
  without the mask → collusion alone never reaches S3 (restores docs/14 §5.6.5).
- Any 2 of 3 contacts + the passphrase reconstruct → keeps "lose one contact".
- Lose the passphrase paper ⇒ S3 unrecoverable (docs/01 §"What this costs us"
  already accepts this for the passphrase factor).
- The #1 release-passphrase fallback becomes the **normal** S3 path (the
  passphrase is always required), not an optional fallback. S2 keeps the optional
  fallback exactly as shipped.

## Rollout

**Landed — crypto core, verified:** `splitTierKeyForS3Nested` +
`combineTierKeyForS3Nested` in `packages/keys` (`S3_NESTED_CONTACT_{THRESHOLD,
SHARES} = 2,3`), with property tests proving round-trip, any-2-of-3 fault
tolerance, passphrase-mandatory (contacts-only ≠ key; wrong mask ≠ key), and the
arity/tier guards.

**Landed — full wiring (the S3 release path is now nested end to end; the
production collusion gap is closed):**
1. `packages/client-crypto` `splitTierKeyToContactShares`: S3 derives the
   passphrase mask, XORs the tier key, and 2-of-3 splits the masked key into
   **3 contact shares** (S3 still assigns 3 contacts; reconstruction needs any 2
   **+** the passphrase — the earlier "2 contacts" wording conflated "2 must
   participate" with "assign 2"). S2 unchanged.
2. Owner assignment (`apps/web` `Contacts.tsx` / `contacts/crypto.ts`): S3 assigns
   **3** diverse contacts as before; the passphrase is mandatory at assignment
   (it already was — it derives the mask) and the UI states it is required to
   reconstruct, not an optional fallback.
3. Reconstruction (`apps/web/src/ceremony/reconstruct.ts` + the portal): S3
   **always** uses `combineTierKeyForS3Nested` with the recipient-entered
   passphrase; there is no contacts-only S3 path. Beneficiary S3 likewise needs
   the passphrase.
4. API `/v1/ceremonies/:id/shares`: S3 returns the contact shares at threshold
   `S3_NESTED_CONTACT_THRESHOLD` (2); the consensus gate (`processor.ts`
   `TIER_THRESHOLD.s3`) drops to 2; `/release-salt` is load-bearing for every S3
   reconstruction. Migration `0033` moves the `user_tier_keys` S3 metadata +
   CHECK to `(2,3)`.
5. Tests: `ceremonies-shares.test.ts` S3 property rewritten to the nested flow
   (2 + passphrase reconstruct; 3 colluding contacts **cannot**) + the
   processor/client-crypto/E2E specs updated to passphrase-mandatory S3.
6. Reconciled `docs/01` §3, `docs/14` §5.6, and `docs/18` with the nested scheme.

**Landed — share-recomposition / rotation aligned with nested S3.** The
recomposition + rotation paths no longer model a flat S3 index-4 passphrase share:
- `/v1/release/passphrase-slot` is **S2-only** (nested S3 has no passphrase slot —
  the passphrase is the mask, recorded only as the KDF salt); the web records the
  slot for S2 only.
- `validateComposition` (`apps/api`) and `changeShareComposition` +
  `buildReleaseShareInsert` (`packages/sensitive-actions`) cap S3 at
  `S3_NESTED_CONTACT_SHARES` (1..3) and **reject** a `release_passphrase` factor
  for S3; S2 keeps its flat reserved passphrase slot.
- `rotate_release_passphrase` re-wraps the 3 S3 contact shares (no index-4 share).
Tests updated to the nested layout (key-rotation seeds 3 contacts; new negative
coverage that S3 rejects a release_passphrase recomposition / out-of-range index).
