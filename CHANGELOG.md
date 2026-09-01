# Changelog

All notable user-visible changes to Truecairn, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/) in user-facing language —
what changed for you, not which files moved. The public `/changelog` page
renders this same file. The lockstep rule (CLAUDE.md): a change lands here in
the SAME change-set that ships it.


## 2026-08-31 — Your older contacts are protected now too

### Fixed
- **Yesterday's fix only covered contacts added from then on. It now covers the
  rest.** We told you your private labels for contacts were no longer readable by
  whoever receives your first-tier vault. That was true of contacts added after
  the change, and we said so — the older ones were still stored the old way. Next
  time you unlock your vault, they are quietly moved across as well. There is
  nothing to click and nothing to confirm.
- **In particular, you are not asked to re-check anybody.** If you have already
  compared a contact's security code with them and confirmed it matched, that
  confirmation stands — only where it is stored changes. Being asked to redo it
  would teach people to click through the one warning that has to keep meaning
  something, so we don't.
- **A contact whose confirmation no longer checks out is left alone**, still
  showing its warning, rather than being quietly rewritten into something that
  looks fine.

## 2026-08-30 — Your contacts' names are no longer readable by whoever receives your vault

### Fixed
- **The private names you give your contacts were readable by one of them.** You
  can write a private label for each trusted contact — your own note about who
  they are. Those labels, and your confirmation that a contact's security code
  matched, were encrypted with a key that is handed to whoever receives your
  first-tier vault when a release completes. So that one person could read your
  private label for **every** contact you have, including people who are only
  involved in your second- or third-tier release and have nothing to do with
  theirs.

  They are now encrypted with a key derived from your master passphrase, which
  no release ever hands to anybody: a release rebuilds the keys for a tier of
  your vault, never your master key. Labels written before today stay readable
  and **nothing asks you to re-confirm any contact** — re-doing a security-code
  comparison you already did correctly would teach people to click through the
  one warning that must keep meaning something.

- **When a release was cancelled, your contact's device kept a key it no longer
  needed.** If you are named as someone's trusted contact, your browser creates a
  key for that specific release — it is how the pieces sent to you can be opened
  by you and nobody else. That key was correctly deleted once you had retrieved
  someone's vault. But if the release ended any other way — the owner came back
  and cancelled it, or it failed — the key stayed in your browser's storage
  indefinitely, because the screen that deletes it stops being shown the moment a
  release ends. It is now deleted when a release is cancelled or fails, as well
  as when it completes.

  To be accurate about what this did and did not mean: the key on its own opens
  nothing. The pieces it unseals stay on our servers, behind your sign-in and
  behind the time lock that only opens when a release is genuinely underway. So
  this was a key left lying around longer than it should have been, not an
  exposure of anyone's vault. It should not have been lying around.

- **The reverse mistake is now specifically guarded against.** A release can be
  finished for one contact while another still has to retrieve their part — and
  for that second person the key must be kept, or they would be locked out of a
  release permanently, with no way to re-register a new one. A test now checks
  every combination of release state and contact state to make sure the cleanup
  never runs early.

- **Encryption key material is wiped from memory sooner.** When your release
  passphrase is turned into one of the pieces that reconstructs a vault, the
  intermediate value is now erased the moment it has been copied, rather than
  left for the browser to clean up whenever it gets around to it.

## 2026-08-27 — Your recovery code can finally be used, and our rate limits count the right computer

### Added
- **You can now unlock with your recovery code.** This is the bigger admission
  here: the code we hand you when you create your vault, and tell you to save
  somewhere safe, had nowhere to be typed in. The encryption behind it worked and
  always had — your master key really was stored wrapped under that code — but no
  screen in the product ever asked for it. So if you had forgotten your master
  passphrase, the code would not have saved you. There is now a "Use your
  recovery code" link on the unlock screen, and a page that takes the code and
  opens your vault.
- **It still takes two things, not one.** That page sits behind your passkey,
  exactly as the passphrase screen does — so a recovery code on its own,
  photographed or found in a notes app, does not open your vault. The code is
  used entirely on your device: it derives a key here and is never sent to us,
  which is checked by a test.
- **A `security.txt` file**, at `/.well-known/security.txt`. It is the standard
  place a researcher or a scanner looks first for how to report a vulnerability,
  and it names the same contact and policy the disclosure page does.

### Fixed
- **Our rate limits were counting a number the caller could choose.** Every
  per-visitor limit here — failed sign-ins, passkey attempts, the second-factor
  check that guards protective actions like cancelling a release, and the AI
  usage ceilings — counts attempts against the address a request comes from. We
  were reading that address from a header anyone can set, and which the networks
  in front of us pass along rather than replace. Someone could therefore hand us
  a different address on every attempt and never reach any limit. The address now
  comes from a value our own edge writes and a caller cannot forge, and a header
  sent twice is discarded rather than believed. Nothing about your account
  changes; the limits that were supposed to be there simply are.
- **The security contact address is readable again without JavaScript.** Our
  network provider had been rewriting `security@truecairn.app` on the disclosure
  page into a placeholder only a script could turn back into an address — so
  anyone reading with scripts off, or with a tool, saw no address at all on the
  page whose entire job is publishing one. That rewriting is off, which also
  means the only scripts on our pages are ours again.

### Changed
- **Our edge now verifies our servers' certificate** rather than just checking
  one exists. Traffic between the network edge and our servers was encrypted, but
  the certificate was accepted unchecked — a gap something in between could have
  stood in. It is now validated.
- **Removed a leftover public endpoint.** A "hello world" service left over from
  when this project was first created had been reachable on the internet since
  June. It held nothing, did nothing and was connected to nothing, but it was
  ours and it should not have been there.

### Known limitation
- **Recovery unlocks your vault; it does not change your passphrase.** Keep the
  code — for now it stays the way back in. Letting you set a new passphrase
  afterwards is the next piece of this work.


## 2026-08-26 — The search box works, your vault searches and reorders, and the engine says what it is doing in words

### Added
- **The search box in the sidebar does something now.** It has shown a "⌘ K"
  hint next to it since the current design shipped, over a box that took your
  cursor and ignored everything you typed. Pressing ⌘K (or Ctrl+K) now opens a
  command palette: jump to any screen, or find a vault item or a contact by name.
  Arrow keys move, Enter runs, Escape closes.
- **It searches on your device and sends nothing anywhere.** There is no search
  request behind it and no server-side index. Your vault titles and contact names
  are already decrypted here, in this browser, because that is the only place
  they can be read — so matching what you type against them costs no request and
  tells us nothing. The panel says so at the bottom, and that line is a statement
  of how it is built rather than a reassurance.
- **The Engine page now draws the liveness ladder.** Seven steps, from Active
  through to Full release, showing which have been passed and which are still
  ahead. The page has always said the escalation is slow and reversible; now you
  can see how far it has gone and how much room is left, instead of reading one
  status word and taking our word for it.

- **Search your vault by title.** A search box sits beside the tier filter and
  narrows the list as you type. It works on your device, over titles already
  decrypted in this browser — there is no search request and no index on our
  side, so what you type never leaves your computer. The box says where the
  decryption happened.
- **Open an item without leaving the list.** "Details" expands a row to show its
  tier, category and when it last changed. The content stays sealed until you ask
  for it by name: a second, deliberate "Decrypt content". "Re-seal" closes it
  again and drops the decrypted copy. The handles disappear while a search or
  filter is active — reordering a filtered list has no honest meaning, because
  the positions you can see are not the positions being saved.
- **Put your vault in the order you want it.** Drag a row to move it, and the
  order is remembered. It is your order, not a sort we chose, and it is stored as
  a display preference — it changes nothing about tiers, timing, or who receives
  what. Dragging is a pointer convenience and never the only way to work: the
  order is optional, an untouched vault keeps the order it always had, and
  keyboard reordering is still to come.

- **The split now shows you what it is, and what it still needs.** Choosing S2 or
  S3 draws the shares the split will contain — each holder you have picked, an
  "empty share" for each one you have not, and your release passphrase — followed
  by a plain sentence about what that threshold means and a live list of the four
  conditions still outstanding. Before, the button simply refused and told you one
  reason at a time, after you pressed it.
- **The difference between S2 and S3 is stated where you choose it.** For S2 the
  release passphrase is an optional fallback: two contacts can reconstruct without
  it. For S3 it is a mandatory mask — the passphrase *and* two of three contacts,
  with no contacts-only path — so losing it makes S3 permanently unrecoverable.
  That sentence now sits beside the tier switch instead of only in the guide.
- **Smaller things the page was leaving you to infer.** A step count at the top
  ("0 of 3 — invite, enrol, confirm"). The contact list counts confirmed as well
  as enrolled, because confirmed is the one that gates a release, with a badge
  when any are outstanding. A note beside the Label field saying it is sealed
  under your S1 tier key and we never see it. And the beneficiary section now says
  that S2 and S3 send no key material — the tier arrives only through a completed
  release.

- **You can change language from any public page.** The picker is in the footer,
  so it is on the landing page and on every guide, security, company and legal
  page behind it. It was only on the sign-in, sign-up, unlock and Settings screens
  when Spanish shipped — which left the one surface a Spanish reader actually
  arrives on with no way to switch. Detecting a Spanish browser was never enough:
  plenty of Spanish readers use a machine set to English.

- **Truecairn is available in Spanish.** A language picker sits on the sign-in,
  sign-up and unlock screens and in Settings, a Spanish browser now gets Spanish
  by default, and `/es/…` addresses work for every public page. Switching takes
  effect immediately, without a reload, and each language is named in itself so
  the list stays readable after you switch.
- **What we want to be straight about.** The Spanish was written by a model and
  checked line by line against the English for meaning — that pass found and fixed
  a real problem, where the master passphrase had two different names. **No native
  Spanish speaker has read it yet.** We are saying so rather than letting you
  assume otherwise, because a translation that is merely grammatical is not good
  enough for the two or three sentences here that someone reads on the worst day
  they will ever use this product. If something reads wrong to you, telling us is
  genuinely useful.
- **Fixed while turning it on:** every Spanish page description was too long for a
  search result and would have been cut off mid-sentence. Spanish runs longer than
  English and nothing had ever measured them, because the check only ran against
  the language we served.

- **Your notification channels read as a list of channels.** Each one shows its
  destination with a Verified or Unverified badge beside it, and the card header
  counts how many actually work — the number that matters, since one channel is
  one point of failure for the message that decides whether your silence is real.
  Turning on push for a browser now sits with the other ways to add a channel
  instead of in its own block further down the page.
- **Two layout fixes on that page.** The check-in interval and the button that
  saves it share a line, so the action is where the change is. And on the audit
  trail, verifying the chain and downloading a copy sit at opposite ends rather
  than side by side — they are different kinds of act.

- **You can change your check-in cadence.** Settings now has a Check-in cadence
  card: how many days you can be silent before we start asking. It shows what is
  in force now, and changing it queues the change like every other sensitive
  setting — the delay runs, the old cadence stays in effect throughout, and you
  can cancel from the Engine page at any point until it applies. The two numbers
  are never merged: what governs today and what is coming are shown separately.
  This is the first time this setting has been reachable at all — the machinery
  to apply it has been there since the engine was built, with nothing on the
  outside able to ask for it.

- **Your audit trail is readable now.** It was a stack of boxes each showing a
  bare event name; it is a proper list, newest first, filterable by whether an
  entry is about your vault, your contacts, a release, or your account. Opening a
  row shows the hash chain behind it — this entry's digest and the one before it
  — with a line explaining why that makes the record tamper-evident. The event
  name is still shown exactly as it is stored rather than reworded, because the
  point of the card is that it shows you what is actually recorded.

