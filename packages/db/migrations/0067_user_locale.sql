-- Remember which language a user reads (docs/40 Phase 1).
--
-- WHY THE SERVER HAS TO KNOW. The SPA can remember a language in localStorage,
-- and until now that is all it did — which is per-browser, so the preference did
-- not follow anyone to a second device. That alone would be worth fixing, but it
-- is not the reason this column exists.
--
-- The 13 transactional templates in packages/notifications/src/templates.ts are
-- rendered SERVER-SIDE, by the worker, minutes or months after any browser was
-- involved. There is no request, no session and no Accept-Language header at that
-- moment. A stored value is the only thing that can be read there, so without this
-- column every check-in request, escalation and ceremony notice is permanently
-- English no matter what the app is set to.
--
-- NULLABLE, NOT `DEFAULT 'en'`. NULL means "has never expressed a preference",
-- which is the true state of every account that exists today; a default would
-- record all of them as having CHOSEN English, and that difference stops being
-- cosmetic the first time we want to offer someone the language their browser
-- asks for without overriding a deliberate choice. Same reasoning as the channel
-- matrix, where an absent row means "not decided" rather than a stored default.
-- Readers resolve NULL through DEFAULT_LOCALE in packages/shared/src/locale.ts.
--
-- CHECK, NOT A POSTGRES ENUM — the precedent set by 0060, 0063 and 0065. Adding a
-- third language is then an ALTER of one constraint inside a transaction rather
-- than a type migration with a rewrite and a dependency graph, and languages are
-- expected to be added.
--
-- The vocabulary is LOCALES in packages/shared/src/locale.ts, and
-- locale-lockstep.test.ts fails if the two ever disagree — so a language cannot
-- be added to the code and rejected by the database, which would surface as a
-- constraint violation on someone's settings page rather than as a build error.
--
-- NOT vault content, and nothing here weakens the zero-knowledge boundary: a
-- language tag is the same category of display metadata as display_name (0049),
-- carries nothing about what a vault holds, and the server already necessarily
-- knows an email address to deliver to.

ALTER TABLE users ADD COLUMN locale text;

ALTER TABLE users
  ADD CONSTRAINT users_locale_vocabulary
  CHECK (locale IS NULL OR locale IN ('en', 'es'));
