import { Link } from 'react-router-dom';
import { Trans } from 'react-i18next';
import { PublicPage } from '../../site/PublicPage.js';
import { SECURITY_EMAIL, DISCLOSURE_RESPONSE_DAYS } from '../../site/links.js';
import { SourceLangLink } from '../../site/SourceLangLink.js';
import { useSecurityPills } from '../../site/security-pills.js';
import { useT } from '../../i18n/useT.js';

// Public security pages, grounded in docs/18 (crypto architecture) and
// docs/04–17 (threat model). No invented claims: primitives and tier mechanics
// are taken verbatim from the spec, and the "independent reviews" section says
// plainly that no third-party report is published yet rather than faking one.
// Those rules bind translations too — see the per-page notes in the security
// block of i18n/catalog/pages/en.ts.
//
// The sibling-page pill nav now lives in site/security-pills.ts: it was
// duplicated here and in build.tsx, and the two had drifted (build.tsx's copy
// was missing /security/limits, so that page was the only one from which a
// reader could not reach Known limits).

export function SecurityModel(): JSX.Element {
  const t = useT();
  const pills = useSecurityPills();
  return (
    <PublicPage
      eyebrow={t('site.security.model.eyebrow')}
      title={t('site.security.model.title')}
      pills={pills}
      current="/security"
    >
      <p>{t('site.security.model.lede')}</p>
      <p>
        <Trans
          i18nKey="site.security.model.summary"
          components={{ threat: <Link to="/security/threat-model" /> }}
        />
      </p>

      <h2>{t('site.security.model.secrets.title')}</h2>
      <p>{t('site.security.model.secrets.lede')}</p>
      <ul>
        <li>
          <Trans i18nKey="site.security.model.secrets.passkey" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.model.secrets.master" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.model.secrets.release" components={{ strong: <strong /> }} />
        </li>
      </ul>

      <h2>{t('site.security.model.crypto.title')}</h2>
      <p>
        <Trans i18nKey="site.security.model.crypto.body" components={{ strong: <strong /> }} />
      </p>

      <h2>{t('site.security.model.tiers.title')}</h2>
      <p>{t('site.security.model.tiers.lede')}</p>
      <ul>
        <li>
          <Trans i18nKey="site.security.model.tiers.s1" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.model.tiers.s2" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.model.tiers.s3" components={{ strong: <strong /> }} />
        </li>
      </ul>

      <h2>{t('site.security.model.gate.title')}</h2>
      <p>
        <Trans i18nKey="site.security.model.gate.body" components={{ strong: <strong /> }} />
      </p>

      <h2>{t('site.security.model.audit.title')}</h2>
      <p>{t('site.security.model.audit.body')}</p>

      <h2>{t('site.security.model.ai.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.model.ai.body"
          components={{ em: <em />, ai: <Link to="/security/ai" /> }}
        />
      </p>

      <h2>{t('site.security.model.windDown.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.model.windDown.body"
          components={{ winddown: <SourceLangLink to="/legal/wind-down" /> }}
        />
      </p>

      <h2 id="audits">{t('site.security.model.audits.title')}</h2>
      <div className="pub-empty">{t('site.security.model.audits.none')}</div>
      <p>
        <Trans
          i18nKey="site.security.model.audits.report"
          values={{ days: DISCLOSURE_RESPONSE_DAYS, email: SECURITY_EMAIL }}
          components={{
            disclosure: <Link to="/security/disclosure" />,
            email: <a href={`mailto:${SECURITY_EMAIL}`} />,
          }}
        />
      </p>

      <h2>{t('site.security.model.notCovered.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.model.notCovered.body"
          components={{ limits: <Link to="/security/limits" /> }}
        />
      </p>
    </PublicPage>
  );
}

export function ThreatModel(): JSX.Element {
  const t = useT();
  const pills = useSecurityPills();
  return (
    <PublicPage
      eyebrow={t('site.security.threat.eyebrow')}
      title={t('site.security.threat.title')}
      pills={pills}
      current="/security/threat-model"
    >
      <p>
        <Trans i18nKey="site.security.threat.lede" components={{ strong: <strong /> }} />
      </p>
      <p>
        <Trans i18nKey="site.security.threat.assumptions" components={{ strong: <strong /> }} />
      </p>

      {/* Written out rather than looped. A `t(\`…t${n}.title\`)` helper needs an
          `as` cast to satisfy the key union, and that cast is exactly the
          compile-time check the typed catalog exists to provide — a typo in the
          template would render as its own dotted key instead of failing the
          build. Six repetitions is the cheaper price. */}
      <h2>{t('site.security.threat.t51.title')}</h2>
      <p>{t('site.security.threat.t51.body')}</p>

      <h2>{t('site.security.threat.t52.title')}</h2>
      <p>{t('site.security.threat.t52.body')}</p>

      <h2>{t('site.security.threat.t53.title')}</h2>
      <p>{t('site.security.threat.t53.body')}</p>

      <h2>{t('site.security.threat.t54.title')}</h2>
      <p>{t('site.security.threat.t54.body')}</p>

      <h2>{t('site.security.threat.t55.title')}</h2>
      <p>{t('site.security.threat.t55.body')}</p>

      <h2>{t('site.security.threat.t56.title')}</h2>
      <p>
        <Trans i18nKey="site.security.threat.t56.body" components={{ strong: <strong /> }} />
      </p>

      <h2>{t('site.security.threat.ai.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.threat.ai.body"
          components={{ em: <em />, ai: <Link to="/security/ai" /> }}
        />
      </p>

      <h2>{t('site.security.threat.residual.title')}</h2>
      <p>{t('site.security.threat.residual.body')}</p>
      <p>{t('site.security.threat.residual.deliberate')}</p>
    </PublicPage>
  );
}

export function AiTransparency(): JSX.Element {
  const t = useT();
  const pills = useSecurityPills();
  return (
    <PublicPage
      eyebrow={t('site.security.ai.eyebrow')}
      title={t('site.security.ai.title')}
      pills={pills}
      current="/security/ai"
    >
      <p>
        <Trans i18nKey="site.security.ai.lede" components={{ strong: <strong /> }} />
      </p>

      <h2>{t('site.security.ai.sees.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.ai.sees.body"
          components={{ strong: <strong />, model: <Link to="/security" /> }}
        />
      </p>

      <h2>{t('site.security.ai.can.title')}</h2>
      <ul>
        <li>
          <Trans i18nKey="site.security.ai.can.suggest" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.ai.can.act" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.ai.can.pause" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.ai.can.narrate" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.ai.can.cannot" components={{ strong: <strong /> }} />
        </li>
      </ul>

      <h2>{t('site.security.ai.guarantee.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.ai.guarantee.body"
          components={{ model: <Link to="/security" /> }}
        />
      </p>

      <h2>{t('site.security.ai.controls.title')}</h2>
      <ul>
        <li>
          <Trans i18nKey="site.security.ai.controls.off" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.ai.controls.autonomy" components={{ strong: <strong /> }} />
        </li>
        <li>
          <Trans i18nKey="site.security.ai.controls.kill" components={{ strong: <strong /> }} />
        </li>
      </ul>

      <h2>{t('site.security.ai.model.title')}</h2>
      <p>{t('site.security.ai.model.body')}</p>

      <p>
        <Trans
          i18nKey="site.security.ai.report"
          components={{ disclosure: <Link to="/security/disclosure" /> }}
        />
      </p>
    </PublicPage>
  );
}

export function Disclosure(): JSX.Element {
  const t = useT();
  const pills = useSecurityPills();
  return (
    <PublicPage
      eyebrow={t('site.security.disclosure.eyebrow')}
      title={t('site.security.disclosure.title')}
      pills={pills}
      current="/security/disclosure"
    >
      <p>{t('site.security.disclosure.lede')}</p>

      <h2>{t('site.security.disclosure.how.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.disclosure.how.body"
          values={{ email: SECURITY_EMAIL }}
          components={{ email: <a href={`mailto:${SECURITY_EMAIL}`} /> }}
        />
      </p>

      <h2>{t('site.security.disclosure.ask.title')}</h2>
      <ul>
        <li>{t('site.security.disclosure.ask.window')}</li>
        <li>{t('site.security.disclosure.ask.scope')}</li>
        <li>{t('site.security.disclosure.ask.testAccounts')}</li>
        <li>{t('site.security.disclosure.ask.minimum')}</li>
      </ul>

      <h2>{t('site.security.disclosure.expect.title')}</h2>
      <ul>
        <li>
          {t('site.security.disclosure.expect.ack', { days: DISCLOSURE_RESPONSE_DAYS })}
        </li>
        <li>{t('site.security.disclosure.expect.assessment')}</li>
        <li>{t('site.security.disclosure.expect.updates')}</li>
        <li>{t('site.security.disclosure.expect.credit')}</li>
      </ul>

      <h2>{t('site.security.disclosure.scope.title')}</h2>
      <p>{t('site.security.disclosure.scope.body')}</p>
    </PublicPage>
  );
}

// ── Known limits (D9, 2026-08-13) ────────────────────────────────────────────
//
// The page a prospective recovery-drill volunteer, or anyone about to pay us,
// should be able to find. Its whole value is that it does not hedge, so the
// rules for editing it are narrower than for any other public page:
//
//   1. EVERY LINE IS SOURCED. The facts here are carried from
//      `docs/38-release-readiness.md` §5, which is the repo's only status
//      source. If docs/38 and this page disagree, docs/38 wins and this page is
//      the bug. Do not add a limit here that docs/38 does not carry, and do not
//      quietly drop one it still lists.
//   2. THE S1/S2-vs-S3 SENTENCE MUST NOT BE SMOOTHED. It is pinned by a test
//      for exactly that reason — it is the residual of the C-1 contact-key fix,
//      it is the most important sentence on the page, and it is the kind of
//      awkward asymmetry a well-meaning copy edit rounds off into "we verify
//      contact keys". A "fix" that flips that test is a bug.
//   3. NARROWED IS NOT CLOSED. Two of these have been narrowed since they were
//      first written (the safety-number call on 2026-08-11, the mobile client on
//      2026-08-13). The narrowing is stated because it is true; the remaining
//      gap is stated in the same breath because it is also true.
export function KnownLimits(): JSX.Element {
  const t = useT();
  const pills = useSecurityPills();
  return (
    <PublicPage
      eyebrow={t('site.security.limits.eyebrow')}
      title={t('site.security.limits.title')}
      pills={pills}
      current="/security/limits"
    >
      <p>{t('site.security.limits.lede')}</p>
      <p>{t('site.security.limits.notBroken')}</p>

      <h2>{t('site.security.limits.safetyNumber.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.limits.safetyNumber.what"
          components={{ strong: <strong /> }}
        />
      </p>
      {/* Rule 2 above: both halves of this paragraph — the dependency AND the S3
          exception — are pinned by tests/public-pages.test.tsx. */}
      <p>
        <Trans
          i18nKey="site.security.limits.safetyNumber.unenforceable"
          components={{ strong: <strong /> }}
        />
      </p>
      <p>{t('site.security.limits.safetyNumber.narrowed')}</p>

      <h2>{t('site.security.limits.noHumanRelease.title')}</h2>
      <p>
        <Trans i18nKey="site.security.limits.noHumanRelease.mechanism" components={{ em: <em /> }} />
      </p>
      <p>
        <Trans
          i18nKey="site.security.limits.noHumanRelease.people"
          components={{ strong: <strong /> }}
        />
      </p>

      <h2>{t('site.security.limits.mobile.title')}</h2>
      <p>{t('site.security.limits.mobile.body')}</p>

      <h2>{t('site.security.limits.singleRegion.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.limits.singleRegion.body"
          components={{ strong: <strong /> }}
        />
      </p>

      <h2>{t('site.security.limits.noLoadTest.title')}</h2>
      <p>{t('site.security.limits.noLoadTest.body')}</p>

      <h2>{t('site.security.limits.noAudit.title')}</h2>
      <p>{t('site.security.limits.noAudit.body')}</p>

      <h2>{t('site.security.limits.noDefence.title')}</h2>
      <p>{t('site.security.limits.noDefence.lede')}</p>
      <ul>
        <li>
          <Trans
            i18nKey="site.security.limits.noDefence.ownSecrets"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.security.limits.noDefence.coercion"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.security.limits.noDefence.device"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.security.limits.noDefence.metadata"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.security.limits.noDefence.state"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.security.limits.noDefence.contacts"
            components={{ strong: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="site.security.limits.noDefence.falseRelease"
            components={{ strong: <strong /> }}
          />
        </li>
      </ul>
      <p>{t('site.security.limits.noDefence.notExecutor')}</p>

      <h2>{t('site.security.limits.elsewhere.title')}</h2>
      <p>
        <Trans
          i18nKey="site.security.limits.elsewhere.body"
          components={{
            threat: <Link to="/security/threat-model" />,
            winddown: <SourceLangLink to="/legal/wind-down" />,
            status: <Link to="/status" />,
          }}
        />
      </p>
    </PublicPage>
  );
}
