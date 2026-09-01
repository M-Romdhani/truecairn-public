import { Link } from 'react-router-dom';
import { PublicPage } from '../../site/PublicPage.js';

// Sibling-page pill nav shared by the legal family.
const LEGAL_PILLS = [
  { to: '/legal/privacy', label: 'Privacy' },
  { to: '/legal/terms', label: 'Terms' },
  { to: '/legal/dpa', label: 'DPA' },
  { to: '/legal/sub-processors', label: 'Sub-processors' },
  { to: '/legal/wind-down', label: 'Wind-down' },
] as const;
import { PRIVACY_EMAIL, CONTACT_EMAIL } from '../../site/links.js';
import { SourceLangLink } from '../../site/SourceLangLink.js';

// Public LEGAL pages. Every factual statement is grounded in what the product
// actually does (docs + code): zero-knowledge collection, the real sub-processor
// stack, the wind-down commitments already stated in the FAQ. No compliance
// certification is claimed (we hold none). The pre-launch "draft — pending legal
// review" banner has been removed; these are finalized for launch.

const UPDATED = 'July 9, 2026';

// Wind-down carries its OWN date. The four other legal pages share UPDATED and
// did not change on 2026-08-13; re-dating them to make one edit look tidy would
// tell every reader that the privacy policy and the terms had been revised when
// they had not — a small false claim of exactly the kind this revision exists to
// remove.
const WIND_DOWN_UPDATED = 'August 13, 2026';

export function Privacy(): JSX.Element {
  return (
    <PublicPage eyebrow="legal" title="Privacy policy" updated={UPDATED} pills={LEGAL_PILLS} current="/legal/privacy">
      <p>
        Truecairn is built so that we cannot see the things that matter most. This policy describes
        what we do and do not collect, why, and how long we keep it. Where the architecture makes a
        promise stronger than a policy can, we say so. It covers your data specifically; your use of
        the service itself is governed by the <SourceLangLink to="/legal/terms">terms of service</SourceLangLink>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account email.</strong> Used to sign you in, send check-ins and security notices,
          and reach you about your account.
        </li>
        <li>
          <strong>Ciphertext.</strong> Your vault items and attachments, encrypted on your device
          before upload. We store these as opaque blobs and cannot read them.
        </li>
        <li>
          <strong>Operational metadata.</strong> The minimum needed to run the continuity engine:
          login and check-in times, engine state transitions, the signed audit log, your trusted
          contacts&apos; delivery addresses, notification delivery results, and salted/hashed
          client IPs used only for abuse and rate-limiting. We do not store raw IP addresses at
          rest.
        </li>
        <li>
          <strong>Public cryptographic material.</strong> Public keys, salts, and sealed boxes that
          let the system function. None of it reveals your content.
        </li>
      </ul>

      <h2>What we never see</h2>
      <p>
        By construction — not merely by promise — we never receive your vault plaintext, your master
        passphrase, your release passphrase, your backup recovery code, your encryption keys, your
        contacts&apos; private keys, or any unwrapped share. These exist only on your device and
        your contacts&apos; devices. There is no server code path, log line, or notification that
        carries them.
      </p>

      <h2>How we use what we collect</h2>
      <p>
        To operate the service: authenticate you, run the engine, deliver notifications, maintain the
        audit log, prevent abuse, and keep the system secure and reliable. We do not sell personal
        data, and we do not use your content for advertising — we cannot, since we cannot read it.
        Optional AI features (the dashboard briefing, the in-app assistant, readiness proposals,
        the opt-in autonomy, and the release guardian) operate on account metadata only — counts,
        states, and cadence, plus any text you choose to type to the assistant — never vault
        content; only the LLM-backed surfaces send that metadata to our AI sub-processor, prompts
        are not retained, and every AI feature can be turned off for your account in Settings. See{' '}
        <Link to="/security/ai">How Truecairn uses AI</Link>.
      </p>

      <h2>Who we share it with</h2>
      <p>
        We rely on a small set of infrastructure providers to operate. Each one receives only what
        it needs, and several only handle ciphertext or opaque keys. See the full{' '}
        <SourceLangLink to="/legal/sub-processors">sub-processors list</SourceLangLink>. We also disclose metadata or
        ciphertext when compelled by lawful order — but never plaintext, because we do not possess
        it.
      </p>

      <h2>Retention</h2>
      <p>
        We keep account data and ciphertext while your account is active. If you delete an item or
        your account, we delete the corresponding ciphertext and attachment blobs.
      </p>
      <p>
        <strong>Your audit log is the deliberate exception, and we would rather be
        explicit about it than let it read as an oversight.</strong> Deleting your account removes
        your content, but the tamper-evident record of actions taken on the account is kept, and
        your account identifier is retained in a tombstoned form so that record still makes sense.
        The reason is that the audit log exists to catch someone acting as you: if deleting the
        account also erased the log, then anyone who compromised your session could cover their
        tracks by deleting you. A log an attacker can erase protects nobody. The retained record is
        activity metadata — what happened and when — never your vault content, which we could not
        read in the first place.
      </p>

      <h2>Your choices</h2>
      <p>
        You can access and export your data, correct your account email, and delete items or your
        whole account from within the app. That includes your audit log: Settings shows the full
        record of actions on your account, lets you download it, and can verify it in your own
        browser — the check runs on your device rather than asking our server whether it has been
        honest. For questions or requests, contact{' '}
        <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>.
      </p>
    </PublicPage>
  );
}

