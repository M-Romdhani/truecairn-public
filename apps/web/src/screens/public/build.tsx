import { useEffect, useState } from 'react';
import { Trans } from 'react-i18next';
import { PublicPage } from '../../site/PublicPage.js';
import { REPO_URL } from '../../site/links.js';
import { useSecurityPills } from '../../site/security-pills.js';
import { useT } from '../../i18n/useT.js';

// The build-provenance page (2026-07-25).
//
// Truecairn's central claim is that the server never sees plaintext — but every
// byte of crypto that makes that true is JavaScript this server hands your
// browser. This page exists to be honest about that, and to give a reader
// something concrete to check rather than a promise to believe.
//
// It deliberately does NOT overstate. The digest is computed by code served from
// the same origin as the bundle it describes, so a fully compromised origin
// could lie here too. What independent rebuilds change is the economics:
// silent, targeted, deniable tampering becomes tampering that has to survive
// comparison against a build someone else ran from published source.
// Every sentence below is written to leave the reader with that accurate model.
//
// CORRECTED 2026-08-09 (QA P1-3). This page used to instruct the reader to "find
// the release matching the commit above and open its build attestation". There
// are no releases and no tags — release.yml is real but has never been triggered
// — so the one surface built to be checked adversarially was describing a
// capability that did not exist, and the first researcher to follow those steps
// would have found nothing. The instructions now describe only what a reader can
// actually do TODAY (rebuild the published source and compare), and the page
// says plainly that signed per-release attestation is not yet published. When
// the first tag ships, add the attestation step back — do not re-add it early.

interface Manifest {
  commit: string;
  ref: string;
  builtAt: string;
  bundleDigest: string;
  assetCount: number;
  assets: Record<string, string>;
}

export function BuildProvenance(): JSX.Element {
  const t = useT();
  const pills = useSecurityPills();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/build-manifest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m: Manifest) => {
        if (live) setManifest(m);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <PublicPage
      eyebrow={t('site.build.eyebrow')}
      title={t('site.build.title')}
      pills={pills}
      current="/security/build"
    >
      <p>{t('site.build.lede')}</p>

      <h2>{t('site.build.what.title')}</h2>
      <p>
        <Trans i18nKey="site.build.what.body" components={{ strong: <strong /> }} />
      </p>
      <p>
        <Trans i18nKey="site.build.notShipped" components={{ strong: <strong /> }} />
      </p>

      {failed && (
        <div className="pub-empty">
          <p>
            <Trans i18nKey="site.build.noManifest" components={{ code: <code /> }} />
          </p>
        </div>
      )}

      {manifest !== null && (
        <>
          <h2>{t('site.build.bundle.title')}</h2>
          <table>
            <tbody>
              <tr>
                <th scope="row">{t('site.build.bundle.digest')}</th>
                <td>
                  <code style={{ wordBreak: 'break-all' }}>{manifest.bundleDigest}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">{t('site.build.bundle.commit')}</th>
                <td>
                  <code>{manifest.commit}</code>
                </td>
              </tr>
              {/* Labelled "ref", not "Release": in production this is the branch
                  the deploy built from, because no release has been tagged. Calling
                  a branch name a release is the same overclaim this page exists to
                  avoid, in a table cell. The catalog carries the same note. */}
              <tr>
                <th scope="row">{t('site.build.bundle.ref')}</th>
                <td>
                  <code>{manifest.ref}</code>
                </td>
              </tr>
              <tr>
                <th scope="row">{t('site.build.bundle.builtAt')}</th>
                <td>{manifest.builtAt}</td>
              </tr>
              <tr>
                <th scope="row">{t('site.build.bundle.files')}</th>
                <td>{manifest.assetCount}</td>
              </tr>
            </tbody>
          </table>

          <h2>{t('site.build.check.title')}</h2>
          {REPO_URL === null ? (
            <p>{t('site.build.check.unpublished')}</p>
          ) : (
            <>
              <ol>
                <li>
                  <Trans
                    i18nKey="site.build.check.step1"
                    components={{ repo: <a href={REPO_URL} rel="noreferrer" /> }}
                  />
                </li>
                <li>
                  <Trans i18nKey="site.build.check.step2" components={{ code: <code /> }} />
                </li>
                <li>
                  <Trans i18nKey="site.build.check.step3" components={{ code: <code /> }} />
                </li>
              </ol>
              <p>
                <Trans i18nKey="site.build.check.mismatch" components={{ strong: <strong /> }} />
              </p>
            </>
          )}

          <h2>{t('site.build.proves.title')}</h2>
          <p>
            <Trans i18nKey="site.build.proves.does" components={{ strong: <strong /> }} />
          </p>
          <p>
            <Trans i18nKey="site.build.proves.doesNot" components={{ strong: <strong /> }} />
          </p>
          <p>
            <Trans i18nKey="site.build.proves.unchecked" components={{ strong: <strong /> }} />
          </p>

          <h2>{t('site.build.files.title')}</h2>
          <p>
            <button type="button" className="btn" onClick={() => setShowAll((v) => !v)}>
              {showAll
                ? t('site.build.files.hide')
                : t('site.build.files.show', { count: manifest.assetCount })}
            </button>
          </p>
          {showAll && (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('site.build.files.colFile')}</th>
                    <th scope="col">{t('site.build.files.colHash')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(manifest.assets).map(([path, hash]) => (
                    <tr key={path}>
                      <td>
                        <code>{path}</code>
                      </td>
                      <td>
                        <code style={{ wordBreak: 'break-all' }}>{hash}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </PublicPage>
  );
}
