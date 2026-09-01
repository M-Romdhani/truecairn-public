import { Trans } from 'react-i18next';
import { PublicPage } from '../../site/PublicPage.js';
import { useT, type TranslationKey } from '../../i18n/useT.js';
import '../../site/public.css';

// The Truecairn user guide. A single, canonical PUBLIC page (PublicPage chrome),
// reachable from the footer and the account menu — a prospect or a signed-in user
// reads the same crypto-free help doc, with no sidebar. It is deliberately free of
// any authed-graph imports (no useSession / @truecairn/client-crypto) so it can
// live in the public, libsodium-free chunk (see main.tsx / PublicPages.tsx).
//
// Rendered as semantic JSX (no markdown renderer — that would be an XSS surface)
// using the shared prose typography. Copy lives in the PAGES catalog half, which
// loads with PublicPages rather than eagerly (docs/40 Phase 2).
//
// CONTENT NOTE — S3 is the passphrase-MANDATORY nested scheme (docs/24), kept
// consistent with the assistant system prompt and the landing FAQ. S2 keeps the
// release passphrase as an OPTIONAL fallback. Do not reintroduce the old flat
// four-share ("any three of four") framing for S3, and never call the release
// passphrase "optional" or "just a share" for S3. That rule binds translations
// too — see the header of the guide block in i18n/catalog/pages/en.ts.

// The section list drives BOTH the table of contents and the numbered <h2>s.
// It used to drive only the ToC, with each heading repeating its own title as a
// literal ("1. How Truecairn works" beside a ToC entry reading "How Truecairn
// works"). Two copies of fourteen titles is two chances for a translator to make
// the contents disagree with the page it indexes, so the number is composed here
// and the words come from one key.
const SECTIONS = [
  'overview',
  'secrets',
  'account',
  'unlock',
  'vault',
  'contacts',
  'tiers',
  'plans',
  'engine',
  'ceremony',
  'recovery',
  'privacy',
  'ai',
  'help',
] as const;

type SectionId = (typeof SECTIONS)[number];

const titleKey = (id: SectionId): TranslationKey =>
  `site.guide.${id}.title` as unknown as TranslationKey;

