# 20 — Server-Side Credential Storage

Companion to `18-crypto-architecture.md`. Where `18` specifies the **client-side**
zero-knowledge key hierarchy (master passphrase → master key → tier/item keys,
never server-seen), this document specifies the **server-side** credentials that
gate **session authentication** — the login layer that is deliberately *separate*
from the vault-crypto layer (`PHASE3_1_AUTH_PROPOSAL §0`, threat 5.2.2).

The distinction is load-bearing: a login credential gets you API access (the
dashboard); it never derives a vault key. So the parameters and storage choices
here optimise for an *online, server-verified* secret, which is a different
problem from the *offline-derived* master passphrase.

## Password (login fallback factor)

- **Primitive:** Argon2id, via `@truecairn/crypto`'s `deriveKey` — the **same KDF
  wrapper** used everywhere else. There is no separate password-hashing library
  and no hand-rolled hashing.
- **Parameters:** libsodium **INTERACTIVE** cost (`opslimit = 2`,
  `memlimit = 64 MiB`) — **not** the master passphrase's PRODUCTION cost
  (`opslimit = 4`, `memlimit = 256 MiB`, `01-decisions-locked.md`).
- **Why the difference:**
  - The master passphrase is derived **client-side**, infrequently, on the
    user's own device — 256 MiB is a one-device, occasional cost paid by the
    owner, and a high bar is desirable because it guards offline brute-force of
    the vault.
  - The login password is verified **server-side on every login attempt**.
    Running 256 MiB Argon2id per attempt is a memory-exhaustion DoS vector:
    256 MiB × concurrent attempts exhausts host memory. INTERACTIVE is
    libsodium's documented preset for exactly this online-verification use.
  - Proportionality also fits the threat model: the login password is **never a
    standalone credential** — it is always paired with TOTP, and is hard-blocked
    entirely when a passkey is registered (Q9). It is one factor in a layered
    gate, not the sole guard of anything.
- **Encoding (stored in `password_credentials.argon2_phc`):**
  `v1$<opslimit>$<memlimit>$<saltB64url>$<hashB64url>`. The parameters travel
  **with** each hash, so a cost change is a per-row decision verifiable without
  a schema migration.
- **Rehash-on-verify:** on a *successful* login, if the stored hash's parameters
  differ from the current login cost (`needsRehash`), the password is
  re-hashed with current parameters and stored. A future cost increase (because
  hardware got faster) therefore drains **organically** as users log in — no
  forced rehash sweep, no flag day.
- **Constant-time enumeration defence:** an unknown email (or an account with no
  password row) runs the **full Argon2id verify against an in-memory sentinel
  hash** (`SENTINEL_PASSWORD_HASH`), never a DB lookup for the hash. The only
  timing cost is the constant derive, so a `401` carries no account-existence
  signal — there is no fast path whose absence would leak "this email exists."

## TOTP secret

- **Primitive:** RFC 6238 TOTP (HMAC-SHA-1, 6 digits, 30 s period); verification
  checks the **current and previous** window (30 s drift tolerance).
- **At rest:** the 160-bit secret is encrypted with **XChaCha20-Poly1305**
  (`@truecairn/crypto` `secretbox`) under a **server KEK**.
- **Honest non-zero-knowledge note:** TOTP is **not** zero-knowledge — the server
  holds the secret and can mint codes, because it must verify them. This is
  acceptable *precisely because* TOTP gates **session** auth only and never
  touches vault keys: a server compromise that exposes TOTP secrets cannot
  decrypt any vault content.
- **KEK versioning:** each row records `totp_credentials.kek_id` — the id of the
  KEK that wrapped that secret. The server may hold several KEKs at once: a
  `current` KEK that wraps new secrets, plus prior KEKs retained only to
  *decrypt* not-yet-migrated rows. On a **successful verify**, a secret found on
  a non-current KEK is transparently re-encrypted under the current KEK. A KEK
  rotation is therefore a **background re-encrypt-on-verify migration** that
  drains as users authenticate — *not* a forced TOTP re-enrolment. This matters
  in the scenario where you would actually rotate: suspected server compromise,
  i.e. incident response, where forcing every user to re-enrol TOTP would be
  operationally catastrophic. A row whose `kek_id` is unknown to the running
  server **fails closed** (cannot decrypt ⇒ cannot verify).

## Session tokens

- 256-bit opaque CSPRNG token; the server stores only `SHA-256(token)`. A
  256-bit input space defeats rainbow tables, so a fast hash is correct here — no
  salt or slow KDF (`PHASE3_1_AUTH_PROPOSAL §1`). Validity is computed
  (`revoked_at IS NULL AND now() < idle_expires_at AND now() <
  absolute_expires_at`), never stored as a status.

## Step-up signature (fresh-passphrase proof)

