-- 0019_auth_and_sessions.sql
-- Phase 3 deliverable 3.1 — auth & sessions. Per PHASE3_1_AUTH_PROPOSAL.md
-- (Revision 2, approved 2026-05-29). Two authorization layers that must never
-- be conflated: a SESSION (login credential -> API access, server-verified) is
-- distinct from the MASTER PASSPHRASE (client-side key derivation, never
-- server-seen). These tables back the SESSION layer only — no vault key
-- material lives here.
--
-- New numbered file per the migration-discipline rule (docs/19): migration 0010
-- defined sensitive_actions.requested_by_session_id as a nullable forward-ref
-- with no FK and no writer; this migration finally points it at sessions(id).

-- ── sessions ─────────────────────────────────────────────────────────────────
-- Opaque 256-bit token; the server stores only SHA-256(token). Validity is
-- COMPUTED (revoked_at IS NULL AND now() < idle_expires_at AND now() <
-- absolute_expires_at) — no status enum, same soft-delete-via-timestamp
-- convention as device_registrations / release_shares.
CREATE TABLE sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash              bytea NOT NULL,        -- SHA-256(opaque 256-bit token)
  device_registration_id  uuid REFERENCES device_registrations (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  idle_expires_at         timestamptz NOT NULL,  -- sliding; bumped on use
  absolute_expires_at     timestamptz NOT NULL,  -- hard cap regardless of activity
  last_stepup_at          timestamptz,           -- last fresh-second-factor proof
  created_ip_hash         bytea,                 -- salted; anomaly detection, never raw IP
  user_agent              text,
  revoked_at              timestamptz,
  revoked_reason          text
);
CREATE UNIQUE INDEX sessions_token_hash_uniq ON sessions (token_hash);
CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

-- ── sensitive_actions.requested_by_session_id FK ─────────────────────────────
-- The column has existed (nullable, no writer) since 0010. ON DELETE SET NULL,
-- never CASCADE: revoking or deleting a session must NEVER delete a pending
-- sensitive action — the 7-day cooldown is the load-bearing control, not the
-- session (PHASE3_1_AUTH_PROPOSAL §"(f)"). A pending action whose origin session
-- was later purged simply has a null origin; it still runs out its cooldown.
ALTER TABLE sensitive_actions
  ADD CONSTRAINT sensitive_actions_requested_by_session_fk
  FOREIGN KEY (requested_by_session_id) REFERENCES sessions (id) ON DELETE SET NULL;

-- ── webauthn_credentials ─────────────────────────────────────────────────────
-- Both roles of the account OWNER's authenticators: passkeys (primary login)
-- and roaming hardware keys (is_hardware_key = true, the step-up tap). Distinct
-- from release_shares.hardware_key_id, which is a hardware key holding a Shamir
-- SHARE — release crypto, not auth.
CREATE TABLE webauthn_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id   bytea NOT NULL,            -- WebAuthn credential id (raw)
  public_key      bytea NOT NULL,            -- COSE public key
  sign_count      bigint NOT NULL DEFAULT 0, -- clone detection (regression => flag)
  transports      text[],
  aaguid          bytea,
  is_hardware_key boolean NOT NULL DEFAULT false,
  nickname        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE UNIQUE INDEX webauthn_credentials_credential_id_uniq
  ON webauthn_credentials (credential_id) WHERE revoked_at IS NULL;
CREATE INDEX webauthn_credentials_user
  ON webauthn_credentials (user_id) WHERE revoked_at IS NULL;

-- ── password_credentials (optional fallback factor; NEVER standalone) ─────────
-- Argon2id PHC string of the LOGIN password (!= master passphrase; unlocks no
-- keys). A password login ALWAYS also requires a TOTP code.
CREATE TABLE password_credentials (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  argon2_phc   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── totp_credentials ─────────────────────────────────────────────────────────
-- Secret encrypted at rest under a server KEK. NOT zero-knowledge (the server
-- must verify codes) — acceptable because TOTP gates SESSION auth only and
-- never touches vault keys.
CREATE TABLE totp_credentials (
  user_id           uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret_ciphertext bytea NOT NULL,
  secret_nonce      bytea NOT NULL,
  confirmed_at      timestamptz,     -- null until first verified code
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── auth_challenges (single-use, short-lived) ────────────────────────────────
-- WebAuthn register/auth and the step-up signature each need a server-issued
-- challenge consumed atomically on verification. user_id is nullable for
-- usernameless / discoverable login.
CREATE TABLE auth_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  purpose     text NOT NULL,        -- 'webauthn_register' | 'webauthn_auth' | 'stepup_signature'
  challenge   bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL, -- short, e.g. 5-10 min
  consumed_at timestamptz
);
CREATE INDEX auth_challenges_lookup
  ON auth_challenges (user_id, purpose) WHERE consumed_at IS NULL;

-- ── auth_attempts (rate-limit / lockout accounting) ──────────────────────────
-- Sliding-window failure counting for the brute-forceable surfaces. Keyed on
-- both ip_hash and identifier; unknown identifiers still record an attempt and
-- take the same code path so a 401/429 never reveals account existence
-- (enumeration discipline, PHASE3_1_AUTH_PROPOSAL §"(e)").
CREATE TABLE auth_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL,    -- 'login' | 'totp' | 'recovery_code'
  identifier   text NOT NULL,    -- email_lower or user_id; what we throttle on
  ip_hash      bytea,
  succeeded    boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_window ON auth_attempts (scope, identifier, attempted_at);
