-- 0021_auth_rate_limit.sql
-- Rate limiting + lockout (PHASE3_1_AUTH_PROPOSAL §5; the 3.1 tail). The
-- auth_attempts table itself already exists (migration 0019); this adds the two
-- things §5 needs on top of it.

-- (1) Per-IP failure counting — the fast-probe-many-emails defense (a single IP
-- hammering many emails one or two times each). 0019's index is keyed by
-- identifier (per-account); per-IP counting needs an index keyed by ip_hash.
CREATE INDEX auth_attempts_ip_window ON auth_attempts (scope, ip_hash, attempted_at);

-- (2) Durable account lock. account_status flips to 'locked' after too many
-- failures (the enum value has existed since 0001); locked_until carries the
-- automated-unlock time. Manual unlock (support) = clear locked_until + set
-- account_status back to 'active'; automated unlock = locked_until elapses and
-- the next access auto-clears it.
ALTER TABLE users ADD COLUMN locked_until timestamptz;