- The tier-2 step-up gate requires an **Ed25519 signature** by the user's audit
  signing key (derived client-side from the master passphrase; public half in
  `user_key_material.audit_signing_pubkey`) over a canonical payload:
  `0x01 || lp("truecairn.stepup.v1") || uuid16(user_id) || lp(action_type) ||
  challenge(32) || lp(canonical_json(action_params))`. The `lp`, `uuid16`, and
  `canonical_json` encoders are **reused from `@truecairn/audit`** — there is no
  second canonical encoding.
- This signature signs the **step-up payload**, which is a *different message*
  from an audit entry's `entry_hash`. It is therefore recorded in the gated
  action's audit **payload** (server-signed, so the hash chain stays verifiable),
  **not** stored as `audit_log.user_signature` — putting a non-`entry_hash`
  signature in that column would break `verifyChain`.

### Deferred: chain-bound user-signed step-up entries

`PHASE3_1_AUTH_PROPOSAL §c` originally envisioned the step-up signature being
stored as the entry's `user_signature`. We did **not** do that, for the reason
above. The current state and its limitation, stated plainly for a future
auditor:

- **What we have (V1):** the step-up signature lives in the gated action's audit
  *payload*. The server signs the entry (so the chain verifies and is
  tamper-evident), and the user's signature over the step-up payload is present
  and bound to the action — but it is **not** verified by `verifyChain` as a
  chain-position-bound `user_signature`. A server that fabricated a step-up event
  would produce a verifiable *server* signature; it could not forge the *user's*
  step-up signature (it lacks the key), but the user signature is not woven into
  the hash chain.
- **The limitation:** `docs/18`'s strongest property — "a compromised server
  cannot forge user-signed entries" *as chain-bound entries* — does not yet
  extend to step-up events. They are user-signed-in-payload, server-bound-in-chain.
- **The path (if an external audit asks for it):** a two-phase or
  predict-the-context append. The append-only `audit_log` (no-UPDATE trigger)
  forbids the naive "INSERT then UPDATE user_signature". Instead the client
  pre-computes the next chain context — it learns the current head `(seq,
  prev_entry_hash)`, reconstructs the canonical entry bytes the server will
  insert, and signs **a commitment that binds both the step-up payload and that
  predicted `entry_hash`** — so a valid `user_signature` can be supplied *at
  INSERT*, with the server rejecting the insert if the head moved (the audit lock
  already serialises per-user appends, making the window race-free). This was
  scoped out of 3.1 to avoid a client/round-trip protocol change; it is the
  documented upgrade path, not a silent gap.

## Server-held secrets — production handling

The login/TOTP/audit server secrets share one operational lane, tracked in
`19-implementation-handoff.md §"Things to track separately"`:

- `SERVER_AUDIT_SIGNING_KEY` — Ed25519 audit signing key.
- `TOTP_KEK` (+ optional `TOTP_KEK_PREVIOUS`) — TOTP secret KEK(s).

In development each is generated per-process if unset, with a loud stderr
warning, because an ephemeral key means the dependent data (audit signatures /
TOTP secrets) does not survive a restart. **Production must load all of them from
a secrets manager** so they persist across restarts and so KEK rotation is a
managed event.

The vault (Phase 3.3) adds one more secret on the same lane:

- `OUTER_LAYER_KEK` (+ optional `OUTER_LAYER_KEK_PREVIOUS`) — the platform KEK
  that wraps the per-tier outer-layer keys. Held in the **API and worker** tier
  (the API wraps/unwraps on store/fetch during ACTIVE; the worker re-wraps on a
  tier move and is the only path that releases the key into a ceremony). HSM-backed
  in production. The id is derived from the key, so the API and worker MUST be
  given the **same value** — the API stores `kek_id`, the worker looks it up.

## Operations

- **`OUTER_LAYER_KEK` must be set in the worker environment** for the
  `set_vault_item_tier` handler to apply (it re-wraps content under the
  destination tier's outer key). A missing KEK causes tier-move actions to remain
  **pending with retry** — never cancelled, never applied with a wrong key.
  Cancellation requires explicit user action. The worker logs
  `worker.no_outer_layer_kek` at startup when the ring is empty.

- **Attachment blobs go through a `BlobStore` (`ATTACHMENTS_BACKEND`).** With the
  default `local` backend the API streams uploaded blobs to
  `<ATTACHMENTS_DIR>/<user_id>/<attachment_id>.bin` and the `purge_attachment`
  handler (worker) deletes them there — so `ATTACHMENTS_DIR` must be set and
  identical in both. With `ATTACHMENTS_BACKEND=s3` (the `S3_*` set) the same
  `<user_id>/<attachment_id>.bin` key lives in an S3-compatible bucket instead, so
  the API and worker no longer share a disk. Either way the blob is opaque client
  ciphertext the server never crypto-processes, and the gate is inherited from the
  parent vault item. A missing/misconfigured store makes purge actions remain
  **pending with retry** rather than deleting the DB row while orphaning the blob
  (the DB row is the durable state; the blob is best-effort, so an already-gone
  blob is a successful purge).