- **Home shows your vault.** It summarised it as a number in the readiness row
  and then never named a single item, so the screen you land on had nothing of
  yours on it. There is now a Vault card beside Trusted contacts, listing your
  most recent items with their tier and category. Titles are decrypted here, the
  same as on the vault list; the content is never fetched.
- **"Add your first vault item" now adds it, without leaving Home.** That checkup
  opens the real new-item form in place — the same one the vault page uses,
  category guidance and attachments included — and closes again when you save.
  The other checkups still take you to the screen that owns the change, because
  those flows involve keys and a second copy of a key flow is a place for the two
  to drift apart.
- **A pending contact offers to finish, instead of only saying "Pending".** And
  the checkups card shows how many of the outstanding items would actually stop a
  release today, rather than flattening "one thing blocks you" and "three things
  could be tidier" into one number.
- **When a checkup came from the assistant rather than the scorer, it says so.**
  The disclosure below the list only appears when something on it actually did.

- **The sidebar shows how many items and contacts you have.** A small count sits
  next to Vault and Contacts. It appears only once we actually know the number —
  never a "0" while the page is still loading, or when the list could not be
  fetched, because a confident zero on a screen about whether your things are
  still there is worse than no number at all.

### Changed
- **The new-item form no longer sits in front of your vault.** It stays open while
  your vault is empty, because then there is only one useful thing to do. Once you
  have items it collapses to a "New vault item" button, so the list starts at the
  top of the page instead of below a form you were not filling in.

### Fixed
- **The engine used to describe itself in code.** The Engine page printed the raw
  internal name of the state in its status pill — `check_in_pending`,
  `limited_release` — and the Home page had its own list of friendlier names that
  had drifted out of step with the actual engine: it named four states the engine
  can never be in, and was missing seven that it can. The most ordinary one,
  the state that simply means "we are waiting to hear from you", was among the
  missing, so it rendered as `check in pending` — in English, whichever language
  you had chosen. Every state now has one name, written once, used on both pages
  and translated in both languages.

## 2026-08-25 — The AI features run on a newer model, reached a different way

### Correction
- **An earlier version of this entry, published this morning, said the switch to
  Gemini 3.7 Flash was done. It was not.** The new model turned out not to be
  offered in the region our Google Cloud project runs in, so for part of the day
  the AI features could not answer at all: the assistant said it was unavailable
  and the dashboard plan card said it could not generate a plan. Nothing else was
  affected — no check-in, no release, no vault content — because every AI feature
  is built to fail quietly rather than block anything. We are correcting the entry
  rather than quietly editing it, because a changelog that revises itself without
  saying so is worth less than no changelog.

### Changed
- **Every AI feature now uses Gemini 3.7 Flash instead of Gemini 2.5 Flash.** The
  assistant, the dashboard plan, the readiness explanation, the briefing, the
  draft invitation and the continuity-report narration all move together. Nothing
  about what the AI can see or do changed — it still receives only counts, tiers
  and states, never your vault contents, and it still cannot release anything.
- **We now call Google's Gemini API directly, instead of going through Google
  Cloud's Vertex AI.** Same company, same model, one less layer. We use a
  billing-enabled account, on which Google does not use prompts or responses to
  train its models — that was the condition for making the change at all. Our
  sub-processor list has been updated to say so.
- **What you may notice:** answers are a little longer and more structured, and
  they may take slightly longer to arrive.

### Why
- **The old model family retires on 16 October 2026.** Every AI surface fails
  soft, so that date would not have broken anything — it would have quietly
  stopped answering, and the honest risk was that nobody noticed for weeks. We
  would rather move early than discover it from a blank panel.
- **Why we left Vertex AI.** The current Gemini models are not offered on the
  regional endpoints we were using, only on a global one that carries no
  guarantee about which country processes the request. That left a choice between
  running an old model and giving up a location guarantee. Calling the API
  directly avoids both, and the AI only ever receives counts and settings — never
  your content — so there was little to give up.
- **We re-ran our adversarial check against the new model before switching.** It
  passed: no account information leaked into an answer, and all four
  prompt-injection attempts were ignored. That check covers two of the six places
  a model writes text for you, which is the same coverage it had before — we are
  saying so rather than implying it covers all six.
- **One caveat we would rather state than hide:** the new model does its own
  internal "reasoning" before answering, and unlike the old one it cannot be told
  to skip it entirely. We turned it down as far as the model allows. It costs a
  little more per answer and it is the reason answers can run longer.

### Fixed
- **Settings no longer shows an empty "Language" box.** Truecairn is published in
  one language today, so there is no choice to offer — but the box was drawn
  anyway, with a heading and nothing inside it. That reads as a setting that is
  broken rather than one that does not exist yet. The section now appears only
  when there is a second language to pick.

## 2026-08-21 — Your vault items have set categories, and your contacts have a kind

### Changed
- **The Category box on a vault item is now a list of eight choices instead of a
  blank field you typed into.** The eight are: recovery instructions,
  operational playbooks, asset inventory, identity documents, financial
  accounts, legal documents, crypto wallets, and personal archive.
- **If you had typed a category that is not one of those eight, that item now
  reads "Personal archive".** We would rather say this plainly than let you
  discover it. Nothing about the item itself changed — not its contents, not its
  title, not its tier, not who would receive it. Only the label moved, and you
  can set it to any of the eight from the item's own page.
- **Adding a contact now asks "Who should receive this, if the conditions are
  met?"** instead of asking for a role. You pick the kind of recipient — spouse /
  family executor, cofounder / business partner, lawyer / accountant, recovery
  contact, or designated heir.
- **Your existing contacts kept working and were given the closest kind.** A
  personal contact became a spouse / family executor, a professional one became a
  cofounder / business partner, and a recovery contact stayed a recovery contact.
  You can change any of them.
- **The new-item screen now shows who an item would reach.** Pick a category and
  it lists which kinds of recipient receive it, at which stage, and which never
  receive it at all.

### Why
- **Both lists come from the same table**, which our release policy has been
  written around since July: eight kinds of material, five kinds of recipient, and
  which stage each pairing belongs to. Until now it existed only in a document,
  because neither list was fixed enough to attach it to.
- **It is a suggestion, not a rule.** The tier you choose is the one that applies —
  we do not override it and nothing is blocked. The list is there because the
  alternative was choosing a stage with no idea who was on the other end of it.
- **Why unknown categories became "Personal archive", and why new items start
  there.** It is the category that reaches the fewest people. When we could not
  tell what an item was meant to be, we moved it to the narrowest setting rather
  than guess at a wider one — and an item whose category you have not thought
  about yet should sit where it reaches fewest people, to be widened deliberately.
- **Why a lawyer and a cofounder still count as the same "role" underneath.** A
  release needs agreement from people in genuinely different parts of your life —
  that is what makes a group of contacts hard to collude. A lawyer and a cofounder
  may be different kinds of recipient, but they are the same part of your life, and
  possibly the same office. Counting them as two would have quietly lowered that
  bar. So the new kinds sit on top of the rule rather than replacing it.


## 2026-08-12 — The front page was nine and a half megabytes

### Changed
- **Our landing page was downloading about 9.5 MB before it showed you
  anything, and now downloads about 1.4 MB.** Roughly 96% of that page was four
  files: three photographs and the background video behind the headline. The
  photographs were stored losslessly — around one byte per pixel, which is what
  that format is for and precisely what it should not have been used for on
  photographs. They are now AVIF and WebP: the same three pictures, 5.0 MB down
  to 150 KB.
- **The video behind the headline was a 1080p file at 3.2 Mbps.** It is
  decorative, it is cropped to fit whatever shape your window is, and it sits
  under a dark gradient — so most of that detail never reached anyone's eye. It
  is now 720p: 3.9 MB down to 1.0 MB, and we could not see the difference on the
  page.
- **The pictures further down the page now load when you scroll to them.** All
  of them used to be fetched during the first load, including the large
  photograph at the very bottom, which nobody sees until they have read the whole
  page. Their boxes were already reserved at the right size, so nothing shifts
  around as they arrive.
- **What this does not change:** nothing about your account, your vault, the
  release ladder or any page you see once you are signed in. This is the public
  marketing page only. If you are on a metered connection, it is the difference
  between a page visit costing 9.5 MB and costing 1.4 MB.
- **The background video no longer loads before the page does — and on a phone it
  does not load at all.** It used to start downloading before anything you could
  read had arrived, and on a phone it was fetched *twice*: the browser began the
  download, our app rebuilt the page around it, and the fetch started over. The
  still image behind the headline now loads first and the loop follows once the
  page has settled. On a small screen, where the video sits behind a dark
  gradient and is cropped to a sliver, it is skipped entirely — as it is if you
  have asked your device for reduced motion, or are on a metered or 2G
  connection. The page looks the same; it just stops spending a megabyte to say
  so.
- **Together with the above, the landing now finishes its largest paint at the
  same moment it paints anything at all.** Measured on a simulated phone
  connection: 2.1 s before this work, 1.3 s after.

### Fixed
- **The landing page had no `main` landmark, and our footer headings skipped
  three levels.** Both are things a screen reader relies on to let someone move
  around a page instead of reading it top to bottom. The page now has one `main`
  region, and the four footer headings are proper second-level headings styled to
  look the same. Verified with a full axe scan of the landing and two public
  pages: no violations.
- **A screenshot on the landing page was still advertising WhatsApp
  verification.** We withdrew WhatsApp on August 1 and corrected every line of
  text — but one of the four product screenshots is a picture of a page that used
  to say it, and no test can read a picture. It has been re-taken from the current
  app.
- **Everything the browser downloads now says how long it may be kept.** Files
  whose names contain a content fingerprint — which change name whenever they
  change — may be kept for a year. Files with fixed names, like the hero video,
  get a week. Pages themselves are always re-checked, so a deploy reaches you
  immediately. Before this, everything expired after four hours regardless, which
  meant a returning visitor re-downloaded megabytes that had not changed.

## 2026-08-11 — Backups on the status page, and a plain-language index for the assistants people ask about us

### Added
- **A summary of this site, written for AI assistants, now lives at
  `/llms.txt`.** More and more people meet a product like ours by asking an
  assistant about it rather than by reading the site, and the answer they get is
  assembled from whatever the assistant managed to read. Our public pages are
  long and careful, which is a virtue for a reader and a liability for a machine
  skimming them: the qualifications are exactly what gets dropped.
  So we wrote the summary ourselves. It says what Truecairn is, describes each
  public page in a sentence, and — the part that matters — states plainly what
  we do **not** claim: that no third-party security audit has been published, that
  we hold no security certifications, that no funding has been announced, and
  that our protection against a substituted contact key depends on you actually
  making the out-of-band call to confirm their security code. Those are the same
  facts as our press page's fact sheet, in the place a machine will actually
  find them. We would rather write our own limits down than have them inferred.

### Changed
- **Our status page now reports database backups, and it reports the part that
  actually matters.** That dot had been grey since the page launched, labelled
  "not instrumented", because the snapshots are taken by our hosting platform's
  control plane and this application genuinely cannot see them. Which was
  honest, and useless: it looked exactly the same whether backups existed or
  not — and for a period earlier this year they did not exist at all, while the
  dot said precisely what it says now.
  So it reports something else instead: whether a person has actually restored
  from a backup, decrypted the result and recorded the date. That is the only
  property anyone wants from a backup, and a snapshot count never proves it. A
  backup nobody has ever restored from is a hypothesis.
- **Green there does not mean "a backup ran last night".** We would rather say
  so than let a colour imply it. It means a restore was completed and verified
  on a date we hold — nothing about the snapshot schedule, which we still cannot
  observe from here and still do not claim to.
