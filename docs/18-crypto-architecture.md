# 18 — Cryptographic Architecture

The spec Claude Code reads before writing a line of cryptographic code.

## Primitives

### Symmetric encryption
**XChaCha20-Poly1305** via libsodium's `crypto_secretbox` family.

Chosen for:
- AEAD properties (authenticated encryption)
- 192-bit nonces (safe to randomly generate without coordination)
- Audited implementation
- Broad library support

Per-item keys are 256 bits. Nonces are randomly generated per encryption operation.

### Key derivation
**Argon2id** via libsodium's `crypto_pwhash`.

Parameters:
- Memory: 256 MiB
- Operations: 4
- Parallelism: 1

Above libsodium "moderate" defaults and below "sensitive" — appropriate for a passphrase used infrequently on user devices. We benchmark on target devices and adjust upward if practical.

Salt: 16 bytes, randomly generated at user enrollment, stored alongside the wrapped key material.

### Asymmetric encryption for contact share wrapping
**X25519** for key agreement, **XSalsa20-Poly1305** for the wrapped payload, via libsodium's `crypto_box`.

Each contact has an X25519 keypair generated at their enrollment. Their share is encrypted to their public key. The contact's private key is wrapped by their own passphrase-derived key plus their device-binding key.

### Signatures
**Ed25519** via libsodium's `crypto_sign`.

Used for:
- Audit log signatures (signing key derived from user passphrase)
- Contact affirmation signatures (signing key derived from contact passphrase plus device binding)
- Code-release signatures by the team (separate, hardware-key-based)

### Secret sharing
**Shamir's secret sharing over GF(256)**, threshold scheme per `01-decisions-locked.md`:
- **S3 (nested, docs/24):** the release passphrase's Argon2id evaluation is a one-time-pad **mask** over the S3 tier key; the contacts hold a **2-of-3** split of the *masked* key. Reconstruction = any 2 of 3 contact shares **and** the passphrase mask. Colluding contacts alone never recover the tier key.
- **S2 (flat):** 2-of-3 `{contact, contact, passphrase}` — the passphrase is an optional fallback share; any 2 of the 3 reconstruct.

Library: a reviewed implementation such as `vsss-rs` or equivalent. We will write our own bindings, not the primitive itself.

## Key hierarchy

1. **User master passphrase.** Never stored. Provided by user at enrollment and at sensitive-action authentication. Used to derive the user master key via Argon2id.

2. **User master key.** Derived from passphrase via Argon2id. Never stored. Used to derive: the audit log signing key, the wrapping key for per-tier keys, and the verification key for the audit log.

3. **Per-tier keys (S1, S2, S3).** Random 256-bit keys generated at enrollment. Wrapped under the user master key for normal user access. The S2 key is split via Shamir into contact shares (+ the optional passphrase fallback share). The S3 key is XOR-masked by the release-passphrase evaluation and the *masked* key is split 2-of-3 across contacts (nested scheme, docs/24) — the passphrase is the mandatory mask, not a distributed share. The S1 key is wrapped with the temporal gate only.

4. **Per-item keys.** Random 256-bit keys generated per vault item. Wrapped under the appropriate per-tier key.

5. **Outer-layer keys.** Random 256-bit keys held server-side, used to wrap the per-tier ciphertext before storage. Released only after engine cooldown completes. **These are NOT a Shamir share; they are a temporal gate** as specified in `01-decisions-locked.md`.

5b. **Vault capture keypair (X25519).** Derived from the user master key via
   `crypto_kdf_derive_from_key` with its own context (`tc-vcapt`, subkey id 1) →
   `x25519KeypairFromSeed`. Its **public** half is published to the account
   (`user_key_material.vault_capture_pubkey`) so a phone can seal new items to
   the vault without holding anything that can open one; the secret half is
   derived in the browser on demand and wiped after use. See `docs/34`.

   Two consequences follow from the derivation and are load-bearing:
   - It is **deterministic**, so publishing it twice is a no-op rather than a
     rotation, and an account enrolled before capture existed heals itself on
     the next unlock instead of needing a migration that cannot reach the master
     key.
   - It is **master-derived, not tier-derived**, so a release ceremony — which
     reconstructs tier keys and never the master key — cannot open a capture.
     An unfiled capture is therefore outside the release ladder by construction,
     and both clients say so (docs/34 D4).

   Its own KDF context rather than reusing the audit signing key via
   `crypto_sign_ed25519_pk_to_curve25519`: the audit key's whole value is that an
   owner signature means exactly one thing.

6. **Release-only passphrase.** Separate from the user master passphrase. Stored physically by the user, off-site. Derives, via Argon2id, a 32-byte evaluation that for **S2** is an optional fallback Shamir share, and for **S3** is the mandatory one-time-pad mask over the tier key (nested scheme, docs/24). It never reaches the server; only its per-(tier,index) KDF salt is stored.

