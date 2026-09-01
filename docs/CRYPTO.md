# Truecairn cryptography — public specification

This is the reviewable, public description of the cryptography Truecairn uses. It
is extracted from the internal architecture (`docs/18`) and kept accurate to the
code (`packages/crypto`, `packages/keys`, `packages/client-crypto`, `packages/audit`).
The client and these crypto packages are the open-source, buildable core (see
`docs/BUILDING.md`).

The one-line summary: **everything that protects vault content is derived and
computed on the owner's device; the server stores ciphertext, public keys, salts,
and sealed boxes, and its single cryptographic power is releasing a temporal gate.**

## Primitives

| Purpose | Primitive | Notes |
|---|---|---|
| Symmetric AEAD (vault content, wraps) | **XChaCha20-Poly1305** (libsodium `crypto_aead_xchacha20poly1305_ietf`) | 256-bit keys; 192-bit (24-byte) random nonces — safe to generate without coordination. Ciphertext carries the Poly1305 tag. |
| Password KDF | **Argon2id** (libsodium `crypto_pwhash`, `ALG_ARGON2ID13`) | Memory 256 MiB, ops 4, parallelism 1; 16-byte random salt per user, generated at enrollment. |
| Contact-share wrapping | **X25519** key agreement + **XSalsa20-Poly1305** (libsodium `crypto_box`) | A share is sealed to the contact's X25519 public key. |
| Signatures | **Ed25519** (libsodium `crypto_sign`) | Audit-log entries + contact affirmations. |
| Secret sharing | **Shamir over GF(256)** | AES irreducible polynomial x⁸+x⁴+x³+x+1 (0x11b); precomputed log/exp tables. |
| Audit hash chain | **SHA-256** | `entry_hash = SHA-256(canonical(entry))`, prev-hash chained. |

All keys in the hierarchy are **256-bit (32-byte)**.

## Key hierarchy

1. **Master passphrase** — never stored, never sent. Entered at unlock and at
   sensitive-action step-up.
2. **Master key** — `Argon2id(master passphrase, salt)`. Never stored. Derives the
   audit signing key, the per-tier wrapping key, and the audit verification key.
3. **Per-tier keys (S1/S2/S3)** — random 256-bit, generated at enrollment, wrapped
   under the master key for the owner's own access. Additionally:
   - **S1** — wrapped with the temporal gate only (a sealed envelope to a
     designated beneficiary).
   - **S2 (flat 2-of-3)** — Shamir-split across `{contact, contact, passphrase}`;
     the release passphrase is an **optional** fallback share (any 2 of 3
     diverse-role parties reconstruct).
   - **S3 (nested, docs/24)** — the release-passphrase Argon2id evaluation is a
     one-time-pad **mask** over the tier key; the contacts hold a **2-of-3** split
     of the *masked* key. Reconstruction needs the mask **and** any 2 of 3 contacts.
     Colluding contacts alone recover only the masked secret — never the tier key.
4. **Per-item keys** — random 256-bit per vault item, wrapped under the per-tier key.
5. **Outer-layer keys** — random 256-bit, held **server-side**, wrapping the
   per-tier ciphertext at rest. **Not a Shamir share — a temporal gate**: released
   only after the engine's inactivity/consensus cooldown completes. Holding it does
   **not** widen plaintext exposure (the inner passphrase-derived wraps still
   apply). Optionally HSM-backed (GCP Cloud KMS) so the KEK never enters process
   memory.
6. **Release-only passphrase** — separate from the master passphrase, stored
   off-site by the owner. Derives (Argon2id) a 32-byte evaluation that is an
   optional S2 fallback share and the **mandatory** S3 mask. Never reaches the
   server; only its per-(tier, index) KDF salt is stored.

## Zero-knowledge boundary