- **It expires by itself.** A date somebody types in once and forgets is exactly
  the decorative green tile this page exists to avoid, so it goes amber on its
  own when the drill falls out of date, and stays amber until someone runs
  another one. Neglect makes that dot worse, never better. Grey now means no
  restore has ever been verified.
- **Backups still cannot fail a release.** The verdict at the top of the page —
  could a release ceremony complete right now? — is the conjunction of the
  release-critical checks, and a backup has never been one of them. An overdue
  drill is visible without pretending the service is down, and it does not move
  the published availability figure.
- **Internally, our dashboard now names which parts of the assistant are switched
  on and which model they use.** It could previously only say whether the model
  had been called today, which on a quiet day meant it said nothing at all — the
  same blank answer whether the assistant was fully wired up or had no
  credentials behind it. Nothing about what the assistant may do changed, and
  this is an operator-facing page; it is here because the same honesty rule
  applies to it.
- **Nothing about your account, your vault or your data changed.**

### Added
- **Your readiness panel now tells you when a contact is waiting on a security-code
  confirmation.** Before a trusted contact can hold a share of your release, you
  confirm their security code with them directly — by phone or in person, not
  through this app. Your browser then pins that exact key and refuses to hand a
  share to any other, which is what stops anyone substituting a key for theirs.
  Until you make that call, the option to give that contact a share simply is not
  there. That was correct and completely silent: you could enrol three people,
  believe you were covered, and see only "too few shares assigned" — never that
  the reason was three unconfirmed codes. Your readiness panel now names it, with
  the number waiting and a link straight to them.
  **We still cannot tell whether you actually made the call.** Nothing can — the
  button records what you say you confirmed. This makes *skipping* the step
  visible; it does not make the step itself verifiable, and we would rather say so
  than let a green tick imply otherwise.
  **Your readiness score will drop by 8 points** if you have a contact in this
  state — nothing about your setup changed, we are just no longer silent about
  something that was already true. Same as last week's change for an unreachable
  owner, and said out loud for the same reason.
- **The same contact could read "Verified" in one place and "not confirmed" in
  another.** Your dashboard used "Verified" to mean a contact had finished
  enrolling and published their key. The new checkup above it uses "confirmed" for
  the separate step where you compare their security code by phone. So the panel
  could show a green *Verified* badge for the very contact it was telling you to go
  and confirm.
  Finishing enrolment and confirming a security code are two different things, and
  only the second lets someone hold a share of your release. The dashboard now says
  **"Enrolled"**, and the wording that said a contact was ready "once their key is
  verified" has been corrected — enrolment is necessary and not sufficient.

### Changed
- **The assistant now has two capacity pools, so nobody's usage can switch off
  anybody else's.** The AI features are not a paid add-on and we have no plans to
  make them one — every capability is on every plan. But there is a daily ceiling
  on what the assistant may spend across the whole service, and until now it was
  one shared pool on a first-come basis. A handful of heavy accounts could exhaust
  it, and everyone else's assistant went quiet for the rest of the day, having used
  nothing themselves.
  Personal accounts now draw on guaranteed capacity: a Personal subscriber's daily
  allowance is theirs alone, three times the free allowance, and the shared ceiling
  cannot take it away. Free accounts keep a smaller allowance drawn from what the
  service has left. Nothing about what the assistant can *do* differs by plan.
  **None of this touches your safety machinery.** Check-ins, the release ladder and
  the anomaly detectors have never depended on a model call, and still do not — if
  the assistant is unavailable for any reason, every one of them runs exactly as
  before.

### Fixed
- **Your dashboard could say "Everything is healthy" while telling you, three
  inches lower, that a release could not complete.** The greeting line and the
  Engine tile were both reporting one thing — whether the engine is alive and
  counting down — and phrasing it as though it covered everything. So an account
  with no verified way to be contacted read "Everything is healthy" and "All
  healthy" at the top, above a readiness ring of 12 out of 100 and a blocker
  saying a release could not complete.
  Those are two different questions. The engine can be perfectly alive while your
  setup cannot actually hand anything over. The header now says what is true —
  *"Your engine is running, but 1 thing would stop a release completing"* — and
  the tile shows the count instead of the word healthy. When we cannot tell,
  because the readiness check is unavailable, it now says only that your engine is
  active and claims nothing further. **A missing answer is not a good answer**,
  which is the same rule our public status page already follows.
- **Suggestions you had already acted on stayed in your list, with a live Accept
  button.** The assistant raises a suggestion for each thing blocking your
  release. It never took one back. So you could add your first vault item, enrol
  a contact and verify a channel, and all three suggestions would still be
  sitting there telling you to do what you had just done — mixed in with the ones
  that genuinely still applied, which is worse than either alone, because it
  makes the whole list untrustworthy.
  A suggestion whose problem you have solved now leaves the list on your next
  visit. It is recorded as **resolved by you**, distinct from one that simply
  lapsed after 14 days — you fixed it, and our records should not say you ignored
  it.
- **The assistant could turn a blocker into a chore.** Our readiness explanations
  are written from a fixed set of checks; the assistant rephrases them into plain
  language. For the most serious kind — a **blocker**, meaning a release could not
  complete or could complete wrongly — it was rewriting away the part that matters.
  "A check-in request cannot reach you, and the engine reads that silence as
  inactivity" came back as "add a notification channel so we can contact you":
  the same instruction, with the consequence removed, sitting in a to-do list
  beside genuinely minor suggestions.
  The assistant is now required to keep the consequence of any check that states
  one — what happens if you do nothing — and may shorten only the checks that
  carry no consequence at all. It may never reduce a blocking problem to one line
  of a to-do list. If it ever fails to, the plain-language version we write
  ourselves always states it.
- **You could arm the engine with no way for us to reach you, and nothing said
  so.** Arming checks that you have a trusted contact. It never checked that you
  have a verified email, phone or push channel — so an account could be fully
  armed, showing as protected, while every check-in request we tried to send had
  nowhere to go.
  The failure was silent in the worst way. A check-in you never receive is a
  check-in you never answer, and the engine cannot tell the difference between
  "did not answer" and "could not be asked". It reads both as inactivity and
  starts the escalation ladder — toward releasing your vault to your trusted
  contacts, while you are perfectly fine and simply were never contacted.
  Your readiness panel now shows this as a **blocker** whenever the engine is
  running and you have no verified channel, with a direct link to add one. It
  does not fire before you arm, because until then there is no check-in to miss.
  Unverified channels and ones you have removed do not count — only a channel we
  could actually deliver to.
- **Your readiness score went DOWN when you added your first vault item.** An
  empty vault scored 80 out of 100 — the top of the green band — because the
  score is built by deducting from a perfect 100, and an account with nothing in
  it has only one thing wrong with it. Adding your first item then revealed
  everything else that was not set up yet, and the number fell to 60. Filling all
  three tiers took it to 12.
  Nothing was broken about the advice underneath: the specific gaps it listed
  were real, and the score climbed back correctly as you worked through them. But
  the first number you ever saw was the highest, and the first correct thing you
  ever did made it worse — which teaches you to ignore the number exactly when it
  is trying to help. An empty vault now reads 0, because a continuity plan with
  nothing in it cannot release anything at all. Every later step raises the score.
- **Our privacy policy never linked to our terms of service.** The two documents
  divide the work between them — one covers what happens to your data, the other
  covers your use of the service — and the privacy policy explained its own half
  without ever pointing at the other. Someone reading about how we handle your
  data had no way to get from there to the terms they are agreeing to except by
  going back to the footer. The opening paragraph now says which document covers
  what, and links to it.


## 2026-08-10 — A deletion you scheduled is visible again, and our release-key check now proves the key is the right one

### Fixed
- **Asking to delete a vault item left no trace of it anywhere.** Deleting an
  item does not delete it — we mark it, wait seven days, and only then remove
  it, so that someone who steals a session cannot destroy anything before you
  can stop them. You saw a banner saying so. Then, if you navigated away and
  came back, the banner was gone and the Delete button was simply there again,
  as though you had imagined it.
  The deletion was still scheduled. We were recording it correctly and never
  telling you about it again: the banner you saw came from the reply to your
  click and lived only until the page redrew. There was a way to cancel — on the
  Engine page, under pending actions — but nothing on the item pointed at it, and
  a destructive action you cannot see is one you cannot stop.
  The item now says a deletion is scheduled, when it takes effect, that it stays
  readable until then, and links you to where you can cancel it. Your vault list
  shows the date on the row too. Nothing was ever deleted early, and nothing was
  deleted that you had cancelled.
- **The same was true of a file you asked us to remove.** Removing an attachment
  is the same seven-day action, and the row went on looking exactly like every
  other file, still offering a "Remove" button for something already on its way
  out. It now shows the date and stops offering to do it twice.
- **"Request tier change" did nothing at all on an S2 item.** The tiers control
  how your vault is released — S1 through S3 differ in how many people it takes
  to open them — so moving an item between them is a real decision. On an item
  already in S2, the menu displayed "S1" while the app had in fact remembered
  "S2", so pressing the button asked us to move the item to the tier it was
  already in. We refused, correctly, and you saw nothing happen.
  The menu and the button now always agree, on every tier. Where the menu starts
  is now worked out from the item rather than fixed in advance, and it starts on
  the more protected neighbouring tier, so a change you did not choose can never
  reduce an item's protection.
- **When we refused something, we too often just said "please try again".** For
  a refusal that will happen identically every time, that is not advice. We had
  already worked out the reason and thrown it away before it reached you. Every
  action on the item page now tells you what we actually said — and the message
  appears next to the button you pressed, rather than at the bottom of the page
  below your attachments, which on an item with files meant it could arrive off
  the edge of your screen.
- **Our status page published 100.1% availability.** Which is not a number that
  can exist. The figure counts one health sample per minute against the number
  of minutes we should have been watching, and we were counting the minutes with
  an off-by-one: for a period of one thousand five hundred and eight and a half
  minutes, we compared samples from 1,509 of them against a total of 1,508.
  It was the first percentage that page had ever published — it starts
  publishing only after a full day of evidence, which had passed about an hour
  earlier. Nothing about the service was wrong, and the figure was wrong in the
  flattering direction, on a page whose entire argument is that its numbers are
  conservative. We fixed the arithmetic rather than capping the result at 100%,
  because a cap would have made it look right while leaving it wrong. The same
  page also said "of the last 1 days".
- **The same page checked that our release key worked, not that it was the right
  key.** There is exactly one cryptographic power we hold: at the end of a
  release, and only when the engine and your contacts both say so, we open the
  outer lock on a tier. The status page reports whether we can still do that,
  and it is marked release-critical — if it is red, nothing can be handed over.
  It was testing this by locking something and immediately unlocking it again,
  which passes with *any* valid-looking key, including the wrong one.
  So if that key were ever replaced with a wrong-but-well-formed value — a
  mistyped transcription, a half-applied rotation, an environment set up from
  the wrong copy — the page would have gone on saying everything was fine while
  every vault we hold was permanently unopenable. The first sign of it would
  have been a real release failing at its last step, in front of a family, which
  is the worst possible place to find out.
  It now opens a key we have actually stored: that cannot pass with the wrong
  key, because it either opens real data or it does not. On a deployment holding
  no keys yet there is nothing to open, and the page says so rather than implying
  it checked. Nothing was wrong with the live key — we found this while
  rehearsing a restore from backup, not because anything failed.

## 2026-08-09 — You confirm your contacts' keys yourself now, and we corrected what our status page measures

