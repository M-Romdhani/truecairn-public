-- 0001_enums.sql
-- Postgres ENUM types for every closed value set in the schema.
-- Keep in lockstep with packages/shared/src/enums.ts.

CREATE TYPE account_status AS ENUM (
  'pending',
  'active',
  'locked',
  'recovery',
  'terminated'
);

CREATE TYPE contact_role AS ENUM ('personal', 'professional', 'recovery');

CREATE TYPE contact_status AS ENUM (
  'invited',
  'pending_keygen',
  'enrolled',
  'active',
  'rotating',
  'removed'
);

CREATE TYPE vault_tier AS ENUM ('s1', 's2', 's3');

CREATE TYPE engine_state AS ENUM (
  'pre_active',
  'active',
  'check_in_pending',
  'notification_stalled',
  'escalation_pending',
  'release_review',
  'limited_release',
  'staged_release',
  'full_release',
  'returning',
  'review_required'
);

CREATE TYPE ceremony_status AS ENUM (
  'initiated',
  'collecting_affirmations',
  'awaiting_outer_key',
  'reconstructing',
  'released',
  'cancelled',
  'failed'
);

CREATE TYPE affirmation_status AS ENUM (
  'pending', 'tentative', 'committed', 'revoked'
);

CREATE TYPE sensitive_action_type AS ENUM (
  'rotate_master_passphrase',
  'rotate_release_passphrase',
  'rotate_recovery_code',
  'add_contact',
  'remove_contact',
  'change_contact_role',
  'rotate_contact',
  'change_release_threshold',
  'change_tier_configuration',
  'change_inactivity_threshold',
  'change_cooldown_window',
  'register_hardware_key',
  'remove_hardware_key',
  'change_email',
  'arm_engine',
  'delete_account'
);

CREATE TYPE sensitive_action_status AS ENUM (
  'pending', 'applied', 'cancelled', 'expired'
);

CREATE TYPE notification_channel_type AS ENUM ('email', 'sms', 'push', 'webhook');

CREATE TYPE notification_channel_health AS ENUM ('healthy', 'degraded', 'failing');

CREATE TYPE notification_purpose AS ENUM (
  'check_in_request',
  'escalation_request',
  'sensitive_action_notice',
  'ceremony_initiation',
  'ceremony_affirmation_request',
  'ceremony_revocation_window',
  'engine_state_change',
  'contact_invitation',
  'health_probe'
);

CREATE TYPE delivery_status AS ENUM (
  'queued', 'sending', 'sent', 'delivered', 'confirmed', 'bounced', 'failed'
);

CREATE TYPE share_type AS ENUM (
  'contact',
  'release_passphrase',
  'hardware_key',
  'second_professional_contact'
);

-- pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
