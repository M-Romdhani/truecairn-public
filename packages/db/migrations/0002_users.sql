-- 0002_users.sql
-- Every human with a Truecairn account has one row here.
-- email is plaintext metadata (we must deliver to it). No vault content lives here.

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  email_lower     text NOT NULL GENERATED ALWAYS AS (lower(email)) STORED,
  account_status  account_status NOT NULL DEFAULT 'pending',
  enrolled_at     timestamptz,
  armed_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_uniq ON users (email_lower);
