-- Give vault_items.category a vocabulary (docs/03 implementation, part 1 of 3).
--
-- The column shipped as free `text NOT NULL` and has an index on
-- (user_id, category), so it was always meant to be queried by — but nothing ever
-- fixed what could go in it. A repo-wide grep finds exactly two values anywhere
-- outside test fixtures, which is another way of saying the product never asked
-- the user for one.
--
-- That matters because docs/03-release-policy-matrix.md, ratified July 2026, is
-- written as an eight-row table keyed on precisely this column: category ×
-- recipient type → release tier. With category untyped the matrix had no row
-- axis, so it stayed a document while owners assigned S1/S2/S3 by hand with no
-- guidance. The failure that permits is quiet and terminal — the wrong material
-- reaching the wrong person at release, discovered when the one person who could
-- have corrected it is gone.
--
-- The eight values are docs/03's rows, unchanged, so the doc and the constraint
-- cannot disagree on the vocabulary.
--
-- NOT a crypto format change. `category` appears in neither buildOuterLayerAad
-- (user_id, tier, kek_id, generation) nor the item-identity AAD of migration
-- 0062, so this does not touch aadVersion and no ciphertext is affected. It is a
-- label, and this migration only bounds which labels are legal.
--
-- CHECK rather than a Postgres enum, same reasoning as 0060 and
-- 0063_channel_destination_hash_check: adding a ninth category later is then an
-- ALTER of one constraint inside a transaction, not a type migration with a
-- rewrite and a dependency graph.
--
-- The backfill is deliberately conservative. Any row holding a value outside the
-- set is moved to 'personal_archive' — the category docs/03 places at S3 for the
-- two recipient types that may see it at all, and therefore the narrowest
-- distribution the matrix offers. An unrecognised label is by definition one
-- whose intended audience we cannot infer, and the safe direction for an unknown
-- is later and narrower, never sooner and wider.

UPDATE vault_items
   SET category = 'personal_archive'
 WHERE category NOT IN (
   'recovery_instructions',
   'operational_playbooks',
   'asset_inventory',
   'identity_documents',
   'financial_accounts',
   'legal_documents',
   'crypto_wallets',
   'personal_archive'
 );

ALTER TABLE vault_items
  ADD CONSTRAINT vault_items_category_vocabulary
  CHECK (category IN (
    'recovery_instructions',
    'operational_playbooks',
    'asset_inventory',
    'identity_documents',
    'financial_accounts',
    'legal_documents',
    'crypto_wallets',
    'personal_archive'
  ));
