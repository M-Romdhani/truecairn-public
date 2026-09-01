// The SITE catalog — the public pages, plus the few strings both halves need.
//
// LOADED EAGERLY, because the landing is the first thing an anonymous visitor
// renders and it must not wait on a fetch. That is also why the split exists:
// before it, the landing bundle would have carried every product-UI key to
// render copy it never shows. Anything only a signed-in screen says belongs in
// ../app/en.ts, behind the same lazy boundary that keeps libsodium off the
// landing.
//
// Same conventions as the app catalog: flat dotted keys (i18next's '.' nesting
// is off), keys named for the PLACE rather than the words, and `_one`/`_other`
// pairs for plurals — see ../../useT.ts on why plural bases are derived rather
// than hand-listed.
export const siteEn = {
  // Shared by both halves. The language picker renders on the public pages AND
  // on the auth screens, so its label has to live in the always-loaded catalog.
  'settings.language.label': 'Language',


  // ── Shared public chrome: header, footer, back link ───────────────────────
  'site.chrome.skipToContent': 'Skip to main content',
  'site.chrome.signIn': 'Sign in',
  'site.chrome.getStarted': 'Get started',
  'site.chrome.backHome': 'Back to home',
  'site.chrome.lastUpdated': 'Last updated {{date}}',
  'site.chrome.pillsLabel': '{{section}} pages',

  'site.footer.tagline':
    'Continuity for your digital life. Encrypted on your device. Released by people you choose, under rules you write.',
  'site.footer.product': 'Product',
  'site.footer.vault': 'Vault',
  'site.footer.contacts': 'Trusted contacts',
  'site.footer.plans': 'Continuity plans',
  'site.footer.ceremony': 'Release ceremony',
  'site.footer.guide': 'User guide',
  'site.footer.changelog': 'Changelog',
  'site.footer.security': 'Security',
  'site.footer.securityModel': 'Security model',
  'site.footer.threatModel': 'Threat model',
  'site.footer.ai': 'How we use AI',
  'site.footer.reviews': 'Independent reviews',
  'site.footer.build': 'Build provenance',
  'site.footer.limits': 'Known limits',
  'site.footer.source': 'Source code',
  'site.footer.disclosure': 'Disclosure policy',
  'site.footer.company': 'Company',
  'site.footer.about': 'About',
  'site.footer.contact': 'Contact',
  'site.footer.press': 'Press',
  'site.footer.status': 'Status',
  'site.footer.legal': 'Legal',
  'site.footer.privacy': 'Privacy',
  'site.footer.terms': 'Terms',
  'site.footer.dpa': 'DPA',
  'site.footer.subProcessors': 'Sub-processors',
  'site.footer.windDown': 'Wind-down playbook',
  // The licence line. "Truecairn Contributors" and Apache-2.0 are FACTS about a
  // published licence, not marketing — the previous version claimed a company
  // that does not exist and reserved rights already granted. A translation must
  // not reintroduce either: keep the licence name untranslated (it is a proper
  // noun with legal meaning) and claim no entity.
  'site.footer.licence': '© 2026 Truecairn. Distributed under the <licence>Apache 2.0 License</licence>.',


  // ── Landing (marketing) ───────────────────────────────────────────────────
  // The first page anyone meets and the one bearing the security claims. Every
  // number and every "we cannot" here is also stated on /security and in the
  // threat model; a translation that strengthens one of them makes the pages
  // disagree, and the weaker page is the true one.
  'site.landing.nav.product': 'Product',
  'site.landing.nav.security': 'Security',
  'site.landing.nav.useCases': 'Use cases',
  'site.landing.nav.pricing': 'Pricing',
  'site.landing.nav.faq': 'FAQ',
  'site.landing.nav.openMenu': 'Open menu',

  'site.landing.hero.eyebrow': 'Built for privacy. Designed for continuity.',
  'site.landing.hero.title': 'Digital continuity for your most important information.',
  // The second sentence is the one that SHIPS, verbatim. An earlier draft of this
  // catalog carried 'Security you can verify, continuity you can rely on.' — a
  // better sentence, and not the one on the page. Extraction moves copy; it does
  // not rewrite it, or the English assertions stop being evidence that the
  // refactor changed nothing. Caught by diffing the prerendered text before and
  // after, which is the only thing that could have caught it.
  'site.landing.hero.lede':
    'Create encrypted vaults that remain under your control until predefined conditions are met. Secure, private, and built around a zero-knowledge architecture.',
  'site.landing.hero.ctaPrimary': 'Get started — free',
  'site.landing.hero.ctaSecondary': 'Read the security model',
  'site.landing.hero.badge.encrypted': 'End-to-end encrypted · XChaCha20-Poly1305',
  'site.landing.hero.badge.zeroKnowledge': 'Zero-knowledge — we hold no key to your vault',
  'site.landing.hero.badge.revocation': '48-hour revocation window on every release',

  // Photo descriptions, read aloud instead of the image. They describe what is
  // IN the picture, not what the section argues — a translator who rewrites
  // them into marketing copy leaves a screen-reader user with a slogan where
  // everyone else sees a photograph.
  'site.landing.problem.photoAlt':
    'A closed notebook with a pen and a cup of coffee on a desk at night, city lights out the window.',
  'site.landing.problem.eyebrow': 'the problem',
  'site.landing.problem.title': 'When you go silent, what happens to what matters?',
  'site.landing.problem.founder.role': 'a founder',
  "site.landing.problem.founder.title": "The team can't run payroll",
  'site.landing.problem.crypto.role': 'a crypto holder',
  'site.landing.problem.crypto.title': 'The phrase is in a notebook',
  'site.landing.problem.freelancer.role': 'a freelancer',
  "site.landing.problem.freelancer.title": "The clients don't get a reply",

  'site.landing.product.photoAlt':
    'A hardware security key resting in a dark wooden drawer beside house keys.',
  'site.landing.product.eyebrow': 'the product',
  'site.landing.product.title': 'An engineered system, not an estate planner.',
  'site.landing.product.vault.eyebrow': 'the vault',
  'site.landing.product.vault.title': 'Items, organized by sensitivity',
  'site.landing.product.contacts.eyebrow': 'trusted contacts',
  'site.landing.product.contacts.title': 'People you choose, verified by signed link',
  'site.landing.product.plans.eyebrow': 'continuity plans',
  'site.landing.product.plans.title': 'What releases, to whom, under what',
  'site.landing.product.ceremony.eyebrow': 'the release ceremony',
  'site.landing.product.ceremony.title': 'Slow, reversible, audited end to end',

  'site.landing.steps.add.title': 'Add what matters',
  'site.landing.steps.add.body':
    'Start with one item from a template. The first plan can be live in 4 minutes.',
  'site.landing.steps.invite.title': 'Invite contacts',
  'site.landing.steps.invite.body':
    'Two is the minimum we recommend. One Personal, one Professional, for diverse consensus.',
  'site.landing.steps.arm.title': 'Arm the switch',
  'site.landing.steps.arm.body':
    'Nothing watches you until you say so. Arming needs at least one enrolled contact.',
  'site.landing.steps.checkIn.title': 'Check in when we ask',
  "site.landing.steps.checkIn.body":
    "One email. One tap. You set the interval — 7 days by default. We don't gamify the streak.",

  'site.landing.security.eyebrow': 'security',
  'site.landing.security.title': 'We engineer for the day we cannot help you.',
  'site.landing.security.claim.zeroKnowledge.label': 'Zero knowledge.',
  'site.landing.security.claim.zeroKnowledge.meta': 'argon2id · 256 MiB · t=4',
  'site.landing.security.claim.encrypted.label':
    'Vault contents are encrypted before they leave your device.',
  'site.landing.security.claim.encrypted.meta': 'XChaCha20-Poly1305',
  'site.landing.security.claim.contacts.label':
    'Trusted contacts prove possession of their keys.',
  'site.landing.security.claim.contacts.meta': 'ed25519 · x25519',
  'site.landing.security.claim.audit.label': 'Every release event is auditable.',
  'site.landing.security.claim.audit.body':
    'Affirmations, withdrawals, disputes, edits, and revocations are appended to a hash-chained log.',
  'site.landing.security.claim.audit.meta': 'hash-chained log',
  'site.landing.security.claim.source.metaUnpublished': 'not yet published',
  'site.landing.security.claim.source.metaPublished': 'reproducible build',
  // "No third-party audit yet" and "no certifications" are the page's most
  // important sentences precisely because they are the ones a marketing
  // translation would soften. They must stay flat statements of absence.
  "site.landing.security.claim.audits.body":
    "<strong>No third-party audit yet, and no certifications</strong> — no SOC 2, no ISO 27001. We would rather say that plainly than point at a report that doesn't exist.",
  'site.landing.security.claim.audits.meta': 'none held',
  'site.landing.security.claim.recovery.label':
    'Server-side recovery is impossible by design.',
  'site.landing.security.claim.recovery.body':
    'We do not have a backdoor. We will not build one. The 7-day edit cooldown and 48-hour release window exist for a reason.',
  'site.landing.security.claim.recovery.meta': 'by design',

  "site.landing.audience.eyebrow": "who it's for",
  'site.landing.audience.title': 'Built for people who already keep their own keys.',
  "site.landing.audience.lede":
    "Truecairn is calibrated for technically literate people who tolerate security friction and want it to feel calm. If you already use 1Password and Proton and a hardware wallet, you'll be home in about ten minutes.",
  'site.landing.audience.whoThisFits': 'who this fits',
  'site.landing.audience.planLabel': 'Continuity plan',
  'site.landing.audience.cooldownLabel': 'Typical cooldown',
  'site.landing.audience.itemsLabel': 'Items in scope',
  'site.landing.audience.founders.title': 'Founders and small teams',
  "site.landing.audience.founders.body":
    "You hold admin on payroll, payments, and infrastructure. A two-week silence shouldn't shut down the company. Write a runbook once, link it to your co-founder and lawyer, and revisit it when the runbook changes.",
  'site.landing.audience.founders.plan': 'Business handover',
  'site.landing.audience.founders.cooldown': '14 days',
  'site.landing.audience.founders.items': 'Stripe · payroll · domain · AWS root',
  'site.landing.audience.crypto.title': 'Crypto holders',
  'site.landing.audience.crypto.body':
    'Self-custody is meaningless if no one can recover the position. Encode wallet locations, derivation paths, and a one-page recovery walkthrough written for someone who has never used a hardware wallet.',
  'site.landing.audience.crypto.plan': 'Crypto recovery',
  'site.landing.audience.crypto.cooldown': '30 days',
  'site.landing.audience.crypto.items': 'Wallet locations · seed instructions · CPA contact',
  'site.landing.audience.freelancers.title': 'Freelancers and consultants',
  'site.landing.audience.freelancers.body':
    'Your business is your inbox. If you go quiet, contracts stall, clients churn, money sits in escrow. A lightweight handover plan keeps the most important relationships moving without you.',
  'site.landing.audience.freelancers.plan': 'Client continuity',
  'site.landing.audience.freelancers.cooldown': '14 days',
  'site.landing.audience.freelancers.items': 'Client list · invoicing · accountant access',
  'site.landing.audience.remote.title': 'Remote professionals',
  "site.landing.audience.remote.body":
    "You live in cloud accounts. Family doesn't know your structure. A small set of plain instructions — where things are, what to read first — is the most consequential single document you can write.",
  'site.landing.audience.remote.plan': 'Family essentials',
  'site.landing.audience.remote.cooldown': '7 days',
  'site.landing.audience.remote.items': 'Accounts · insurance · employer contact',

  'site.landing.pricing.eyebrow': 'pricing',
  'site.landing.pricing.title': 'One plan for what matters most. Free if you only need a few.',
  "site.landing.pricing.lede":
    "Pricing is per-account. Trusted contacts never pay — receiving a release link is always free. Switch tiers any time. We don't gate the release ceremony or the security primitives behind paid tiers.",
  'site.landing.pricing.billingPeriod': 'Billing period',
  'site.landing.pricing.monthly': 'Monthly',
  'site.landing.pricing.yearly': 'Yearly',
  'site.landing.pricing.save': 'Save {{pct}}%',
  'site.landing.pricing.free': 'Free',
  'site.landing.pricing.forever': 'forever',
  'site.landing.pricing.freeBlurb': 'Enough to start. Enough to verify it works for you.',
  'site.landing.pricing.freeCta': 'Create a free account',
  'site.landing.pricing.freeChannels': 'Email & push check-ins',
  'site.landing.pricing.popular': 'Most popular',
  'site.landing.pricing.personal': 'Personal',
  // Prices arrive already formatted with their currency symbol, so the amount
  // stays one opaque token a translator can move but not reformat — writing
  // '${{n}}' into the catalog would put a US dollar sign in every language.
  'site.landing.pricing.perMonthAnnually': '/ month, billed annually',
  'site.landing.pricing.perMonthMonthly': '/ month, billed monthly',
  'site.landing.pricing.annualSubline': '{{amount}} billed once a year — save {{saved}} vs monthly',
  'site.landing.pricing.monthlySubline': '{{amount}} a year — or save {{pct}}% paying yearly',
  'site.landing.pricing.personalBlurb':
    'For an individual taking continuity seriously across business and personal life.',
  'site.landing.pricing.personalCta': 'Start Personal',
  'site.landing.pricing.everythingInFree': 'Everything in Free',
  'site.landing.pricing.unlimited': 'unlimited',
  'site.landing.pricing.trustedContacts': 'Trusted contacts',
  'site.landing.pricing.vaultItems': 'Vault items',
  'site.landing.pricing.attachments': 'Encrypted attachments',
  'site.landing.pricing.releaseTiers': 'Release tiers',
  'site.landing.pricing.sms': 'SMS verification',
  'site.landing.pricing.multichannel': 'Multi-channel continuity checks',

  'site.landing.faq.eyebrow': 'questions',
  'site.landing.faq.title': 'Things people actually ask.',
  'site.landing.faq.passphrase.q': 'What happens if I lose a passphrase?',
  'site.landing.faq.contact.q':
    'What stops a single trusted contact from triggering a release alone?',
  'site.landing.faq.contact.a':
    'You set a per-stage minimum number of affirmations, and you can require those affirmations to come from contacts of different categories — at least one Personal contact and one Professional contact, for example. No single family member or workplace can act on their own. On top of that, every release runs through a 48-hour revocation window during which you, or any affirming contact, can cancel.',
  "site.landing.faq.unreachable.q": "How do you know I'm actually unreachable, and not just on vacation?",
  "site.landing.faq.unreachable.a":
    "We don't, and we shouldn't. Truecairn asks you to check in on an interval you set — 7 days by default — then escalates slowly: a check-in window, then a 14-day cooldown, before contacts are approached at all. Contacts can affirm or dispute, and a dispute halts everything for review. How many affirmations are needed depends on the tier: the least-sensitive stage can be opened by one contact you nominated, while the higher stages need a threshold of contacts from different categories plus your release passphrase. The system errs heavily toward “still here.”",
  'site.landing.faq.read.q': 'Can you read my vault?',
  'site.landing.faq.read.a':
    'No. Your vault is encrypted on your device with XChaCha20-Poly1305 using a key derived via Argon2id from your master passphrase plus a per-account salt. We store only that salt — never the passphrase, never the key, and not a hash we could test guesses against. We hold no security certifications yet and have published no third-party audit; what protects you is the design, which you can read in full in our threat model.',
  'site.landing.faq.cooldown.q': 'Why a 7-day delay on edits to a continuity plan?',
  'site.landing.faq.cooldown.a':
    'Editing release rules is the most consequential action you can take. A 7-day delay gives you (or anyone with momentary access to your account) a window to revert. During the window, the existing plan remains in effect. We default to slowness wherever a faster default would be unsafe.',
  'site.landing.faq.windDown.q': 'What happens if truecairn shuts down?',
  'site.landing.faq.windDown.a':
    'We publish a wind-down playbook with our terms. What we commit to today: advance notice, a read-only window (target 180 days) to export your data, and a signed export of your audit log. The playbook separates those from the things our design permits but we have not built — an offline decryption tool, a bulk or outer-key export, and escrow for ceremonies already underway. Your vault is not locked to us by design, but we would rather you read which parts are built before you rely on them.',

  'site.landing.problem.lede':
    'Most of your important information lives in places only you can reach. The Stripe dashboard. The hardware wallet drawer. The recovery email on your old phone. None of it transfers automatically. Estate planning treats this as paperwork. We treat it as an engineering problem.',
  "site.landing.problem.founder.body":
    "You're admin on Stripe, Gusto, AWS root. You're unreachable for two weeks. Your co-founder watches systems rotate her out. The runway clock keeps running.",
  "site.landing.problem.crypto.body":
    "The hardware wallet is in a drawer. The recovery phrase is in a notebook in a different drawer. No one in your family knows which notebook, or that there's a wallet at all.",
  'site.landing.problem.freelancer.body':
    'Half your invoices are mid-negotiation. Your inbox is a single point of failure. Your accountant has no standing access. Refunds stall. Renewals lapse.',
  'site.landing.product.lede':
    'Four primitives, composed into rules you can edit and revise. Every release runs through a 48-hour revocation window. Every change waits 7 days before it takes effect. Reversibility is a design constraint, not a feature.',
  'site.landing.product.vault.body':
    'Add items from templates: business handover, crypto recovery, family essentials. Encryption happens on your device with your master passphrase, which we never see. Attach files. Link items into playbooks that read in order.',
  "site.landing.product.contacts.body":
    "Invite anyone with an email address. Tag them Personal or Professional. They don't need an account to start — accepting the link creates one and enrols their device, which is what lets them hold a share. You can require a minimum of one from each category before release — never a single workplace or family group acting alone.",
  'site.landing.product.plans.body':
    'Set a trigger (inactivity, manual, or signed external event), a cooldown (7–90 days), and a release stage ladder. Preview the timeline visually before saving. Every edit waits out its own 7-day delay, so nothing changes under you.',
  'site.landing.product.ceremony.body':
    'If you go silent, your contacts receive a signed link. They affirm or dispute — and a dispute halts the release for review. Threshold met triggers a 48-hour revocation window. You can cancel from any verified device. Any affirming contact can withdraw. Every action is timestamped and signed.',

  // Paragraphs whose markup is part of the sentence — rendered through <Trans>
  // so a translator can move the link or the emphasis where their language needs
  // it, instead of receiving three fragments in English word order.
  'site.landing.security.lede':
    "Your master passphrase never leaves your device. We can't read your vault. We can't help you recover the passphrase — that's the point. Below is the part of the security model that's easy to write down. The rest is in our <threat>threat model</threat>.",
  'site.landing.security.claim.zeroKnowledge.body':
    'Your master passphrase is processed on your device. We store only its key-derivation salt — never the passphrase, and never a hash we could test guesses against. Everything we do hold is itemised in our <privacy>privacy policy</privacy>.',
  'site.landing.security.claim.encrypted.body':
    'XChaCha20-Poly1305, with a key derived from your passphrase via Argon2id and an account-bound salt.',
  'site.landing.security.claim.contacts.body':
    'A contact holds their own account. Enrolling binds an Ed25519 signing key and an X25519 sealing key, each proved by a challenge only the holder can answer, and you confirm their safety number out of band before any share is sealed to them. Every affirmation is signed over the challenge <em>and</em> the ceremony id, so it cannot be replayed against a different release.',
  'site.landing.security.claim.source.labelUnpublished': 'Client source will be published.',
  'site.landing.security.claim.source.bodyUnpublished':
    'Dependencies are hash-pinned and the web build is reproducible from the spec on our <build>build page</build>. The repository is not public yet, so treat this as a commitment rather than something you can check today.',
  'site.landing.security.claim.source.labelPublished': 'Client source is published.',
  'site.landing.security.claim.source.bodyPublished':
    'Dependencies are hash-pinned and the web build is reproducible: clone the <repo>repository</repo>, build it, and compare the bundle digest with the one on our <build>build page</build>. What we have not shipped is signed per-release attestation — the comparison is the check, not a signature.',
  // The two passphrases fail DIFFERENTLY, and the emphasis is what carries that.
  // Losing the master passphrase and the recovery code is total and permanent;
  // losing the release passphrase costs one tier. A translation that flattens
  // them into one warning loses the only distinction that matters here.
  'site.landing.faq.passphrase.a':
    'There are two, and they fail differently. Lose your <strong>master passphrase</strong> and your recovery code, and your whole vault is unrecoverable — we cannot reset, restore, or substitute it, and there is no backdoor even for us. Lose only your <strong>release passphrase</strong>, and the high-sensitivity tier becomes unreleasable while the rest still reaches your contacts through ordinary release. Write both on paper and store them somewhere that is not your home.',

  "site.landing.closing.title": "Most of this you'll do once. The relief is permanent.",
  "site.landing.closing.lede":
    "Create a free account. Add one plan, one contact, one vault item. About four minutes from now, you'll be done.",

  // ── 404 ───────────────────────────────────────────────────────────────────
  // Read by someone whose link did not work — often a trusted contact acting for
  // a person who may have died, following a ceremony link a mail client mangled.
  // The copy has one job beyond apologising: stop them creating an account to
  // "make it work", because a new account is not a substitute for the invitation
  // and someone acting on another's behalf must never be quietly handed the
  // wrong task. A translation that softens that paragraph removes the only thing
  // on the page that prevents it.
  'site.notFound.title': 'That page does not exist',
  'site.notFound.lede':
    'We could not find anything at this address. Nothing has gone wrong with your account or your vault — this is only a link that does not lead anywhere.',
  'site.notFound.attempted': 'The address you tried',
  'site.notFound.sentHeading': 'If someone sent you this link',
  'site.notFound.sentBody':
    'Links get broken in transit — mail clients wrap long ones across lines, and chat apps sometimes cut them short. Ask whoever sent it to send it again, and open it in one piece rather than retyping it.',
  'site.notFound.contactWarning':
    '<strong>If you were asked to act as a trusted contact</strong>, do not create an account here to try to make it work. The invitation you were sent is what grants you access, and a new account is not a substitute for it. Go back to the original message, or tell the person who contacted you that their link did not open.',
  'site.notFound.whereHeading': 'Where to go instead',
  'site.notFound.home': 'The home page',
  'site.notFound.guide': 'The guide',
  'site.notFound.guideNote': ' — what Truecairn does and how it works',
  'site.notFound.security': 'The security model',
  'site.notFound.emailNote':
    ' — if you think this address should have worked, send it to us with the message you got it from',
  // The 404's <title>. Not in PAGE_META because a 404 has no route entry — the
  // pathname is arbitrary, which is the whole reason the page emits no canonical
  // and no JSON-LD.
  'site.meta.notFound.title': 'Page not found — Truecairn',

  // ── Per-route <head> metadata ─────────────────────────────────────────────
  //
  // Moved here from site/page-meta.ts in Phase 2, so ALL user-visible copy has
  // one home. That table still owns which routes exist and what shape their
  // structured data takes; the words are here.
  //
  // DESCRIPTIONS ARE WRITTEN FROM THE PAGES THEMSELVES, not generated. Where a
  // page's own opening paragraph says the thing best, this paraphrases it
  // closely. If a page ever exists whose content cannot support an honest
  // description, omit the key rather than pad — an absent description lets the
  // search engine pick a snippet from the page, which is better than a confident
  // sentence that misleads. 140–160 characters.
  //
  // A TRANSLATION OF ONE OF THESE IS A PUBLISHED CLAIM. A search engine repeats
  // it to people who never visit, so the same rule as the pages applies: nothing
  // here may promise more than the product does.
  'site.meta.home.title': 'Truecairn — Digital continuity for what matters most',
  'site.meta.home.description':
    'Encrypted vaults that stay under your control until conditions you set are met. Zero-knowledge by design: we cannot read your vault or reset your passphrase.',
  'site.meta.guide.title': 'Guide — How Truecairn works, screen by screen',
  'site.meta.guide.description':
    'A walkthrough of everything Truecairn does: the secrets you manage, sensitivity tiers and release, trusted contacts, the continuity engine, and getting help.',
  'site.meta.changelog.title': 'Changelog — What changed and when',
  'site.meta.changelog.description':
    'Every user-visible change to Truecairn, newest first, in plain language — security and reliability work written up as plainly as features, dated and specific.',
  'site.meta.status.title': 'Service status — Truecairn',
  'site.meta.status.description':
    'Live component status and measured availability, answering one question: could a release ceremony complete right now? An outage cannot release your vault.',
  'site.meta.security.title': 'Security model — Truecairn',
  'site.meta.security.description':
    'Everything is encrypted on your device before upload, with keys the server never holds. It stores ciphertext, public keys and sealed boxes — never plaintext.',
  'site.meta.security.threatModel.title': 'Threat model — What we defend against',
  'site.meta.security.threatModel.description':
    'The adversaries Truecairn is designed against, and the two failure modes it is judged by: releasing a vault wrongly, and never releasing one at all.',
  'site.meta.security.ai.title': 'How Truecairn uses AI',
  'site.meta.security.ai.description':
    'AI in a deliberately small, one-directional role: it can only ever add safety, never remove it. It cannot loosen a control, advance a release, or read content.',
  'site.meta.security.build.title': 'Build provenance — Check the code we serve you',
  'site.meta.security.build.description':
    'We encrypt in your browser, so the encrypting code is code we serve. Every release publishes a digest for each file it ships, built by a public workflow.',
  'site.meta.security.limits.title': 'Known limits — What we do not protect against',
  'site.meta.security.limits.description':
    'Everything we do not protect against, have not built, or have never tested. A security page that lists only strengths is a marketing page — here is the rest.',
  'site.meta.security.disclosure.title': 'Coordinated disclosure policy — Truecairn',
  'site.meta.security.disclosure.description':
    'How to report a vulnerability to Truecairn, what we ask of researchers, and what you can expect from us in return — including a first-response commitment.',
  'site.meta.legal.privacy.title': 'Privacy policy — Truecairn',
  'site.meta.legal.privacy.description':
    'What we collect, why, and how long we keep it. Truecairn is built so we cannot see the things that matter most, and we say where architecture beats policy.',
  'site.meta.legal.terms.title': 'Terms of service — Truecairn',
  'site.meta.legal.terms.description':
    'The terms governing your use of Truecairn, a zero-knowledge digital-continuity platform. A working skeleton, to be finalised with counsel before launch.',
  'site.meta.legal.dpa.title': 'Data processing agreement — Truecairn',
  'site.meta.legal.dpa.description':
    'How Truecairn processes personal data as a processor on a customer’s behalf. For individual consumer accounts the privacy policy governs instead.',
  'site.meta.legal.subProcessors.title': 'Sub-processors — Truecairn',
  'site.meta.legal.subProcessors.description':
    'The third-party providers Truecairn may use and what each one handles. None of them can read your vault: it is encrypted on your device before it ever leaves.',
  'site.meta.legal.windDown.title': 'Wind-down playbook — If Truecairn goes away',
  'site.meta.legal.windDown.description':
    'What happens to your vault if we shut down, are acquired, or go out of business. Your protection cannot depend on our survival — so it does not.',
  'site.meta.company.about.title': 'About Truecairn',
  'site.meta.company.about.description':
    'A calm, deliberate system for the parts of your digital life that should outlast you. We engineer for the day we cannot help you — that is when it must hold.',
  'site.meta.company.contact.title': 'Contact Truecairn',
  'site.meta.company.contact.description':
    'How to reach us: general and support, security reports under our disclosure policy, and press. Email, read by a small team — no contact form to disappear into.',
  'site.meta.company.press.title': 'Press kit — Truecairn',
  'site.meta.company.press.description':
    'Approved boilerplate, a fact sheet, brand marks and screenshots free to publish — plus a plain list of what we will and will not claim about ourselves.',
} as const;

export type SiteMessageKey = keyof typeof siteEn;

// Keys deliberately NOT translated. The ROUTE list they belong to lives in
// @truecairn/shared (SOURCE_LANGUAGE_ONLY_ROUTES) because the prerenderer, this
// app and the API's route table all have to agree about it; the reasoning is
// there. This is the key-level view of the same decision, used by the coverage
// report so the percentage stays a measure of work outstanding rather than of a
// decision already taken.
export const SOURCE_LANGUAGE_ONLY_KEYS: readonly SiteMessageKey[] = [
  'site.meta.changelog.title',
  'site.meta.changelog.description',
  'site.meta.legal.privacy.title',
  'site.meta.legal.privacy.description',
  'site.meta.legal.terms.title',
  'site.meta.legal.terms.description',
  'site.meta.legal.dpa.title',
  'site.meta.legal.dpa.description',
  'site.meta.legal.subProcessors.title',
  'site.meta.legal.subProcessors.description',
  'site.meta.legal.windDown.title',
  'site.meta.legal.windDown.description',
];