## Audit log signing

The audit log is a hash chain. Each entry contains:
- Timestamp (server-attested)
- Event type
- Event payload
- Hash of previous entry

Each entry is signed by the server (for non-repudiation by the server) and additionally, for sensitive events, by the user's audit signing key (for non-forgery by the server).

The user's audit signing key is derived from the user master passphrase. The verification key is published in the user's account at enrollment. The server signs all entries; the user signs sensitive-action entries from their device when the action is performed.

A user reviewing their log can verify:
- That the server signed every entry
- That the user-signed entries verify under the published verification key
- That the hash chain is unbroken

**A compromised server can append entries but cannot forge user-signed entries.** A server that omits or reorders entries breaks the hash chain, which is detectable.

## Contact share wrapping

Each contact, at enrollment, generates an X25519 keypair on their device.
- Public key registered with the platform.
- Private key wrapped by a key derived from the contact's own passphrase (via Argon2id) plus a device-binding key (random, generated on the device at first registration, stored only on that device).

When a contact's share is created (at user enrollment, when the user adds the contact to a tier), the share is encrypted to the contact's public key and stored on the platform as ciphertext.

When a release ceremony begins:
1. The contact authenticates with their passphrase on their bound device.
2. The device unwraps the contact's private key.
3. The contact's private key unwraps the share.
4. The contact contributes the unwrapped share to the ceremony, signed by the contact's Ed25519 affirmation key.

**The platform never sees the contact's passphrase, private key, or unwrapped share.**

## Contact key verification — safety numbers and pinning

The section above describes how a share is sealed *to a public key*. It says
nothing about how the owner's client learns **which** public key belongs to a
contact. If the answer were "the platform told it", key distribution would be a
server-side capability depending on operator goodwill, which §5.7.8 of docs/15
says is always wrong. See docs/15 Path E for
the full attack; the summary is that one `UPDATE contacts SET
contact_x25519_pubkey = …` gives up S1 outright and S2 with two of them, with no
code change and therefore no reproducible-build signal.

**The fingerprint.**

```
digest = BLAKE2b-256( lp("truecairn/contact-key-fingerprint/v1")
                   || lp(contact_x25519_pubkey)
                   || lp(contact_ed25519_pubkey) )
lp(x)  = u32_be(len(x)) || x
```

Rendered as 6 groups of 5 decimal digits (each group = 5 digest bytes big-endian,
mod 100000, zero-padded) — 30 digits, ~99.6 bits, sized to be read aloud without
losing one's place. Length-prefixed for the same reason as the outer-layer AAD;
domain-separated so this digest cannot equal one computed elsewhere over the same
bytes. Implementation `packages/crypto/src/contact-fingerprint.ts`, frozen vectors
`packages/crypto/src/vectors/contact-fingerprint.json`.

**Both keys are covered deliberately.** Sealing uses X25519 alone, but a
fingerprint over X25519 alone would let the server pair a genuine Ed25519 — whose
affirmation signatures verify — with a substituted X25519 that reads the share,
making the substitution invisible in the half the owner checks. The vector file
pins a partial-substitution case for exactly this.

**The pin.** After the owner compares the code with the contact out of band, the
client stores the confirmed key bytes as
`XChaCha20-Poly1305(key = S1 tier key, aad = lp(domain) || lp(owner_id) || lp(contact_id))`
in `contacts.key_pin_ciphertext` / `key_pin_nonce` (migration 0061). This follows
the display-label precedent: the server holds ciphertext under a key it does not
have. It therefore cannot forge a pin, and the AAD stops it transplanting one
between rows or replaying a removed contact's. It *can* delete one — which
degrades to "unverified" and blocks sealing, per invariant #2.

**The gate.** `requireVerifiedContactKey()` is the only way to mint the
`VerifiedContactKey` token that `sealS1EnvelopeToContact` and
`splitAndSealTierShares` accept. Verification is enforced by the type system at
every call site rather than by a null check at one of them. Both S1 sealing paths
go through it — share assignment and beneficiary designation.

**Rotation vs. attack.** Contact keys are deterministic from the contact's master
key, so they change only on a genuine rotation, which is already a sensitive
action with a 7-day delay and out-of-band notice. The client therefore treats an
unannounced change as an attack (`changed`, shown as an alarm) rather than as a
prompt to silently re-confirm. `tampered` — a pin that fails to decrypt — is kept
distinct from `unverified` for the same reason: one means work not yet done, the
other means something interfered with work already done.

**What is NOT claimed.** The security of this rests on a human comparison the
client cannot observe. An owner who confirms without calling, or who compares over
a channel the server relays, has verified nothing. S1 and S2 depend on that
diligence; S3 does not, because its mandatory passphrase mask (docs/24) is a
factor the server cannot hold either way. Extending that mask to S2 would remove
the human dependency there too, at the cost of making the release passphrase
mandatory for S2 recovery — an open product decision, recorded in docs/17.