### Fixed
- **Every row in your vault list said "Title unavailable".** Titles are
  encrypted, and your browser has to know which of our formats a title was
  written in before it can read one. We added that format marker to each item
  earlier the same day — and then left it out of the answer we send when your
  browser asks for the list. Your browser refused to read any title, which is
  exactly what it is built to do when it cannot tell what it is looking at, and
  every row fell back to the "title unavailable" wording added below.
  Nothing was lost or damaged. The titles were intact throughout, opening an
  item showed its title and contents normally, and a release to your contacts
  was never affected — those two paths sent the marker as intended. The list was
  the only place it was missing, and the only thing wrong was the label you saw.
- **Moving an item to a different tier made it look like your whole vault had
  vanished.** Each item's title is encrypted with a key belonging to its tier.
  When you moved an item between tiers we re-encrypted the item's contents for
  the new tier but not its title, so afterwards we were trying to read the title
  with the wrong key. That failed — and because the failure happened while the
  list was being drawn, it took the *entire* list down with it, not just the one
  item. Opening the moved item failed for the same reason, even though its
  contents were re-encrypted correctly and were never damaged.
  Nothing was ever lost: the title was still there, still readable with the key
  it was written under. We were simply reaching for the wrong one. Titles now
  move with the item, and a move that somehow arrives without one is refused
  rather than half-applied.
  We also stopped one broken title from being able to do that again. If any
  single item's title cannot be read in future, that row now says "title
  unavailable" and still opens; the rest of your vault is unaffected. We found
  this while auditing a different change, not because anyone hit it.
- **Cancelling a release could leave a release running anyway.** When you tell
  Truecairn you are here and stop a release, we cancel it and put your account
  back to normal. Separately, a background process is periodically opening the
  ceremonies your contacts take part in. If your cancellation landed in the
  couple of seconds while that process was mid-way through its work, it did not
  stop it — it cleared the way for it. Your account correctly went back to
  normal, and a new ceremony opened behind it that your contacts could still
  respond to. **Nothing could have been handed over:** the actual release of your
  vault is checked against your account status, which said "active", so the door
  stayed shut and stayed shut. What was wrong was that a cancellation you
  performed did not visibly take, and your contacts could be asked to act on a
  release you had already stopped. The background process now takes a lock on
  your account status before opening anything, and stands down if you have
  cancelled — a cancellation always wins. We found this in our own testing; it
  was never reached by anyone's account.
- **A cancelled deletion said "pending deletion" forever.** Deleting a vault
  item or an attachment is a delayed action: we mark the thing, wait out a
  cooldown, and only then remove it — so that a stolen session cannot destroy
  anything before you can stop it. Cancelling during that window did stop the
  deletion, correctly and completely, but did not remove the mark. The
  attachment went on reading "pending deletion" indefinitely, with nothing
  actually pending behind it and no way to clear it. Nothing was ever at risk of
  being deleted; the label just outlived the thing it described. Cancelling now
  clears the mark in the same step.
- **A mistyped or broken link now shows a real "page not found" page.** Before,
  any address we did not recognise silently redirected — to the signup page in
  one part of the site and to the homepage in another — which rewrote the address
  bar and destroyed the link that had failed before you could read it or send it
  to us. It was worst for someone acting as a trusted contact: a ceremony link
  broken in transit by a mail client dropped them on a signup form, with no sign
  anything had gone wrong and a strong suggestion that creating an account was
  the way to fix it. It is not. The new page shows the address that failed, says
  plainly that nothing is wrong with your account, and tells a trusted contact to
  go back to whoever sent the link rather than sign up.
- **Our build-verification page told you to check something that does not
  exist.** That page exists so you can confirm the app we send your browser is
  built from the code we publish — the one page on the site written to be checked
  by someone who does not trust us. It instructed you to find the release
  matching the build and open its signed attestation. We have never published a
  release, so there was nothing there to find. Anyone who actually followed those
  steps would have hit a dead end, on the page least able to afford one. The
  instructions now describe what you can genuinely do today — rebuild the
  published source yourself and compare the fingerprint — and the page says
  plainly that signed per-release attestation is something we have built and not
  yet shipped. It also now warns you that if the published source and this
  deployment are at different versions, the fingerprints will differ for that
  reason alone, so you are not left reading an ordinary version gap as evidence
  of tampering.

### Changed
- **Yesterday we fixed the broken check. Today we fixed the number it left
  behind.** The availability figure on our status page is computed from health
  samples taken every minute, and for nine days those samples recorded a fault in
  our own measurement as though it were an outage. Fixing the check stopped new
  bad samples; it could not un-write the old ones. The page has been reading
  0.1%, which is not what happened.
  The published figure now starts from the moment the measurement was corrected —
  **8 August 2026, 21:30 UTC**. For the first day after that there is no
  percentage at all, because a day is our threshold for publishing one; then it
  begins again from a clean base. You will see the page say "measuring since"
  a much more recent date, and that date is now honest about what the number
  beside it covers.
- **We did not delete the nine days.** That was the obvious fix and we decided
  against it. Our own rule for this page is that a minute with no sample counts
  against us rather than being skipped — written so that our monitoring cannot
  improve the published number by going quiet. Deleting samples because we have
  judged them wrong is that same move, made deliberately, and once it is
  available to us it is available the next time the number is inconvenient for a
  reason we like less. The records are still there, still visible to us, and
  still checkable by anyone who ever wants to audit this claim. We simply stopped
  publishing a conclusion drawn from them.
- **Our sitemap now tells search engines when each public page last changed.**
  When we added the sitemap we deliberately left those dates out, and said so
  here: we had no per-page timestamp that was not a guess, and an absent number
  beats an invented one. The reasoning was right and the conclusion was wrong —
  the date each page's text last changed had been recorded all along, in the
  history of the file that text lives in. Every public page now carries that
  date, and a check refuses to let it drift out of step with the page it
  describes, so a page edited without updating its date fails our build rather
  than quietly advertising a date that is no longer true.
  It is **not** the date we last deployed. Stamping all seventeen pages as
  freshly changed on every release would be exactly the invented number the
  original decision was avoiding, so the dates are fixed in our source and the
  deploy never touches them.
- **Two links you would have expected on the homepage were missing.** The
  security section said the rest was in our threat model without linking to it,
  and the sentence about what we store did not point at the privacy policy.
  Both are links now. Nothing about either page changed.

### Security
- **You now confirm a contact's security code before you can entrust them with
  anything — because until today, you were trusting us to tell you which key was
  theirs.** When you give a contact a share of your vault, your browser locks
  that share to their personal key so that only they can ever open it. Your
  browser learned which key was theirs from us. We never abused that, but we
  should never have been in a position to: someone with access to our database
  could have swapped in a key they controlled, and your browser — the real one,
  the published one, doing exactly what its code says — would have sealed your
  share to it. Nothing you could check would have looked wrong. In particular,
  our build-verification page would still have said the app was genuine, because
  it was; no code had to change for this to work.
  You will now see a **security code** for each contact: six groups of five
  digits. Your contact sees the same code on their own screen, worked out from
  their own key rather than from anything we sent them. **Call them, or ask them
  in person, and check the two codes match.** Not by email or chat — if someone
  could change what one screen shows you, they could change the other. Once you
  confirm, your browser remembers that exact key and will refuse to hand a share
  to anything else. If a contact's key ever changes without a rotation notice
  from them, you get a warning instead of a silent swap, and Truecairn stops.
  Being plain about what this does and does not fix. **It only works if you
  actually make the call.** We cannot tell whether you did, and clicking "the
  codes match" without checking leaves you where you were. Your S3 vault was
  never exposed to this — the release passphrase you keep offline is a piece we
  structurally cannot hold — but S1 and S2 were, and for those two the check is
  now the thing standing in the way. We found this in an audit of our own
  cryptography, we have no evidence it was ever used, and we would rather tell
  you it was possible than let you find out it had been.
- **We removed the Android app identity our domain was vouching for.** For six
  days `truecairn.app` published a statement telling Android that a particular
  app signing key could be trusted to receive passkeys for your account. That key
  was a development key, whose password is a publicly known word — fine as a
  short-term step while a real one was being set up, except that the real one
  turned out not to exist yet. An open-ended arrangement where a widely-copyable
  file could be used to build an app our own domain endorses is not one we are
  willing to leave running, so the statement now authorises nobody.
  This changes nothing for anyone using Truecairn today: the mobile app is not
  distributed, and the web app is unaffected. It costs us passkey sign-in on our
  own internal test builds until a proper signing key exists, which is the right
  way round.
- **We upgraded the part of the app that handles web addresses, which had
  published security advisories against it.** Three of them, including one where
  a crafted link could be made to run code inside the page. In most products that
  is a defacement risk. Here it is not: the code running in your browser is the
  code holding your keys while your vault is unlocked, so anything that can run
  script in this app can read what that code is holding. That makes this class of
  flaw one of the most serious that can affect us, and the reason our security
  page treats the browser as the thing worth defending. We have no evidence any
  of the three were reachable in Truecairn as it is built — the patterns they
  target are not ones we use — and we upgraded rather than spend the effort
  arguing ourselves into feeling safe. Nothing about how the app behaves has
  changed.

## 2026-08-08 — The uptime figure we published about ourselves was wrong

### Security
- **Yesterday's fix for the overlapping-upload flaw had a hole in it, and we
  found it by auditing our own fix.** The repair works by having one upload claim
  the file before writing, so a second one is turned away. But the final step —
  the moment an upload is marked as finished — only checked that *an* upload was
  in progress, not that it was *this* one. There is a narrow case where a stalled
  upload can have its claim handed to a fresh attempt, and in that case the
  stalled one could still mark the file finished, publishing its own half-written
  bytes over the new attempt's. Same damage as the original flaw, through a
  smaller door. Each upload now carries an identity, and every step that touches
  the file checks it, so an upload can only ever finish, or undo, its own work.
- **And we closed the door itself.** That case was only reachable because nothing
  put a limit on how long a single request may take to arrive. There was a size
  limit — no file over 100 MB — but a size limit is not a time limit, and a
  connection trickling bytes could stay open indefinitely. Requests now have to
  arrive within 15 minutes, and the point at which a stalled upload's claim can be
  reassigned is set to twice that, so a live upload can never lose its place.
- **What this means for you if you upload large files on a slow connection.** An
  upload that cannot finish within 15 minutes will now be stopped and can be
  retried, where before it would have hung. 100 MB inside 15 minutes needs roughly
  1 Mbps sustained. We would rather tell you an upload failed than leave you
  looking at a progress bar that will never finish.
- As with yesterday's: there is no evidence any of this happened to anyone, and
  because your attachments are encrypted on your device we could not have seen it
  if it had. That is exactly why we keep auditing this path.
- **Somebody could have taken your paid plan away by buying one themselves.**
  When you upgrade, we hand your browser a checkout page at our payment provider
  and quietly attach your account number to it. That number sat in the address
  bar, and it could be edited. Someone who knew another customer's internal
  account number could put it there, pay for a plan in that person's name, and
  our system would attach the new subscription to that account and drop the one
  already there. Cancel it afterwards and a paying customer would find themselves
  back on the free plan, having done nothing and been told nothing.
  We now treat the subscription number our payment provider issues as the truth,
  and the account number in the address bar as a claim to be checked: a
  subscription stays attached to the account it was first attached to, and a new
  subscription cannot displace a live one unless it comes from the same paying
  customer. Upgrading a plan, or cancelling and resubscribing, still works exactly
  as before — that is the same person, and we can tell.
  **No account was affected.** Nothing in Truecairn shows you another customer's
  internal account number, so this needed information nobody has. We found it in
  our own audit and it is closed.
