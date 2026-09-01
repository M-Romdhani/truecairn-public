# Truecairn threat model (public)

This consolidates the internal threat model (`docs/04`–`docs/17`) into a public
summary and adds the **AI subsystem**. It is written so a stranger reading only
the public repo can judge what Truecairn defends against and how.

## Trust pillars (the invariants)

1. **Client-side encryption** — vault content is encrypted in your browser
   (XChaCha20-Poly1305; Argon2id-derived keys; Shamir for social recovery; nested
   envelopes for S3).
2. **Zero-knowledge server** — the server stores ciphertext, public keys, salts,
   and sealed boxes only. Its one cryptographic power is releasing a TEMPORAL gate
   when the engine + contact consensus say so.
3. **Deterministic, fail-closed release** — the engine and ceremony state machines
   are the sole release authorities. Below threshold or without diverse consensus,
   gates return 403 and the engine does not advance.
4. **Open-source clients** — the client and crypto packages are buildable and
   verifiable against the repo.
5. **Honest documentation** — this file, `docs/AI.md`, and `SECURITY.md` are kept
   accurate to the code.

## Core adversaries & defences (summary)

| Adversary | Defence |
|---|---|
| Compromised server / malicious insider | Zero-knowledge storage; the server never holds plaintext, passphrases, keys, or unwrapped shares. Audit hash chain is server-signed and tamper-evident. |
| **Contact key substitution by the server** — serving the owner a public key the operator holds the secret for, so release shares get sealed to it. Needs no code change, so reproducible builds do not detect it. | Owner-confirmed **safety numbers** compared out of band, then pinned: the client refuses to seal to a key the owner has not confirmed, or to one that changed since. The pin is sealed under the owner's own tier key, so the server can delete it (fails closed) but cannot forge it. Residual: it depends on the owner actually making the call — see `docs/17`. |
| Wrongful / premature release | Fail-closed engine + ceremony gates; threshold + role-diversity consensus; step-up (fresh 2FA + passphrase signature) on sensitive actions; delay + veto windows. |
| Contact collusion | Shamir thresholds with role diversity; the mandatory release-passphrase mask on nested S3 (docs/24) closes the all-contacts-collude gap. |
| Credential stuffing / brute force | Per-IP and per-account rate limits + lockout; step-up TOTP throttle; peppered IP hashes (never raw IPs). |
| Log / notification leakage | Redaction by construction (`apps/api/src/logging.ts`); sensitive fields never enter a log or notification body. |
| Ephemeral-secret misconfig in prod | `config.ts` + `packages/audit/keys.ts` refuse to boot on ephemeral durable secrets. |

## AI subsystem threats

The AI is metadata-only and can only *add* safety. Each AI-specific threat maps to
the §3 control (of `docs/25-ai-guardian-plan.md`) that answers it.

| Threat | Answering control |
|---|---|
| **Prompt injection via metadata** — a hostile string steering the model. | The context builder (§3.2) emits counts + closed enums only — **no free text**; titles/names are ciphertext and never enter a prompt. The only free text is the owner's own assist question, and it can't act: outputs are validated deny-by-default (§3.3). |
| **Model text → action** — the model "deciding" to do something. | Structured-output validation (§3.3): every behaviour-influencing output is JSON validated against a strict closed schema; a failure is discarded and audited (`ai_output_rejected`). No path from unvalidated text to an effect. |
| **Authority escalation** — AI reaching a forward engine event / ceremony advance / gate skip. | The authority chokepoint (§3.1): one module owns every AI effect; `assertAllowedEngineSignal` permits only `review_required`; an import fence stops AI code from reaching engine/ceremony/sensitive-actions directly; permanent asymmetry tests enumerate every engine event. |
| **Model drift / provider change** — a new model that starts obeying injections or emitting un-gateable shapes. | `scripts/ai-live-eval.ts` runs the injection corpus + golden cases against the live model; a provider/model change requires a fresh run + owner sign-off (§11.9). |
| **Provider compromise / data exposure** — what a compromised Gemini could learn. | Only ever the metadata allowlist (counts + enums) — never content, keys, emails, or IPs. Prompts are not persisted (D6). Per-user opt-out and a global kill switch cut the provider off entirely. |
| **Cost exhaustion** — an attacker (or a loop) running up spend. | Per-user + per-IP rate limits (§0.1) and a daily-token cost breaker (§0.2) that fails AI soft while leaving the vault/engine/ceremonies/auth fully functional. |
| **Forensic repudiation** — proving the AI didn't cause a forward event. | Every audit row carries an `actor` (`owner`/`worker`/`ai`); a permanent test proves an `actor='ai'` row can only carry an allowlisted AI event type, none of which is a forward engine event. |
| **AI tighten turned loosen (enqueue→apply TOCTOU)** — an AI action valid at enqueue becomes a loosening by apply time (owner manually lowers the threshold below the AI's pending value during the veto window). | The `change_inactivity_threshold` handler re-checks direction **at apply time**: an AI-initiated action that would not strictly tighten is cancelled fail-closed (`ai_threshold_change_must_tighten`). Owner-initiated changes are unaffected. Pinned by integration tests. |
| **Wrongful release rushed through** (a coerced owner, colluding contacts racing a ceremony). | The **Guardian** (deterministic detectors) emits the fail-closed `review_required` through the chokepoint, PAUSING the release for human review. It can only pause, never advance; a severity-2 ceremony-time anomaly bypasses the cooldown. The LLM never touches the decision. |
| **Guardian abused to freeze a healthy account** (flag-spam as a nuisance). | Detectors run only in release-relevant states (never freezes an `active` account); per-user cooldown (default 7 days) bounds severity-1 flags; golden near-miss tests guard against over-firing. |

## Residual risks

- The `actor` discriminator is defence-in-depth metadata, **not** part of the
  signed canonical hash (adding a field there would invalidate all existing entry
  hashes). Its guarantee rests on the chokepoint being the sole `ai` writer, which
  the import fence + tests enforce.
- Advisory AI outputs (briefing/assist free text) are rendered as React text
  (auto-escaped); they are display-only and reach no action, but they are model
  text and may be wrong — they are never authoritative.
- See `docs/17-residual-risk.md` for the pre-AI residual-risk register.