## Item-identity binding (AAD v2)

Two layers protect a vault item under its tier key: the **per-item key**
(wrapped by the tier key) and the **title** (encrypted directly under it). Both
must be bound to the item they belong to. A tier-only AAD on the item-key wrap
(`'I','K',tier`) and no AAD at all on the title would leave both interchangeable
between items of the same tier, which is the property this construction closes.

A server with write access could therefore permute titles and contents among
same-tier items of the same owner. Swap two S2 items' outer envelopes and each
decrypts perfectly, under the wrong title. The server reads neither, so this is
not a confidentiality break — it is an **authenticity** one, and it lands at
release, in front of a recipient who cannot tell that the item labelled "Bank
details" holds something else.

```
item_key_aad = lp("tc-item-key/v2")   || lp(tier_byte) || lp(item_id)
title_aad    = lp("tc-item-title/v2") || lp(tier_byte) || lp(item_id)
```

The **client chooses the item id** before encrypting anything (`newItemId()` →
sent in the create body). Server-assigned ids were the stated reason the binding
did not exist; a client-generated UUID dissolves it, and the create route
rejects an id that is already taken rather than overwriting. The client also
refuses a create whose echoed id differs from the one it sealed to — following
the server's id would silently hand every later read the wrong binding.

Distinct domain strings for the two layers, so a title ciphertext can never be
accepted in the item-key slot or the reverse. Length-prefixed because a UUID is
variable-length text.

**Content needs no AAD of its own.** It is encrypted under the per-item key and
travels with that key inside the same outer bundle, so binding the key to the
item covers both; swapping content alone fails against the unchanged item key.

### Versioning, and why there is no v1 reader

`vault_items.aad_version` (migration 0062) records the construction. It is
**read and asserted** on every unwrap — a version this client does not
understand is refused by name (`unsupported item AAD version N`) rather than
handed to a different builder and surfacing as a generic decryption failure.

There is deliberately **no compatibility path for v1**. When this landed,
production held 36 vault items across 21 owners, all pre-launch test data, and
the column did not yet exist there — so every one of them becomes v1 on deploy
and is refused. Carrying a v1 reader and its permanent doubled test matrix for a
population that will never exist is the more expensive mistake. The cost of a
format change is zero before the first real customer item and rises
monotonically after; this was the last moment it was free.

The column stays as the mechanism for the **next** format change. It is read on
every unwrap rather than written-and-ignored — a version column nobody reads is
a version column that silently stops meaning anything.

### The tier move carries the title

The title is encrypted under the tier key, so a tier move has to re-encrypt it.
A move that rewrites `tier` while leaving `title_ciphertext` sealed under the
tier the item just left makes every moved item throw on read — and in an
uncaught render path that takes the whole vault list with it, while the content
was intact the entire time. The re-encryption is not optional bookkeeping.

Both values are produced at **enqueue**, not at apply seven days later: the
client holds both tier keys at that moment and the worker holds none, so it is
the only point at which either can exist. The apply handler requires the
re-encrypted title and cancels a payload without one rather than half-applying.
A moved item is re-sealed under the destination tier, so it lands at the current
AAD version whatever it was before.

Because the pending action's payload is fixed at step-up and notified, it must
never be rewritten afterwards — so renaming an item with a tier move pending is
**refused** (409, carrying the action id and `effectiveAt`) rather than being
silently reverted when the move applies. That check reads `sensitive_actions`
directly rather than a marker column on `vault_items`: the existing
`pending_delete_at` precedent is cleared only in the apply handler, so a
*cancelled* action leaves it set forever, and copying that shape would give an
item that can never be renamed again.

## Release ceremony protocol

The release ceremony has its own sub-protocol with three phases:

### Phase 1 — Initiation
Engine state has reached RELEASE_REVIEW. Contacts are notified. Each is presented with the affirmation interface and asked to confirm the release.

### Phase 2 — Tentative affirmation
A contact who affirms enters the "tentative" state. Their share is unwrapped on their device but **not yet contributed** to the ceremony — held locally, encrypted under a ceremony-specific ephemeral key.

Cross-contact notifications fire. The contact receives a 48-hour revocation window during which they can withdraw their affirmation with one tap.

### Phase 3 — Commitment and reconstruction
After the revocation window expires for all tentative affirmations, the platform releases the outer-layer key (if and only if the engine cooldown has completed without cancellation).

Affirmed contacts contribute their shares to the reconstruction. For S2 the Shamir reconstruction yields the per-tier key directly; for **S3** it yields the *masked* key, which the recipient un-masks by XOR with the release-passphrase evaluation they enter (the nested scheme, docs/24 — no passphrase, no key). The per-tier ciphertext is decrypted using the outer-layer key, then the per-tier key. Contents are delivered to the affirmed contacts according to the release policy matrix.