- **Related, and duller, but it is why the above stayed possible:** a payment
  notification naming an account that does not exist used to make our system
  fail rather than shrug. Our payment provider retries anything that fails, so a
  single bad notification could retry forever. Those now stop cleanly and get
  recorded for us to look at.

### Fixed
- **Our public status page was reporting near-zero availability, and the fault was
  in the measurement, not the service.** The page publishes a figure computed from
  health samples taken every minute — and one of the things those samples check is
  whether any notification has ever failed to deliver after all its retries. "Ever"
  was the bug. That count had no time limit, so a single failed delivery from any
  point in the past kept the check permanently unhealthy, kept every sample marked
  as a bad minute, and dragged the published percentage toward zero and held it
  there. Nothing was actually down. Worse, a number already pinned at the floor
  cannot fall any further: a *real* outage would not have moved it, which means the
  figure had stopped being able to tell you anything at all.
- **The check now asks whether a delivery has failed in the last 24 hours**, which
  is the question that was always intended — is delivery working *now*. A genuine
  delivery problem still shows up, and still shows up for hours afterwards. Older
  failures are not erased or hidden: the page and our own dashboard still say how
  many there have been, they just no longer count as an outage happening right now.
- We are calling this out rather than quietly correcting it because the whole point
  of publishing an availability figure is that it is measured rather than claimed.
  A number produced by a broken instrument is not a measurement, and if we would
  not accept that from someone else we should not ask you to accept it from us.

## 2026-08-07 — Nobody can lock you out of proving you are alive

### Security
- **Someone who knew your email address could stop you checking in.** Five wrong
  password guesses lock an account for an hour — a normal defence, and one we
  keep. But while locked, *every* part of Truecairn refused you, including the
  check-in that tells us you are still here. Your inactivity countdown kept
  running the whole time. Repeat the guesses each hour and the lockout holds,
  which meant a stranger with nothing but your address could push your account
  toward releasing your vault to your contacts. Simulating your death, from
  outside, with no access to anything of yours.
  We found this in a security audit of our own code. **No account was affected**
  — we have no evidence of anyone using it, and it is closed now.
- **What changed.** A locked account can still check in and still see its own
  status. Everything else — your vault, your contacts, your settings — stays
  locked, which is the part that was always right. Signing in with a passkey now
  clears the lock outright: a passkey proves it is you, which is exactly what the
  lock was waiting to establish. And if the hour has already passed, the lock now
  lifts the moment you do anything, instead of waiting for one specific screen.
  If you sign in only with a passkey, that screen was one you never visited — so
  the hour could have lasted indefinitely.
- **And a second layer, in case we ever get the first one wrong.** While your
  account is locked, the countdown toward release now pauses instead of
  advancing. Silence only means something if you had the option to break it. That
  pause is deliberately *not* permanent — it lasts up to 30 days and then the
  ladder resumes, because a pause nobody could ever end would be its own failure:
  it would let anyone block your release forever by keeping your account locked.
- **A locked account now says so.** You used to get a blank refusal. It now tells
  you the account is locked and when it lifts.

### Fixed
- **Uploading the same attachment twice at the same moment could damage it.** If
  two uploads of one file overlapped — a double-tap, a flaky connection that
  retried while the first was still going — both were allowed to write, into the
  same place, at the same time. The result was one file made of two interleaved
  halves, and your storage allowance charged twice for it. The second upload is
  now refused outright.
  The part we want to be straight about: because your attachments are encrypted
  on your device, **we cannot see inside them, so we could not have detected
  this.** A damaged file would look completely normal to us and would only be
  discovered by whoever you left it to, when they tried to open it. That is the
  worst shape a bug can have in a product like this. We found it in an audit of
  our own code, there is no evidence it happened to anyone, and it is closed.
- **The check that an upload arrived intact was not running on one of our storage
  backends.** We compare the bytes we received against the size your device
  declared, and roll the upload back if they disagree. On S3-compatible storage
  that comparison was accidentally checking a number against itself, so it agreed
  every time — including when it shouldn't have. It now counts the bytes that
  actually arrive.
- **The same overlapping-upload flaw existed for items sent from the phone**, and
  is fixed in the same way.
- **One trusted contact could have blocked your release forever.** When a contact
  says "the owner is alive", we stop the release and ask you to confirm — that is
  exactly right, and it has not changed. What was wrong is that they could do it
  over and over. Each time you resolved the review, the same contact could push it
  straight back, and resolving costs you a passkey confirmation while their side
  cost nothing. A contact whose release attempt had ended months earlier could
  still do it, because their record of that ceremony never goes away.
  Now each contact can stop a given release once, and a release that has already
  finished cannot be reopened. **Nothing was taken away from them:** a contact who
  believes you are alive can still stop *every* new release attempt, and still
  does not need to have voted first — the person most likely to know you are fine
  is the one who has not voted yet.

- **Four fields in Settings had no name a screen reader could announce.** They
  showed a hint inside the box, which vanishes the moment you type and is not a
  label. One of them was the 6-digit code field used to confirm a notification
  channel, so the gap sat on a security step. All four now announce properly.
  For a product people set up while thinking about their own death, this is not a
  peripheral concern: the people most likely to need a screen reader are well
  represented among the people most likely to need Truecairn.

### Changed
- **A blocker no longer shows as a healthy score.** Yesterday's change moved an
  account whose highest tier can never be reconstructed from 100 out of 100 down
  to 80 — and 80 was still drawn in green, which is the same false reassurance
  twenty points lower. A completely empty vault read the same way. If anything
  blocks a release, the ring is no longer green and the words "A release could not
  complete today" sit beside the number. Whether a release can complete is not a
  percentage, and we stopped presenting it as one.

### Removed
- **The "AI readiness briefing" card is gone.** Your dashboard was carrying two
  AI-written paragraphs about the same thing. The one we kept is tied to the
  readiness score and its specific gaps, and falls back to text we wrote when the
  model is unavailable; the briefing was loose prose with nothing behind it and no
  fallback. Keeping the weaker one because it was there first is not a reason. One
  less place your account information is sent to a model.


## 2026-08-06 — Your readiness score now knows whether a release could actually complete, and your contacts get the evidence in plain language

### Changed
- **The readiness score on your dashboard is computed properly now.** It used to
  be a rough estimate your browser worked out from counts: do you have items, do
  you have contacts, is the engine running. It is now computed where the full
  picture lives, and it checks what actually has to be true for a release to
  succeed — how many contacts hold a share for each tier, whether those contacts
  span two different roles, whether your S1 tier has a named beneficiary, whether
  your S2 release-passphrase slot is set, and whether anything has gone stale.
- **The case this was really about: an account could show 100 out of 100 and
  still be unable to release anything.** A release needs its consensus to span
  two different contact roles. If every contact holding a share for a tier is,
  say, a personal contact, that tier can never be reconstructed — not by us, not
  by them, not ever. The old score counted contacts and could not see it, so it
  told those owners they were fully protected. It now shows as a blocker, in
  plain words, with the fix linked.
- **Your checkups are the real gaps now, and they carry the numbers.** Instead of
  a generic nudge you get "1 of 2 required contact shares assigned", and blockers
  — the things that would stop a release completing — sort above warnings.
- **If the score cannot be computed, you keep the old estimate rather than a
  zero.** A dashboard that flashes "0/100" because a background service is
  briefly unavailable would be alarming and wrong.

### Added
- **AI suggestions are switched on.** When your setup has a gap, it can appear as
  a suggestion on your dashboard for you to approve or dismiss. Approving records
  your decision — it does not change anything on your account by itself. You make
  the change, the same way you would have anyway.
- **A safety check now watches releases in progress.** If something looks wrong
  while a release is under way — trusted contacts all affirming within a few
  minutes of each other, or a burst of failed sign-in attempts — it pauses the
  release and asks for review. It can only ever pause. It cannot release
  anything, approve anything, or move a release forward.
- **Nothing acts on your behalf unless you switch that on yourself.** The setting
  is in Settings, it is off, and it stays off until you turn it on and set a
  limit it may not go past.
- **Your trusted contacts get the Continuity Report explained to them.** If a
  release ever begins, the people you named see a report: what we tried, on which
  kinds of channel, what provably arrived, and how long you have been silent. It
  is precise and it is not easy reading for someone who is worried about you. It
  now also carries a short plain-language explanation of that same evidence.
- **It explains; it does not decide, and it does not guess.** The outcome stays
  the value our rules computed — the explanation cannot change it. It is written
  under instructions never to speculate about why you are silent, never to say or
  imply that you have died, and never to tell your contact whether to agree to a
  release or refuse. That decision stays theirs.
- **It is written from the report and nothing else.** The evidence it describes is
  the same frozen record your contact is already looking at: counts, kinds of
  channel, dates. It has no access to your vault, your messages, the addresses or
  numbers we tried, or anyone's name.
- **If it cannot be written, your contact sees the report as before.** The
  explanation is an addition to a record that already stood on its own.
- **Turning off AI for your account turns this off too.** It is your account's
  evidence, so your choice governs it.

### Note
- **The score and the gaps are not written by an AI.** They are computed by
  ordinary, testable code — the same inputs always give the same answer. The
  model's only job is to write the sentence that explains them, and when it is
  unavailable you get a sentence we wrote in advance instead. Where a sentence
  came from the model, it is marked.
- **What it can see is unchanged:** counts, settings, and dates. Never your
  vault contents, your item titles, your contacts' names, or any of your keys —
  those are encrypted on your device and we do not hold them.


## 2026-08-01 — An account we cannot reach now pauses instead of advancing, and the site stops claiming things that were not true

### Fixed
- **If we cannot reach you on any channel, the countdown stops.** That was
  already true when every channel you had was failing — but not when you had
  none at all, which is the most unreachable an account can be. A no-channel
  account was the one configuration that kept counting down toward a release
  with nothing sent and nobody told. It now pauses like any other total
  delivery failure. The pause is still bounded: after 30 days the ladder
  resumes, because silence that lasts that long is itself evidence.

### Changed
- **We removed claims from our own site that were not true.** In plain terms,
  and because you should be able to see what we corrected rather than notice it
  quietly disappear:
  - A **third plan** ("Pro", custom pricing, with team seats, SAML SSO, notary
    integration and 50 GB) was advertised and had a "Talk to us" button. It does
    not exist. There are two plans: Free and Personal.
  - **WhatsApp** was listed as a paid feature. It was not delivering, so we
    stopped selling it. It is now withdrawn outright — see the note below.
  - A **"rehearsal"** — simulating a release without notifying anyone — was
    described on the homepage, in the guide, and in a welcome email. There is no
    such feature. We removed the claim rather than leave you looking for it.
  - Contacts were said to be able to **"delay"** a release by 7 days. They
    cannot: the choices are affirm or dispute, and dispute is what an unsure
    contact should use. It halts the release for review.
  - A **SOC 2 Type II audit "in progress"** was on the homepage while two other
    pages correctly said we hold no certifications. We hold none.
  - **Usage statistics** ("41% of accounts") were on the use-case cards for a
    product that has not launched. Removed.
  - **Open-source clients** were described as published, including a macOS
    client. The repository is not public yet and there is no macOS client.
  - The wind-down answer said keys are escrowed **"with our auditor"**. We have
    no auditor. The commitment itself is real and stated properly in the
    wind-down playbook.
  - The homepage called one thing a **"release-only passphrase"** and used it to
    mean both your master passphrase and your release passphrase. They are
    different secrets that fail in different ways, and the page now says which
    is which — losing the master one costs you everything, losing the release
    one costs you the highest tier.
  - **Check-in frequency** was given as "monthly" in one place and "30 days" in
    another. The default is 7 days, and you set it.
