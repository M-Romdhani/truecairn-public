-- 0007_audit_log.sql
-- Hash-chained, append-only audit log. UPDATE/DELETE are blocked by triggers
-- AND should be revoked at the role level when an application role is created
-- (deferred until we have role provisioning). audit_log_locks is used by app
-- code via SELECT ... FOR UPDATE to serialize concurrent inserts per user so
-- the seq / prev_entry_hash chain stays consistent.

CREATE TABLE audit_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  seq               bigint NOT NULL,
  event_type        text NOT NULL,
  event_payload     jsonb NOT NULL,
  prev_entry_hash   bytea,
  entry_hash        bytea NOT NULL,
  server_signature  bytea NOT NULL,
  server_key_id     text NOT NULL,
  user_signature    bytea,
  server_timestamp  timestamptz NOT NULL DEFAULT now(),
  client_timestamp  timestamptz,
  UNIQUE (user_id, seq)
);

CREATE INDEX audit_log_user_time ON audit_log (user_id, server_timestamp);

CREATE TABLE audit_log_locks (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION audit_log_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();

CREATE OR REPLACE FUNCTION audit_log_verify_chain() RETURNS trigger AS $$
DECLARE
  last_seq  bigint;
  last_hash bytea;
BEGIN
  SELECT seq, entry_hash
    INTO last_seq, last_hash
    FROM audit_log
   WHERE user_id = NEW.user_id
   ORDER BY seq DESC
   LIMIT 1;

  IF last_seq IS NULL THEN
    IF NEW.seq <> 1 THEN
      RAISE EXCEPTION 'audit_log first seq for user % must be 1, got %', NEW.user_id, NEW.seq;
    END IF;
    IF NEW.prev_entry_hash IS NOT NULL THEN
      RAISE EXCEPTION 'audit_log first row for user % must have NULL prev_entry_hash', NEW.user_id;
    END IF;
  ELSE
    IF NEW.seq <> last_seq + 1 THEN
      RAISE EXCEPTION 'audit_log seq out of order for user %: expected %, got %',
        NEW.user_id, last_seq + 1, NEW.seq;
    END IF;
    IF NEW.prev_entry_hash IS DISTINCT FROM last_hash THEN
      RAISE EXCEPTION 'audit_log prev_entry_hash mismatch for user %', NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_verify_chain_trg
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_verify_chain();
