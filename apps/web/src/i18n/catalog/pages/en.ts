// ── The public CONTENT pages (docs/40 Phase 2) ───────────────────────────────
//
// The third catalog half, and the reason there are three rather than two.
//
// `site/` is EAGER — it ships in the bundle every anonymous visitor downloads to
// read the landing page, so its size is a cost paid on every first visit. `app/`
// is lazy behind AuthedApp. This half is lazy behind PublicPages: the long-form
// pages (the guide, the security model, the company pages, build provenance) are
// several times the landing's word count, and a visitor who never leaves "/"
// must not pay for a word of it.
//
// The alternative — putting these in `site/` because they are "the website" —
// was measured and rejected: it is roughly 100 KB of copy across two languages
// added to the critical path of the one page that has to be fast.
//
// Flat dotted keys, `keySeparator: false`, same as the other two halves. The
// three merge into one i18next namespace, so a call site says
// t('site.guide.overview.body') and never knows which bundle carried it.
export const pagesEn = {
  // ── The user guide (/guide) ──────────────────────────────────────────────
  //
  // CONTENT RULE, carried over from the file this was extracted from and binding
  // on every translation: S3 is the passphrase-MANDATORY nested scheme (docs/24).
  // S2 keeps the release passphrase as an OPTIONAL fallback. A translation that
  // blurs those two — or that calls the release passphrase "optional" or "just a
  // share" for S3 — tells a reader their permanently-unrecoverable items are
  // recoverable. Do not soften §7 or §11 for readability.
  'site.guide.eyebrow': 'help',
  'site.guide.title': 'User guide',
  'site.guide.intro':
    'This guide walks through everything Truecairn does, screen by screen. If you only read two sections, read <secrets>the secrets you manage</secrets> and <tiers>sensitivity tiers and release</tiers> — together they explain what is recoverable and what is not.',
  'site.guide.contents': 'Contents',

  'site.guide.overview.title': 'How Truecairn works',
  'site.guide.overview.body':
    'Truecairn keeps the important parts of your digital life encrypted on your own device, and releases them to people you choose — under rules you write — only if you become unreachable. Nothing in your vault is readable by us. You add items, invite trusted contacts, and set the conditions for release. If you stop checking in, a continuity engine escalates slowly through reminders; if it reaches the release stage, your contacts confirm and, together, reconstruct access. Every step is reversible right up to the end.',

  'site.guide.secrets.title': 'The secrets you manage',
  'site.guide.secrets.lede':
    'Three different secrets do three different jobs. Keeping them straight is the single most important thing to understand:',
  'site.guide.secrets.passkey':
    '<strong>Your passkey</strong> signs you in. It lives on your device or security key. Signing in starts a session but does <em>not</em> unlock your vault.',
  'site.guide.secrets.master':
    '<strong>Your master passphrase</strong> unlocks the vault. It derives your encryption keys on your device and never leaves it; we can neither see nor reset it.',
  'site.guide.secrets.release':
    '<strong>Your release passphrase</strong> is separate again. You store it offline, off site, and it is used only during a release ceremony.',
  'site.guide.secrets.recoveryNote':
    '<strong>The recovery code is your safety net.</strong> At enrollment you save a one-time backup recovery code. If you ever forget your master passphrase, that code is the only way back into your vault. Store it somewhere safe and offline.',

  'site.guide.account.title': 'Creating your account',
  'site.guide.account.body':
    'Sign up with your email and register a passkey. You then run a one-time enrollment ceremony: you choose your master passphrase, your device derives your key material (this is the brief “working” pause — real cryptography running in your browser), and you are shown your backup recovery code. Save the recovery code before you continue; it is shown once. When enrollment finishes, your vault is unlocked and ready.',

  'site.guide.unlock.title': 'Unlocking and locking',
  'site.guide.unlock.body':
    "Signing in and unlocking are two steps. After you sign in with your passkey, you enter your master passphrase to unlock the vault for that session. <strong>Lock vault</strong> wipes the key from your browser's memory but keeps you signed in — you'll re-enter your master passphrase next time. <strong>Sign out</strong> does both: it ends the session and wipes the key. Your vault also locks itself automatically after a period of inactivity. You can lock or sign out from the account menu at the bottom of the sidebar, or from Settings.",

  'site.guide.vault.title': 'Your vault',
  'site.guide.vault.body':
    'The vault holds your items — notes, credentials, recovery instructions, documents. Add an item, give it a category, and choose its sensitivity tier (see the next section). You can attach encrypted files. Everything is encrypted on your device before it is uploaded, so what reaches our servers is ciphertext only. Open any item to edit it or change its tier.',

  'site.guide.contacts.title': 'Trusted contacts',
  'site.guide.contacts.body':
    "Trusted contacts are the people who can help release your vault if you go silent. Invite anyone with an email address — they don't need an account to start, just the signed link you send. Tag each contact with a role (for example Personal or Professional). Roles matter: a release can require contacts of <em>different</em> roles, so no single family group or workplace can act alone. When a contact accepts and enrolls, their device generates its own keys and they become able to hold a share. We recommend keeping more contacts than the minimum a release needs, so a release can still proceed if someone is unavailable.",

  'site.guide.tiers.title': 'Sensitivity tiers and release',
  'site.guide.tiers.lede':
    'Every vault item sits in one of three tiers. The tier decides how the item is released, so you can trade ease of recovery against resistance to collusion, item by item.',
  'site.guide.tiers.s1.title': 'S1 — most accessible',
  'site.guide.tiers.s1.body':
    'Released when any one trusted contact opens the sealed envelope you left them. Use it for things that should be easy for someone to reach.',
  'site.guide.tiers.s2.title': 'S2 — sensitive',
  'site.guide.tiers.s2.body':
    'A flat 2-of-3 split across two diverse-role contacts and your release passphrase. Any two of those three shares reconstruct it. Here, <strong>the release passphrase is one of the three shares — an optional fallback</strong>: two contacts can recover S2 without it, so losing the release passphrase does not by itself make S2 unrecoverable.',
  'site.guide.tiers.s3.title': 'S3 — most sensitive',
  'site.guide.tiers.s3.body':
    'A nested scheme. Your release passphrase is a <strong>mandatory mask</strong> over a 2-of-3 split held by three contacts. Reconstructing S3 requires the release passphrase <strong>and</strong> any two of those three contacts. There is no contacts-only path for S3, and the release passphrase is not just one share among several — it is always required.',
  'site.guide.tiers.note':
    '<strong>The crucial difference.</strong> For S2 the release passphrase is an optional fallback. For S3 it is mandatory: if you lose your release passphrase, your S3 items become <strong>permanently unrecoverable</strong> — colluding contacts can never reach them, and we cannot help. File anything you could not bear to have colluded over, or to lose if your passphrase is gone, with that trade-off in mind.',

  'site.guide.plans.title': 'Continuity plans',
  'site.guide.plans.body':
    'The Plans screen shows how each tier of your vault is released and to whom — it consolidates your vault tiers, your contacts, and the release rules into one view. (It is an explainer of your trust tiers, not a billing page.) Set a trigger, a cooldown, and a release-stage ladder, then preview the timeline before saving. Editing release rules is the most consequential change you can make, so it takes effect only after a delay, during which the existing plan stays in force and you can revert.',

  'site.guide.engine.title': 'The continuity engine',
  'site.guide.engine.body':
    "The engine is what notices you've gone quiet. While you're active it sits idle. If you miss check-ins past your configured threshold, it moves step by step — reminding you, then notifying your contacts, then opening a cooldown — never all at once. You confirm you're still here from the Engine screen or by responding to a check-in. If you know you'll be unreachable (travel, a hospital stay, a retreat), you can register an absence window so the engine waits longer. The engine errs heavily toward “still here.”",

  'site.guide.ceremony.title': 'The release ceremony',
  'site.guide.ceremony.body':
    'If the engine reaches the release stage, your contacts receive a signed link and are asked to affirm or dispute — a dispute halts the release into review, and a contact who is simply unsure should use it rather than affirm. Affirming is tentative at first: it opens a revocation window during which that contact — or you, from any verified device — can cancel with one tap. Only after the window passes, the threshold of affirmations is met across diverse roles, and the cooldown completes without cancellation does the platform release the time-locked outer key so the affirmed contacts can reconstruct. For S3 they also need your release passphrase to un-mask the result. Every action is timestamped and signed into the audit log.',

  'site.guide.recovery.title': 'Recovery and lost secrets',
  'site.guide.recovery.lede': 'What happens if you lose a secret depends on which one:',
  'site.guide.recovery.master':
    '<strong>Forgot your master passphrase?</strong> Use your one-time backup recovery code to get back in, then set a new master passphrase.',
  'site.guide.recovery.release':
    '<strong>Lost your release passphrase?</strong> If you still have your master passphrase (or your recovery code), you can rotate to a new release passphrase. The impact of losing it differs by tier: <strong>S2 survives</strong> — its two diverse-role contacts can reconstruct without it — but <strong>S3 does not</strong>, because the release passphrase is its mandatory mask. There is no “contact support” path that can restore S3.',
  'site.guide.recovery.everything':
    '<strong>Lost everything</strong> — master passphrase, release passphrase, and recovery code? Then your account is unrecoverable, and we cannot assist. Your contacts can still complete an S1 or S2 release if you become unreachable; S3 additionally needs the release passphrase.',

  'site.guide.privacy.title': 'Security and privacy',
  'site.guide.privacy.body':
    "Truecairn is zero-knowledge: your vault plaintext, your passphrases, your recovery code, and your keys never reach our servers — not in a log, not in a notification, not anywhere. Sensitive changes (editing contacts, thresholds, or the release passphrase) require a fresh second factor and a passphrase signature, and they wait through a delay with out-of-band notice, so a hijacked session can't quietly rewire your plan. You can read the full <security>security model</security> and the <threat>threat model</threat> for the details and the honest limits.",

  'site.guide.ai.title': 'The AI assistant and guardian',
  'site.guide.ai.lede':
    'Truecairn includes an optional AI with one hard rule, enforced in code: it can only ever <strong>add</strong> safety, never remove it. What that looks like in the product:',
  'site.guide.ai.assistant':
    '<strong>Assistant and briefing</strong> — answer questions and summarise your account using metadata only (counts, states, cadence). They never see your encrypted content, item names, or keys.',
  'site.guide.ai.proposals':
    '<strong>Readiness proposals</strong> — suggestions on your dashboard (for example, “add an S3 contact in a different role”). A proposal changes nothing until you approve it, and dismissing it makes it go away.',
  'site.guide.ai.autonomy':
    '<strong>Opt-in autonomy</strong> — off by default. If you enable it in Settings, the AI may queue a shorter check-in interval on your behalf — never below the floor you set — and the change waits in your pending list, badged as AI-proposed, where you can veto it before it takes effect.',
  'site.guide.ai.guardian':
    '<strong>The guardian</strong> — watches a release in progress for anomalies and can do exactly one thing about them: pause the release for your review. It can never approve or advance one.',
  'site.guide.ai.optOut':
    'One switch in Settings (“Turn off AI for my account”) disables every AI feature for you without touching your check-ins or release plan. The full account of what the AI can see and do is on <ai>How Truecairn uses AI</ai>.',

  'site.guide.help.title': 'Getting help',
  'site.guide.help.body':
    "The in-app Assistant answers questions about how Truecairn works and what to do next — it sees only your account's metadata, never your encrypted content, and you should never paste a passphrase or recovery code into it. For account questions, reach us from the <contact>contact page</contact>. And remember: we will never ask you for a passphrase, recovery code, or anything from inside your vault.",
  // ── The /security/* sub-navigation (site/security-pills.ts) ──────────────
  'site.security.pill.model': 'Security model',
  'site.security.pill.threat': 'Threat model',
  'site.security.pill.ai': 'AI',
  'site.security.pill.build': 'Build provenance',
  'site.security.pill.limits': 'Known limits',
  'site.security.pill.disclosure': 'Disclosure policy',

  // ── Build provenance (/security/build) ───────────────────────────────────
  //
  // THE PAGE THAT MUST NOT OVERCLAIM, and the one where a translator's instinct
  // to sound reassuring does the most damage. Three sentences below say what
  // this page CANNOT prove — that no signed attestation exists yet, that this
  // page could itself be lying if the origin were compromised, and that nobody
  // has actually performed the check. They were written after a correction
  // (QA 2026-08-09) in which this page told readers to go and find a build
  // attestation that has never existed. Every one of those disclaimers is
  // load-bearing; a translation that softens or drops one re-creates the defect
  // in another language.
  'site.build.eyebrow': 'security',
  'site.build.title': 'Build provenance',
  'site.build.lede':
    'Truecairn encrypts everything in your browser, which means the code doing that encryption is code we serve to you. That is the honest weak point of every browser-based end-to-end encrypted product, including this one: if our origin were compromised or coerced, it could serve one targeted person a modified bundle. We would rather describe that plainly and give you something to check than let the phrase “zero-knowledge” do the work.',
  'site.build.what.title': 'What this page is',
  'site.build.what.body':
    'Every build publishes a SHA-256 for every file it ships plus one combined digest over all of them. Below is the digest of the bundle <strong>you are running right now</strong>, and the source it was built from. The build is deterministic, so the same source on the same pinned toolchain produces the same digest on your machine as on ours — that is the property this page rests on, and you can test it yourself.',
  'site.build.notShipped':
    '<strong>What we have not shipped yet:</strong> signed per-release build attestation. The workflow that produces it exists and is public, but no tagged release has been published, so there is nothing signed for you to check against today. We would rather say that here than send you looking for an artifact that does not exist. Until it does, the check below is a rebuild you run yourself — weaker, because it rests on your copy of the source rather than on a signature from infrastructure we do not control, and still worth doing.',
  'site.build.noManifest':
    'This build did not publish a manifest. That is expected for a local development build and unexpected for <code>truecairn.app</code> — if you are seeing it there, treat it as a reason to ask us, not as proof of anything.',
  'site.build.bundle.title': 'This bundle',
  'site.build.bundle.digest': 'Bundle digest',
  'site.build.bundle.commit': 'Source commit',
  // "ref", not "Release": in production this is the BRANCH the deploy built
  // from, because no release has been tagged. Calling a branch a release is the
  // same overclaim this page exists to avoid, in a table cell.
  'site.build.bundle.ref': 'Built from ref',
  'site.build.bundle.builtAt': 'Built at',
  'site.build.bundle.files': 'Files',
  'site.build.check.title': 'How to check it',
  'site.build.check.unpublished':
    'The source repository is not public yet, so today you can record this digest and compare it across visits and devices — if the bundle you are served ever differs from the one everyone else is served, that is worth asking about. Independent verification against a published attestation becomes possible when the repository is published; we would rather say that than link you somewhere that does not exist.',
  'site.build.check.step1': 'Clone <repo>the published client source</repo>.',
  'site.build.check.step2':
    'Rebuild from source with the pinned toolchain — Node 22 and the exact pnpm the repository declares, installing with <code>--frozen-lockfile</code>. The build steps and the known causes of byte drift are in <code>docs/BUILDING.md</code>.',
  'site.build.check.step3':
    'Compare the <code>bundleDigest</code> your build prints with the one shown above.',
  'site.build.check.mismatch':
    '<strong>Expect a difference if the two are not at the same commit.</strong> The published repository is a curated export of the client, and this deployment can be ahead of it. A mismatch on its own therefore means “these are different versions” at least as often as it means anything else — check the commit above against the published head before concluding anything, and ask us if they match and the digests still differ. Telling you that a mismatch is automatically alarming would make this page a source of false alarms, which is its own kind of dishonesty.',
  'site.build.proves.title': 'What this does and does not prove',
  'site.build.proves.does':
    '<strong>It does</strong> mean that serving one person a modified bundle has to survive comparison against a build anyone can run from published source. Tampering that would once have been silent and deniable becomes tampering that a single reader with a terminal can catch.',
  'site.build.proves.doesNot':
    '<strong>It does not</strong> mean this page cannot lie to you. The code computing and displaying this digest was served by the same origin as the bundle it describes, so an origin that had been fully compromised could serve a doctored page as easily as a doctored bundle. Checking is only meaningful when the comparison happens somewhere we do not control — on your machine, from source you fetched yourself. We would rather you understand that limit than trust a green checkmark.',
  'site.build.proves.unchecked':
    '<strong>And it does not</strong> mean anyone has actually checked. No third party has reproduced this build and published the result; the honest status of this page is that the check is available, not that it has been performed. Signed per-release attestation, which would let you verify without rebuilding anything, is still to come.',
  'site.build.files.title': 'Per-file digests',
  'site.build.files.hide': 'Hide',
  'site.build.files.show': 'Show all {{count}} files',
  'site.build.files.colFile': 'File',
  'site.build.files.colHash': 'SHA-256',
  // ── Security model (/security) ───────────────────────────────────────────
  //
  // Grounded in docs/18 (crypto architecture) and docs/04–17 (threat model).
  // No invented claims: primitives and tier mechanics are taken verbatim from
  // the spec, and "Independent reviews" says plainly that no third-party report
  // is published rather than faking one. That sentence is the one a translator
  // must not soften — an absence stated plainly is the whole point of it.
  "site.security.model.eyebrow": "security",
  "site.security.model.title": "Security model",
  "site.security.model.lede":
    "Truecairn is a zero-knowledge system. Everything in your vault is encrypted on your own device before it is uploaded, with keys the server never holds. The server stores ciphertext, public keys, salts, and sealed boxes — never plaintext, never a passphrase, never an unwrapped key. Its single cryptographic power is releasing one outer layer (a time-locked gate) when, and only when, the continuity engine and your trusted contacts agree the conditions you wrote have been met.",
  "site.security.model.summary":
    "This page is the readable summary. The full cryptographic specification lives in the project's architecture documents, and the adversaries we design against are catalogued in the <threat>threat model</threat>.",

  "site.security.model.secrets.title": "The three secrets",
  "site.security.model.secrets.lede":
    "Three different secrets do three different jobs. Keeping them distinct is the heart of the design:",
  "site.security.model.secrets.passkey":
    "<strong>Your passkey</strong> signs you in day to day. Signing in establishes a session; it does not, by itself, unlock the vault.",
  "site.security.model.secrets.master":
    "<strong>Your master passphrase</strong> unlocks the vault. It derives every vault encryption key on your device, never leaves it, and the server can neither see nor reset it. If you forget it, you recover with the one-time backup recovery code you saved at enrollment.",
  "site.security.model.secrets.release":
    "<strong>Your release passphrase</strong> is different again. You store it offline, off site, and it is used only during a release ceremony (see the tiers below). The server never sees it; only its key-derivation salt is stored.",

  "site.security.model.crypto.title": "How your vault is encrypted",
  // The non-breaking spaces in "256 MiB" and "4 passes" are deliberate — a
  // number must not be orphaned from its unit across a line break. They are real
  // U+00A0 characters, so a translator moving the phrase carries them along.
  "site.security.model.crypto.body":
    "Vault content is sealed with <strong>XChaCha20-Poly1305</strong> authenticated encryption (libsodium), using random 256-bit per-item keys and random per-operation nonces. Keys are derived from your master passphrase with <strong>Argon2id</strong> (256 MiB memory, 4 passes) over a random 16-byte per-account salt. Contact shares are wrapped to each contact's <strong>X25519</strong> public key; affirmations and audit entries are signed with <strong>Ed25519</strong>. All of this runs in the browser; the server's cryptographic role is limited to storing ciphertext, signing audit entries with its own key, managing the time-locked outer key, and routing messages.",

  "site.security.model.tiers.title": "The release tiers",
  "site.security.model.tiers.lede":
    "You file each vault item under a sensitivity tier. Each tier reconstructs differently, so you can trade recoverability against collusion-resistance item by item.",
  // S2 optional-fallback vs S3 mandatory-mask (docs/24). A translation that
  // blurs these two tells a reader their permanently-unrecoverable items are
  // recoverable. Never render the S3 passphrase as "optional" or "one share".
  "site.security.model.tiers.s1":
    "<strong>S1 — most accessible.</strong> Released when any one trusted contact opens the sealed envelope you left them.",
  "site.security.model.tiers.s2":
    "<strong>S2 — sensitive.</strong> A flat 2-of-3 Shamir split across two diverse-role contacts and your release passphrase. Any two of those three shares reconstruct it, so the release passphrase is an <strong>optional fallback</strong> — two contacts can recover S2 without it, and losing it does not by itself make S2 unrecoverable.",
  "site.security.model.tiers.s3":
    "<strong>S3 — most sensitive.</strong> A nested scheme: your release passphrase is a <strong>mandatory mask</strong> over a 2-of-3 split held by three contacts. Reconstruction needs the release passphrase <strong>and</strong> any two of three contacts. There is no contacts-only path. If the release passphrase is lost, S3 is permanently unrecoverable — colluding contacts alone can never reach it, and the server cannot help. This is by design.",

  "site.security.model.gate.title": "The temporal gate",
  "site.security.model.gate.body":
    "Above the tier keys sits an outer layer the platform holds: a random key that wraps the stored ciphertext and is released only after the engine's cooldown completes without cancellation. It is a <strong>time lock, not a confidentiality key</strong> — removing it strips one wrap, but the inner wraps still require the secrets the server never sees. A single long-running worker is the only code path that can release it, and that worker is open-source.",

  "site.security.model.audit.title": "The audit log",
  "site.security.model.audit.body":
    "Every release-relevant event — affirmations, withdrawals, disputes, edits, revocations — is appended to a hash-chained log. The server signs every entry; your device additionally signs sensitive ones with a key derived from your master passphrase. You can verify that the chain is unbroken and that the user-signed entries verify under your published key. A server that fabricates or reorders entries produces signatures that do not verify, or a broken chain — both detectable.",

  "site.security.model.ai.title": "Where the AI fits",
  "site.security.model.ai.body":
    "Truecairn's AI sits <em>outside</em> everything above. It sees an allowlisted slice of metadata — counts, states, cadence — and never ciphertext, names, keys, or passphrases. Its authority is one-directional by construction: it can suggest, it can (with your opt-in) queue a vetoable tightening, and it can pause an in-progress release for your review — it can never loosen a control, advance a release, or decrypt anything. The full account is on <ai>How Truecairn uses AI</ai>.",

  "site.security.model.windDown.title": "If Truecairn disappears",
  "site.security.model.windDown.body":
    "The legitimate parties — you, your contacts, the holder of the release passphrase — can still decrypt with publicly available code. See the <winddown>wind-down playbook</winddown> for what we commit to if the company shuts down.",

  "site.security.model.audits.title": "Independent reviews",
  "site.security.model.audits.none":
    "We have not yet published a third-party security audit, and we hold no security certifications (SOC 2, ISO 27001, or otherwise). We would rather say that plainly than link to a report that does not exist. When an independent review is completed and we are able to publish it, the report — or a summary and how to request the full version — will appear here.",
  "site.security.model.audits.report":
    "Found something before we did? Our <disclosure>coordinated disclosure policy</disclosure> explains how to report it. We aim to acknowledge reports within {{days}} business days at <email>{{email}}</email>.",

  "site.security.model.notCovered.title": "What this page does not cover",
  "site.security.model.notCovered.body":
    "Everything above is what the system does protect. The other half — what we do not protect against, what we have not built, and what nobody has tested yet — is on <limits>known limits</limits>. It is the more useful page of the two if you are deciding whether to trust this with something that matters.",
  // ── Threat model (/security/threat-model) ────────────────────────────────
  //
  // The two-directional framing in the lede is the page's spine: a false
  // positive (releasing while you are alive) and a false negative (never
  // releasing) are BOTH failures, and every mitigation is judged against both.
  // A translation that keeps only one of them turns a balanced argument into a
  // sales pitch for whichever half it kept.
  "site.security.threat.eyebrow": "security",
  "site.security.threat.title": "Threat model",
  "site.security.threat.lede":
    "Truecairn pulls in two opposite directions. A <strong>false positive</strong> — releasing your vault while you are alive and would not consent — is irreversible and catastrophic at the top tier. A <strong>false negative</strong> — never releasing when you are genuinely gone — defeats the entire point. Every mitigation below is judged against both. The engine errs toward “still here,” because a wrongful release cannot be taken back.",
  "site.security.threat.assumptions":
    "We assume the cryptographic primitives are sound, your enrolled devices are not actively compromised, and you chose your contacts in good faith. We do <strong>not</strong> assume a contact's intentions stay fixed, that any one device or channel stays under your control, or that operators deserve the power to decrypt. The consequence threaded through the whole design: <strong>single-party authority is forbidden</strong> anywhere a release can advance.",

  "site.security.threat.t51.title": "5.1 — A malicious trusted contact",
  "site.security.threat.t51.body":
    "The most likely real-world failure: a contact you listed in good faith waits out a period of unreachability to trigger a release you would not consent to. We counter it with multi-contact consensus, a required mix of diverse roles, cross-contact notifications, the cooldown ladder, and a revocation window in which you — or any affirming contact — can cancel.",
  "site.security.threat.t52.title": "5.2 — Account compromise",
  "site.security.threat.t52.body":
    "An attacker with your authenticated session, but not your passphrase or shares, cannot decrypt anything: the login credential opens the dashboard, not the plaintext. Reconfiguring contacts, thresholds, or the release passphrase are sensitive actions guarded by a fresh second factor, a passphrase signature over the exact change, and a multi-day delay with out-of-band notice — so a hijacked session cannot quietly rewire your plan.",
  "site.security.threat.t53.title": "5.3 — Notification failure",
  "site.security.threat.t53.body":
    "Not an attacker but entropy: a dead inbox, a spam filter, a changed provider. If every channel silently fails, the engine could advance while you are simply unreached. So we treat being unreachable as a reason to pause rather than to proceed: when no channel is working — including when you have not added one — the ladder stops and waits instead of escalating. We also escalate slowly, surface the live state on every device you open, and keep the cooldown long enough to notice and cancel. We ask for more than one channel, and we recommend it, but we do not currently refuse to arm without one.",
  "site.security.threat.t54.title": "5.4 — Contact compromise",
  "site.security.threat.t54.body":
    "An attacker who takes over a contact's account (phishing, SIM-swap, a stolen device) cannot start an inactivity event on their own, and we deliberately never store a usable share inside a contact's account — shares are unwrapped only on the contact's bound device at ceremony time. Diverse-role consensus means one compromised contact is never enough.",
  "site.security.threat.t55.title": "5.5 — False inactivity",
  "site.security.threat.t55.body":
    "You are on a retreat, hospitalized, hiking, or travelling somewhere restricted — alive, but silent past your threshold. You can pre-register absence windows that extend the threshold, the cooldown ladder buys time, and a single tap from any verified device cancels an in-flight release the moment you resurface.",
  "site.security.threat.t56.title": "5.6 — Multi-contact collusion",
  "site.security.threat.t56.body":
    "Two or more contacts conspiring is the threat the secret-sharing scheme exists to defeat. For <strong>S3</strong> the guarantee is cryptographic: contacts hold only a masked split, so any number of them, however patient, cannot reconstruct without the release passphrase you keep off site. For <strong>S2</strong> the protection is procedural — diverse roles, visibility, audit, and the cooldown — and we state honestly that two diverse-role contacts can reach S2 without the passphrase. File anything you could not bear to have colluded over as S3.",

  "site.security.threat.ai.title": "Our own AI, treated as an adversary",
  "site.security.threat.ai.body":
    "We treat our own AI as a potential adversary. A hallucinating model, a prompt injection smuggled through a question, or a compromised AI provider must never be able to move a release forward — so the AI's authority is capped structurally, not by policy: its only engine signal <em>pauses</em> a release for human review, every action it takes is logged under its own identity in the tamper-evident audit chain, model output that would influence behaviour is validated against closed schemas (an injected instruction is inert), and it is never given content — only counts, states, and cadence. The worst case of a fully compromised AI is noise: a dismissible false alarm or a vetoable suggestion. See <ai>How Truecairn uses AI</ai>.",

  "site.security.threat.residual.title": "Residual risk — what we do not guarantee",
  "site.security.threat.residual.body":
    "We are explicit about the edges. We cannot recover your data if you lose your release passphrase and become unreachable — S2 survives on its contacts, but S3 does not. We cannot force your contacts to be available or cooperative. We cannot defend against coercion of a keyholder, against a state-level adversary attacking you, your contacts, and our providers at once, or against a backdoored client you install. We log operational metadata (account existence, login and engine-state times, signed audit entries) and will hand over metadata and ciphertext under lawful order — but never plaintext, because we do not have it. And we are a release mechanism, not a legal instrument: pair us with a proper estate plan.",
  "site.security.threat.residual.deliberate":
    "These limits are deliberate. A service that promises more than it can keep is the more dangerous choice for the things that should outlast you.",
  // ── How Truecairn uses AI (/security/ai) ─────────────────────────────────
  //
  // The transparency page the lockstep rule keeps in step with the AI's actual
  // capabilities (CLAUDE.md invariant 8). "The AI can only ever add safety,
  // never remove it" is not a slogan here — it is a claim about the code, and
  // the list below enumerates exactly what "add" covers. A translation that
  // generalises the list, or that renders "it cannot" as anything softer than
  // a flat impossibility, describes a different product.
  "site.security.ai.eyebrow": "security",
  "site.security.ai.title": "How Truecairn uses AI",
  "site.security.ai.lede":
    "Truecairn uses AI in a deliberately small, deliberately one-directional role. The design rule is simple and enforced in code: <strong>the AI can only ever add safety, never remove it</strong>. It can suggest you tighten a setting, add a reminder, or pause a release for you to review — it can never loosen a control, advance a release, or reach your encrypted content. This page explains exactly what it does and the boundaries it runs inside.",

  "site.security.ai.sees.title": "What the AI can see",
  "site.security.ai.sees.body":
    "Strictly less than the server does. The AI is given an allowlisted slice of your <strong>metadata only</strong> — counts (how many contacts, how many items), closed-enum states (armed or not, which tier), and cadence (your check-in interval). It is never given — and the server is built so it cannot be given — your encrypted content, item titles, contact names, keys, passphrases, or shares. Those are ciphertext the server itself never holds (see the <model>security model</model>). Your typed questions to the assistant are your own words, sent with that same metadata; the client also blocks obviously secret-shaped text before it ever leaves your device.",

  "site.security.ai.can.title": "What the AI can do — and can't",
  "site.security.ai.can.suggest":
    "<strong>Suggest (proposer).</strong> It can surface a safety proposal — e.g. “your S3 plan needs a contact in a different role.” A proposal is a suggestion in your inbox; nothing changes until <strong>you</strong> approve it.",
  "site.security.ai.can.act":
    "<strong>Act, but only vetoably, and only if you opt in.</strong> If you turn on autonomy in Settings, the AI may enqueue a <strong>tightening</strong> — an extra check-in reminder, or a shorter check-in interval, never below a floor you set. Every such action waits in your pending list behind a delay and you can veto it before it takes effect. It can only ever shorten, never lengthen.",
  "site.security.ai.can.pause":
    "<strong>Pause a release for review (guardian).</strong> If a release is in progress and something looks anomalous, the AI can pause it into a <strong>review</strong> state and alert you. That is the one signal it can send the continuity engine — and it is fail-closed: it can add a review gate, it can never open one or release anything.",
  "site.security.ai.can.narrate":
    "<strong>Explain a continuity report (narration).</strong> When a release ceremony opens, your trusted contacts see a frozen evidence report — every attempt to reach you, with provider-proven results. The AI may add a short plain-language reading of that same evidence. It <strong>explains, never decides</strong>: the outcome stays rule-computed, the sealed evidence and its audit anchor are untouched (narration is stored beside them, never inside), and if the AI is off, opted out, over budget, or simply wrong-shaped, the deterministic report stands alone — a release is never delayed or blocked by narration. The engine that drives releases makes no AI calls at all.",
  "site.security.ai.can.cannot":
    "<strong>It cannot</strong> decrypt content, remove a safety check, lower a threshold, skip a delay, advance or complete a release, or act at all when you've turned it off.",

  "site.security.ai.guarantee.title": "How that limit is guaranteed, not just promised",
  "site.security.ai.guarantee.body":
    "The one-directional rule is enforced structurally, not by good intentions. Every AI action flows through a single chokepoint whose types make a “release” or “loosen” signal unrepresentable; a permanent test suite asserts the AI can emit only the fail-closed review signal and never a forward engine event; and every AI action is written to the same tamper-evident audit log as everything else, tagged as done by the AI, so you can see precisely what it did. The client and these controls are open source — you can read and rebuild them (see <model>the security model</model>).",

  "site.security.ai.controls.title": "Your controls",
  "site.security.ai.controls.off":
    "<strong>Off for your account.</strong> One switch in Settings turns off every AI feature for you — assistant, proposals, autonomy, and guardian narration. Your safety machinery (check-ins, the release ladder) is completely unaffected.",
  "site.security.ai.controls.autonomy":
    "<strong>Autonomy is opt-in and off by default.</strong> The AI takes no action on your behalf unless you explicitly enable it, and even then only within the floor you set and always vetoably.",
  "site.security.ai.controls.kill":
    "<strong>A global kill switch.</strong> Operators can disable the entire AI subsystem instantly; when it's off, every AI surface simply goes quiet and the rest of the product works exactly as before.",

  "site.security.ai.model.title": "The model and your privacy",
  "site.security.ai.model.body":
    "The assistant and briefings are generated by a large language model (Google Gemini). We never send it your plaintext content, and we never log raw prompts or model output — the audit entry for an AI action records a salted hash and token counts, not the words. If the model is ever unavailable or the request would exceed a cost budget, the AI surfaces degrade to an empty state rather than blocking anything you need to do.",
  "site.security.ai.report":
    "Found a way the AI could exceed these limits? That is exactly the kind of finding our <disclosure>coordinated disclosure policy</disclosure> is for.",

  // ── Coordinated disclosure (/security/disclosure) ────────────────────────
  "site.security.disclosure.eyebrow": "security",
  "site.security.disclosure.title": "Coordinated disclosure policy",
  "site.security.disclosure.lede":
    "We are grateful to security researchers who take the time to find and report vulnerabilities responsibly. This policy explains how to reach us, what we ask of you, and what you can expect in return. It is written in good faith by a small team — it is a commitment to cooperate, not a bug-bounty contract.",
  "site.security.disclosure.how.title": "How to report",
  "site.security.disclosure.how.body":
    "Email <email>{{email}}</email> with enough detail to reproduce the issue: affected component or URL, steps, impact, and any proof-of-concept. If you want to encrypt your report, ask us for a current public key in your first message. One clear report beats a flood of automated scanner output.",
  "site.security.disclosure.ask.title": "What we ask of you",
  "site.security.disclosure.ask.window":
    "Give us a reasonable window to investigate and fix before any public disclosure.",
  "site.security.disclosure.ask.scope":
    "Don't access, modify, or exfiltrate data that isn't yours, and don't run attacks that degrade service for other people (no denial-of-service, no spam, no social engineering of our team or users).",
  "site.security.disclosure.ask.testAccounts":
    "Use only test accounts you control, and stop as soon as you confirm a vulnerability.",
  "site.security.disclosure.ask.minimum":
    "Don't exploit the issue beyond the minimum needed to demonstrate it.",
  "site.security.disclosure.expect.title": "What you can expect from us",
  "site.security.disclosure.expect.ack":
    "An acknowledgment within {{days}} business days that a human has your report.",
  "site.security.disclosure.expect.assessment":
    "An honest assessment of severity and a realistic timeline to remediation.",
  "site.security.disclosure.expect.updates":
    "Regular updates while we work, and notice when the fix ships.",
  "site.security.disclosure.expect.credit":
    "Credit for your finding if you would like it (and discretion if you would not). Acting in good faith under this policy, we will not pursue legal action against you.",
  "site.security.disclosure.scope.title": "Scope",
  "site.security.disclosure.scope.body":
    "In scope: the Truecairn web application and its API. Out of scope: findings that require a compromised end-user device, reports about the soundness of standard cryptographic primitives themselves, volumetric denial-of-service, and best-practice suggestions with no demonstrable security impact. When in doubt, send it — we would rather triage a borderline report than miss a real one.",
  // ── Known limits (/security/limits) — D9, 2026-08-13 ─────────────────────
  //
  // THE NARROWEST EDITING RULES ON THE SITE, and they bind translations exactly
  // as they bind the English. The page's whole value is that it does not hedge:
  //
  //   1. EVERY LINE IS SOURCED to docs/38-release-readiness.md §5, the repo's
  //      only status source. If docs/38 and this page disagree, docs/38 wins.
  //      Do not add a limit here docs/38 does not carry, or drop one it lists.
  //   2. THE S1/S2-vs-S3 SENTENCE MUST NOT BE SMOOTHED. It is pinned by a test
  //      (tests/public-pages.test.tsx) because it is the most important claim
  //      on the page and exactly the kind of awkward asymmetry a well-meaning
  //      copy edit rounds off into "we verify contact keys". Both halves have
  //      to survive translation: the dependency AND the S3 exception. Either
  //      alone is misleading — the first without the second implies S3 is
  //      equally exposed, the second without the first reads as reassurance.
  //   3. NARROWED IS NOT CLOSED. Where a limit says it has been narrowed, the
  //      remaining gap is stated in the same breath. Keep both clauses.
  //
  // The failure mode here is never a crash. It is a fluent, well-written page
  // that no longer discloses anything.
  "site.security.limits.eyebrow": "security",
  "site.security.limits.title": "Known limits",
  "site.security.limits.lede":
    "Everything on this page is something we do not protect against, have not built, or have never tested. We publish it because a security page that lists only strengths is a marketing page, and because you cannot judge whether this product is right for you from the half we are proud of.",
  "site.security.limits.notBroken":
    "This is not a list of things we believe are broken. It is a list of things nobody has evidence about — which is a different and more useful claim.",

  "site.security.limits.safetyNumber.title": "The safety-number call is unenforceable",
  "site.security.limits.safetyNumber.what":
    "When you give a trusted contact a share of your release key, we ask you to confirm a <strong>safety number</strong> with them out of band — over a phone call or in person, not through us. That is what stops anyone with access to our database from substituting their own key for your contact's and receiving a share intended for someone else.",
  "site.security.limits.safetyNumber.unenforceable":
    "<strong>It only works if you actually make the call, and nothing in the system can tell whether you did.</strong> The button records what you say you confirmed. An owner who clicks it without phoning anyone is indistinguishable, to us, from one who read the digits aloud and checked every group. <strong>Your S1 and S2 protection against key substitution depends on that call. S3 does not</strong> — an S3 release additionally requires your offline release passphrase, which is a factor our servers structurally cannot hold, so substituting a contact key does not open an S3 vault.",
  "site.security.limits.safetyNumber.narrowed":
    "Narrowed, but not closed: since August 2026, an owner who has never confirmed a contact at all is shown a warning rather than left at a silent dead end. The unverifiable half — whether the confirmation you recorded reflects a call you made — is unchanged, and we will not present it as solved.",

  "site.security.limits.noHumanRelease.title": "No release has ever been completed by a human",
  "site.security.limits.noHumanRelease.mechanism":
    "Our automated tests drive a full release end to end: an account goes quiet, the engine escalates through every rung of the ladder, a ceremony opens, contacts affirm, and the vault is released — with the complete audit sequence behind it. That proves the <em>mechanism</em>.",
  "site.security.limits.noHumanRelease.people":
    "<strong>That real people can complete a release under pressure is a different claim, and it is what our recovery drills are for. They have not yet run.</strong> Nobody has sat down as a grieving trusted contact, with our instructions in front of them, and got a vault open.",

  "site.security.limits.mobile.title": "The mobile app is not distributed",
  "site.security.limits.mobile.body":
    "There is no Truecairn app in any app store. An Android build exists and has been installed and launched on a real device, but everything behind the sign-in screen is untested, and passkey sign-in on Android is deliberately disabled until a release signing identity exists. Treat the phone app as unavailable when deciding whether this product fits you.",

  "site.security.limits.singleRegion.title": "One region, one replica, one database",
  "site.security.limits.singleRegion.body":
    "We run a single application instance and a single Postgres database in one region. There is no failover. Our 2026-08-10 restore drill measured recovery at roughly <strong>50 minutes</strong> to a working stack, and the recovery point — how much you could lose — at <strong>up to 24 hours</strong>. That 24 hours is set by file attachments, which are backed up by daily volume snapshots rather than continuously; the database itself is about five minutes. The worst case is the one to plan around.",

  "site.security.limits.noLoadTest.title": "No load or performance testing of any kind",
  "site.security.limits.noLoadTest.body":
    "None has been done. That is defensible only because we are deliberately ramping the number of accounts slowly — the ramp is why it is not yet a problem, and it is also the reason the ramp exists. Both halves of that sentence are true and we would rather state them together.",

  "site.security.limits.noAudit.title": "No third-party audit, and no certifications",
  "site.security.limits.noAudit.body":
    "No independent security firm has reviewed this system, and we hold no certifications — no SOC 2, no ISO 27001, nothing. The cryptographic design is documented and the client is open source and reproducibly buildable so that you do not have to take our word for it, but that is an invitation to check, not a substitute for someone having checked.",

  "site.security.limits.noDefence.title": "What we do not defend against at all",
  "site.security.limits.noDefence.lede":
    "Stated plainly, because each of these has caught someone out somewhere:",
  "site.security.limits.noDefence.ownSecrets":
    "<strong>Losing your own secrets.</strong> If you lose your passphrase and your recovery code, your vault is gone. We cannot reset it — that is the design working, not failing.",
  "site.security.limits.noDefence.coercion":
    "<strong>Coercion.</strong> If someone can compel you to unlock, encryption does not help you.",
  "site.security.limits.noDefence.device":
    "<strong>A compromised device.</strong> Everything is encrypted in your browser, so an attacker already on your machine sees what you see.",
  "site.security.limits.noDefence.metadata":
    "<strong>Metadata.</strong> We cannot read your vault, but we can see that you have one, how many items it holds, when you check in, and who your contacts are.",
  "site.security.limits.noDefence.state":
    "<strong>A state-level adversary targeting you personally.</strong> We are not built for that, and saying otherwise would be dishonest.",
  "site.security.limits.noDefence.contacts":
    "<strong>Your contacts being unavailable.</strong> If the people you nominated cannot or will not act, no release happens.",
  "site.security.limits.noDefence.falseRelease":
    "<strong>A rare but legitimate false release.</strong> If you go silent in a way that looks exactly like the thing this product watches for, and your contacts agree, your vault opens. Every rung of the ladder is reversible by you, but only if you are there to reverse it.",
  "site.security.limits.noDefence.notExecutor":
    "We also cannot give you legal authority over anyone's estate. Truecairn moves information to people you chose; it does not make them your executor.",

  "site.security.limits.elsewhere.title": "Where else to look",
  "site.security.limits.elsewhere.body":
    "Our <threat>threat model</threat> sets out the adversaries the system is designed against in full. Our <winddown>wind-down playbook</winddown> separates what we commit to if the service shuts down from what our architecture permits but we have not built. Live component status and our measured availability are on the <status>status page</status> — and that availability figure is measured from August 8, 2026, not from the day we launched, because an earlier broken health check recorded its own fault as nine days of downtime and we would rather publish a short honest window than a long misleading one.",
  // ── Company family: the sub-navigation ───────────────────────────────────
  "site.company.pill.about": "About",
  "site.company.pill.contact": "Contact",
  "site.company.pill.press": "Press",
  "site.company.pill.status": "Status",

  // ── About (/company/about) ───────────────────────────────────────────────
  "site.company.about.eyebrow": "company",
  "site.company.about.title": "About Truecairn",
  "site.company.about.p1":
    "Truecairn is a calm, deliberate system for the parts of your digital life that should outlast you. You encrypt what matters on your own device; if you go silent, a continuity engine escalates through check-ins, and people you chose reconstruct access through consensus — under rules you wrote, reversible at every step.",
  "site.company.about.p2":
    "We started from a simple, uncomfortable premise: the most important information in your life lives in places only you can reach, and none of it transfers automatically. Estate planning treats that as paperwork. We treat it as an engineering problem — and we engineer for the day we cannot help you, because that is exactly when the design has to hold.",
  "site.company.about.p3":
    "The principle we will not compromise is zero knowledge: we cannot read your vault, and we cannot recover your passphrase. That is the point. You can read precisely how it works in the <model>security model</model> and what we do and don't defend against in the <threat>threat model</threat>.",

  // ── Contact (/company/contact) ───────────────────────────────────────────
  "site.company.contact.eyebrow": "company",
  "site.company.contact.title": "Contact us",
  "site.company.contact.lede":
    "We are a small team and we read everything. Email is the fastest way to reach us — there is no contact form to disappear into.",
  "site.company.contact.general": "<strong>General and support</strong> — <email>{{email}}</email>",
  "site.company.contact.security":
    "<strong>Security reports</strong> — <email>{{email}}</email> (see our <disclosure>disclosure policy</disclosure>)",
  "site.company.contact.press": "<strong>Press</strong> — see <press>press</press>",
  // Said sincerely, and it is the one line on this page that protects someone.
  // A translation that turns it into boilerplate politeness loses the warning.
  "site.company.contact.neverEmail":
    "A reminder we mean sincerely: never email us a passphrase, recovery code, or anything from inside your vault. We can't use it, and we don't want to hold it.",

  // ── Press (/company/press) ───────────────────────────────────────────────
  //
  // THE BOILERPLATE IS APPROVED COPY A JOURNALIST QUOTES VERBATIM, and it is
  // also the on-page text, so what they copy is what they read — there is no
  // second, rosier version. Translating it produces a second quotable text, so
  // the Spanish must carry exactly the same claims: the server can never
  // decrypt, and Truecairn cannot read a vault or reset a passphrase.
  //
  // The word counts in the boilerplate meta labels are counts of the ENGLISH.
  // They are kept as an interpolated number so a translation can state its own.
  "site.company.press.eyebrow": "company",
  "site.company.press.title": "Press",
  "site.company.press.boilerplateShort":
    "Truecairn is a zero-knowledge digital continuity platform: owners encrypt their most important information on their own devices, and people they chose can reconstruct access through consensus if they go silent.",
  "site.company.press.boilerplateLong":
    "Truecairn is a zero-knowledge digital continuity platform for the parts of a person's digital life that should outlast them. Owners encrypt credentials, documents and instructions on their own devices; a continuity engine escalates through check-ins if they go silent; and trusted contacts they nominated reconstruct access through consensus ceremonies, under rules the owner wrote and reversible at every step. The server holds only ciphertext and sealed boxes and can never decrypt them — Truecairn cannot read a vault or reset a passphrase.",
  "site.company.press.lede":
    "Everything a journalist needs to write about Truecairn accurately, and nothing we cannot back up. We have no coverage to point to yet and no funding to announce — this page is the assets, the facts, and a direct line to the small team who can answer for them.",
  "site.company.press.brandAssetsCta": "Brand assets",
  "site.company.press.oneAddress":
    "One address, read by the people who build this. There is no press office to route around.",
  "site.company.press.story.title": "What Truecairn is",
  "site.company.press.story.p1":
    "Truecairn is a zero-knowledge digital continuity platform. Owners encrypt what matters on their own devices; if they go silent, a continuity engine escalates through check-ins, and trusted contacts they chose reconstruct access through consensus ceremonies — under rules the owner wrote, reversible at every step. The server stores only ciphertext and sealed boxes and can never decrypt.",
  "site.company.press.story.p2":
    "The premise we started from is uncomfortable: the most important information in your life lives in places only you can reach, and none of it transfers automatically. Estate planning treats that as paperwork. We treat it as an engineering problem — and we engineer for the day we cannot help you, because that is exactly when the design has to hold.",
  "site.company.press.quotable":
    "The one line worth quoting, because it is the whole product: <strong>we cannot read your vault, and we cannot reset your passphrase.</strong> Any story that describes us as able to recover an owner's data on request has described a different company.",
  "site.company.press.boilerplate.title": "Boilerplate",
  "site.company.press.boilerplate.lede": "Approved copy — use it verbatim, no clearance needed.",
  "site.company.press.boilerplate.shortMeta": "One sentence · {{words}} words",
  "site.company.press.boilerplate.longMeta": "Full paragraph · {{words}} words",
  "site.company.press.boilerplate.shortLabel": "the one-sentence boilerplate",
  "site.company.press.boilerplate.longLabel": "the full-paragraph boilerplate",
  "site.company.press.copy": "Copy",
  "site.company.press.copied": "Copied",
  // Not "Copy failed". The text is on the page in full either way, so the
  // button says what to do instead of what went wrong.
  "site.company.press.copyFailed": "Select it instead",
  "site.company.press.copyAria": "Copy {{label}}",

  "site.company.press.facts.title": "Fact sheet",
  // THIS TABLE VOLUNTEERS ITS OWN ABSENCES — "Nothing announced", "No
  // third-party audit published", "no company has been incorporated". Two rows
  // here (a legal name and offices in two cities) were false until 2026-08-13
  // and were removed. A journalist who trusts the awkward rows is trusting them
  // because rows like these are here; softening any of them in translation
  // removes the reason the rest is credible.
  "site.company.press.facts.operatedBy.k": "Operated by",
  "site.company.press.facts.operatedBy.v":
    "An individual operator; no company has been incorporated",
  "site.company.press.facts.whatItIs.k": "What it is",
  "site.company.press.facts.whatItIs.v": "Zero-knowledge digital continuity platform",
  "site.company.press.facts.licence.k": "Licence",
  "site.company.press.facts.licence.v": "Apache 2.0; client and release worker source published",
  "site.company.press.facts.status.k": "Status",
  "site.company.press.facts.status.v":
    "V1 core shipped: encrypted vault, trusted-contact enrolment, inactivity engine, and release ceremonies end to end",
  "site.company.press.facts.funding.k": "Funding",
  "site.company.press.facts.funding.v": "Nothing announced",
  "site.company.press.facts.audit.k": "Independent audit",
  "site.company.press.facts.audit.v":
    "No third-party audit published and no security certifications held",
  "site.company.press.facts.contact.k": "Contact",
  "site.company.press.facts.codename":
    "Truecairn is a working codename; the final product name is not yet decided. If you are writing on a timeline where that matters, ask us first.",

  "site.company.press.assets.title": "Brand assets",
  "site.company.press.assets.lede":
    "The cairn mark and wordmark. Please use the mark as supplied — do not recolour it, rotate it, add effects, or set the wordmark in another face. The wordmark is Poppins SemiBold, written <strong>TrueCairn</strong>, with the “ai” in its own blue (<code>#002FD7</code> — deeper than our UI accent, and listed separately below for that reason): a nod to the <ai>AI guardian</ai>, and the only permitted colour break in the word. On dark backgrounds the “ai” takes the soft companion <code>#9DAAFF</code> instead, because <code>#002FD7</code> on ink is unreadable.",
  "site.company.press.marks.full.name": "Mark — full colour",
  "site.company.press.marks.full.note": "light backgrounds",
  "site.company.press.marks.inverse.name": "Mark — inverse",
  "site.company.press.marks.inverse.note": "dark backgrounds",
  "site.company.press.marks.mono.name": "Mark — monochrome",
  "site.company.press.marks.mono.note": "one-colour print",
  "site.company.press.marks.icon.name": "App icon",
  "site.company.press.marks.icon.note": "squared, rounded",
  "site.company.press.downloadSvg": "Download SVG",
  "site.company.press.downloadPng": "Download PNG",
  "site.company.press.colour.title": "Colour and type",
  "site.company.press.swatch.accent": "Accent",
  "site.company.press.swatch.accentHover": "Accent hover",
  "site.company.press.swatch.wordmarkAi": "Wordmark “ai”",
  "site.company.press.swatch.ink": "Ink",
  "site.company.press.swatch.sheet": "Sheet",
  "site.company.press.type":
    "<strong>Poppins SemiBold</strong> sets the wordmark and display type; <strong>Inter</strong> sets body text. Both are open-licensed and available from Google Fonts, so you do not need anything from us to typeset a headline correctly.",

  "site.company.press.shots.title": "Product screenshots",
  "site.company.press.shots.lede":
    "Real interface captures, free to publish with a Truecairn credit. Every value shown in them is demonstration data — no customer's vault, contacts or plan appears in any asset we hand out, and we could not produce one if we wanted to.",
  "site.company.press.shots.dashboard": "Continuity dashboard",
  "site.company.press.shots.vault": "The vault",
  "site.company.press.shots.ceremony": "Release ceremony",

  "site.company.press.claims.title": "What we will and won't claim",
  "site.company.press.claims.lede":
    "We would rather be a boring interview than a corrected one. So that you do not have to guess which of our statements are load-bearing:",
  "site.company.press.claims.willSay":
    "<strong>We will say</strong> that the server cannot decrypt a vault, and point you at the <model>security model</model>, the published <threat>threat model</threat> including what we do <em>not</em> defend against, and the per-release <build>build fingerprint</build> that lets anyone check the code we serve.",
  "site.company.press.claims.willNotSay":
    "<strong>We will not say</strong> that we are unbreakable, or that any system is. The threat model names the attacks that beat us and the residual risk we accept.",
  "site.company.press.claims.noCustomers":
    "<strong>We have no customers to parade.</strong> No logos, no testimonials, no user counts — not as modesty, but because publishing who trusts us with their continuity plan would itself be a disclosure.",
  "site.company.press.claims.noAudit":
    "<strong>We have not published a third-party security audit, and we hold no security certifications</strong> — no SOC 2, no ISO 27001. When an independent review is completed and we are able to publish it, it will appear on the <audits>security pages</audits> before it appears here.",
  "site.company.press.claims.noCoverage":
    "<strong>No coverage and no funding announcements to date.</strong> Anything that appears here later will be a link to the outlet, not a summary written by us.",

  "site.company.press.reach.title": "Reaching us",
  "site.company.press.reach.press":
    "<strong>Press, interviews, and everything else</strong> — <email>{{email}}</email>",
  "site.company.press.reach.security":
    "<strong>Security reports</strong> — <email>{{email}}</email>, under our <disclosure>coordinated disclosure policy</disclosure>",
  "site.company.press.reach.deadline":
    "If you are on deadline, say so in the subject line and we will treat it that way. We will go on the record about the architecture, the threat model and what we have not built yet; we will not speculate about competitors, and we cannot discuss any individual account, because we have nothing to discuss.",
  // ── Service status (/status) ─────────────────────────────────────────────
  //
  // THE PROSE LIVES HERE, NOT ON THE SERVER. GET /v1/status sends ids, enums
  // and integers and no sentences at all, deliberately: every detail string the
  // INTERNAL dashboard composes is interpolated from a live count ("3
  // delivery(s) dead-lettered", the active KEK id), and none of that is public.
  // So each watched component below carries its own explanation, matched to a
  // live state by id. A check added to packages/ops does not become public
  // until someone writes its entry — and an id with no entry renders with its
  // server-supplied label and no prose, never silently disappears.
  //
  // The page's honesty rules, which bind translations: "unknown" is never
  // described as a degree of working, a missing sample counts AGAINST
  // availability rather than being skipped, and the backups dot reports a
  // verified restore rather than a snapshot count.
  "site.status.eyebrow": "company",
  "site.status.title": "Service status",
  // The first thing on the page, and the thing worth knowing before anything
  // else: downtime is not a release trigger. Keep it first and keep it flat.
  "site.status.headline.title": "An outage cannot release your vault",
  "site.status.headline.body":
    "This is the thing worth knowing before anything else on this page. A temporary service interruption does not trigger a release. The continuity engine is server-authoritative and errs toward <em>“still here”</em>: it only ever advances on evidence, never on the absence of a working system. Long cooldowns and a revocation window sit between every step, so downtime cannot quietly advance a ceremony while you are unable to reach us.",
  "site.status.checking": "Checking…",
  // The one-line verdict, written as a lookup rather than assembled from
  // fragments so each state reads like a sentence a person wrote — and so
  // 'unknown' gets its own wording instead of being described as a degree of
  // working. Translate them as four separate sentences, not one template.
  "site.status.verdict.ok": "A release ceremony could complete right now",
  "site.status.verdict.degraded": "Working, but not fully — details below",
  "site.status.verdict.down": "Part of the release path is failing",
  "site.status.verdict.unknown": "We cannot currently confirm the release path",
  "site.status.verdict.unavailable": "Status unavailable — we could not reach the API",
  "site.status.live.sub":
    "One question, asked continuously: <strong>could a release ceremony complete right now?</strong> The verdict is the conjunction of the release-critical checks below and nothing else — for a product that acts on behalf of someone who cannot complain, “the website is up” is nearly worthless.",
  "site.status.live.stale":
    "This reading is the last one we could load; the most recent refresh failed.",

  "site.status.watched.title": "What we monitor",
  "site.status.watched.lede":
    "Each component below is checked by <em>doing</em> the thing rather than by confirming a setting exists — the release gate is verified with a real wrap-and-unwrap round-trip on the live key, not by noting that a key is configured. The dot is the current state; the release-critical ones are the only inputs to the verdict above.",
  "site.status.tag.critical": "Release-critical",
  "site.status.tag.supporting": "Supporting",
  "site.status.dotAria": "{{name}}: {{state}}",
  "site.status.watch.worker.name": "Release worker — the continuity engine",
  "site.status.watch.worker.detail":
    "The process that notices silence and drives every ceremony forward. Watched by an in-database heartbeat that proves each tick completed, plus an external service that alerts a human when a ping fails to arrive. A worker that is alive but wedged mid-tick reports as failing, not healthy.",
  "site.status.watch.database.name": "Database",
  "site.status.watch.database.detail":
    "The durable store for ciphertext, sealed boxes and engine state. Reachability is checked continuously; nothing about a release can proceed without it, so a failure here fails closed rather than guessing.",
  "site.status.watch.outerLayerKek.name": "Outer-layer key — the release gate",
  "site.status.watch.outerLayerKek.detail":
    "The one cryptographic power the server holds. Verified by actually opening a key this deployment has stored — not by checking that a setting is present, and not by sealing something and immediately opening it again. That second test is the one worth naming: any valid-looking key passes it, so it would have proved the key worked without proving it was the right one, and the wrong key would have looked healthy here until the last step of someone’s ceremony.",
  "site.status.watch.crypto.name": "Cryptography",
  "site.status.watch.crypto.detail":
    "Whether the crypto library actually initialised in this process. If it did not, every operation that touches a key would throw — so it is checked as its own condition rather than assumed from a successful boot.",
  "site.status.watch.auditSigning.name": "Audit signing",
  "site.status.watch.auditSigning.detail":
    "Every significant action lands in a tamper-evident hash-linked chain, and the append rides the same transaction as the change it records. So an unavailable signer does not merely lose the record — it rolls the change back. That is why this is release-critical.",
  "site.status.watch.notifications.name": "Notification delivery",
  "site.status.watch.notifications.detail":
    "Whether anyone could actually be reached — configured providers, queue depth, and messages that exhausted their retries. If every channel to you starts failing, the engine deliberately stops advancing instead of reading a delivery outage as your silence.",
  "site.status.watch.auditChain.name": "Audit chain integrity",
  "site.status.watch.auditChain.detail":
    "The chains are re-verified continuously in the background, and you can recompute your own in your browser from Settings. Deliberately NOT release-critical: a broken chain is a forensic emergency, but it does not make a legitimate release unsafe, and treating it as critical would take the whole engine red on every restart.",
  "site.status.watch.backups.name": "Database backups — the restore, not the snapshot",
  "site.status.watch.backups.detail":
    "The snapshots are taken by the hosting platform’s control plane, which this application genuinely cannot see. So this dot deliberately reports something else, and something better: whether a person has actually restored from a backup and decrypted the result, and how long ago. That is the only property anyone wants from a backup, and a snapshot count never proves it — a backup nobody has restored from is a hypothesis. The dot turns amber on its own once that drill goes stale, so it cannot stay green through neglect, and grey means no restore has ever been verified.",
  "site.status.watch.api.name": "API and web app",
  "site.status.watch.api.detail":
    "The parts you touch. A liveness probe and a separate readiness probe that reports not-ready when the database is unreachable, so a half-working deployment is never presented as healthy.",

  "site.status.availability.title": "Measured availability",
  "site.status.availability.lede":
    "The number below is computed from health samples recorded on a clock, not from an incident log written after the fact. That distinction is the whole reason it is worth reading: a status page built from recorded incidents can only ever be as honest as the day someone remembered to write one.",
  "site.status.availability.unreachable": "We could not reach the API to load the current figure.",
  "site.status.availability.loading": "Loading the current figure…",
  // Three honest cases, and the first two are the common ones early on. A
  // placeholder number would defeat the entire point of the series — never
  // translate these into a reassurance that a figure exists.
  "site.status.availability.notStarted":
    "We have not started recording availability on this deployment yet, so there is no figure to publish. There will be one here, and it will only ever cover the period actually measured.",
  "site.status.availability.tooEarly":
    "Measuring since {{since}} — not yet long enough to publish a percentage worth trusting. A number computed from a few hours of evidence would look precise and mean nothing, so we are waiting rather than rounding.",
  // Pluralised whole, not stitched from "day" + "s" — the singular is the only
  // value that reads wrong in English (QA 2026-08-10 F-03) and other languages
  // split the count differently again.
  "site.status.availability.days_one": "{{count}} day",
  "site.status.availability.days_other": "{{count}} days",
  "site.status.availability.figureLabel":
    "of the last {{days}}, the full release path was operational",
  "site.status.availability.measuringSince": "Measuring since {{since}}.",
  "site.status.availability.shortWindow":
    "That is shorter than the {{days}}-day window we intend to report, and the figure covers only what we have actually observed — we do not extrapolate backwards.",
  "site.status.availability.unobserved_one":
    "{{count}} minute in that period recorded no sample at all; it counts <em>against</em> the figure above rather than being skipped, because a monitor that stops writing is usually a system that stopped working.",
  "site.status.availability.unobserved_other":
    "{{count}} minutes in that period recorded no sample at all; each one counts <em>against</em> the figure above rather than being skipped, because a monitor that stops writing is usually a system that stopped working.",
  "site.status.availability.allObserved": "Every minute in that period recorded a sample.",
  "site.status.availability.trustworthy":
    "Two properties make it trustworthy rather than flattering. It counts the <strong>full release path</strong>, so a minute where notifications could not be delivered is not a green minute even though the website was perfectly reachable. And a minute with <strong>no sample at all</strong> counts as unavailable — the sampler runs inside the release worker, so the outage that would erase its own evidence is exactly the one that matters most, and it cannot improve our number by going silent.",

  "site.status.watchdog.title": "The watchdog has a watchdog",
  "site.status.watchdog.lede":
    "The release worker is the safety-critical part: it is the only thing that notices your silence, and it is the one component whose quiet failure nobody would report. So it is monitored twice, in two different ways, on the assumption that either could fail.",
  "site.status.watchdog.inside.label": "Inside",
  "site.status.watchdog.inside.body":
    "Every completed tick writes a liveness record to the database, always on and impossible to switch off by misconfiguration. It proves <strong>ticks</strong>, not that a process exists — which is what catches a worker that is alive but wedged mid-tick, the failure where releases silently stop while every process monitor stays green.",
  "site.status.watchdog.outside.label": "Outside",
  "site.status.watchdog.outside.body":
    "An external heartbeat service expects a ping on a schedule and alerts us when one fails to arrive. It runs on infrastructure that is not ours, so the alarm does not depend on the thing it is watching — including the case where our whole deployment is gone.",
  "site.status.watchdog.durability":
    "<strong>Durability beats uptime here.</strong> The engine works on timescales of days and weeks, not seconds. An hour where the app will not load is an inconvenience; a lost sealed box, or a worker that stopped ticking three weeks ago without anyone noticing, is the unforgivable failure. Our monitoring is weighted accordingly, and so is where we spend engineering time.",

  "site.status.unknown.title": "Why you will never see a green tile we did not earn",
  "site.status.unknown.lede":
    "The dots on this page have four states, and the fourth one is the reason the other three are worth anything. Anything we cannot actually observe reports as unknown rather than green — and unknown is ranked worse than ok, so it never quietly disappears into a healthy total, in the verdict at the top or in the availability figure above.",
  // The four state names double as the legend AND as the spoken state in each
  // dot's aria-label, so they are looked up from one key in both places: a
  // legend whose words do not match what a screen reader says is worse than an
  // untranslated one.
  "site.status.state.ok.label": "ok",
  "site.status.state.ok.meaning": "checked, working",
  "site.status.state.degraded.label": "degraded",
  "site.status.state.degraded.meaning": "working, not well",
  "site.status.state.down.label": "down",
  "site.status.state.down.meaning": "checked, failing",
  "site.status.state.unknown.label": "unknown",
  "site.status.state.unknown.meaning": "nothing observed it",
  "site.status.unknown.twoThings": "Two things we would rather name than round up:",
  // The straight apostrophe in "platform's" is what this page ships (the JSX
  // wrote &apos;), while site.status.watch.backups.detail above ships a curly
  // one because it was already a JS string literal. Preserved rather than
  // normalised: extraction moves copy, and evening the two out is a rendered
  // change someone should make on purpose, not as a side effect of this one.
  "site.status.unknown.backups":
    "<strong>Database backups are attested, not probed.</strong> The snapshots live in the hosting platform's control plane, which this application cannot see, so a green dot there does not mean “a backup ran last night”. It means a person restored from one, decrypted the result and recorded the date. We publish that instead of the thing we cannot check — and because a date can go stale, the dot expires by itself and turns amber rather than sitting green forever.",
  "site.status.unknown.attachments":
    "<strong>Encrypted attachment storage.</strong> Object storage holding encrypted attachments — unreadable to us and to the provider. Its availability is not separately instrumented yet, so it has no dot at all; a failure would surface as an upload or download error, not as an alarm.",
  "site.status.unknown.publishesLess":
    "A dashboard that guesses in your favour is worse than no dashboard. That is why this page publishes less than our internal one rather than more: you are seeing component states and a measured figure, not queue depths, version numbers or an incident feed, because those are operational detail you cannot act on and a map of when we are least able to respond.",

  "site.status.outage.title": "If something looks wrong",
  "site.status.outage.lede":
    "Email <email>{{email}}</email> and we will respond as quickly as we can. It genuinely helps if you include what you were doing, roughly when, and the exact error text — but send it even if you have none of that.",
  "site.status.outage.lockedOut":
    "<strong>You are locked out and worried the clock is running.</strong> It is not running against you: the engine needs positive evidence to advance. A check-in from any device resets it, and if a release has already started, opening your vault pauses it and offers a one-tap confirmation that stops it outright.",
  "site.status.outage.unexpectedPrompt":
    "<strong>You got a check-in prompt you did not expect.</strong> That is the engine doing its job early and loudly, not a release. Confirm you are here and it stops.",
  // The 30-day clause is the one a reader must not lose: sustained
  // unreachability EVENTUALLY becomes evidence. Both halves stay — that it
  // resumes, and that it is not a shortcut to release.
  "site.status.outage.channelsFailing":
    "<strong>Your channels are all failing.</strong> The engine pauses rather than reading a delivery outage as your silence — but not forever: after 30 days sustained unreachability is itself treated as evidence and the ladder resumes at the escalation step. That is not a shortcut to release. One working channel and one tap stops everything, the full escalation delay still has to pass, and your contacts still have to reach agreement.",
  "site.status.outage.securityProblem":
    "<strong>You suspect a security problem</strong> rather than an outage — that goes to <email>{{email}}</email> under our <disclosure>disclosure policy</disclosure>, which commits to a first response window.",
  "site.status.outage.midCeremony":
    "<strong>You are a trusted contact mid-ceremony</strong> and something failed. Say so in the subject line and tell us roughly when: every step of a ceremony is recorded in the audit trail, so we can tell you exactly where it stopped.",

  "site.status.planned.title": "Planned work and what we publish",
  "site.status.planned.body":
    "We do not take scheduled downtime windows on a product like this if we can avoid them, and to date we have not needed one. When we do, it will be announced here and by email to owners first, never discovered.",
  "site.status.planned.changelog":
    "Every user-visible change we ship — including security and reliability work, which we write up as plainly as features — lands in the <changelog>changelog</changelog> in the same change-set that ships it. If you want to know what moved and when, that is the honest record; this page is only about whether it is working now. You can also check the exact fingerprint of the app your browser is running on the <build>build provenance</build> page.",
} as const;

export type PagesMessageKey = keyof typeof pagesEn;