The server, at rest, holds: outer-layer-wrapped ciphertext, public keys, KDF
salts, wrapped (sealed) contact private keys and shares, and hash-chained audit
entries. It **never** holds — in storage, a log line, a notification body, or an
audit payload — any plaintext content, passphrase, private key, or unwrapped share.
The AI subsystem sees strictly less than the server does (see `docs/AI.md`): an
allowlisted subset of metadata (counts, closed-enum states, cadence), never content.

## Audit log — tamper-evidence

A per-user hash chain. Each entry: server timestamp, event type, event payload,
previous-entry hash, entry hash (SHA-256 of the canonical encoding), a **server**
Ed25519 signature (non-repudiation), and for sensitive actions an additional
**user** Ed25519 signature (non-forgery). A reviewer verifies: every entry is
server-signed, user-signed entries verify under the published verification key, and
the chain is unbroken. **A compromised server can append but cannot forge
user-signed entries; omission/reordering breaks the chain and is detectable.**

## Contact share wrapping

Each contact generates an X25519 keypair on their own device at enrollment; the
public key is registered, the private key is wrapped by `Argon2id(contact
passphrase)` plus a device-binding key that never leaves the device. A share is
sealed to the contact's public key. During a ceremony the contact authenticates on
their bound device, unwraps their private key, unwraps the share, and contributes
it signed by their Ed25519 affirmation key. **The platform never sees the contact's
passphrase, private key, or unwrapped share.**

## Contact key verification (safety numbers)

Sealing a share to a contact is only as good as knowing the key is theirs, and
that is not something the server can tell you — it is the party serving the key.
So the owner confirms it directly with the contact instead.

Both screens show the same 30-digit code:

```
code = BLAKE2b-256( lp("truecairn/contact-key-fingerprint/v1")
                 || lp(contact_x25519_pubkey)
                 || lp(contact_ed25519_pubkey) )
```

rendered as 6 groups of 5 digits (each group = 5 digest bytes big-endian, mod
100000); `lp(x)` is `u32_be(len(x)) || x`. The owner's client computes it from
what the server served; the contact's computes it from keys their own master key
derives, with nothing from the server involved. **Both** public keys are covered,
so pairing a genuine signing key with a substituted sealing key changes the code
too. Frozen vectors: `packages/crypto/src/vectors/contact-fingerprint.json`.

The owner compares the code with the contact **by phone or in person** — not over
any channel we carry — and confirms. The client then pins the confirmed key
bytes, encrypted under the owner's S1 tier key with AAD binding
`(owner_id, contact_id)`. Consequences:

- The server **cannot forge** a pin: no tier key, so no valid AEAD tag.
- It **cannot transplant** one contact's pin onto another row, or replay a
  removed contact's — the AAD binds both identities.
- It **can delete** one. That degrades to "unverified", which blocks sealing.
  Fail closed, never open.

Sealing takes a token that only the pin check can mint, so an unconfirmed or
changed key cannot be sealed to from any call site. Contact keys are
deterministic from the contact's master key, so they change only on a rotation —
already a sensitive action carrying 7 days' notice. An **unannounced** change is
therefore treated as an attack, not as a prompt to re-confirm.

The honest limit: a code the owner does not actually compare protects nobody, and
we cannot detect that. See `docs/17-residual-risk.md`.

## Recovery

- **Forgot master passphrase** → recover the vault with the offline backup
  **recovery code** (a second Argon2id-wrapped copy of the master key).
- **Lost the release passphrase** → S2 still reconstructs via 2 diverse-role
  contacts; **S3 becomes permanently unrecoverable** (the mask is mandatory and the
  server cannot help). This is by design — the server has no recovery power here.

## What to review / report

The high-value invariants to hold us to (see `SECURITY.md`):
- No plaintext / passphrase / private key / unwrapped share reaches a server code
  path, log, notification, or audit payload.
- Release gates fail closed: below threshold or without diverse-role consensus, no
  advance.
- The KDF/AEAD parameters above match the code (`packages/crypto`).
