-- 0049_user_profile.sql
-- Optional display name + honorific ("Mr.", "Mrs.", …) shown in the account
-- menu. Pure display metadata, the same category as the email already stored in
-- this table — never used for auth, crypto, or release, and never a share/key/
-- passphrase, so this crosses no zero-knowledge boundary. Both columns are
-- nullable: an account that has set neither falls back to its email in the UI.

ALTER TABLE users ADD COLUMN display_name text;
ALTER TABLE users ADD COLUMN title        text;