- **Our threat-model page no longer says we require two channels before arming.**
  We do not enforce that today. We ask for more than one and we recommend it,
  and if we cannot reach you the ladder now pauses — but the page was describing
  a gate that was not there.
- **The same two corrections, on the two places we missed the first time.** We
  fixed the pages that were pointed out to us and did not go looking for the same
  sentence elsewhere. It was elsewhere:
  - The **upgrade page still sold the "Pro" plan** we had just removed from the
    homepage — Custom pricing, a "Talk to us" button, SAML SSO and notary
    integration. This was the worse of the two places to leave it: you only see
    that page once you have signed in and are deciding whether to pay. There are
    two plans, Free and Personal, and now that page says so.
  - The **welcome email still called your master passphrase a "release-only
    passphrase"** — the same invented term, in the first thing you read after
    signing up. It now says master passphrase. Your release passphrase is a
    different secret and the email's warning about it (we will never ask you for
    it) was always about the right one.
  - The welcome email also said a trusted contact needs **"no account"**. They
    need no account *to start* — accepting your invite is enough — but enrolling
    does create keys on their device. The guide had this right; the email now
    matches it.

### Removed
- **WhatsApp is withdrawn. You cannot add it, and we have stopped describing it
  as something you can have.** WhatsApp requires every business message to use
  wording it approved in advance. Eight of our nine message types are approved.
  The ninth is the one that sends you the code proving a channel reaches you —
  and WhatsApp will not let us create it. Without that one, a WhatsApp channel
  can never finish being set up, which makes the other eight approvals worth
  nothing: they all assume a channel that exists.
  - **Nothing you have stops working.** No one ever had a working WhatsApp
    channel — it never delivered a message to anyone — so there is nothing to
    lose. If you somehow hold a verified one, it keeps working and keeps its
    history; we do not take channels away.
  - **We have removed it from the plan pages, the settings picker and our own
    changelog entries** that described it as available. It was sold as part of
    Truecairn Personal. It should not have been, and earlier entries here that
    said so are corrected rather than quietly deleted — you should be able to
    see what we got wrong.
  - **It is paused, not abandoned.** The work is finished and waiting: when
    WhatsApp approves that last message type, the channel comes back. We are not
    going to announce it again until it can actually reach someone.


## 2026-07-31 — Your phone can add to your vault, and WhatsApp’s rules reshape what our notices say

### Added
- **The Truecairn app can put something in your vault.** Write a note, photograph
  a document, or attach a file, and it is encrypted on the phone before it leaves.
  Three tabs now — Home, Vault, Settings — instead of a settings icon in the
  corner.
- **The phone cannot read what it sent, including a moment after sending it.**
  That is not a rule we chose to follow; it is how the encryption works. Your
  phone is given a public key, which lets it lock something to your vault and
  gives it no way to unlock anything — not your vault, not the item it just
  locked. Nothing in the app can decrypt, and nothing in it ever holds your
  passphrase.
- **The phone keeps no copy.** Not the title, not the text, not the photo. After
  a send it remembers four things: when, which tier, whether it was a note or a
  file, and how many files. The list on the Vault tab shows times and tiers
  because that is genuinely all it has. Signing out clears even that.
- **New items wait for you on the web, in a list called "Sent from your phone".**
  Open it with your passphrase and file each one, which is what turns it into a
  vault item like any other.

### Changed
- **The check-in reminder and the channel test are worded differently.** The
  reminder used to read "Open Truecairn to confirm you are active." It now reads
  "This is a Truecairn account status notification. Open the app to confirm you
  are active." What it tells you is unchanged: still no vault content, no names,
  no hint about your account beyond the fact that you have one. The opening
  sentence is there because WhatsApp would not accept the shorter version as an
  account notification.
- **Confirming a WhatsApp channel looks different.** The code used to arrive in
  our wording: "Your Truecairn channel verification code is 123456. Enter it in
  the app to confirm this channel." It now arrives in WhatsApp's own format for
  verification codes — "123456 is your verification code. For your security, do
  not share this code." — with a button that copies the code for you. **Email and
  text messages are unchanged** and still use our wording; this affects WhatsApp
  only.
- **The plan-ended notice no longer asks you to upgrade.** It used to close with
  "To add new premium channels again, open Truecairn and upgrade." That sentence
  is gone; the notice now says only that your plan ended and that every channel
  you already verified keeps working. Nothing else about it changed, and the
  upgrade option itself is unchanged — it lives in Settings, where the notice
  was already pointing you.

### Note
- **Filing matters, and the app says so in both places.** Until you file it, an
  item captured on your phone is sealed to a key only you hold — so if a release
  ran, your trusted contacts would not receive it. This follows from how release
  works: your contacts reconstruct the keys for a tier, never your master key,
  and a captured item is locked to a key derived from your master key. Filing is
  what moves it under a tier key and into your release plan. We would rather say
  this plainly than let a captured passport sit outside the thing you set
  Truecairn up for.
- **Sending an item is not a check-in.** Adding to your vault from your phone
  tells the engine nothing. Only your tap on "I'm here" does that — the same rule
  that has always applied to opening the app, unlocking it, or a notification
  arriving.
- **Nothing changed for anyone using the web.** This is off by default and the
  app is not yet in either store; the web app is unchanged apart from the new
  "Sent from your phone" list, which appears only when something is waiting.
- **Why a sentence had to change to keep a channel honest.** WhatsApp sorts the
  messages a business sends into categories, and it declined to file our check-in
  reminder as a service notification — too bare to read as one — offering us the
  marketing category instead. We turned that down. Marketing messages can be
  switched off by the person receiving them, and WhatsApp does not deliver them
  to US numbers at all. Either would leave a check-in reminder recorded as sent
  and never arriving, which is the one failure this product cannot have, on the
  one message whose job is to notice your silence. So we changed the wording
  instead of the category.
- **The same words go to every channel, with one exception we did not choose.**
  We could have reworded the check-in reminder for WhatsApp alone and kept the
  shorter version for email and text messages. We deliberately did not: a notice
  should not say different things depending on how it reaches you, and the added
  sentence reveals nothing that a message from "Truecairn" did not already
  reveal. The verification code is the exception, and not by our choice — that
  one WhatsApp writes itself.
- **We did not choose the words of the verification code, and cannot.** WhatsApp
  has a dedicated category for verification codes, and messages in it are written
  by WhatsApp: the text is fixed and a business cannot edit it. Accepting that
  meant losing our own sentence explaining where to type the code. We took the
  trade because WhatsApp declined to accept our version as an account message,
  and this is the one message that has to work before a WhatsApp channel exists
  at all — every other WhatsApp notice depends on it. This category is also the
  most reliably delivered one WhatsApp offers.
- **The code still grants nothing.** It only proves that this channel reaches
  you. It is not a password, it unlocks nothing in your vault, and we will never
  ask you for your release passphrase — not by email, not by message, not by
  phone.
- **Why the upgrade prompt went, and why we think that is the right outcome.**
  WhatsApp declined to treat the plan-ended notice as a service message while it
  ended by asking you to buy something — and on that one it was reading us
  correctly, unlike the check-in reminder above. We could have kept the sentence
  for email and text messages and dropped it only for WhatsApp. We did not,
  because we would rather every channel say the same thing, and because a notice
  whose job is to reassure you that nothing stopped working is a poor place to
  sell you something. It is a smaller message now, doing only the job it was
  written for.
- **Nothing for you to do.** No channel needs re-verifying, no reminder schedule
  changed, and channels you have already verified are unaffected.


## 2026-07-30 — A live status page, public pages machines can read, and WhatsApp that stops failing quietly

### Added
- **Public pages ship as real HTML.** Until now every page arrived as an empty
  container that only became readable once the browser had downloaded and run
  the application. Browsers cope with that. The crawlers behind AI assistants
  largely do not — they do not run JavaScript at all, so to them every page here
  was blank. Given that our public case is made almost entirely in prose — the
  threat model, the wind-down playbook, what the assistant may and may not do —
  being unreadable to the tools people now ask about products was a real loss.
  The seventeen public pages are now rendered at build time and served as
  finished HTML.
- A side benefit for everyone: those pages paint immediately rather than after
  the application loads, and they remain readable if the script fails or is
  blocked.
- **Every public page has its own title and description.** They all shared one —
  "TrueCairn" — so a link posted in a message or a chat rendered as a bare URL,
  browser tabs were indistinguishable, and in a search result each page competed
  with every other for the same words. Each page now carries a title, a
  description written from that page's own content, a canonical address, and a
  preview card. Nothing was generated to fill a slot: where a page could not
  support an honest description, the rule is to leave it out and let the search
  engine quote the page instead.
- **Signed-in pages now ask not to be indexed.** They were already excluded from
  the sitemap and disallowed for crawlers; this closes the remaining gap, since
  a disallow only stops a page being *fetched* and does not stop a URL learned
  elsewhere from being listed.
- **`robots.txt` and `sitemap.xml`.** The sitemap lists the seventeen public
  pages and nothing else; every authenticated route is excluded there and
  disallowed in `robots.txt`. Listing a path in a public file is not a security
  control and we do not treat it as one — the real gates are unchanged — but a
  crawler now spends its time on pages a reader can actually read, and those
  pages stop turning up as login redirects in search results. The sitemap
  carries no `lastmod` dates, because we have no per-page timestamp that would
  not be a guess, and the same rule applies here as on the status page: an
  absent number beats an invented one.
- **`/status` is now live, and its uptime figure is measured rather than
  asserted.** The page used to say, in as many words, that there was no live
  dashboard and that we would not show you invented figures until we had real
  ones. This is the promised page. Every component we watch now carries its
  current state, and the verdict at the top answers the only question that
  matters for a product like this — could a release ceremony complete right now?
  It is the conjunction of the release-critical checks and nothing else, so the
  website being reachable never counts as an answer on its own.
- **A measured availability figure.** We started recording health samples on a
  clock, and the percentage is computed from those. Two things make it worth
  reading rather than flattering. It scores the **full release path**, so a
  minute where nobody could have been notified is not a green minute even if the
  site was perfectly up. And a minute with **no sample at all** counts against
  it — the sampler runs inside the release worker, so the one outage that would
  erase its own evidence is the one that matters most, and it cannot improve our
  number by going quiet. Until there is enough evidence for a figure we say how
  long we have been measuring and publish no percentage, and the window shown
  never claims to cover longer than we have actually been watching.

### Changed
- **WhatsApp now goes straight to Meta instead of through our text-message
  provider.** Same messages, same wording — what changed is who carries them.
  Truecairn is built on the rule that no single way of reaching you is trusted
  to work, which is why it asks for more than one. That promise was quietly
  weaker than it looked: text messages and WhatsApp were travelling through the
  same company, so one outage at that company, one suspended account or one
  leaked key would have taken out both at once — at exactly the moment the
  second one was supposed to save you. They now share no supplier, no
  credentials and no infrastructure. A failure on one side leaves the other
  standing, which is the entire reason to have two.
- **The status page publishes deliberately less than our internal dashboard.**
  You see component states and one measured figure — not queue depths, version
  numbers, key identifiers or an incident feed. Those are operational detail you
  cannot act on, and together they would map out when we are least able to
  respond. The four states are unchanged, including the fourth: anything nothing
  actually observed shows as unknown, never as green, in the verdict and in the
  availability figure alike.

### Fixed
- **WhatsApp messages are sent the way WhatsApp actually requires.** We were
  sending plain text. That works while you are testing, and it works for 24
  hours after someone messages us — but every message we send is one we start,
  not a reply, and for those WhatsApp requires wording it has approved in
  advance. The failure was the quiet kind: our provider accepted each message
  and handed back a receipt, and WhatsApp discarded it without telling anyone.
  A check-in reminder could be recorded as sent and simply never reach the
  phone. WhatsApp notices now go out as approved messages.
