-- 0061_contact_key_pin.sql
-- Owner-confirmed pin of a contact's public keys (closes the key-substitution
-- path, docs/15 §5.7.5 Path E).
--
-- The gap this closes: the server distributes contact public keys and the
-- owner's client seals release shares to whatever bytes it receives. One
-- UPDATE against contacts.contact_x25519_pubkey substitutes a key the operator
-- holds the secret for, and the genuine published client seals the share to it.
-- No code changes, so the reproducible build is unaffected. The possession
-- proof does not help — the server is both its issuer and its verifier.
--
-- The fix is a value the OWNER confirmed out of band, stored where the server
-- cannot forge it. Hence the shape of these columns:
--
--   key_pin_ciphertext / key_pin_nonce — the confirmed public-key bytes,
--   XChaCha20-Poly1305 under the owner's S1 TIER KEY, AAD-bound to
--   (owner_user_id, contact_id, pin version). The server holds ciphertext for a
--   key it does not have, exactly as it already does for display_label_*.
--
-- What that buys, precisely:
--   * The server cannot FORGE a pin — no tier key, so no valid AEAD tag.
--   * It cannot TRANSPLANT one contact's pin onto another row, or replay a
--     removed contact's — the AAD binds owner and contact id.
--   * It CAN delete one. That is a denial, not a forgery: the client reads a
--     missing pin as "unverified" and refuses to seal (fail closed, invariant
--     #2). An attacker who wants a share sealed to a substituted key must now
--     get a human to re-confirm a number over a channel the server does not
--     carry.
--
-- Deliberately plaintext: key_pin_confirmed_at. It is metadata the server
-- already has an equivalent of (enrolled_at), the UI needs it to say when the
-- check happened, and putting a timestamp inside the sealed blob would mean
-- decrypting to render a list.
ALTER TABLE contacts
  ADD COLUMN key_pin_ciphertext bytea,
  ADD COLUMN key_pin_nonce bytea,
  ADD COLUMN key_pin_confirmed_at timestamptz;

-- All three together or none. A half-written pin would be indistinguishable
-- from a tampered one, and the client would have to guess which it was looking
-- at; the constraint means that state cannot reach the client at all.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_key_pin_complete CHECK (
    (key_pin_ciphertext IS NULL AND key_pin_nonce IS NULL AND key_pin_confirmed_at IS NULL)
    OR
    (key_pin_ciphertext IS NOT NULL AND key_pin_nonce IS NOT NULL AND key_pin_confirmed_at IS NOT NULL)
  );
