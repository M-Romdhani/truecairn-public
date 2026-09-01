# @truecairn/crypto

Phase 2 deliverable 1: the libsodium wrapper.

This package is the **only** place in the codebase that calls cryptographic
primitives. Every other module reaches for ciphertext, signatures, key
material, and Shamir shares through the explicit interfaces here.

## Design rules (locked for Phase 2)

1. **No optimizations.** Boring, obvious, 1:1 with `/docs/18-crypto-architecture.md`. No key caching, no batching, no early-exit tricks. Performance gets measured and tuned later; correctness is the only thing that matters in this phase.
2. **Known-answer test vectors, not round-trips.** Every operation has a test that loads a published or frozen KAT and verifies the actual output bytes match. Round-trip-only tests are insufficient — they would not catch a wrong cipher mode.
3. **Same wrapper, server + client.** All primitives run via `libsodium-wrappers-sumo` (WebAssembly). The Phase 4 client uses the identical wrapper; no native bindings.
4. **Sync after init.** Call `initCrypto()` once at process start (it awaits libsodium's WASM ready promise). After that, every wrapper function is synchronous.

## Why `libsodium-wrappers-sumo` rather than `libsodium-wrappers`

`libsodium-wrappers` (the minimal variant) ships only the "safe and commonly used" subset of the Sodium surface. It excludes `crypto_pwhash` (Argon2id), `crypto_sign_seed_keypair`, several KDF primitives, and others we need or expect to need in later deliverables. `libsodium-wrappers-sumo` exposes the full Sodium API with no other functional differences — same WASM core, same portability, same browser-and-Node compatibility. Using sumo from day one avoids a confusing "which variant am I using here?" question later.

A separate issue: as of 0.7.16, both variants ship a broken ESM dist (the published `modules-esm/*.mjs` file imports a sibling that isn't in the package's `files` manifest). `src/init.ts` works around this by loading the CJS build via `createRequire` from the ESM context.

## Operation surface

| Operation | Spec ref | KAT source |
|---|---|---|
| XChaCha20-Poly1305 AEAD encrypt/decrypt | docs/18 §"Symmetric encryption" | IETF `draft-irtf-cfrg-xchacha-03` Appendix A.3.1 |
| Argon2id KDF (256 MiB / 4 ops / parallelism 1) | docs/18 §"Key derivation" | Frozen libsodium output + low-params KAT (see kdf.test.ts) |
| X25519 keypair + scalarmult | docs/18 §"Asymmetric encryption" | RFC 7748 §5.2 (Alice/Bob) |
| X25519 sealed box encrypt/decrypt | docs/18 §"Contact share wrapping" | Frozen libsodium fixture + structural assertion |
| Ed25519 sign + verify | docs/18 §"Signatures" | RFC 8032 §7.1 Test 1 + Test 2 |
| Shamir over GF(256) split + combine | docs/18 §"Secret sharing" | GF(256) field KAT (FIPS 197 §4.2) + fixed-seed share fixture |

## Vector sources, with caveats

- **IETF/RFC vectors** (XChaCha20-Poly1305, X25519, Ed25519) are independent authoritative KAT. A successful match proves the underlying primitive is wired correctly.
- **Argon2id**: libsodium's `crypto_pwhash` does not expose the `secret` / `ad` inputs that the RFC 9106 vectors use, so the RFC vectors cannot be used directly. Two tests instead:
  1. Low-params test against a frozen reference output (see comment in `kdf.test.ts` for the regenerable CLI command).
  2. Production-params test (256 MiB / 4 / 1) against a frozen output to catch accidental parameter changes.
  Neither is fully independent. Full Argon2id correctness verification requires a separate Argon2id implementation in pre-deployment QA.
- **Sealed box**: `crypto_box_seal` uses an ephemeral X25519 keypair generated at encryption time, so the ciphertext is non-deterministic. Tests cover (a) decryption of a frozen ciphertext yields known plaintext, (b) ciphertext structure (length = 32 + payload + 16).
- **Shamir**: GF(256) field arithmetic is independently KAT-able (FIPS 197 §4.2 gives `0x57 · 0x83 = 0xc1`). End-to-end share/combine is tested via a fixed-seed PRNG.

## What this package does NOT do

- Key material management (master key, per-tier keys, outer-layer keys) — that is `@truecairn/keys`, deliverable 2 of Phase 2.
- Release ceremony orchestration — that is deliverable 3 of Phase 2.
- Audit-log signing — that lives in `@truecairn/audit` and uses Node's built-in Ed25519, not this package. (Phase 1 design choice; can be unified later if useful.)