**If any phase fails** (revocation, cooldown cancel, insufficient affirmations within the synchronization window of 14 days), the ceremony resets and must restart.

## Recovery and reset flows

### User forgets master passphrase
User can rotate via re-authentication with a separate factor (backup recovery code generated at enrollment, stored offline). Rotation is a sensitive action with a 7-day delay. During the delay, all registered channels notified. Rotation invalidates the old audit log signing key; the new key is used going forward, with the rotation event signed by both old and new keys for continuity.

### User forgets release-only passphrase
User can rotate to a new release-only passphrase if they still have the master passphrase (a sensitive action); if the master passphrase is also lost, rotate via the backup recovery code. **Loss impact differs by tier:** **S3 becomes unrecoverable** if the passphrase is lost (it is the mandatory mask, docs/24) — by design, no "contact support" path. **S2 survives** — its 2 diverse-role contacts reconstruct without the passphrase; only the +1 fallback is lost.

### Contact loses passphrase
Contact can rotate via their own backup recovery code (generated at their enrollment). Rotation is a sensitive action on the contact's account with a 7-day delay and out-of-band notification.

### Contact loses device
Contact can register a new device by re-authenticating with their passphrase and backup recovery code. Device-binding ceremony repeats. Old device is deauthorized; any share material on it can no longer be unwrapped (because the device-binding key is local to that device, lost with it).

### User loses all factors
If the user loses their master passphrase, their release-only passphrase, and their backup recovery code, the account is unrecoverable. **The platform will not assist.** The contacts can still complete an S1 or S2 release ceremony if the user becomes unreachable; **S3 additionally needs the release passphrase** (its mandatory mask, docs/24), so S3 is releasable only if the off-site passphrase paper survives. The user themselves cannot regain access.

## Platform outer-layer key handling

Outer-layer keys are generated at vault creation (lazily, on the first vault item stored in a tier), encrypted under a platform-held key encryption key (KEK), and stored alongside the ciphertext. The KEK is reached through a **KekProvider seam** (`packages/vault/kek.ts`) with two implementations: **env-backed** (`EnvKekProvider` — the KEK is a 32-byte value from `OUTER_LAYER_KEK`, XChaCha20 wrap/unwrap in process; the default), and **HSM-backed** (`KmsKekProvider` over GCP Cloud KMS via `OUTER_LAYER_KEK_PROVIDER=gcp-kms` + `OUTER_LAYER_KMS_KEY` — the KEK never leaves the HSM; wrap/unwrap are KMS `encrypt`/`decrypt` calls AAD-bound to `(user_id, tier, kek_id, generation)`; auth is the same ADC as Vertex). The provider is selected identically in the API config and worker, so both wrap/unwrap under the same key. The **worker** is the only path that releases the key into a ceremony, but **both** processes use it for the transparent owner-facing unwrap-on-fetch (and wrap-on-store) during ACTIVE state. KEK access does not widen plaintext exposure: the outer key is a temporal gate, not a confidentiality key — it removes one wrap, and the inner wraps still require the master passphrase the server never sees (see Phase 3.3, PHASE3_3_VAULT_PROPOSAL §c). KMS operations are logged by the provider; the HSM keeps its own access log.

The release worker, upon engine state reaching the appropriate stage and the cooldown completing without cancellation, releases the outer-layer key to the ceremony. **The release worker code is open-source.** The HSM operations are logged to an append-only log accessible to users.

If the platform ceases to operate, the user can request export of their encrypted outer-layer keys (encrypted under a user-specified destination key) before the platform shuts down. This export is part of the open-source escape hatch.

## Implementation notes for Claude Code

- Use libsodium where possible. Do not implement primitives directly.
- All key derivation, encryption, decryption, and signing operations happen on the client. The server's cryptographic role is limited to: storing ciphertext, signing audit entries with its own key, managing the HSM-stored outer-layer KEK, and routing affirmation messages.
- Server-side code in the release worker has no access to user master passphrases, contact passphrases, contact private keys, or unwrapped shares. The release worker can release the outer-layer key when conditions are met; it cannot decrypt anything else.
- The audit log signing on the client side requires the user's device to have the master passphrase available — meaning sensitive actions require the user to enter their passphrase, not just be logged in. This is by design (matches threat 5.2 mitigations).
- Backup recovery codes are 256-bit random values, displayed to the user at enrollment in a recoverable format (hex or BIP-39 word list), with explicit instructions to store offline.
- All randomness comes from the platform's cryptographically-secure random number generator (libsodium's `randombytes_buf`).
- Time-attestation for audit logs uses server time, but the server-time signature is paired with client-time at the moment of signing. Both are recorded. A server that lies about time produces inconsistent records detectable by the client.
