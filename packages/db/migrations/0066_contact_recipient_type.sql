-- Recipient type: a SECOND axis over contacts.role (docs/03 implementation, 2 of 3).
--
-- docs/03-release-policy-matrix.md names five recipient types and gives each one
-- a column: spouse/family executor, cofounder/business partner, lawyer/accountant,
-- recovery contact, designated heir. The product has only ever had three ROLES,
-- because role is not a label — it is the collusion bar.
--
-- READ THIS BEFORE WIDENING contact_role. `diverseRoleSatisfied` is a release
-- gate (packages/ceremony/src/transitions.ts) and docs/14 states what it buys: a
-- conspiracy must span "both personal and professional life", which is a
-- materially higher coordination bar than two people who already work together.
-- If the five types had been added to contact_role instead of beside it, a lawyer
-- and a cofounder would read as two distinct roles and satisfy diversity — while
-- sitting in the same sphere of the owner's life, possibly the same firm, possibly
-- introduced to the owner by each other. The rule would keep its letter and lose
-- the thing it protects.
--
-- So this is a separate column. `role` stays the only input to any security
-- decision; `recipient_type` is what the owner sees and what the advisory matrix
-- keys on. packages/shared/src/recipient-type.test.ts pins the mapping down to
-- role as total, and pins that two professional types collapse to one role.
--
-- TEXT + CHECK rather than a Postgres enum, matching 0065's reasoning: a sixth
-- type later is one ALTER of a constraint rather than a type migration.
--
-- NULLABLE, and backfilled to the most conservative type in each existing role:
--
--   personal     → spouse_family_executor
--   professional → cofounder_business_partner
--   recovery     → recovery_contact
--
-- "Most conservative" here means the type whose matrix column receives the LEAST,
-- so a backfilled guess never widens what someone would receive. Within personal,
-- spouse_family_executor and designated_heir are identical in the matrix except
-- that the heir receives asset_inventory at S2 where the spouse gets it at S1 —
-- so the spouse column is the one that never grants earlier access than the heir.
-- Within professional, cofounder receives 3 categories to the lawyer's 4.
--
-- Nullable is load-bearing for the UI: a row the owner has not revisited reads as
-- "not chosen yet" rather than silently claiming they picked the backfilled value.
-- The backfill fills it anyway so nothing is null in practice today; the column
-- stays nullable so a future contact created before the owner answers the question
-- has somewhere honest to sit.

ALTER TABLE contacts
  ADD COLUMN recipient_type text;

UPDATE contacts
   SET recipient_type = CASE role
     WHEN 'personal'     THEN 'spouse_family_executor'
     WHEN 'professional' THEN 'cofounder_business_partner'
     WHEN 'recovery'     THEN 'recovery_contact'
   END
 WHERE recipient_type IS NULL;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_recipient_type_vocabulary
  CHECK (recipient_type IS NULL OR recipient_type IN (
    'spouse_family_executor',
    'cofounder_business_partner',
    'lawyer_accountant',
    'recovery_contact',
    'designated_heir'
  ));

-- The mapping down to role is enforced in code (RECIPIENT_TYPE_ROLE) but also
-- here, so a hand-edit or a future writer cannot put a professional type on a
-- personal-role row and silently change what diversity means for that contact.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_recipient_type_matches_role
  CHECK (
    recipient_type IS NULL
    OR (role = 'personal'     AND recipient_type IN ('spouse_family_executor', 'designated_heir'))
    OR (role = 'professional' AND recipient_type IN ('cofounder_business_partner', 'lawyer_accountant'))
    OR (role = 'recovery'     AND recipient_type = 'recovery_contact')
  );