function GuideBody(): JSX.Element {
  const t = useT();
  const heading = (id: SectionId): JSX.Element => (
    <h2 id={id}>
      {SECTIONS.indexOf(id) + 1}. {t(titleKey(id))}
    </h2>
  );

  return (
    <>
      <p>
        <Trans
          i18nKey="site.guide.intro"
          components={{ secrets: <a href="#secrets" />, tiers: <a href="#tiers" /> }}
        />
      </p>

      <nav className="guide-toc" aria-label={t('site.guide.contents')}>
        <h2>{t('site.guide.contents')}</h2>
        <ol>
          {SECTIONS.map((id) => (
            <li key={id}>
              <a href={`#${id}`}>{t(titleKey(id))}</a>
            </li>
          ))}
        </ol>
      </nav>

      <section aria-labelledby="overview">
        {heading('overview')}
        <p>{t('site.guide.overview.body')}</p>
      </section>

      <section aria-labelledby="secrets">
        {heading('secrets')}
        <p>{t('site.guide.secrets.lede')}</p>
        <ul>
          <li>
            <Trans i18nKey="site.guide.secrets.passkey" components={{ strong: <strong />, em: <em /> }} />
          </li>
          <li>
            <Trans i18nKey="site.guide.secrets.master" components={{ strong: <strong /> }} />
          </li>
          <li>
            <Trans i18nKey="site.guide.secrets.release" components={{ strong: <strong /> }} />
          </li>
        </ul>
        <div className="pub-note">
          <p>
            <Trans i18nKey="site.guide.secrets.recoveryNote" components={{ strong: <strong /> }} />
          </p>
        </div>
      </section>

      <section aria-labelledby="account">
        {heading('account')}
        <p>{t('site.guide.account.body')}</p>
      </section>

      <section aria-labelledby="unlock">
        {heading('unlock')}
        <p>
          <Trans i18nKey="site.guide.unlock.body" components={{ strong: <strong /> }} />
        </p>
      </section>

      <section aria-labelledby="vault">
        {heading('vault')}
        <p>{t('site.guide.vault.body')}</p>
      </section>

      <section aria-labelledby="contacts">
        {heading('contacts')}
        <p>
          <Trans i18nKey="site.guide.contacts.body" components={{ em: <em /> }} />
        </p>
      </section>

      <section aria-labelledby="tiers">
        {heading('tiers')}
        <p>{t('site.guide.tiers.lede')}</p>
        <h3>{t('site.guide.tiers.s1.title')}</h3>
        <p>{t('site.guide.tiers.s1.body')}</p>
        <h3>{t('site.guide.tiers.s2.title')}</h3>
        <p>
          <Trans i18nKey="site.guide.tiers.s2.body" components={{ strong: <strong /> }} />
        </p>
        <h3>{t('site.guide.tiers.s3.title')}</h3>
        <p>
          <Trans i18nKey="site.guide.tiers.s3.body" components={{ strong: <strong /> }} />
        </p>
        <div className="pub-note">
          <p>
            <Trans i18nKey="site.guide.tiers.note" components={{ strong: <strong /> }} />
          </p>
        </div>
      </section>

      <section aria-labelledby="plans">
        {heading('plans')}
        <p>{t('site.guide.plans.body')}</p>
      </section>

      <section aria-labelledby="engine">
        {heading('engine')}
        <p>{t('site.guide.engine.body')}</p>
      </section>

      <section aria-labelledby="ceremony">
        {heading('ceremony')}
        <p>{t('site.guide.ceremony.body')}</p>
      </section>

      <section aria-labelledby="recovery">
        {heading('recovery')}
        <p>{t('site.guide.recovery.lede')}</p>
        <ul>
          <li>
            <Trans i18nKey="site.guide.recovery.master" components={{ strong: <strong /> }} />
          </li>
          <li>
            <Trans i18nKey="site.guide.recovery.release" components={{ strong: <strong /> }} />
          </li>
          <li>
            <Trans i18nKey="site.guide.recovery.everything" components={{ strong: <strong /> }} />
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy">
        {heading('privacy')}
        <p>
          <Trans
            i18nKey="site.guide.privacy.body"
            components={{
              security: <a href="/security" />,
              threat: <a href="/security/threat-model" />,
            }}
          />
        </p>
      </section>

      <section aria-labelledby="ai">
        {heading('ai')}
        <p>
          <Trans i18nKey="site.guide.ai.lede" components={{ strong: <strong /> }} />
        </p>
        <ul>
          <li>
            <Trans i18nKey="site.guide.ai.assistant" components={{ strong: <strong /> }} />
          </li>
          <li>
            <Trans i18nKey="site.guide.ai.proposals" components={{ strong: <strong /> }} />
          </li>
          <li>
            <Trans i18nKey="site.guide.ai.autonomy" components={{ strong: <strong /> }} />
          </li>
          <li>
            <Trans i18nKey="site.guide.ai.guardian" components={{ strong: <strong /> }} />
          </li>
        </ul>
        <p>
          <Trans i18nKey="site.guide.ai.optOut" components={{ ai: <a href="/security/ai" /> }} />
        </p>
      </section>

      <section aria-labelledby="help">
        {heading('help')}
        <p>
          <Trans
            i18nKey="site.guide.help.body"
            components={{ contact: <a href="/company/contact" /> }}
          />
        </p>
      </section>
    </>
  );
}

export function Guide(): JSX.Element {
  const t = useT();
  return (
    <PublicPage eyebrow={t('site.guide.eyebrow')} title={t('site.guide.title')}>
      <GuideBody />
    </PublicPage>
  );
}
