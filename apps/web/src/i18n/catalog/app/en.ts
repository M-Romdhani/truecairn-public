// The APP catalog — every string on an authenticated screen (docs/40 Phase 2).
//
// SPLIT FROM THE SITE CATALOG BY SURFACE, not by taste. The public pages load
// eagerly (main.tsx keeps the landing bundle deliberately lean), and before this
// split the landing would have downloaded all ~770 product-UI keys to render
// copy it never shows. This half loads with AuthedApp — the same lazy boundary
// that already keeps libsodium off the landing.
//
// Merged into the SAME i18next namespace at runtime (see loadAppCatalog in
// ../index.ts), so nothing about how a screen calls t() changes: the split is a
// delivery decision, not a naming one.
//
// The English catalog — the SOURCE language (docs/40 Phase 0).
//
// Every string the product says is authored here first; every other catalog is a
// translation OF this file and falls back to it key by key. That makes this the
// one place to read to know what the app says, and it makes `MessageKey` below
// the closed set of things it CAN say.
//
// FLAT, DOTTED KEYS — NOT NESTED OBJECTS. i18next nests on '.' by default; this
// catalog turns that off (`keySeparator: false` in ../index.ts) and keeps one
// level. The reason is grep: `t('auth.login.heading')` in a component finds its
// string here with the same search string, which a nested catalog breaks. The
// dots are a naming convention — screen.section.item — and nothing more.
//
// KEYS DESCRIBE THE PLACE, NOT THE WORDS. `auth.login.submit`, never
// `auth.login.signIn`: a key named after its current English text becomes a lie
// the first time the copy is reworded, and the rename never happens.
export const appEn = {
  // ── Shared across the auth screens ────────────────────────────────────────
  'auth.field.email': 'Email',
  'auth.tagline': 'Continuity for your digital life. Encrypted on your device.',

  // ── Sign in ───────────────────────────────────────────────────────────────
  'auth.login.heading': 'Sign in',
  'auth.login.lede': 'Sign in with your passkey, then unlock your vault with your master passphrase.',
  'auth.login.submit': 'Sign in with your passkey',
  'auth.login.submitBusy': 'Signing in…',
  'auth.login.waiting':
    "Waiting for your device's passkey prompt — this can take a little while. Don't refresh; you can cancel below.",
  'auth.login.cancel': 'Cancel and try again',
  'auth.login.switchPrompt': 'New to Truecairn?',
  'auth.login.switchLink': 'Create an account',
  'auth.login.error.timeout':
    'Sign-in timed out waiting for your passkey. Try again, or use a different device/browser.',
  'auth.login.error.generic': 'We could not sign you in. Please try again.',

  // ── Create account ────────────────────────────────────────────────────────
  'auth.register.heading': 'Create your account',
  'auth.register.lede':
    'Your vault is encrypted on your device. We only ever hold ciphertext — never your keys.',
  'auth.register.submit': 'Create account with a passkey',
  'auth.register.submitBusy': 'Creating…',
  'auth.register.switchPrompt': 'Already have an account?',
  'auth.register.switchLink': 'Sign in',
  'auth.register.error.conflict': 'An account with this email already exists — sign in instead.',
  'auth.register.error.generic': 'We could not create your account. Please try again.',

  // ── Unlock ────────────────────────────────────────────────────────────────
  'auth.unlock.heading': 'Unlock your vault',
  'auth.unlock.lede':
    'Enter your master passphrase. It never leaves this device — it derives your keys here.',
  'auth.unlock.field.passphrase': 'Master passphrase',
  'auth.unlock.submit': 'Unlock',
  'auth.unlock.submitBusy': 'Unlocking…',
  'auth.unlock.deriving': 'Deriving your keys on this device — this can take a few seconds.',
  // Two DIFFERENT failures, deliberately worded so they cannot be confused. See
  // the long comment in Unlock.tsx: telling someone holding the correct
  // passphrase that it was wrong is the worst false alarm this product has, and
  // it invites the one destructive response. A translator must keep them
  // distinct — "not the problem" is the load-bearing clause in the first.
  'auth.unlock.error.memory':
    'This device ran out of memory while unlocking — your passphrase was not the problem. Close other tabs or apps (or try another browser), then press Unlock again.',
  'auth.unlock.error.passphrase': 'That passphrase did not unlock your vault.',
  // The recovery route, named on the one screen where someone reaches for it
  // (QA 2026-08-26 F2). Deliberately always visible, not revealed after a failed
  // attempt: a person who has genuinely forgotten their passphrase may never
  // guess wrong at all — they simply stop, and until now nothing on this page
  // told them there was another way in.
  'auth.unlock.recoveryPrompt': 'Lost your passphrase?',
  'auth.unlock.recoveryLink': 'Use your recovery code',

  // ── Recover (redeem the recovery code) ────────────────────────────────────
  'auth.recover.heading': 'Unlock with your recovery code',
  'auth.recover.lede':
    'The 64-character code you were given when you created your vault. Like your passphrase, it is used here on this device and never sent to us.',
  'auth.recover.field.code': 'Recovery code',
  'auth.recover.field.hint':
    'Spaces and line breaks are fine — paste or type it however you wrote it down.',
  'auth.recover.submit': 'Unlock vault',
  'auth.recover.submitBusy': 'Unlocking…',
  'auth.recover.deriving': 'Deriving your keys on this device — this can take a few seconds.',
  // THREE distinct failures, and keeping them distinct is load-bearing. "Doesn't
  // look right" means you mistyped it just now and can fix it; "did not unlock"
  // means the code itself is not the one for this vault, which is far worse news
  // and must not be shown for a typo. The memory case is the Unlock.tsx false
  // alarm, and it is worse here — someone told their correct recovery code is
  // wrong has no third credential left to try.
  'auth.recover.error.format':
    'That does not look like a recovery code. It is 64 characters long and uses only the digits 0–9 and the letters a–f. Check for a missing or extra character.',
  'auth.recover.error.code': 'That recovery code did not unlock this vault.',
  'auth.recover.error.memory':
    'This device ran out of memory while unlocking — your recovery code was not the problem. Close other tabs or apps (or try another browser), then try again.',
  // Said before they succeed as well as after, because it changes what they do
  // with the code next. Recovery unlocks; it does not re-key.
  'auth.recover.afterwards':
    'This unlocks your vault now. It does not change your passphrase, so keep this code somewhere safe — for the moment it stays the way back in.',
  'auth.recover.backToUnlock': 'Back to unlocking with your passphrase',

  // ── Vault: the item list ──────────────────────────────────────────────────
  'vault.list.heading': 'Your vault',
  'vault.list.loading': 'Loading…',
  // A PLURAL PAIR. Called as t('vault.list.count', { count: n }); i18next picks
  // the suffix. Never assemble this from a number plus a translated noun — the
  // agreement rules differ by language and the English shape does not survive.
  'vault.list.count_one': '{{count}} item',
  'vault.list.count_other': '{{count}} items',
  // SEARCH IS LOCAL AND THE PLACEHOLDER SAYS SO. Titles arrive as ciphertext and
  // are decrypted in the browser, so filtering happens over rows already in
  // memory and the query string never leaves the device. That is a fact about
  // how it is built, not a reassurance — keep the wording concrete.
  'vault.create.close': 'Close',
  'vault.list.searchLabel': 'Search titles',
  'vault.list.searchPlaceholder': 'Decrypted on this device',
  'vault.list.countFiltered': '{{shown}} of {{total}} shown',
  'vault.list.emptySearch':
    'Nothing matches “{{q}}”. <clear>Clear the search</clear> to see every item.',
  'vault.list.expand': 'Details',
  'vault.list.collapse': 'Hide',
  'vault.list.added': 'Added {{date}}',
  'vault.list.updated': 'Last changed {{date}}',
  'vault.list.reorder': 'Drag to reorder',
  'vault.list.sealedNote':
    'The content is still sealed. Opening it decrypts on this device only — nothing is fetched in the clear.',
  'vault.list.decrypt': 'Decrypt content',
  'vault.list.decrypting': 'Decrypting…',
  'vault.list.decryptError': 'We could not decrypt this item on this device.',
  'vault.list.contentLabel': 'item content',
  'vault.list.reseal': 'Re-seal',
  'vault.list.openFull': 'Open full item',
  'vault.list.filterLabel': 'Filter by tier',
  'vault.list.allTiers': 'All tiers',
  'vault.list.error': 'We could not load your vault.',
  'vault.list.emptyAll': 'No items yet. Create your first one above — it is encrypted on your device.',
  // A SENTENCE WITH A CONTROL INSIDE IT, rendered through <Trans>. Never split
  // into prefix + button + suffix: that hard-codes English word order, and the
  // first language that puts the verb elsewhere gets a scrambled sentence with no
  // way for the translator to fix it. The <clear> tag is the button's position,
  // and a translator may move it anywhere in the sentence.
  'vault.list.emptyFiltered': 'No {{tier}} items. <clear>Clear filter</clear> to see all tiers.',
  'vault.list.titleUnavailable': 'Title unavailable — the item can still be opened',
  'vault.list.pendingDelete': 'deletion {{date}}',

  // ── Vault: the write-lock banner ──────────────────────────────────────────
  // The reasons are a closed set mirroring the server's LOCKED_FOR_WRITE
  // (apps/api/src/vault/engine-gate.ts). They are sentence FRAGMENTS that slot
  // into vault.locked.banner below — which is exactly the shape that does not
  // survive translation intact, so the note there matters.
  'vault.locked.reason.release_review': 'a release is being reviewed',
  'vault.locked.reason.limited_release': 'a release is in progress',
  'vault.locked.reason.staged_release': 'a release is in progress',
  'vault.locked.reason.full_release': 'a release has completed',
  'vault.locked.reason.returning': 'you’re confirming your return after a release',
  'vault.locked.reason.review_required': 'your continuity engine is paused for review',
  // A FRAGMENT-IN-A-SENTENCE, kept because the English reads well and the six
  // fragments are grammatically parallel. A translator who finds the joint does
  // not work in their language may instead translate each reason as a WHOLE
  // sentence and reduce this to '{{reason}} <engine>…</engine>' — the fragments
  // and the frame are all in this catalog, so that regrouping is a translation
  // decision and needs no code change.
  'vault.locked.banner':
    'Editing is paused because {{reason}}, so vault items can’t be added or changed right now. <engine>Go to the Engine page</engine> to check in or resolve it — that unlocks editing.',

  // ── Vault: the attachment picker ──────────────────────────────────────────
  'vault.attach.dropHint': 'Drag files here, or',
  'vault.attach.encryptedNote':
    'Encrypted on this device before upload — even the filename travels inside the encryption.',
  'vault.attach.remove': 'Remove',

  // ── Vault: create an item ─────────────────────────────────────────────────
  'vault.create.heading': 'New vault item',
  'vault.create.lede': 'Encrypted on your device before it ever leaves it.',
  'vault.create.field.tier': 'Tier',
  'vault.create.field.category': 'Category',
  'vault.create.field.title': 'Title',
  'vault.create.field.content': 'Content',
  'vault.create.field.attachments': 'Attachments (optional)',
  'vault.create.guidance.who': 'Who a <strong>{{category}}</strong> item reaches:',
  'vault.create.guidance.pickedTier': ' (the tier you picked)',
  'vault.create.guidance.never': 'Never',
  'vault.create.guidance.advisory':
    'A suggestion, not a rule — the tier you choose is the one that applies.',
  'vault.create.phase.saving': 'Encrypting & saving…',
  'vault.create.phase.uploading': 'Encrypting & uploading {{n}} of {{total}}…',
  'vault.create.submit': 'Save item',
  'vault.create.submitBusy': 'Saving…',
  'vault.create.error.generic': 'We could not save this item. Please try again.',
  'vault.create.error.limit': 'You\'ve reached your Free plan\'s vault-item limit.',
  'vault.create.error.locked':
    'Your vault is locked because a release or review is in progress, so items can’t be added or edited right now. Go to the Engine page to check in (or resolve the review) — that unlocks editing.',
  'vault.create.upgradeLink': 'Upgrade to Personal',
  'vault.create.engineLink': 'Go to the Engine page',
  // WHOLE sentences per plural form, not a stem plus a stitched 's' and a
  // swapped it/them. English happens to need only those two edits; Spanish needs
  // different agreement, and a language with three plural forms needs a third
  // sentence that no amount of fragment-swapping can produce.
  'vault.create.partial_one':
    'Saved — but {{count}} file didn\'t attach ({{files}}). <open>Open the item</open> to add it.',
  'vault.create.partial_other':
    'Saved — but {{count}} files didn\'t attach ({{files}}). <open>Open the item</open> to add them.',

  // ── Vault: captures waiting to be filed ───────────────────────────────────
  'vault.captures.heading': 'Sent from your phone',
  'vault.captures.count': '{{count}} waiting',
  'vault.captures.waiting_one':
    'One item is waiting to be filed. Your phone sealed it to your vault key and cannot open it again — only your passphrase, here, can.',
  'vault.captures.waiting_other':
    '{{count}} items are waiting to be filed. Your phone sealed them to your vault key and cannot open them again — only your passphrase, here, can.',
  'vault.captures.filingNote':
    '<strong>Filing is what puts an item into your release plan.</strong> Until you file it, a capture is sealed to a key that only you hold, so your trusted contacts would not receive it even if a release completed.',
  'vault.captures.error':
    'We could not file that capture. It is still here — nothing was lost. Please try again.',
  'vault.captures.partial':
    'The item was saved, but {{files}} did not upload. The capture is still here so you can try again.',
  'vault.captures.sealedBox': 'sealed box',
  'vault.captures.arrived': 'Arrived {{when}}',
  'vault.captures.file': 'File it',
  'vault.captures.filing': 'Filing…',
  'vault.captures.phase.opening': 'Opening…',
  'vault.captures.phase.saving': 'Saving to your vault…',
  'vault.captures.phase.reencrypting': 'Re-encrypting file {{n}} of {{total}}…',
  'vault.captures.phase.clearing': 'Clearing the capture…',
  'vault.captures.discard': 'Discard',
  'vault.captures.privacyNote':
    'Titles and contents stay encrypted until you file — this list shows only the tier, the size and when each one arrived.',

  // ── Dashboard (Home) ──────────────────────────────────────────────────────
  'dash.greeting.morning': 'Good morning.',
  'dash.greeting.afternoon': 'Good afternoon.',
  'dash.greeting.evening': 'Good evening.',
  'dash.newItem': 'New vault item',
  'dash.summary.idle': 'Here is the state of your continuity setup.',
  'dash.summary.unknownReadiness': 'Your engine is active. Your next check-in is in {{next}}.',
  'dash.summary.healthy': 'Everything is healthy. Your next check-in is in {{next}}.',
  // A plural PAIR, because "{{count}} thing{s}" is English grammar in JSX.
  'dash.summary.blockers_one':
    'Your engine is running, but {{count}} thing would stop a release completing. Your next check-in is in {{next}}.',
  'dash.summary.blockers_other':
    'Your engine is running, but {{count}} things would stop a release completing. Your next check-in is in {{next}}.',

  'dash.readiness.caption': 'Continuity readiness',
  'dash.readiness.blocked': 'A release could not complete today',

  'dash.tile.vaultItems': 'Vault items',
  'dash.tile.vaultItems.empty': 'Nothing stored yet',
  'dash.tile.vaultItems.sub': 'Encrypted on your device',
  'dash.tile.contacts': 'Trusted contacts',
  'dash.tile.contacts.empty': 'None added yet',
  'dash.tile.contacts.sub': '{{count}} enrolled',
  'dash.tile.engine': 'Engine',
  'dash.tile.engine.liveness': 'Liveness state',
  'dash.tile.engine.running': 'Running',
  'dash.tile.engine.allHealthy': 'All healthy',
  'dash.tile.engine.blockers_one': '{{count}} blocker',
  'dash.tile.engine.blockers_other': '{{count}} blockers',
  'dash.tile.nextCheckIn': 'Next check-in',
  'dash.nextCheckIn.none': '—',
  'dash.nextCheckIn.noneSub': 'No check-in scheduled yet',
  'dash.nextCheckIn.due': 'Due',
  'dash.nextCheckIn.days': '{{days}} d',

  // Engine states. A closed set mirroring EngineState; an unmapped value falls
  // back to the raw code with underscores spaced, which is a legible last resort
  // rather than a blank.

  // Readiness gaps. The server sends a CODE and numeric detail only — never a
  // label or a link — so all of this copy is ours and translatable. Keep that
  // property: a gap whose text came from the server could not be translated and
  // would also be a hole in the AI chokepoint.
  'dash.gap.no_vault_items.title': 'Add your first vault item',
  'dash.gap.no_vault_items.sub': 'It is encrypted on your device before it ever leaves it.',
  'dash.gap.no_vault_items.cta': 'Add',
  'dash.gap.no_enrolled_contacts.title': 'Enrol a trusted contact',
  'dash.gap.no_enrolled_contacts.sub': 'They receive your release instructions if you go silent.',
  'dash.gap.no_enrolled_contacts.cta': 'Add',
  'dash.gap.s1_beneficiary_unset.title': 'Designate a beneficiary for your S1 tier',
  'dash.gap.s1_beneficiary_unset.sub':
    'An S1 tier releases to a named beneficiary. Without one it has no recipient.',
  'dash.gap.s1_beneficiary_unset.cta': 'Open',
  'dash.gap.s2_coverage_insufficient.title': 'Assign more S2 contact shares',
  'dash.gap.s2_coverage_insufficient.sub':
    'Too few contacts hold a share for this tier to reconstruct.',
  'dash.gap.s2_coverage_insufficient.cta': 'Assign',
  'dash.gap.s3_coverage_insufficient.title': 'Assign more S3 contact shares',
  'dash.gap.s3_coverage_insufficient.sub':
    'Too few contacts hold a share for this tier to reconstruct.',
  'dash.gap.s3_coverage_insufficient.cta': 'Assign',
  'dash.gap.s2_role_diversity_unsatisfiable.title': 'Add an S2 contact in a different role',
  'dash.gap.s2_role_diversity_unsatisfiable.sub':
    'A release consensus must span two different contact roles, so this tier can never reconstruct as it stands.',
  'dash.gap.s2_role_diversity_unsatisfiable.cta': 'Add',
  'dash.gap.s3_role_diversity_unsatisfiable.title': 'Add an S3 contact in a different role',
  'dash.gap.s3_role_diversity_unsatisfiable.sub':
    'A release consensus must span two different contact roles, so this tier can never reconstruct as it stands.',
  'dash.gap.s3_role_diversity_unsatisfiable.cta': 'Add',
  'dash.gap.s2_passphrase_slot_unset.title': 'Set your S2 release-passphrase fallback',
  'dash.gap.s2_passphrase_slot_unset.sub':
    'Your offline release passphrase is the fixed last share for S2.',
  'dash.gap.s2_passphrase_slot_unset.cta': 'Set',
  'dash.gap.engine_not_armed.title': 'Arm your continuity engine',
  'dash.gap.engine_not_armed.sub': 'Until it is armed, no check-in schedule is running.',
  'dash.gap.engine_not_armed.cta': 'Open engine',
  'dash.gap.checkin_overdue.title': 'Confirm you are active (check-in overdue)',
  'dash.gap.checkin_overdue.sub': 'Confirm you are active to stop the escalation ladder.',
  'dash.gap.checkin_overdue.cta': 'Check in',
  'dash.gap.stale_items.title': 'Review vault items you have not touched in a while',
  'dash.gap.stale_items.sub': 'Items you have not revisited in a while may be out of date.',
  'dash.gap.stale_items.cta': 'Review',
  'dash.gap.no_verified_channel.title': 'Add a verified way to be contacted',
  'dash.gap.no_verified_channel.sub':
    'Your engine is running but a check-in request has nowhere to go. Unanswered check-ins escalate toward a release.',
  'dash.gap.no_verified_channel.cta': 'Add',
  'dash.gap.contact_key_unconfirmed.title': 'Confirm a contact’s security code',
  // Must never imply we can tell whether the call happened — we cannot, and
  // saying so would sell a guarantee that does not exist (docs/38 §5). A
  // translator must keep "with them directly" and the phone/in-person clause.
  'dash.gap.contact_key_unconfirmed.sub':
    'Until you compare their security code with them directly — by phone or in person — they cannot hold a share of your release.',
  'dash.gap.contact_key_unconfirmed.cta': 'Confirm',
  'dash.gap.unknown.title': 'Review a readiness gap',
  'dash.gap.unknown.sub': 'Review this to keep your release able to complete.',
  'dash.gap.unknown.cta': 'Open',
  // Numeric detail prefixed onto a gap's explanation. Sentences, not fragments,
  // so the number and its noun agree in every language.
  'dash.gap.detail.shares': '{{assigned}} of {{needed}} required contact shares assigned. {{base}}',
  'dash.gap.detail.awaiting_one': '{{count}} contact awaiting confirmation. {{base}}',
  'dash.gap.detail.awaiting_other': '{{count}} contacts awaiting confirmation. {{base}}',
  'dash.gap.detail.stale_one': '{{count}} item untouched for over 180 days. {{base}}',
  'dash.gap.detail.stale_other': '{{count}} items untouched for over 180 days. {{base}}',

  'dash.checkups.heading': 'Continuity checkups',
  'dash.checkups.none': 'You are in good shape — nothing to action right now.',
  'dash.checkups.count_one': '{{count}} item to review. Take them at your own pace.',
  'dash.checkups.count_other': '{{count}} items to review. Take them at your own pace.',
  'dash.checkups.emptyBody': 'Your vault, contacts, and engine are all in a healthy state.',
  'dash.checkups.local.noItems.title': 'Add your first vault item',
  'dash.checkups.local.noItems.sub': 'It is encrypted on your device before it ever leaves it.',
  'dash.checkups.local.noContacts.title': 'Add a trusted contact',
  'dash.checkups.local.noContacts.sub':
    'They receive your release instructions if you go silent.',
  'dash.checkups.local.pending.title_one': 'Finish enrolling {{count}} contact',
  'dash.checkups.local.pending.title_other': 'Finish enrolling {{count}} contacts',
  'dash.checkups.local.pending.sub':
    'A contact can hold a release share only after they finish enrolling and you confirm their security code with them.',
  'dash.checkups.local.secondContact.title': 'Add a second trusted contact',
  'dash.checkups.local.secondContact.sub': 'Two-of-two consensus is far stronger than one.',
  'dash.checkups.cta.add': 'Add',
  'dash.checkups.cta.open': 'Open',

  'dash.plan.heading': 'Your AI plan',
  'dash.plan.sub': 'Prioritized next steps, chosen by Gemini from your account signals.',
  'dash.plan.unavailable': 'Couldn’t generate a plan just now — try Refresh in a moment.',
  'dash.plan.cta.add_vault_item': 'Open vault',
  'dash.plan.cta.add_contact': 'Add contact',
  'dash.plan.cta.enrol_contact': 'Open contacts',
  'dash.plan.cta.assign_shares': 'Assign shares',
  'dash.plan.cta.arm_engine': 'Open engine',
  'dash.plan.cta.review': 'Review',
  'dash.plan.cta.fallback': 'Open',

  'dash.proposals.heading': 'AI proposals',
  'dash.proposals.sub':
    'Suggestions from your account signals. You decide — nothing happens without your approval.',
  'dash.proposals.suggested': 'Suggested {{date}}',
  'dash.proposals.dismiss': 'Dismiss',
  'dash.proposals.accept': 'Accept',
  'dash.proposals.label.tighten': 'Shorten your check-in interval from {{from}} to {{to}} days',
  'dash.proposals.label.draftMessage': 'Review a drafted contact message',
  'dash.proposals.label.recategorize': 'Consider recategorising some items',
  'dash.proposals.label.unknown': 'Review an AI suggestion',

  'dash.activity.heading': 'Recent activity',
  'dash.activity.sub': 'Every event is signed and timestamped.',
  'dash.activity.empty':
    'Nothing to show yet. Check-ins, edits, contact verifications, and release events will appear here.',

  'dash.contacts.heading': 'Trusted contacts',
  'dash.checkups.aiSuggested': 'AI suggested',
  'dash.checkups.close': 'Close',
  'dash.contacts.finish': 'Finish',
  'dash.contacts.more': '{{count}} more →',
  'dash.vault.heading': 'Vault',
  'dash.vault.count_one': '{{count}} item, encrypted on your device',
  'dash.vault.count_other': '{{count}} items, encrypted on your device',
  'dash.vault.new': 'New',
  'dash.vault.empty': 'No items yet. The first one is encrypted on your device before it leaves it.',
  'dash.vault.addFirst': 'Add first item',
  'dash.vault.more': '{{count}} more →',
  'dash.contacts.count_one': '{{count}} contact · {{enrolled}} enrolled',
  'dash.contacts.count_other': '{{count}} contacts · {{enrolled}} enrolled',
  'dash.contacts.add': 'Add',
  'dash.contacts.empty':
    'You haven’t added a trusted contact yet. They receive your release instructions if you go silent.',
  'dash.contacts.addFirst': 'Add first contact',
  'dash.contacts.enrolled': 'Enrolled',
  'dash.role.personal': 'Personal contact',
  'dash.role.professional': 'Professional contact',
  'dash.role.recovery': 'Recovery contact',
  'dash.role.fallback': 'Contact',

  // ── Engine dashboard ──────────────────────────────────────────────────────
  'engine.loading': 'Loading…',
  'engine.eyebrow': 'Continuity',

  // ── Engine state names ────────────────────────────────────────────────────
  // One name per member of ENGINE_STATES, pinned by engine-states.test.ts. These
  // replace the Home-only map that named four states the engine cannot be in and
  // omitted seven it can. Owner-facing wording: what is happening to THEM, not
  // the machine's term for it.
  'engine.state.none': 'Not started',
  'engine.state.pre_active': 'Not armed',
  'engine.state.active': 'Active',
  'engine.state.check_in_pending': 'Check-in due',
  'engine.state.notification_stalled': 'Notices not getting through',
  'engine.state.escalation_pending': 'Escalating',
  'engine.state.release_review': 'In review',
  'engine.state.limited_release': 'Limited release',
  'engine.state.staged_release': 'Staged release',
  'engine.state.full_release': 'Full release',
  'engine.state.returning': 'Confirming your return',
  'engine.state.review_required': 'On hold for review',

  // ── Liveness ladder ───────────────────────────────────────────────────────
  'engine.ladder.heading': 'Liveness ladder',
  'engine.ladder.sub': 'Every step is slow, reversible, and audited. You can stop it at any rung above.',
  'engine.ladder.aside': 'Paused here — {{state}}.',
  'engine.ladder.before': 'Nothing on this ladder applies until the engine is armed.',
  'engine.ladder.current': 'Current step',
  'engine.heading': 'Your continuity engine',
  'engine.lede': 'Your liveness state and the next automatic step.',

  'engine.unarmed.heading': 'Your continuity engine isn’t armed yet',
  'engine.unarmed.body':
    'Arming turns on liveness monitoring: if you later go silent past your check-in window, the release ladder begins — slowly, reversibly, with every step cancellable. You need at least one enrolled trusted contact first (someone to release to); add a vault item too, so there’s something to release.',
  'engine.unarmed.prereq':
    'You can’t arm yet: enrol a trusted contact first — a release needs someone to hand your vault to. <contacts>Add a contact →</contacts>',
  'engine.unarmed.arm': 'Arm engine',
  'engine.unarmed.arming': 'Arming…',
  'engine.unarmed.setup': 'Go to setup',

  'engine.nextAction': 'Next automatic step: {{when}}',
  'engine.snoozedUntil': 'Snoozed until {{when}}',

  'engine.escalating.body':
    'Your contacts are being notified that you may be unreachable. If this is a mistake, acknowledge below to stop the escalation.',
  'engine.escalating.ack': 'Acknowledge and check in',

  'engine.checkin.title': 'Confirm you’re still here',
  'engine.checkin.sub': 'One tap resets the check-in countdown.',
  'engine.checkin.action': 'Check in',
  'engine.snooze.label': 'Snooze days',
  'engine.snooze.action': 'Snooze',

  'engine.release.stage.release_review.name': 'Release review',
  'engine.release.stage.release_review.atStake':
    'Your trusted contacts are being asked to confirm. Nothing has been released yet.',
  'engine.release.stage.limited_release.name': 'Limited release (S1)',
  'engine.release.stage.limited_release.atStake':
    'Your most-accessible tier can now be reconstructed by your contacts.',
  'engine.release.stage.staged_release.name': 'Staged release (S2)',
  'engine.release.stage.staged_release.atStake':
    'A further tier is being staged for release to your contacts.',
  'engine.release.next': 'Next stage: {{when}}',
  'engine.release.warning': 'A release of your vault is in progress. If you are reading this, stop it.',
  'engine.release.cancel': 'Cancel release',

  'engine.returning.heading': 'We thought you were gone — please confirm you’re back',
  'engine.returning.body':
    'A release was in progress and you signed in, so your continuity engine <strong>paused it</strong>. Nothing further is being released while it is paused.',
  // The bold clause is the consequence of doing nothing, and it is the whole
  // point of the paragraph — a translation that drops the emphasis, or softens
  // "resumes where it left off", changes what the reader understands is at stake.
  'engine.returning.expiry':
    'Confirm below (your device will ask for your passkey) and the release is cancelled outright, with monitoring re-armed on a fresh check-in clock. <strong>If you do nothing, the pause expires{{when}} and the release resumes where it left off.</strong>',
  'engine.returning.expiryWhen': ' on {{when}}',
  'engine.returning.confirm': 'I’m here — confirm and cancel the release',

  'engine.review.heading': 'On hold for review',
  'engine.review.body':
    'A release attempt was stopped — a ceremony failed, or someone reported you alive — and your continuity engine is paused. <strong>Nothing is being released.</strong> Check-ins are paused too until you resolve this.',
  'engine.review.sub':
    'If everything is fine, confirm it’s you below (your device will ask for your passkey) and monitoring re-arms with a fresh check-in clock.',
  'engine.review.resolve': 'I’m here — resolve and re-arm',

  'engine.pending.heading': 'Pending actions',
  'engine.pending.sub':
    'Sensitive changes wait 7 days before they apply — that delay is the protection. Cancellable until they take effect.',
  'engine.pending.aiBadge': 'AI-proposed',
  'engine.pending.effective': 'takes effect {{when}} (cancellable until then)',
  'engine.pending.effectiveAi': 'Proposed by AI — takes effect {{when}} (cancellable until then)',
  'engine.pending.cancel': 'Cancel',

  // Pending sensitive-action names (QA Pass 2 Finding B): a raw `add_contact`
  // read as "a contact is still being added" when what is pending is the
  // 7-day-delayed grant.
  'engine.action.add_contact': 'Give a contact a release share',
  'engine.action.remove_contact': 'Remove a contact',
  'engine.action.remove_channel': 'Remove a notification channel',
  'engine.action.change_contact_role': 'Change a contact’s role',
  'engine.action.rotate_contact': 'Rotate a contact’s keys',
  'engine.action.designate_beneficiary': 'Designate a beneficiary',
  'engine.action.remove_beneficiary': 'Remove a beneficiary',
  'engine.action.change_share_composition': 'Change the release-share composition',
  'engine.action.change_tier_configuration': 'Change a tier’s configuration',
  'engine.action.change_inactivity_threshold': 'Change the check-in interval',
  'engine.action.change_cooldown_window': 'Change the release cooldown',
  'engine.action.rotate_master_passphrase': 'Rotate the master passphrase',
  'engine.action.rotate_release_passphrase': 'Rotate the release passphrase',
  'engine.action.rotate_recovery_code': 'Rotate the recovery code',
  'engine.action.register_hardware_key': 'Register a hardware key',
  'engine.action.remove_hardware_key': 'Remove a hardware key',
  'engine.action.change_email': 'Change the account email',
  'engine.action.arm_engine': 'Arm the continuity engine',
  'engine.action.delete_account': 'Delete the account',
  'engine.action.set_vault_item_tier': 'Move a vault item to another tier',
  'engine.action.delete_vault_item': 'Delete a vault item',
  'engine.action.purge_attachment': 'Purge an attachment',

  'engine.error.arm': 'We could not arm the engine.',
  'engine.error.checkIn': 'We could not check you in.',
  'engine.error.snooze': 'We could not snooze.',
  'engine.error.cancelRelease': 'We could not cancel the release.',
  'engine.error.confirmReturn':
    'We could not confirm your return — the passkey confirmation may have failed. Nothing changed; try again.',
  'engine.error.resolveReview':
    'We could not resolve the review — the passkey confirmation may have failed. Nothing changed; try again.',
  'engine.error.cancelAction': 'We could not cancel that action.',

  // ── Release progress (owner's live ceremony view) ─────────────────────────
  'release.progress.heading': 'Release progress',
  'release.progress.lede':
    'The live state of your release ceremonies — exactly what your contacts are being asked, and who has answered. If you are reading this and everything is fine, use the protective controls above — check in, cancel the release, or resolve the review hold — and your contacts will be told.',
  'release.progress.tier.s1': 'S1 — sealed envelope',
  'release.progress.tier.s2': 'S2 — 2-of-3 consensus',
  'release.progress.tier.s3': 'S3 — 3-of-4 consensus',
  'release.progress.status.initiated': 'Preparing',
  'release.progress.status.collecting_affirmations': 'Waiting for your contacts',
  'release.progress.status.awaiting_outer_key': 'Consensus reached — final hold',
  'release.progress.status.reconstructing': 'Open — contacts can retrieve',
  'release.progress.status.released': 'Retrieved',
  'release.progress.status.cancelled': 'Cancelled',
  'release.progress.status.failed': 'Failed closed',
  'release.progress.reason.sync_window_expired_below_threshold':
    'The collection window closed without enough confirmations — nothing was released.',
  'release.progress.reason.reconstruction_timed_out':
    'The retrieval window expired — the gate closed again without a retrieval.',
  'release.progress.reason.user_returned': 'You returned — the release was cancelled.',
  'release.progress.reason.dispute_raised':
    'A contact reported you alive — the release was stopped for review.',
  'release.progress.role.personal': 'Personal',
  'release.progress.role.professional': 'Professional',
  'release.progress.role.recovery': 'Recovery',
  // Shown when a contact's label cannot be decrypted (e.g. mid-relock). Never
  // crash the safety panel over a display string.
  'release.progress.unnamedContact': 'A trusted contact',
  'release.progress.consensus': '{{committed}} of {{threshold}} confirmations needed',
  // Leading separators are part of the message: where a clause attaches, and with
  // what punctuation, is a translator's decision.
  'release.progress.windowCloses': ' · collection window closes {{when}}',
  'release.progress.gateOpened': ' · gate opened {{when}}',
  'release.progress.aff.tentativeUntil': 'Affirmed — still revocable until {{when}}',
  'release.progress.aff.tentative': 'Affirmed — still revocable',
  'release.progress.aff.committedAt': 'Confirmed {{when}}',
  'release.progress.aff.committed': 'Confirmed',
  'release.progress.aff.revokedAt': 'Revoked {{when}}',
  'release.progress.aff.revoked': 'Revoked',
  'release.progress.aff.none': 'Has not responded yet',
  'release.progress.rcp.retrievedAt': 'Retrieved their release {{when}}',
  'release.progress.rcp.retrieved': 'Retrieved their release',
  'release.progress.rcp.none': 'Has not retrieved yet',

  // ── The shared AI disclosure ──────────────────────────────────────────────
  // ONE component renders this on every AI surface so the promise reads
  // identically everywhere (trust workstream T7). It is a claim about what the
  // AI can and cannot do, so a translation that weakens "never" or widens what it
  // "sees" is a correctness bug, not a style choice.
  'ai.disclosure.body':
    'AI can only add safety checks, never remove them — it sees counts and settings, never your encrypted content, names, or keys.',
  'ai.disclosure.link': 'How Truecairn uses AI →',

  // ── App chrome: sidebar + account menu ────────────────────────────────────
  // The nav NAMES are load-bearing beyond display: the Playwright E2E navigates
  // by them. English stays the source language and these strings are unchanged,
  // so those specs keep matching — but a future rewording here is also a change
  // to those specs.
  'shell.nav.home': 'Home',
  'shell.nav.vault': 'Vault',
  'shell.nav.plans': 'Plans',
  'shell.nav.contacts': 'Contacts',
  'shell.nav.engine': 'Engine',
  'shell.nav.ceremony': 'Ceremony',
  'shell.nav.assistant': 'Assistant',
  'shell.nav.more': 'More',
  'shell.nav.acceptInvite': 'Accept invite',
  'shell.nav.settings': 'Settings',
  'shell.skipToContent': 'Skip to main content',
  'shell.openNav': 'Open navigation menu',
  'shell.search': 'Search',
  'shell.brandHome': 'Truecairn — home',
  'shell.loading': 'Loading…',

  // ── Command palette (⌘K) ──────────────────────────────────────────────────
  // The footer promise is a factual claim about how this works, not reassurance
  // copy: there is no search endpoint behind the palette, and the vault titles it
  // matches were decrypted on this device. Do not soften it into a vaguer
  // "private" — it says what it says because it is checkable.
  'palette.label': 'Search and run',
  'palette.placeholder': 'Search actions, contacts and vault titles',
  'palette.esc': 'esc',
  'palette.empty': "Nothing matches that. Try a contact's name or a vault title.",
  'palette.hint.move': '↑↓ move',
  'palette.hint.run': '↵ run',
  'palette.hint.local': 'Runs locally. Nothing is sent anywhere.',
  'palette.group.go': 'Go',
  'palette.group.vault': 'Vault',
  'palette.group.contacts': 'Contacts',
  'palette.go.home': 'Go to Home',
  'palette.go.vault': 'Go to Vault',
  'palette.go.plans': 'Go to Plans',
  'palette.go.contacts': 'Go to Contacts',
  'palette.go.engine': 'Go to Engine',
  'palette.go.ceremony': 'Go to Ceremony',
  'palette.go.assistant': 'Go to Assistant',
  'palette.go.settings': 'Go to Settings',
  'palette.go.acceptInvite': 'Go to Accept invite',

  'account.menu.label': 'Account',
  'account.menu.vaultUnlocked': 'Vault unlocked',
  'account.menu.vaultLocked': 'Vault locked',
  'account.menu.settings': 'Settings',
  'account.menu.plans': 'Plans',
  'account.menu.guide': 'User guide',
  'account.menu.signOut': 'Sign out',
  'account.menu.signingOut': 'Signing out…',
  'account.menu.yourAccount': 'Your account',
  'account.plan.personal': 'Personal',
  'account.plan.free': 'Free',

  // ── Assistant ─────────────────────────────────────────────────────────────
  'assistant.eyebrow': 'Help',
  'assistant.heading': 'Assistant',
  'assistant.lede':
    'Ask how Truecairn works or what to do next. It sees only your account’s metadata — never your encrypted content.',
  'assistant.field.question': 'Your question',
  'assistant.placeholder': 'e.g. How do I add a trusted contact?',
  'assistant.note': 'Don’t paste passwords, passphrases, or recovery codes here.',
  'assistant.ask': 'Ask',
  'assistant.thinking': 'Thinking…',
  'assistant.suggestion.release': 'How does the release process work?',
  'assistant.suggestion.passphrase': 'What happens if I lose my release passphrase?',
  'assistant.suggestion.s2': 'How many contacts do I need for an S2 release?',
  // Shown when the text looks like it contains a secret, BEFORE anything leaves
  // the device. The point of the sentence is that the user does not need to
  // supply a secret at all — a translation that only says "remove it" loses it.
  'assistant.error.sensitive':
    'That looks like it contains a passphrase or recovery code. Remove it and ask your question without it — the assistant never needs any of your secrets.',
  'assistant.error.unavailable': 'The assistant is unavailable right now. Try again shortly.',
  'assistant.error.generic': 'Something went wrong. Please try again.',

  // ── Upgrade ───────────────────────────────────────────────────────────────
  'upgrade.back': 'Back to vault',
  'upgrade.title': 'Plans that protect what matters',
  'upgrade.lead':
    'Free covers the full safety machinery on email and push. Personal adds the paid verification channels, so we can reach you every way you’ve configured when it counts.',
  'upgrade.period.label': 'Billing period',
  'upgrade.period.monthly': 'Monthly',
  'upgrade.period.yearly': 'Yearly',
  'upgrade.period.save': 'Save {{pct}}%',
  'upgrade.free.name': 'Free',
  'upgrade.free.per': 'forever',
  'upgrade.free.desc': 'Enough to start — the full release ceremony, on email & push.',
  'upgrade.free.included': 'Included',
  'upgrade.free.yourPlan': 'Your plan',
  'upgrade.free.feat.contacts': 'Up to {{count}} trusted contacts',
  'upgrade.free.feat.items': 'Up to {{count}} vault items',
  'upgrade.feat.attachments': '{{size}} encrypted attachments',
  'upgrade.feat.tiers': 'Release tiers {{tiers}}',
  'upgrade.free.feat.channels': 'Email & push check-ins',
  'upgrade.personal.name': 'Personal',
  'upgrade.personal.popular': 'Most popular',
  'upgrade.personal.per': '/ month',
  'upgrade.personal.billedYearly': '${{total}} billed yearly — save ${{saving}}',
  'upgrade.personal.billedMonthly': '${{total}} billed monthly',
  'upgrade.personal.desc':
    'For an individual taking continuity seriously across business and personal life.',
  'upgrade.personal.current': 'Current plan',
  'upgrade.personal.cta': 'Upgrade to Personal',
  'upgrade.personal.opening': 'Opening checkout…',
  'upgrade.personal.feat.everything': 'Everything in Free',
  'upgrade.personal.feat.contacts': 'Unlimited trusted contacts',
  'upgrade.personal.feat.items': 'Unlimited vault items',
  'upgrade.personal.feat.sms': 'SMS verification',
  'upgrade.personal.feat.multichannel': 'Multi-channel continuity checks',
  'upgrade.renews': 'Your Personal plan renews {{when}}.',
  'upgrade.error.checkout':
    'We could not open checkout — upgrades may not be configured yet. Try again later.',
  'upgrade.fineprint':
    'Secure checkout via LemonSqueezy. Prices in USD. Cancel anytime — a cancelled plan keeps access until the period ends.',
  'upgrade.manageSubscription': 'Manage your subscription',

  // ── Onboarding (enrolment) ────────────────────────────────────────────────
  'onboarding.welcome.heading': 'Set up Truecairn',
  'onboarding.welcome.body':
    'You will choose a master passphrase. We never see it and cannot reset it — it is the only key to your vault.',
  'onboarding.welcome.begin': 'Begin',
  'onboarding.pass.heading': 'Choose your master passphrase',
  'onboarding.pass.lede':
    'At least 8 characters. This is the only key to your vault and can never be reset.',
  'onboarding.pass.field': 'Master passphrase',
  'onboarding.pass.confirmField': 'Confirm passphrase',
  'onboarding.pass.submit': 'Continue',
  'onboarding.pass.submitBusy': 'Setting up…',
  'onboarding.pass.working': 'Setting up your encryption on this device — this can take a few seconds.',
  'onboarding.error.tooShort': 'Your passphrase must be at least 8 characters.',
  'onboarding.error.mismatch': 'The passphrases do not match.',
  // The memory failure is NOT a wrong-passphrase failure, and the copy has to
  // keep saying so — the same distinction Unlock protects. Here it decides
  // whether someone thinks setup is broken or their device is busy.
  'onboarding.error.memory':
    'Your browser could not give this page enough memory to set up your encryption. Close other tabs or windows (or try another browser), then press Continue again.',
  'onboarding.error.generic': 'We could not complete setup. Please try again.',
  'onboarding.recovery.heading': 'Save your recovery code',
  'onboarding.recovery.lede':
    'This is the only way to recover your vault if you forget your passphrase. Write it down and keep it safe — we cannot show it again.',
  'onboarding.recovery.label': 'recovery code',
  'onboarding.recovery.copy': 'Copy code',
  'onboarding.recovery.copied': 'Copied ✓',
  'onboarding.recovery.saved': 'I have saved it',
  'onboarding.done.heading': 'You are all set',
  'onboarding.done.body': 'Your vault is unlocked and ready.',
  'onboarding.done.cta': 'Go to your vault',

  // ── Audit trail ───────────────────────────────────────────────────────────
  'audit.heading': 'Your audit trail',
  'audit.lede':
    'Every significant action on your account, in a tamper-evident chain you can check yourself.',
  'audit.loading': 'Loading…',
  'audit.verify': 'Verify on this device',
  'audit.download': 'Download',
  'audit.verdict.ok_one':
    '✅ Checked {{count}} record on this device. Each one matches its own fingerprint and links to the one before it.',
  'audit.verdict.ok_other':
    '✅ Checked {{count}} records on this device. Each one matches its own fingerprint and links to the one before it.',
  'audit.verdict.broken':
    '⚠️ Record {{seq}} failed: {{why}}. Please contact us — this should never happen, and it is exactly what this check exists to catch.',
  // The three reasons a chain check can fail. Sentence fragments that slot into
  // audit.verdict.broken above — kept as their own keys so a translator can
  // reshape that sentence without losing them.
  'audit.broken.outOfOrder': 'an entry is missing or out of order',
  'audit.broken.notLinked': 'this entry does not link to the one before it',
  'audit.broken.badHash': 'the record does not match its own fingerprint',
  // The limit of what this check proves. It must NOT read as a stronger
  // guarantee than it is: it detects tampering with history, not a server that
  // was dishonest from the very start.
  'audit.caveat':
    'Verification runs in your browser on the records above — we do not ask our own server whether it has been honest. It confirms the chain is intact and unaltered. It does not check the server’s signatures against a key from anywhere other than this server, so it detects tampering with your history, not a server that was dishonest from the very start. The downloaded file contains everything needed to check that elsewhere.',
  'audit.filterLabel': 'Filter by what the entry is about',
  'audit.family.all': 'All',
  'audit.family.vault': 'Vault',
  'audit.family.contacts': 'Contacts',
  'audit.family.release': 'Release',
  'audit.family.account': 'Account',
  'audit.noneInFilter': 'No entries of that kind yet.',
  'audit.noneAtAll': 'Nothing has been recorded on this account yet.',
  // The hash-chain detail. Shown short here and in full in the downloaded log —
  // this row is for recognising a link, not for checking one properly.
  'audit.entryHash': 'entry {{seq}} · sha256 {{hash}}',
  'audit.prevHash': 'prev {{hash}}',
  'audit.chainNote':
    'Each entry carries the hash of the one before it, so changing an earlier entry breaks every hash after it. Verifying on this device recomputes the whole chain.',
  'audit.byAssistant': 'by the assistant',
  'audit.truncated': 'Showing the first 200 records. Download for the complete trail.',

  // ── Continuity plans (release ladder overview) ────────────────────────────
  'plans.eyebrow': 'Continuity',
  'plans.heading': 'Continuity plans',
  'plans.lede':
    'How each tier of your vault is released, and to whom, when your conditions are met.',
  'plans.contacts.title': 'Trusted contacts',
  'plans.contacts.count_one': '{{count}} contact · {{enrolled}} enrolled and able to hold shares',
  'plans.contacts.count_other': '{{count}} contacts · {{enrolled}} enrolled and able to hold shares',
  'plans.contacts.manage': 'Manage contacts',
  // The ladder copy describes SHIPPED mechanics (docs/24), and S2 and S3 treat
  // the release passphrase differently on purpose. S2: an OPTIONAL fallback —
  // two contacts suffice without it. S3: MANDATORY — no contacts-only path
  // exists, and losing it makes S3 permanently unrecoverable. A translation that
  // blurs those two into "the passphrase is one of the shares" misdescribes what
  // the product does, and for S3 it understates a permanent loss.
  'plans.ladder.s1.name': 'Most accessible',
  'plans.ladder.s1.rule':
    'Released when any one trusted contact opens the sealed envelope you left them.',
  'plans.ladder.s1.need': 'Any 1 contact',
  'plans.ladder.s2.name': 'Sensitive',
  'plans.ladder.s2.rule':
    'A 2-of-3 Shamir split across two contacts of different roles and your offline release passphrase. Any two of those three shares reconstruct it — no single share, and no two same-role contacts, can. The release passphrase is an optional fallback here: two contacts can recover S2 without it.',
  'plans.ladder.s2.need': 'Any 2 of 3 shares (2 contacts or release passphrase)',
  'plans.ladder.s3.name': 'Most sensitive',
  'plans.ladder.s3.rule':
    'A nested scheme: your offline release passphrase is a mandatory mask over a 2-of-3 split held by three contacts of different roles. Reconstructing it needs the release passphrase AND any two of those three contacts — there is no contacts-only path, and if the release passphrase is lost, S3 is permanently unrecoverable.',
  'plans.ladder.s3.need': 'Release passphrase (always required) + any 2 of 3 contacts',
  'plans.tier.items_one': '{{count}} item',
  'plans.tier.items_other': '{{count}} items',
  'plans.tier.need': 'Release needs: {{need}}',
  'plans.tier.categories': 'Categories: {{categories}}',
  'plans.tier.openVault': 'Open vault',
  'plans.footnote':
    'Assign which contact holds each tier’s share under Contacts; move items between tiers from the vault item itself.',

  'plans.sub.proName': 'Truecairn Personal',
  'plans.sub.active': 'active',
  'plans.sub.proBlurb':
    'Unlimited contacts & vault items, {{storage}} encrypted attachments, and SMS verification are unlocked — thank you for supporting Truecairn.',
  'plans.sub.usage': 'Using {{used}} of {{limit}} storage.',
  'plans.sub.endsOn': 'Your plan is set to end on {{when}}.',
  'plans.sub.renews': 'Renews {{when}}.',
  'plans.sub.manage': 'Manage subscription',
  'plans.sub.freeBlurb':
    'You’re on the free plan. Personal lifts the limits — unlimited trusted contacts and vault items, far more encrypted-attachment storage — and adds SMS verification so we can reach you every way you’ve configured when it matters.',
  'plans.sub.stat.contacts': 'Trusted contacts',
  'plans.sub.stat.items': 'Vault items',
  'plans.sub.stat.storage': 'Attachment storage',
  'plans.sub.upgrade': 'Upgrade',
  'plans.sub.upgradeHint': 'See both plans, pick monthly or yearly, and save.',

  // ── Continuity verification report ────────────────────────────────────────
  // Every line here is PROVIDER-PROVEN evidence (delivered or bounced), and the
  // panel is read at the worst possible moment — by a trusted contact deciding
  // whether an owner has really gone silent. A translation that softens
  // "provably failed" into "may not have arrived", or that lets "delivered"
  // imply "read", changes what the reader concludes. Truecairn does not track
  // opens, and the closing line must keep saying so.
  'continuity.outcome.channels_unconfigured':
    'No verified notification channel was available to reach the owner through.',
  'continuity.outcome.unreachable_all_channels':
    'Every attempt to reach the owner provably failed — all configured channels bounced or errored.',
  'continuity.outcome.partial_delivery_no_checkin':
    'Some attempts reached the owner’s channels (others were unconfirmed or failed) — and no check-in followed.',
  'continuity.outcome.delivered_no_checkin':
    'Messages provably reached the owner’s channels — and still no check-in followed.',
  // NOT a failure: verified channels exist and simply have not been needed yet
  // (a healthy, freshly-armed engine reports the same closed enum).
  'continuity.outcome.quietButHealthy':
    'No verification attempts have been needed in this window — your channels are ready.',
  'continuity.heading.live': 'Current verification status',
  'continuity.heading.frozen': 'Continuity verification report',
  'continuity.lede.live':
    'What the system is doing to reach you right now — counts update as providers confirm deliveries.',
  'continuity.lede.frozen':
    'Frozen when this ceremony opened{{when}} — the record of every attempt to reach the owner first. Provider confirmations that arrived after this moment are not reflected here, so a recent attempt can show as sent but not yet delivered.',
  'continuity.lede.frozenWhen': ' ({{when}})',
  'continuity.narration.label': 'In plain language (AI-generated):',
  'continuity.lastActive': 'Last confirmed active: {{when}}',
  'continuity.never': 'never',
  'continuity.checkInRequested': 'Check-in requested: {{when}}',
  'continuity.escalated': 'Verification intensified: {{when}}',
  'continuity.noChannels': 'No notification channels were configured.',
  'continuity.channelName': '{{type}} channel',
  'continuity.channelNameUnverified': '{{type}} channel (unverified)',
  'continuity.channelStats_one':
    '{{count}} attempt · {{delivered}} delivered · {{bounced}} bounced · {{failed}} failed{{last}}',
  'continuity.channelStats_other':
    '{{count}} attempts · {{delivered}} delivered · {{bounced}} bounced · {{failed}} failed{{last}}',
  'continuity.lastDelivered': ' · last delivered {{when}}',
  'continuity.recovered': 'The owner returned during this window ({{when}}).',
  'continuity.noTracking':
    'Every line above is provider-proven (delivered or bounced). Truecairn never tracks whether a message is opened or read.',

  // ── Accept a trusted-contact invitation ───────────────────────────────────
  'accept.heading': 'Accept a trusted-contact invitation',
  'accept.locked': 'Unlock your vault first — enrolment uses keys only your passphrase derives.',
  'accept.lede':
    'Paste the one-time token the person who invited you shared. We register your affirmation keys by proving — never revealing — that you hold them.',
  'accept.field.token': 'Invite token',
  'accept.submit': 'Accept and enrol',
  'accept.accepting': 'Accepting…',
  'accept.enrolling': 'Proving key possession…',
  'accept.error': 'We could not accept and enrol with this invitation.',
  'accept.done.heading': 'You are enrolled',
  'accept.done.body':
    'Your affirmation keys are registered. One step remains before the person who invited you can entrust you with a release share.',
  'accept.code.label': 'Your security code',
  // The out-of-band instruction is the whole defence against key substitution
  // (migration 0061). "By phone or in person" and "not over email or chat" are
  // the load-bearing words: comparing the code over the same channel an attacker
  // may control proves nothing. A translation must keep both halves, and must
  // keep "do not continue" as an instruction rather than a suggestion.
  'accept.code.instruction':
    'The person who invited you will read out a code and ask if it matches this one. <strong>Do that by phone or in person</strong> — not over email or chat. If the codes do not match, tell them and do not continue: it means the keys they have been given for you are not yours.',

  // ── Vault item detail ─────────────────────────────────────────────────────
  'item.loading': 'Loading…',
  'item.error.open': 'We could not open this item.',
  'item.back': '← Back to vault',
  'item.tier': 'Tier: {{tier}}',
  'item.contentLabel': 'item content',
  'item.immutable':
    'This record is immutable: its title and content can’t be edited after creation — it’s kept as an audit-trailed record. To change them, move its tier or delete it and create a new item. Attachments below are managed separately.',
  'item.pendingDeletion':
    'Deletion scheduled — this item is removed {{when}}. It stays readable until then, and you can cancel it from the <engine>Engine page</engine>.',
  'item.pendingAction': '{{label}} pending — cancellable for 7 days, takes effect {{when}}.',
  'item.pending.attachmentRemoval': 'Attachment removal',
  'item.pending.tierChange': 'Tier change to {{tier}}',
  'item.pending.deletion': 'Deletion',
  'item.actions': 'Actions',
  'item.moveTier': 'Move to tier',
  'item.requestTierChange': 'Request tier change',
  'item.requesting': 'Requesting…',
  'item.delete': 'Delete',
  'item.revert': 'Revert to backup',
  'item.reverting': 'Reverting…',
  'item.reverted': 'Reverted to your last backup.',
  'item.attachments': 'Attachments',
  'item.attachments.lede':
    'Files can be added or removed independently of the record above. Each is encrypted on this device before upload — the server stores unreadable bytes, and even the filename travels inside the encryption. Names appear when you download and decrypt.',
  'item.attachment.row': 'Encrypted file · {{size}} · added {{when}}',
  'item.attachment.download': 'Download',
  'item.attachment.decrypting': 'Decrypting…',
  'item.attachment.pendingRemoval':
    'Removal scheduled — applies {{when}}; cancel from the Engine page.',
  'item.attachment.remove': 'Remove (7-day)',
  'item.attachment.uploading': 'Encrypting & uploading…',
  'item.attachment.attachNone': 'Attach file',
  'item.attachment.attach_one': 'Attach {{count}} file',
  'item.attachment.attach_other': 'Attach {{count}} files',
  'item.attachment.stored_one': '{{count}} file encrypted and stored.',
  'item.attachment.stored_other': '{{count}} files encrypted and stored.',
  'item.attachment.chooseFirst': 'Choose a file first.',
  // "Nothing was uploaded unencrypted" is the reassurance that matters on a
  // failure here — a translation that drops it leaves the reader wondering what
  // reached the server in the clear. Nothing did.
  'item.attachment.failed_one':
    '{{count}} file could not be stored ({{files}}) — they may exceed your plan storage. Nothing was uploaded unencrypted.',
  'item.attachment.failed_other':
    '{{count}} files could not be stored ({{files}}) — they may exceed your plan storage. Nothing was uploaded unencrypted.',
  'item.error.lockedUpload':
    'Your vault is locked because a release or review is in progress, so attachments can’t be added right now. Resolve it from the Engine page (check in or resolve the review), then try again. Nothing was uploaded.',
  'item.error.decrypt': 'We could not decrypt that attachment.',
  'item.error.removal':
    'We could not request the removal — the security confirmation may have failed.',
  'item.error.tierChange': 'We could not request the tier change. Please try again.',
  'item.error.deletion': 'We could not request deletion. Please try again.',
  'item.error.revert': 'We could not revert this item. Please try again.',

  // ── Release ceremony portal (the CONTACT's side) ──────────────────────────
  // This screen is read by someone acting on behalf of a person who may have
  // died, often once, under stress, possibly in a language they did not choose.
  // Two properties must survive translation: every irreversible-looking step is
  // reversible and says so, and the dispute ("the owner is alive") is always
  // available and always stops everything.
  'ceremony.eyebrow': 'Continuity',
  'ceremony.heading': 'Release ceremony',
  'ceremony.lede':
    'Where your trusted contacts act on a release — slow, reversible, and audited.',
  'ceremony.none': 'There is no release for you to act on.',
  'ceremony.releasedContent': 'released content',
  'ceremony.tier.s1': 'S1 — Essentials',
  'ceremony.tier.s2': 'S2 — Personal',
  'ceremony.tier.s3': 'S3 — Deep vault',
  'ceremony.receive': 'Receive on this device',
  'ceremony.receiving': 'This device is registered to receive the release.',
  'ceremony.affirm': 'Affirm release',
  'ceremony.affirm.confirmText':
    'You are confirming that the owner is gone or unreachable and their vault should be released. You will still be able to change your mind during the revocation window that follows.',
  'ceremony.affirm.yes': 'Yes, affirm the release',
  'ceremony.affirm.notNow': 'Not now',
  'ceremony.affirmed.until': 'You have affirmed. You can change your mind until {{when}}.',
  'ceremony.affirmed.limited': 'You have affirmed. You can still change your mind for a limited time.',
  'ceremony.revoke': 'Revoke my affirmation',
  'ceremony.committed':
    'Your affirmation is confirmed — the change-your-mind window has closed. If the owner is actually alive, you can still stop this release with the action below.',
  'ceremony.provideShare': 'Provide your share',
  'ceremony.shareProvided': 'Your share is sealed to {{count}} recipient device(s).',
  'ceremony.reconstruct': 'Reconstruct',
  // S3 is the nested scheme (docs/24): the passphrase is MANDATORY and contacts
  // alone can never reconstruct. S2's is an optional +1 when a contact is
  // missing. Both say the passphrase is never sent to us, and both must keep
  // saying it.
  'ceremony.s3.hint':
    'S3 requires the owner’s offline release passphrase together with the trusted contacts’ shares. It is never sent to us.',
  'ceremony.releasePassphrase': 'Release passphrase',
  'ceremony.s2.toggle': 'Missing a contact? Use the release passphrase',
  'ceremony.s2.hint':
    'Enter the owner’s offline release passphrase. Combined with one contact’s share, it reconstructs the release. It is never sent to us.',
  'ceremony.s2.reconstruct': 'Reconstruct with release passphrase',
  'ceremony.dispute': 'The owner is alive — stop this release',
  'ceremony.dispute.confirmText':
    'This immediately aborts the release for every contact and flags the account for review. Do this if you believe the owner is alive or something is wrong.',
  'ceremony.dispute.yes': 'Yes, stop the release',
  'ceremony.dispute.goBack': 'Go back',
  'ceremony.error.notOpen': 'The release is not open yet. Please check back later.',
  'ceremony.error.affirm': 'We could not affirm.',
  'ceremony.error.revoke': 'We could not revoke your affirmation.',
  'ceremony.error.provideShare': 'We could not provide your share.',
  'ceremony.error.dispute': 'We could not record the dispute.',
  'ceremony.error.register': 'We could not register this device to receive.',
  'ceremony.error.reconstructPass':
    'We could not reconstruct with that release passphrase. Check it and try again.',
  'ceremony.error.reconstruct':
    'We could not reconstruct the release. If a contact is missing, try the release passphrase below.',

  // ── Settings ──────────────────────────────────────────────────────────────
  'settings.eyebrow': 'Account',
  'settings.heading': 'Settings',
  'settings.lede': 'Manage your session and account protections.',

  'settings.session.heading': 'Session',
  'settings.session.sub': 'Your unlocked vault key lives only in this browser’s memory.',
  'settings.session.signedInAs': 'Signed in as',
  'settings.session.unlocked': 'Vault is unlocked',
  'settings.session.explain':
    'Lock it to wipe the key from memory but stay signed in — you’ll re-enter your master passphrase next time. Sign out to also end this session everywhere it’s stored.',
  'settings.session.lock': 'Lock vault',
  'settings.session.signOut': 'Sign out',
  'settings.session.signingOut': 'Signing out…',

  'settings.ai.heading': 'AI assistance',
  'settings.ai.optOut.title': 'Turn off AI for my account',
  'settings.ai.optOut.sub':
    'When on, no AI feature ever runs for you — no assistant, briefing, proposals, or guardian narration. Your safety machinery (check-ins, release ladder) is unaffected.',
  'settings.ai.optOut.group': 'AI for my account',
  'settings.ai.on': 'AI on',
  'settings.ai.off': 'AI off',
  'settings.ai.autonomy.title': 'Let AI act on my behalf (vetoable)',
  'settings.ai.autonomy.sub':
    'When on, the AI may send extra check-in reminders and propose a shorter check-in interval on your behalf. Every action waits in your pending list and you can veto it before it takes effect. The AI can only ever tighten protection, never loosen it.',
  'settings.ai.autonomy.group': 'Let AI act on my behalf',
  'settings.ai.autonomy.on': 'On',
  'settings.ai.autonomy.off': 'Off',
  'settings.ai.floor.title': 'Never tighten below',
  'settings.ai.floor.sub': 'The floor the AI may shorten your check-in interval toward — never below it.',
  'settings.ai.floor.current': ' Current floor: {{days}} days.',
  'settings.ai.floor.none': ' No floor set — the AI will send reminders but not change your schedule.',
  'settings.ai.floor.placeholder': 'days',
  'settings.ai.floor.label': 'Minimum check-in interval in days',
  'settings.ai.floor.save': 'Save floor',

  'settings.protections.heading': 'Account protections',
  'settings.protections.sub': 'Two-factor, passkeys, and recovery email.',
  'settings.protections.body':
    'Dedicated account-security controls are coming here. For now, passkeys are managed at sign-in, and once your engine is armed you confirm you’re still here from the Engine page.',

  'settings.delete.heading': 'Delete this account',
  // ── Check-in cadence ────────────────────────────────────────────────────
  // The delay is the protection, so the copy separates "in force now" from
  // "queued" everywhere. Never merge them into one number.
  'settings.cadence.heading': 'Check-in cadence',
  'settings.cadence.sub':
    'How long you can be silent before we ask. Changing it is a sensitive action — it waits the usual delay, and the current setting stays in force until then.',
  'settings.cadence.current': 'Now: {{days}} days',
  'settings.cadence.label': 'Interval (days)',
  'settings.cadence.hint': 'Between 1 and 365.',
  'settings.cadence.unarmed':
    'Your engine is not armed yet, so there is no cadence to change. Arm it from the Engine page first.',
  'settings.cadence.delayNote':
    'Queued changes wait before taking effect, and you can cancel one from the Engine page at any point. We default to slowness wherever a faster default would be unsafe.',
  'settings.cadence.pending': 'A cadence change is already queued, taking effect {{when}}. Cancel it from the Engine page to queue a different one.',
  'settings.cadence.save': 'Save with your passkey',
  'settings.cadence.saving': 'Queueing…',
  'settings.cadence.unchanged': 'That is already your cadence.',
  'settings.cadence.outOfRange': 'Pick a whole number of days between 1 and 365.',
  'settings.cadence.error': 'We could not queue that change.',
  'settings.delete.sub':
    'Permanent — your vault, contacts, and continuity plans are removed. Like every destructive change it waits 7 days and stays cancellable from the Engine page.',
  'settings.delete.pending':
    'Account deletion pending — it takes effect {{when}}. Until then you can cancel it from the Engine page’s pending actions, and signing in keeps working.',
  'settings.delete.request': 'Request deletion',
  // The literal word typed to confirm. NOT translated: it is compared against
  // the input, and translating one side of that comparison without the other
  // makes the button permanently disabled for that language.
  'settings.delete.confirmWord': 'DELETE',
  'settings.delete.instruction':
    'Type <strong>{{word}}</strong> to confirm, then approve with your passkey. Nothing is removed for 7 days.',
  'settings.delete.inputLabel': 'Type DELETE to confirm account deletion',
  'settings.delete.button': 'Delete account',
  'settings.delete.busy': 'Deleting — confirm with your passkey…',
  'settings.delete.error':
    'We could not request the deletion — the passkey confirmation may have failed or timed out. Nothing was applied; try again.',

  'settings.profile.heading': 'Your name',
  'settings.profile.sub':
    'Shown on your account menu. Optional — leave it blank to just show your email. This is display-only; it is never used to unlock, release, or verify anything.',
  'settings.profile.title': 'Title',
  'settings.profile.titleNone': 'None',
  'settings.profile.name': 'Name',
  'settings.profile.namePlaceholder': 'e.g. Alex Rivera',
  'settings.profile.save': 'Save name',
  'settings.profile.saving': 'Saving…',
  'settings.profile.saved': 'Saved.',
  'settings.profile.error': 'We could not save your name — please try again.',

  'settings.channels.heading': 'Notification channels',
  // The no-tracking commitment (docs/26 §9), stated where the choice is made.
  'settings.channels.sub':
    'Check-in reminders and account notices go to every channel you verify here. We record only what the provider proves — delivered or bounced — and never track whether you open or read anything.',
  // A LAPSED subscriber's paid channels are grandfathered and never re-gated
  // (docs/28). "Nothing was turned off" is the reassurance; a translation that
  // implies the channels stopped working inverts the message.
  'settings.channels.downgrade':
    'Your paid plan has ended, but every channel you already verified — {{channels}} — keeps protecting you exactly as before. Nothing was turned off. Adding <em>new</em> SMS channels requires <plans>Truecairn Personal</plans>.',
  'settings.channels.push': 'Push notifications (this browser)',
  'settings.channels.verifiedCount_one': '{{count}} verified',
  'settings.channels.verifiedCount_other': '{{count}} verified',
  'settings.channels.state.verified': 'Verified',
  'settings.channels.state.unverified': 'Unverified',
  'settings.channels.verified': 'Verified {{type}} channel',
  'settings.channels.codeSent': 'A verification code was sent — enter it below.',
  'settings.channels.unverified': 'Unverified — re-send a code to finish enrolment.',
  'settings.channels.codePlaceholder': '6-digit code',
  'settings.channels.codeLabel': '6-digit verification code',
  'settings.channels.verify': 'Verify',
  'settings.channels.resend': 'Re-send code',
  'settings.channels.removalPending':
    'Removal scheduled — applies {{when}}; cancel from the Engine page.',
  'settings.channels.remove': 'Remove',
  'settings.channels.add.title': 'Add a channel',
  'settings.channels.add.sub':
    'We send a 6-digit code through the channel itself — an email or a text message — and you type it back here to prove it reaches you.',
  'settings.channels.add.smsLocked': 'SMS is on <plans>Truecairn Personal</plans>.',
  'settings.channels.add.typeLabel': 'Channel type',
  'settings.channels.add.email': 'Email',
  'settings.channels.add.sms': 'SMS',
  'settings.channels.add.emailPlaceholder': 'you@example.com',
  'settings.channels.add.phonePlaceholder': '+15551234567',
  'settings.channels.add.emailLabel': 'Email address to add',
  'settings.channels.add.phoneLabel': 'Phone number to add',
  'settings.channels.add.button': 'Add channel',
  'settings.channels.add.sending': 'Sending code…',
  'settings.channels.pushCard.title': 'Push notifications on this device',
  'settings.channels.pushCard.sub':
    'Your browser will ask permission, then a notification carries the 6-digit code to confirm the channel works end-to-end.',
  'settings.channels.pushCard.enable': 'Enable push',
  'settings.channels.pushCard.enabling': 'Enabling…',
  'settings.channels.error.add': 'We could not add that channel — check the address and try again.',
  'settings.channels.error.push':
    'We could not enable push on this device — notification permission may have been refused.',
  'settings.channels.error.verify':
    'That code was not accepted — it may have expired. Re-send a code and try again.',
  // Must fit BOTH failure shapes (QA 2026-07-21 A4): the passkey prompt was
  // dismissed, or the security check failed without a prompt ever appearing.
  // "May have been cancelled" alone reads as a lie in the second case, so both
  // possibilities are stated and nothing-was-applied is confirmed.
  'settings.channels.error.remove':
    'We could not remove that channel — the passkey confirmation was declined, or the security check did not complete. Nothing was scheduled; try again.',

  'settings.matrix.heading': 'What each channel is used for',
  // The SAFETY FLOOR. Check-in requests, escalation requests and security alerts
  // are exempt from the matrix at selection time, and this sentence is where the
  // owner learns no setting can silence them. A translation that hedges it would
  // let someone believe they muted more than they did.
  'settings.matrix.sub':
    'Turn a channel off for a purpose and routine messages of that kind stop going there. Check-in requests, escalation requests, and security alerts are always delivered — no setting can silence them.',
  'settings.matrix.unverified': ' — unverified (never selected until verified)',
  'settings.matrix.owner_verification.title': 'Verification waves',
  'settings.matrix.owner_verification.hint':
    'The extra are-you-there waves while a check-in is unanswered.',
  'settings.matrix.owner_notices.title': 'Account notices',
  'settings.matrix.owner_notices.hint':
    'Routine updates: engine changes, pending sensitive actions, plan notices.',
  'settings.matrix.contact_notices.title': 'Ceremony requests',
  'settings.matrix.contact_notices.hint': 'Requests you receive as someone ELSE’s trusted contact.',
  'settings.matrix.error': 'We could not save that preference — try again.',

  // ── Trusted contacts ──────────────────────────────────────────────────────
  'contacts.eyebrow': 'Continuity',
  'contacts.heading': 'Trusted contacts',
  'contacts.progress': '{{done}} of 3 — invite, enrol, confirm',
  'contacts.lede': 'People who can reconstruct access when your release conditions are met.',

  'contacts.invite.heading': 'Who should receive this, if the conditions are met?',
  'contacts.invite.sub':
    'Pick the kind of recipient — it decides which parts of your vault reach them, and when. They enrol from their own device by proving they hold their keys.',
  'contacts.invite.kind': 'Kind of recipient',
  'contacts.invite.countsAs': 'Counts as a {{role}} contact.',
  'contacts.invite.labelNote':
    'The label is sealed under your S1 tier key — we never see it.',
  'contacts.invite.label': 'Label',
  'contacts.invite.create': 'Create invitation',
  'contacts.invite.draft': 'Draft a message with AI',
  'contacts.invite.drafting': 'Drafting…',
  'contacts.invite.upgradeLink': 'Upgrade to Personal',
  'contacts.invite.token': 'Share this one-time invite token with your contact:',
  'contacts.invite.draftLede':
    'Suggested message to send alongside the invite token — edit it before you send:',

  'contacts.list.heading': 'Your contacts',
  // Three numbers, because ENROLLED is not the one that gates a release —
  // confirmed is. Showing only enrolled let a contact look ready while their key
  // was still unconfirmed, which is the exact gap the readiness checkup raises.
  'contacts.list.count_one': '{{count}} contact · {{enrolled}} enrolled · {{confirmed}} confirmed',
  'contacts.list.count_other': '{{count}} contacts · {{enrolled}} enrolled · {{confirmed}} confirmed',
  'contacts.list.unconfirmed_one': '{{count}} to confirm',
  'contacts.list.unconfirmed_other': '{{count}} to confirm',
  'contacts.list.empty': 'No contacts yet. Invite one above; they enrol from their own device.',
  'contacts.list.sharePending':
    'Share pending — cancellable for 7 days (effective {{when}})',
  'contacts.list.pending': 'Pending',
  'contacts.list.cancelInvite': 'Cancel invite',
  'contacts.role.personal': 'Personal',
  'contacts.role.professional': 'Professional',
  'contacts.role.recovery': 'Recovery',

  // Key-confirmation states. 'changed' and 'tampered' are NOT errors to retry
  // past: contact keys derive from the contact's own master key, so they change
  // only on a rotation, and a rotation arrives as a notice seven days ahead. An
  // unannounced change is an attack, and this copy has to say so rather than
  // suggest a refresh. A translation that softens it into "please try again"
  // removes the only warning the owner gets.
  'contacts.key.no_keys':
    'This contact has not finished enrolling yet, so there are no keys to confirm.',
  'contacts.key.unverified':
    'Confirm this contact’s security code with them first — compare it by phone or in person, not over this app.',
  'contacts.key.changed':
    'This contact’s keys have changed since you confirmed them, and no key rotation was announced. Do not assign a share. Contact them directly and compare the security code again before doing anything else.',
  'contacts.key.tampered':
    'We could not read your saved confirmation for this contact. Treat this as a warning, not a glitch: confirm the security code with them directly before assigning anything.',
  'contacts.key.verified': 'This contact’s keys are confirmed.',
  'contacts.key.showCode': 'Security code',
  'contacts.key.hideCode': 'Hide security code',
  'contacts.key.confirmedAt': 'Confirmed {{when}}',
  'contacts.key.assignS1': 'Assign S1 share',
  'contacts.key.assigning': 'Assigning…',
  'contacts.key.badge.changed': 'Keys changed — do not assign',
  'contacts.key.badge.tampered': 'Confirmation unreadable',
  'contacts.key.badge.unverified': 'Not confirmed',

  // The out-of-band step is the ONLY part of this feature that establishes
  // anything (migration 0061). Its copy has one job: get the owner onto a
  // different channel. Confirming over a chat window the server relays verifies
  // nothing, so "by phone or in person" and "not over email or a chat app" are
  // load-bearing in every language, as is the reason — if someone can change
  // what you see here, they can change what you see there.
  'contacts.code.changedAlert':
    '<strong>These keys are not the ones you confirmed.</strong> A contact’s keys change only when they rotate them, and a rotation reaches you as a notice seven days ahead. You did not get one. Do not assign a share to this contact. Call them — on a number you already had, not one from this page — and compare the code below before anything else.',
  'contacts.code.tamperedAlert':
    '<strong>We could not read your saved confirmation.</strong> Confirm the code with this contact directly before assigning anything to them.',
  'contacts.code.label': 'Security code for {{name}}',
  'contacts.code.instruction':
    'Read this out to {{name}} <strong>by phone or in person</strong> and check it matches the code on their screen. Do not compare it over email or a chat app — if someone can change what you see here, they can change what you see there too. The codes match only if the keys we hold for them are really theirs.',
  'contacts.code.match': 'The codes match',
  'contacts.code.saving': 'Saving…',
  'contacts.code.notNow': 'Not now',

  'contacts.split.heading': 'Split a higher tier across contacts',
  'contacts.split.sub.s2':
    '{{count}} contacts of different roles each hold one share; your release passphrase (kept offline, never stored) is the extra share. We cannot recover it.',
  'contacts.split.sub.s3':
    '{{count}} contacts of different roles each hold one share, and your release passphrase (kept offline, never stored) is required to combine them: any 2 contacts plus the passphrase reconstruct. We cannot recover the passphrase.',
  'contacts.split.tier': 'Tier',
  'contacts.split.tierGroup': 'Share tier',
  'contacts.split.holders': 'Share holders',

  // ── "This split, as it stands" ────────────────────────────────────────────
  // A live reading of the four conditions onAssignTier enforces. The two
  // threshold sentences are the most dangerous copy in the product: S2's
  // passphrase is an OPTIONAL fallback, S3's is a MANDATORY mask, and describing
  // S3's as optional would tell someone their permanently-unrecoverable items
  // are recoverable. Keep them aligned with /guide §7 and §11.
  'contacts.split.state.heading': 'This split, as it stands',
  'contacts.split.state.thresholdS2':
    'S2 — a 2-of-3 split. Any two of these three shares reconstruct it; no single share, and no two same-role contacts, can. The release passphrase is an optional fallback here.',
  'contacts.split.state.thresholdS3':
    'S3 — a nested scheme. Your release passphrase is a mandatory mask over a 2-of-3 split held by three contacts: reconstructing needs the passphrase and any two of the three. There is no contacts-only path.',
  'contacts.split.chip.empty': 'Empty share',
  'contacts.split.chip.passphraseS2': 'Release passphrase',
  'contacts.split.chip.passphraseS3': 'Release passphrase — required',
  'contacts.split.check.holders': '{{picked}} of {{need}} share holders picked',
  'contacts.split.check.roles':
    'Two different roles — a conspiracy has to span both personal and professional life',
  'contacts.split.check.confirmed': "Every holder's keys confirmed out of band",
  'contacts.split.check.passphrase': 'Release passphrase set and confirmed (8 characters or more)',
  'contacts.split.passphraseNote':
    'Kept offline, never stored. We cannot recover it — and for S3 it is required every time, so losing it makes S3 permanently unrecoverable.',
  'contacts.split.blocked.changed': 'keys changed, confirm again before using',
  'contacts.split.blocked.tampered': 'confirmation unreadable, confirm again',
  'contacts.split.blocked.unverified': 'confirm their security code first',
  'contacts.split.noEnrolled': 'No enrolled contacts yet — invite and enrol some first.',
  'contacts.split.noneConfirmed':
    'Confirm your contacts’ security codes in the list above before splitting a tier key across them.',
  'contacts.split.passphrase': 'Release passphrase',
  'contacts.split.passphraseConfirm': 'Confirm release passphrase',
  'contacts.split.submit': 'Assign {{tier}} shares',
  'contacts.split.assigning': 'Assigning — confirm with your passkey…',
  'contacts.split.needPlan':
    '{{tier}} needs {{needed}} contacts — your plan includes {{cap}}. <upgrade>Upgrade</upgrade> to assign it.',
  'contacts.split.needMore': 'Enrol {{needed}} contacts to split {{tier}}.',
  'contacts.split.pending':
    'Tier share assignments pending, cancellable for 7 days (effective {{when}})',

  'contacts.beneficiary.heading': 'Designate a beneficiary',
  'contacts.beneficiary.sub':
    'Name an enrolled contact to receive a release — they inherit the content without holding a share or affirming. The holders still reach consensus. For S1 we seal them their own copy now; for S2/S3 the holders re-seal at release time. A 7-day, cancellable change.',
  'contacts.beneficiary.tier': 'Beneficiary tier',
  'contacts.beneficiary.contact': 'Beneficiary',
  'contacts.beneficiary.select': 'Select an enrolled contact…',
  'contacts.beneficiary.noteS1':
    'S1 seals the beneficiary their own copy now, so they can open it after a release without holding a share or affirming.',
  'contacts.beneficiary.noteS2S3':
    'S2 and S3 send no key material from here — the beneficiary receives their tier only through a completed release.',
  'contacts.beneficiary.pickFirst': 'Pick an enrolled contact.',
  'contacts.beneficiary.submit': 'Designate beneficiary',
  'contacts.beneficiary.designating': 'Designating — confirm with your passkey…',
  'contacts.beneficiary.pending':
    'Beneficiary designation pending, cancellable for 7 days (effective {{when}})',

  'contacts.error.invite': 'We could not create the invitation.',
  'contacts.error.draftUnavailable': 'The AI drafter is unavailable right now.',
  'contacts.error.draft': 'We could not draft a message.',
  'contacts.error.cancelInvite': 'We could not cancel the invitation.',
  'contacts.error.confirm': 'We could not save that confirmation.',
  'contacts.error.assignS1':
    'We could not assign the share — the passkey confirmation may have failed or timed out. Nothing was applied; try again.',
  'contacts.error.roleDiversity':
    'Pick contacts of at least two different roles — release consensus requires it.',
  'contacts.error.passTooShort': 'The release passphrase must be at least 8 characters.',
  'contacts.error.passMismatch': 'The release passphrases do not match.',
  'contacts.error.unconfirmedPick': 'One of the chosen contacts has an unconfirmed key.',
  // "Re-submitting is safe" is the actionable half — without it the owner does
  // not know whether retrying would double-assign.
  'contacts.error.assignTier':
    'We could not assign the tier shares — the passkey confirmation may have failed or timed out. Re-submitting is safe: an assignment that already went through will not be duplicated.',
  'contacts.error.pickBeneficiary': 'Pick an enrolled contact to designate as a beneficiary.',
  'contacts.error.designate':
    'We could not designate the beneficiary — the passkey confirmation may have failed or timed out. Nothing was applied; try again.',

} as const;

// The closed set of things the app can say. Every catalog is typed against it,
// so a key that exists in a translation but not here is a compile error rather
// than a string nobody ever sees.
export type AppMessageKey = keyof typeof appEn;