export function Terms(): JSX.Element {
  return (
    <PublicPage eyebrow="legal" title="Terms of service" updated={UPDATED} pills={LEGAL_PILLS} current="/legal/terms">
      <p>
        These terms govern your use of Truecairn. They are a working skeleton and will be finalized
        with counsel before launch.
      </p>

      <h2>1. The service</h2>
      <p>
        Truecairn is a zero-knowledge digital-continuity platform: you encrypt information on your
        device, and it is released to people you designate, under rules you configure, if you become
        unreachable. It is a release mechanism, not legal, financial, or estate-planning advice, and
        not a substitute for a will or an estate plan.
      </p>

      <h2>2. Eligibility and accounts</h2>
      <p>
        You must be able to form a binding contract to use Truecairn. You are responsible for your
        account, your devices, your contacts, and for keeping your credentials and passphrases safe.
      </p>

      <h2>3. We cannot recover your passphrases</h2>
      <p>
        This is the most important term, and it is a property of the design rather than a policy
        choice. <strong>We cannot recover or reset your master passphrase or your release
        passphrase, and we cannot decrypt your vault.</strong> If you forget your master passphrase,
        your one-time backup recovery code is the only way back into your vault. If you lose your
        release passphrase, your most-sensitive (S3) items become permanently unrecoverable, and no
        one — including us — can restore them. Store these secrets carefully and off site.
      </p>

      <h2>4. Acceptable use</h2>
      <p>
        Don&apos;t use Truecairn to break the law, infringe others&apos; rights, or attack the
        service or other users. Don&apos;t attempt to misuse the release process to obtain
        information you are not entitled to.
      </p>

      <h2>5. Availability and warranties</h2>
      <p>
        We work to keep the service reliable, but it is provided &ldquo;as is,&rdquo; without
        warranties of any kind to the maximum extent permitted by law. We do not warrant that the
        service will be uninterrupted or error-free.
      </p>

      <h2>6. Limitation of liability</h2>
      <p>
        To the extent permitted by law, Truecairn is not liable for indirect, incidental, or
        consequential damages, or for loss of data resulting from your loss of the secrets we cannot
        recover (see section 3). Final liability terms will be set with counsel.
      </p>

      <h2>7. Termination</h2>
      <p>
        You may stop using Truecairn and delete your account at any time. We may suspend or terminate
        accounts that violate these terms. If we discontinue the service, the{' '}
        <SourceLangLink to="/legal/wind-down">wind-down playbook</SourceLangLink> applies.
      </p>

      <h2>8. Changes and contact</h2>
      <p>
        We may update these terms; we will give reasonable notice of material changes. Questions:{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </PublicPage>
  );
}

export function Dpa(): JSX.Element {
  return (
    <PublicPage eyebrow="legal" title="Data processing agreement" updated={UPDATED} pills={LEGAL_PILLS} current="/legal/dpa">
      <p>
        This DPA skeleton describes how Truecairn processes personal data on behalf of a customer
        where Truecairn acts as a processor. It is a starting framework to be completed and executed
        with counsel; for individual consumer accounts, Truecairn is generally the controller and the{' '}
        <SourceLangLink to="/legal/privacy">privacy policy</SourceLangLink> governs.
      </p>

      <h2>Roles</h2>
      <p>
        Where a customer determines the purposes and means of processing, the customer is the
        controller and Truecairn is the processor, acting only on documented instructions.
      </p>

      <h2>Subject matter and duration</h2>
      <p>
        Processing covers the operation of the continuity service for the duration of the
        agreement, plus any limited wind-down period.
      </p>

      <h2>Nature and purpose</h2>
      <p>
        Storing client-side-encrypted content as ciphertext, running the continuity engine,
        delivering notifications, and maintaining the audit log — as described in the privacy policy.
      </p>

      <h2>Types of data and data subjects</h2>
      <p>
        Account email, operational metadata, and opaque ciphertext relating to account holders and
        their designated trusted contacts. Truecairn does not have access to the plaintext content.
      </p>

      <h2>Processor obligations</h2>
      <ul>
        <li>Process only on documented instructions.</li>
        <li>Ensure personnel are bound by confidentiality.</li>
        <li>
          Implement appropriate technical and organizational measures (see the{' '}
          <Link to="/security">security model</Link>).
        </li>
        <li>
          Engage sub-processors only under equivalent terms, with the current list available at{' '}
          <SourceLangLink to="/legal/sub-processors">sub-processors</SourceLangLink>.
        </li>
        <li>Assist the controller with data-subject requests and security obligations.</li>
        <li>Delete or return personal data at the end of the agreement, subject to legal retention.</li>
        <li>Make available information needed to demonstrate compliance.</li>
      </ul>

      <h2>International transfers</h2>
      <p>
        Where data is transferred across borders, the parties will rely on a lawful transfer
        mechanism, to be specified in the executed agreement.
      </p>

      <p>
        To request a signed DPA, contact <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </PublicPage>
  );
}

export function SubProcessors(): JSX.Element {
  return (
    <PublicPage eyebrow="legal" title="Sub-processors" updated={UPDATED} pills={LEGAL_PILLS} current="/legal/sub-processors">
      <p>
        These are the third-party providers Truecairn may use to operate the service, and what each
        one handles. Several are optional and depend on how a given deployment is configured. None of
        them can read your vault: the items that matter are encrypted on your device before they ever
        leave it.
      </p>

      <h2>Always used</h2>
      <ul>
        <li>
          <strong>Railway</strong> — application hosting, managed PostgreSQL database, and the
          persistent storage volume. Holds everything we store at rest: account email, opaque
          ciphertext, operational metadata, and the audit log. United States.
        </li>
        <li>
          <strong>Resend</strong> — transactional email delivery (check-ins, ceremony and security
          notices). Receives recipient email addresses and notification text, which is metadata only
          — never vault content.
        </li>
      </ul>

      <h2>Used when configured</h2>
      <ul>
        <li>
          <strong>Google — Gemini API</strong> — powers the optional AI features (dashboard
          briefing and in-app assistant). Receives account metadata and the text you choose to
          type. Never receives vault content, passphrases, or keys. Disabled unless the deployment
          configures it. We use a billing-enabled account, on which Google does not use prompts or
          responses to train its models. Until 25 August 2026 this ran through Google Cloud Vertex
          AI; the same company processes it either way.
        </li>
        <li>
          <strong>Google Cloud KMS</strong> — optional hardware-backed key store for the outer-layer
          (temporal-gate) key. Performs wrap/unwrap on an opaque key and never sees vault content or
          your passphrases.
        </li>
        <li>
          <strong>S3-compatible object storage</strong> (for example AWS S3, Cloudflare R2,
          Backblaze B2, or self-hosted MinIO) — optional backend for encrypted attachment blobs.
          Stores ciphertext only. When not configured, attachments live on the Railway volume
          instead.
        </li>
      </ul>

      <p>
        We will give notice of material changes to this list. Questions:{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </PublicPage>
  );
}

export function WindDown(): JSX.Element {
  return (
    <PublicPage eyebrow="legal" title="Wind-down playbook" updated={WIND_DOWN_UPDATED} pills={LEGAL_PILLS} current="/legal/wind-down">
      <p>
        A continuity product has to answer an uncomfortable question honestly: what happens to your
        vault if Truecairn itself goes away? We may go out of business, be acquired, or shut the
        service down. Your protection cannot depend on our survival — so it doesn&apos;t.
      </p>

      <h2>Your data was never locked to us</h2>
      <p>
        Everything that matters is encrypted with keys we never hold, and the client and release
        worker are open source under the Apache License 2.0. The vault format and key hierarchy are
        documented, the browser build is reproducible, and we publish the test vectors. The design
        therefore permits the legitimate parties — you, your contacts, and whoever holds the release
        passphrase — to decrypt with publicly available code.
      </p>
      <p>
        That is a real property and an unusual one, and we are going to be precise about its limit,
        because the previous version of this page was not. <strong>The design permitting something
        is not the same as our having built it.</strong> Below, the commitments we can keep today are
        separated from the ones that are properties of the architecture and nothing more. We would
        rather you knew which is which now than discovered it during a wind-down.
      </p>

      <h2>What we commit to as policy</h2>
      <p>These are things we can do today, or that need no new software to do.</p>
      <ul>
        <li>
          <strong>Advance notice.</strong> We will give as much warning as circumstances allow
          before any shutdown.
        </li>
        <li>
          <strong>A read-only window.</strong> A wind-down period (target: 180 days) during which
          you retain read-only access to export your data. This one is load-bearing in a way that is
          easy to miss: while the service is running, your own reads return your data in a form your
          own secrets can open. That is the window in which recovery is straightforward, and it is
          why the window exists.
        </li>
        <li>
          <strong>A signed audit-log export.</strong> Your full audit log in its signed, verifiable
          form. This one is <em>built</em> — it is the audit trail in your settings, and the same
          record is available in a form you can verify after the fact against the signing key.
        </li>
      </ul>

      <h2>What the architecture permits, and we have not built</h2>
      <p>
        Each of these is possible by design. None of them exists as a tool you could use today, and
        listing them as commitments — which this page previously did — described intent as though it
        were capability.
      </p>
      <ul>
        <li>
          <strong>An offline decryption path.</strong> Your vault format is documented, the client
          that encrypts it is open source and reproducibly buildable, and the test vectors are
          published. The design therefore permits recovering your data with your own secrets and no
          dependence on us. <strong>What we have not built is the tool that does it.</strong> Until
          it exists, this is a property of the design rather than something you can rely on.
        </li>
        <li>
          <strong>Bulk export, and outer-key export.</strong> There is no export route: your data
          comes out through the ordinary screens, one item at a time. This matters more than it
          sounds. Stored items carry an outer layer that our servers remove when you read your own
          vault — it is a timing gate, not a second lock on your content, and it is what stops a
          release from happening before the rules you wrote say it should. But it means a raw copy of
          our database, taken after we are gone, is not something your passphrase alone can open.
          Exporting those outer keys to a destination you choose would close that gap. It is not
          built.
        </li>
        <li>
          <strong>In-flight releases.</strong> An earlier version of this page said trusted-contact
          verification keys were held in escrow <em>with our auditor</em>. There is no auditor; we
          corrected that in July. The mechanism itself was never built either, so rather than name a
          new custodian we will say plainly: <strong>we have no escrow arrangement.</strong> A
          ceremony already underway when the service stops would not complete.
        </li>
      </ul>

      <h2>What we cannot promise</h2>
      <p>
        We cannot guarantee the hosted service will run forever, and none of the above helps if you
        have not kept your own secrets — your master passphrase or recovery code, and your release
        passphrase. That is the same honest boundary that runs through the whole product: we sell you
        strong tools; the recovery of your most-sensitive data ultimately rests on your having stored
        those secrets well.
      </p>
      <p>
        The gap between the second list and the first is work we owe you, and we would rather it sat
        here in the open than be discovered at the worst possible time. What we do and do not protect
        against elsewhere in the product is listed on our{' '}
        <Link to="/security/limits">known limits</Link> page.
      </p>
    </PublicPage>
  );
}