- **A URL that does not exist used to return "success".** Every mistyped
  address, dead inbound link and automated probe got the app shell with an HTTP
  200 — so a human saw a page that looked wrong while every crawler, monitor and
  link-checker was told we had found exactly what they asked for. Unknown
  addresses now return a proper 404. You still get a usable page rather than a
  server error screen; what changed is that the machines are no longer being
  told a comforting untruth. Real pages, signed-in ones included, are unaffected.
- A missing file — a stale bundle after a deploy, say — used to hand back the
  app's HTML instead of an honest "not found", which surfaces in a browser as a
  confusing type error. It now 404s.

### Note
- **Nothing you set up needs redoing.** The change is behind the scenes.
  *(2026-08-01: WhatsApp was withdrawn before anyone could enrol one — see that
  day's entry. Nobody ever had a WhatsApp channel to keep.)*
- **We still record only whether a message was delivered.** WhatsApp reports
  more than that — including when a message is read — and we continue to
  discard it. We also do not treat "handed to WhatsApp" as "arrived": if we
  cannot prove a message reached the device, your Continuity Report says so
  rather than rounding up in our favour.
- **Text messages are unchanged**, and still go through the same provider as
  before.
- **A WhatsApp notice we cannot send correctly now fails loudly.** Each type of
  message needs its own approval, and they arrive one at a time. Rather than
  fall back to a plain message that would be accepted and then dropped, anything
  not yet approved is recorded as undelivered — which is the truth, and which
  your Continuity Report and our status page already treat as a channel that did
  not reach you. We would rather show you a channel that visibly failed than one
  that silently didn't work.
- **The wording did not change.** These are the same one-line notices as every
  other channel, sent to WhatsApp for approval exactly as written — nothing
  added, nothing shortened to fit. They still say only that something needs your
  attention and that the detail is in the app: no vault content, no names, no
  hint of what happened.
- **Text messages are unchanged**, and nothing about what we record changed: a
  WhatsApp "read" receipt still tells us nothing, because we still never ask for
  one.
- **Only public pages are prerendered — never a signed-in one.** Rendering an
  authenticated page ahead of time would mean writing someone's state into a
  file served to everybody, which is exactly the mistake this product cannot
  make. The list of prerendered pages is written out explicitly rather than
  derived, so nothing can be added to it by accident.
- This did **not** loosen the browser security policy that protects the app.
  Adding page descriptions is often done with tools that inject inline scripts,
  which would have required weakening exactly the setting that constrains what
  code can run on a page where your vault is decrypted. We checked what that
  policy actually blocks, found the structured data we wanted was never affected
  by it, and changed nothing.

## 2026-07-29 — A real press kit, an honest status page, and better mail

### Added
- **A press page that is actually a press kit** (`/company/press`). It was two
  paragraphs saying we had nothing yet. It now carries the approved boilerplate in
  both lengths with copy buttons, a fact sheet, the brand marks in all four
  variants as downloadable files, the product screenshots free to publish, and —
  the part we think matters most — a plain list of what we will and will not
  claim. That last section names the things a story about us could get wrong: we
  cannot recover an owner's data on request, we have published no third-party
  audit and hold no certifications, and we have no customers to parade, because
  publishing who trusts us with a continuity plan would itself be a disclosure.
- **The status page now says what we actually watch, and what we do not**
  (`/status`). There is still no live dashboard, and the page still says so
  first — we would rather tell you that than show a wall of green tiles and
  invented uptime figures. What is new is the substance: every component we
  monitor, marked release-critical or supporting, each one measured against the
  only question that matters for a product like this — could a release ceremony
  complete right now? Plus how the release worker is watched twice (an
  in-database record proving each tick completed, and an external service on
  infrastructure that is not ours), and the two things we genuinely cannot
  observe today, named rather than rounded up to green.

### Changed
- **Every email we send is redesigned.** Same words, better made: an ink header
  band carrying the mark and wordmark, a clear headline, and one obvious way back
  into the app. The welcome email now walks through the three things left to set
  up instead of listing them. Two promises are now visible on every message: the
  detail is always in the app behind your sign-in and never in the mail itself,
  and we will never ask for your release passphrase — so a message that does is
  not from us.
- Our mail still contains **no images of any kind** — the mark and wordmark are
  drawn with layout, not artwork. That is not a style choice: a remote image is
  how mail gets tracked, and with nothing to fetch there is nothing that could
  report back. It is checked by a test on every build, alongside the rule that
  the visual shell may only ever add presentation and never information.

### Removed
- The 2026-07-29 domain-move notice, which announced the address change and the
  passkey and push re-enrolment it forces. It described work that landed before
  anyone had an account to be affected by it, so it was telling nobody about an
  inconvenience nobody had. The move itself stands: `truecairn.app` is the home,
  and `security@`, `hello@` and `privacy@truecairn.app` are the addresses.

## 2026-07-25 — Check the code we send you, and read your own audit trail

### Added
- **The source is public, so the build fingerprint is now actually checkable.**
  `/security/build` already showed the fingerprint of the app you are running;
  until now there was nothing to compare it against. The client source is
  published, the footer links straight to it, and the page's instructions moved
  from "record this and watch for changes" to "rebuild it yourself and compare".
  That page also now shows the commit it was built from — it was reporting
  "unknown" in production, which made the fingerprint unverifiable in exactly the
  place it mattered most.
- **An operations dashboard that answers the only question that matters:
  could a release actually complete right now?** Internal, and off unless
  explicitly enabled. It checks the things a release genuinely depends on — the
  database, the engine driving it, initialised cryptography, the outer-layer key
  (verified with a real encrypt/decrypt round-trip, not merely "the setting is
  present"), audit signing, and whether anyone could be reached at all — and
  reports one combined verdict. Anything it cannot actually observe, such as
  platform backups, is shown as unknown rather than green, because a dashboard
  that guesses in your favour is worse than no dashboard.

### Changed
- **If we lose every way of reaching you, monitoring no longer pauses forever.**
  When all of your notification channels start failing, Truecairn deliberately
  stops advancing rather than treating a delivery outage as your silence. That
  pause used to last indefinitely — which sounds like the cautious choice, and
  wasn't: channels tend to fail *because* someone has died (a mailbox starts
  bouncing, a number gets recycled), so the one situation this product exists
  for was the situation in which it would have quietly done nothing forever.
  The pause now lasts 30 days and then resumes at the escalation step. This is
  not a shortcut to release: the moment any channel works again a single tap
  stops everything, the full escalation delay still has to pass, and your
  trusted contacts still have to reach agreement — and can still object — before
  anything is ever handed over.

- **A new Build provenance page (`/security/build`) shows the exact fingerprint of
  the app you are running.** Truecairn encrypts everything in your browser, which
  means the code doing that encryption is code we serve you — the honest weak
  point of every browser-based end-to-end encrypted product. Each release now
  publishes a SHA-256 for every file it ships plus one combined digest, built by a
  public workflow that builds twice and refuses to release if the two builds
  differ. The page states plainly what this does and does not prove: it makes
  tampering leave evidence, but it cannot prove itself honest, because the code
  showing you the digest is served by the same place as the code it describes. We
  would rather you understand that limit than trust a green checkmark.
- **You can now read, download and check your own audit trail, in Settings.**
  Every significant action on your account is recorded in a tamper-evident,
  hash-linked chain — until now nothing could show it to you, so it protected you
  only in principle. "Verify on this device" recomputes the whole chain **in your
  browser**: it does not ask our server whether our server has been honest. It
  catches an altered record, a removed one, or a broken link. It cannot prove we
  were honest from the very start, and it says so rather than implying otherwise.
  Truecairn also re-checks these chains continuously in the background.
- **Deleting your account keeps your audit log, and the privacy policy now says
  so plainly.** Your content goes; the record of actions taken on the account
  stays. That is deliberate: the log exists to catch someone acting as you, so if
  deleting the account erased it, anyone who compromised your session could cover
  their tracks by deleting you.

### Fixed
- **A stalled background engine can no longer fail silently.** The engine that
  watches for your silence is the piece that drives every release and
  escalation. If it stopped, everything else kept looking healthy. It now records
  a heartbeat that monitoring can see, so a stuck engine raises an alarm instead
  of quietly doing nothing.

## 2026-07-24 — Signing in during a release no longer traps you

### Fixed
- **If you sign in while a release is running, you can now confirm you're back
  and stop it.** Opening your vault during a release is meant to pause it and
  ask you to confirm it's really you. The pause worked — but the confirmation
  had no button and no route behind it, so the only way out was to wait, and
  after seven days the pause expired and the release **resumed from where it
  left off**. Checking in was refused in this state, and so was cancelling the
  release. In other words, the one thing most likely to prove you were alive —
  showing up and opening your own vault — was what removed your ability to say
  so. Now the Engine page shows a "we thought you were gone — please confirm
  you're back" banner with a one-tap passkey confirmation that cancels the
  release outright and re-arms monitoring on a fresh clock, and it tells you
  exactly when the pause expires if you do nothing. Trying to check in from this
  state now points you at the confirmation instead of refusing with no next step.

## 2026-07-23 — Clearer reasons when editing is paused, and every recipient can retrieve

### Fixed
- **Adding or changing a vault item while a release or review is in progress now
  explains itself.** Vault content is deliberately locked whenever your
  continuity engine is mid-release or paused for review — you can't rewrite what
  is being released. Previously the only sign was a generic "we could not save
  this item — please try again", which read like a plan or storage limit. Now
  the vault and item pages show a clear banner when editing is paused, and a
  blocked save or attachment says plainly that a release/review is in progress
  and links you to the Engine page to check in or resolve it — which unlocks
  editing. (This was never a paid-plan limit: item and storage caps have always
  reported their own distinct upgrade message.)
- **A second trusted contact can now complete their own retrieval after the
  first one already did.** When a release opens, each recipient reconstructs
  their own copy independently on their own device. Previously, once the first
  recipient finished — which flips the whole release to "retrieved" — a second
  recipient who hadn't finished setting up lost the controls to receive and
  reconstruct, with no way forward. Now a recipient who hasn't retrieved yet
  keeps every step available (register this device, contribute a share,
  reconstruct) for as long as the release stays open, so the first person's
  success never locks anyone else out.
- **Two people sharing one browser no longer clobber each other's ceremony
  keys.** The per-device key a recipient uses to receive a release is now scoped
  to the signed-in account, so signing in as a different contact in the same
  browser profile — or on a shared family computer — no longer overwrites or
  discards the other's key.

## 2026-07-22 — QA follow-ups: the revocation clock, a way out of review, clearer limits

### Fixed
- **Contacts get their promised time to change their mind.** A release
  ceremony holds each affirmation "revocable" for a window (48 hours by default)
  before it commits — the safety promise on our public pages. A misconfigured
  deployment could shrink that window to seconds; the server now refuses to
  start in production with a revocation window under an hour unless it is
  explicitly acknowledged as a compressed drill. Your window is real.
- **The ceremony page now tells you your own deadline.** When you have
  affirmed, the page shows the exact time until which you can still revoke —
  and, once that window closes, says so plainly ("your affirmation is
  confirmed — the change-your-mind window has closed") with the "the owner is
  alive — stop this release" action still offered, instead of the Revoke button
  silently vanishing.
- **A stopped release is no longer a dead end.** When a ceremony fails or a
  contact disputes it, your engine pauses for review. That state used to leave
  the engine page with no way forward. It now shows a clear "on hold for
  review" card and an "I'm here — resolve and re-arm" action (a fresh passkey
  confirmation) that returns you to normal monitoring. Nothing is ever released
  from this state.
- **Hitting your plan's contact limit says so, where you clicked.** On the free
  plan, trying to add a third contact now shows the upgrade nudge right next to
  the button you pressed, instead of a message far down the page that read like
  nothing happened.
- **Clearer sign-in and channel-removal messages.** Passkey sign-in now says
  the wait for your device's prompt is normal (and not to refresh). Removing a
  verified channel, if the security confirmation doesn't complete, now says
  plainly that the passkey was declined or the check didn't finish and that
  nothing was scheduled — instead of always blaming a cancellation.
- **The Continuity Report is clearer about timing.** The frozen report now says
  that provider confirmations arriving after it was taken aren't reflected, so
  a recent attempt can read as sent-but-not-yet-delivered — which explains why a
  frozen snapshot and the live view can show different delivery counts.

## 2026-07-20 — The owner's release panel, the protective buttons, and ceremony fixes

### Added
- **See your release ceremonies as they happen.** The engine page now shows a
  live progress panel whenever a release episode exists for your account: which
  tiers are being released, who has affirmed (by the private name you gave
  them — decrypted on your device, unreadable to the server), which
  affirmations are still revocable and until when, when the collection window
  closes, and — once a release opens — who has retrieved it. Failed and
  cancelled ceremonies stay visible with a plain-language reason.
- This is transparency that doubles as an alarm: if a release started while
  you're alive — a false positive, or contacts acting together — you see
  exactly who did what, with the check-in and cancel-release controls on the
  same screen. The panel itself is strictly read-only: it shows, it never acts.
- **The protective actions are now buttons.** The ceremony page now offers
  *Revoke* (undo a still-revocable affirmation) and *"The owner is alive —
  stop this release"* (dispute, which halts the release for review). Both
  existed server-side; the page never showed them.
- **Affirming asks you to confirm.** Affirming a release is consequential, so
  it is now a two-step action with the tier being released shown plainly.
- **All your ceremonies at once.** A contact involved in several release ranks
  now sees and can act on each ceremony, not just the first.

### Fixed
- **Ceremonies no longer fail while affirmations are still maturing.** An
  affirmation stays revocable for a window before it commits. Previously, a
  ceremony whose collection window closed while affirmations were still inside
  that revocation window was failed outright — with the default settings this
  meant every real-time ceremony was doomed to fail even when every contact had
  affirmed in time. The ceremony now stays open while the affirmations already
  made could still reach the required consensus, and fails only when the
  threshold is genuinely out of reach.
- **The first person to recover no longer locks everyone else out.** Once
  consensus opens the release, every recipient — co-holders and designated
  beneficiaries — can now complete their own recovery, for up to 30 days after
  the release opens. Previously the first successful recovery closed the gate
  on everyone else.
- **Designated beneficiaries can open their ceremony page.** They appeared in
  the ceremony list but got "not found" on the detail view.

### Security
- Recovering released content now always requires having affirmed (or being
  the designated beneficiary) — previously one tier served its envelope to
  holders who had never affirmed once the gate was open.
- An affirmation's cryptographic proof is now bound to the specific ceremony
  it affirms, so it can never be replayed against another.
- Reporting "I have recovered" is only accepted once the release is genuinely
  open and only from someone entitled to recover — a premature report could
  previously freeze the ceremony's 30-day fail-safe.
- Closed narrow race windows so that an affirmation being revoked at the exact
  moment it commits can never be counted both ways.

## 2026-07-18 — Attachments in the app, the channel-matrix switches, and a QA round

### Added
- **Attach files during creation.** The new-item form now takes attachments
  directly — drag files onto it or pick several at once, and they're encrypted
  on your device and uploaded the moment you save, in one flow. You no longer
  have to save first and reopen the item to attach. (You still can add more
  later from the item page, which now also takes multiple files at once.) If a
  file can't be stored — say it would exceed your plan's storage — the item is
  still saved and you're pointed straight at it to retry, so nothing is lost
  silently.
- **Encrypted attachments in the vault.** Attach a file to any vault item:
  it is encrypted on your device before upload (the filename travels inside
  the encryption — the server stores unreadable bytes and a size, nothing
  else), listed on the item, downloadable-and-decryptable anytime, and
  removable through the same 7-day protected action as other destructive
  changes. The storage machinery had shipped server-side earlier; the July 17
  QA round caught that the app itself never exposed it.
- **The channel-matrix switches.** Settings now shows the grid the backend
  has enforced since July 16: per channel, choose whether it serves
  verification waves, account notices, and ceremony requests — with the
  safety floor stated right there (check-in requests, escalation requests,
  and security alerts can never be silenced). Same QA round, same class of
  gap: enforced server-side, previously no way to set it.

### Changed
- **Clearer wording on the item page.** The note that an item is immutable now
  says plainly that it applies to the item's *title and content* — not its
  attachments, which can always be added or removed. The page is laid out as
  Record / Actions / Attachments so what's fixed and what's editable is obvious.

### Fixed
- **Moving a vault item to a different protection tier now takes effect.** A
  startup gap in the background release service meant tier changes were
  accepted and waited out their 7-day protection window, but then never
  applied — the service retried them silently on every pass. Tier moves now
  complete as intended. (No data was ever at risk: the change simply didn't
  happen, and nothing was released with the wrong protection.)
- **Interrupted sign-ups can now finish.** If setup was cut off after
  creating your passkey but before choosing a passphrase (for example by an
  outage), signing in used to land on an unlock screen asking for a
  passphrase that never existed. It now detects the unfinished state and
  returns you to setup automatically.
- Registering with an email that already has an account now says so plainly
  and points you to sign in, instead of a generic failure.
- The verification panel no longer reads like a failure on a healthy, freshly
  armed engine ("no attempts have been needed yet" instead of "no channel was
  available"), no longer shows a stale "the owner returned" note while a
  release is in progress, and updates "last confirmed active" immediately
  after you check in.

## 2026-07-16 — Report narration, channel-removal protection, downgrade transparency

### Added
- **Plain-language AI narration of the Continuity Report** (off by default,
  `CV_NARRATION_ENABLED`). When a release ceremony opens, your trusted
  contacts can read a short AI-written explanation of the evidence report —
  what was attempted, what provably arrived, what the outcome means. It
  explains, never decides: the sealed evidence and its audit anchor are
  untouched, every AI guard applies (your opt-out governs), and if the AI is
  off or fails, the factual report stands alone. The engine that drives
  releases makes no AI calls at all.
- **A downgrade banner in Settings.** If your paid plan ends while SMS or
  WhatsApp channels are enrolled, Settings now tells you plainly: those
  channels keep protecting you, nothing was turned off, and only *adding new*
  paid channels needs an upgrade. A one-time email notice says the same at the
  moment your plan lapses.
- **CV-4 voice-channel design completed** (documentation only, no code): the
  per-jurisdiction consent survey, provider comparison and cost model, the
  evidence-only rules that make a cloned voice useless to an attacker, and the
  full test plan — awaiting owner approval before any implementation.

### Changed
- **Removing a verified notification channel is now a protected action**:
  a fresh security confirmation plus a 7-day delay, cancellable from the
  Engine page — so a stolen session can never instantly silence your check-in
  reminders. The channel being removed still receives the pending-removal
  notice. Unverified channels (a typo'd address) still remove with one click.
- **Your channel matrix now governs routine notices too.** Opting a channel
  out of "owner notices" or "contact notices" is respected when the system
  picks where updates, pending-action notices, and ceremony requests land.
  Check-in requests, escalation requests, and security alerts are deliberately
  exempt — the safety floor no preference can silence.
- The AI transparency page (`/security/ai`) and `docs/AI.md` now describe the
  narration capability — published before the flag is enabled anywhere.

### Fixed
- Web push notifications now show the Truecairn icon (the service worker
  pointed at an icon file that didn't exist, so browser pushes rendered
  without one).

## 2026-07-15 — Plans with real limits, account profile

### Added
- **Real per-tier limits**: Free = 2 trusted contacts, 5 vault items, 10 MB
  attachment storage; Personal = unlimited contacts/items and 5 GB. Enforced
  when you create — a downgrade never deletes or locks anything you already
  have. The Plans page shows live usage against your limits.
- A dedicated **/upgrade** page and corrected landing pricing with a
  monthly/yearly switch.
- **Your name in the app**: an optional display name (with honorific) shown in
  the account menu alongside your plan tier. Display-only — never part of
  auth, crypto, or release.

## 2026-07-14 — Paid plans, branded email, more channels

### Added
- **Truecairn Personal** (LemonSqueezy billing): hosted checkout, subscription
  status in Plans, and SMS channels as the paid difference. No card data ever
  touches Truecairn's servers. *(As first written this said "SMS/WhatsApp".
  WhatsApp never delivered a message to anyone and was withdrawn on 2026-08-01;
  corrected here rather than left selling it.)*
- **SMS notification channels** (Twilio), enrolled with the same code
  round-trip as email — only verified channels are ever selected. *(WhatsApp was
  announced alongside SMS here and never worked; withdrawn 2026-08-01.)*
- **Web push notifications** (browser push), same verified-only enrolment.
- **A branded welcome email** on your first verified email channel, and a
  branded shell for every notice — with the standing promise printed in the
  footer: delivery is recorded, opens and reads never are.

### Fixed
- Delivery confirmations from the email provider now verify correctly (Svix
  signatures), so "delivered" in the Continuity Report is provider-proven.

## 2026-07-13 — Continuity Verification

### Added
- **The verification ladder** (off by default): while a check-in request is
  unanswered, Truecairn escalates across every verified channel you allow —
  repeated waves, spaced and capped, each recorded.
- **The channel matrix**: choose which channels serve verification, routine
  notices, and (for contacts) ceremony requests. No preference set = everything
  enabled, exactly as before.
- **The Continuity Report**: when a release ceremony opens, a frozen,
  audit-anchored evidence report — every attempt to reach the owner with
  provider-proven results and a rule-computed outcome — is attached for the
  ceremony's recipients. No open/read tracking exists, enforced by a
  build-failing test.
- The TrueCairn wordmark and cleaned-up invitation emails.

## 2026-07-04 → 07-10 — The AI Guardian (flags off pending owner sign-off)

### Added
- **AI guardrails first**: a master kill switch, per-user opt-out, rate
  ceilings, a cost circuit breaker, and a single authority chokepoint enforcing
  the rule the whole subsystem is built on — *AI can add safety, never remove
  it* (backed by permanent invariant tests and an injection-eval corpus).
- **AI proposals** (flag off): deterministic readiness analysis that can
  suggest — never apply — safety improvements you approve or reject.
- **Bounded autonomy** (flag off + per-user opt-in): the AI may queue a
  reminder or a check-in tightening into the existing delayed, vetoable
  pipeline. It can only ever shorten toward a floor you set.
- **The Guardian** (flag off): deterministic anomaly detectors that can pause
  a release into human review — the one engine signal the AI has, and it only
  ever pauses.
- The public AI transparency page (`/security/ai`), `docs/AI.md`,
  reproducible-build notes, and this project's security policy.

## Earlier — V1 core (through 2026-07)

The zero-knowledge foundation this all sits on: client-side encryption
(libsodium), enrollment with passkeys + recovery codes, the vault with
attachments, trusted-contact enrolment with possession proofs, the inactivity
engine and its check-in ladder, sensitive actions (step-up + 7-day delay +
all-channel notice), S1 envelope ceremonies, and the full S2/S3 Shamir release
path with the owner's release passphrase as a mandatory factor. Every release
gate fails closed; every audit entry rides the transaction it records.
