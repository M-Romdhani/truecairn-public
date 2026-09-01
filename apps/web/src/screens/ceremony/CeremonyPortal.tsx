import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fromBase64, toBase64 } from '@truecairn/crypto';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  affirmCeremony,
  disputeCeremony,
  getReleasedItems,
  getReleaseSalt,
  getS1Envelope,
  getShares,
  listCeremonies,
  registerRecipientEphemeral,
  reportReconstructed,
  revokeCeremony,
  type CeremonyListItem,
} from '../../ceremony/api.js';
import { discardEphemeral, loadEphemeral, loadOrCreateEphemeral } from '../../ceremony/ephemeral.js';
import { reconstructS1Item, reconstructTierItems } from '../../ceremony/reconstruct.js';
import { provideShares } from '../../ceremony/seal.js';
import { ContinuityReportPanel } from '../../components/ContinuityReportPanel.js';
import { getCeremonyContinuityReport } from '../../continuity/api.js';
import { useSession } from '../../crypto/session.js';
import { formatDateTime } from '../../lib/dates.js';
import { useT, type TFunction, type TranslationKey } from '../../i18n/useT.js';
import { useServerMessage } from '../../i18n/useServerMessage.js';

const TERMINAL = new Set(['released', 'cancelled', 'failed']);

const TIERS = ['s1', 's2', 's3'] as const;
const tierLabel = (tier: string, t: TFunction): string =>
  (TIERS as readonly string[]).includes(tier)
    ? t(`ceremony.tier.${tier as (typeof TIERS)[number]}`)
    : tier;

// A ceremony this contact can still act on. A 'released' ceremony (another
// recipient finished first) stays actionable until THIS recipient has
// reconstructed too — the temporal gate stays open server-side.
export function actionable(c: CeremonyListItem): boolean {
  if (!TERMINAL.has(c.status)) return true;
  return c.status === 'released' && c.myRecipientStatus !== 'released';
}

// A ceremony whose ephemeral keypair has no further use, so the unseal
// capability must not outlive it (docs/38 F5).
//
// This is TODAY EXACTLY `!actionable(c)` — verified exhaustively over all 28
// CeremonyStatus x RecipientReconstructionStatus combinations, and pinned by
// `ceremony-ephemeral-discard.test.tsx`. It is written out separately anyway,
// and the duplication is the point: `actionable` decides what to DISPLAY, while
// this decides whether to DESTROY a key, irreversibly. Widening `actionable`
// later is an ordinary UI change — showing recently-ended ceremonies in a
// "finished" section, say — and if key destruction hung off it, that ordinary
// change would silently stop discarding keys, or start discarding them from
// under a recipient mid-release. The equivalence test turns that from a silent
// regression into a red build somebody has to decide about.
//
// The direction that matters most: 'released' alone is NOT spent for a
// recipient who has not reconstructed yet. Their temporal gate stays open
// server-side, and re-registering a different key is rejected (the shares are
// already sealed to the first one), so discarding there strands their retrieval
// permanently.
export function spent(c: CeremonyListItem): boolean {
  if (c.status === 'cancelled' || c.status === 'failed') return true;
  return c.status === 'released' && c.myRecipientStatus === 'released';
}

// The temporal gate as the client sees it: reconstruction is available while
// the ceremony is 'reconstructing' and stays available for remaining
// recipients after the first success flips it to 'released'.
function gateOpen(c: CeremonyListItem): boolean {
  return c.status === 'reconstructing' || c.status === 'released';
}

// The 403 case is NOT the server's generic detail: "the release is not open yet"
// is a state this screen understands better than the API does, and it is the
// difference between "come back later" and "something is wrong". Everything else
// defers to useServerMessage(), which prefers the API's specific text while the
// UI is in the source language and this screen's own otherwise (docs/40).
function isNotOpenYet(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

// The contact-side release portal (CEREMONY_COMPLETION Checkpoints A + B). Polls
// for the ceremonies this contact is a recipient of, lets the contact affirm
// (possession proof), revoke a tentative affirmation, dispute the release
// ("the owner is alive"), and once the temporal gate opens, reconstruct the
// owner's content client-side. S1 opens the sealed envelope directly; S2/S3 run
// the Shamir path. "Any choice can be undone": a tentative affirmation can be
// revoked until consensus, and a dispute aborts the whole release.
export function CeremonyPortal({ fetchImpl }: { fetchImpl?: typeof fetch }): JSX.Element {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['ceremonies'],
    queryFn: () => listCeremonies(fetchImpl),
    refetchInterval: 1500, // the worker advances the ceremony in the background
  });
  const all = data?.ceremonies ?? [];
  const ceremonies = all.filter(actionable);

  // Drop the ephemeral for every ceremony this recipient is done with. This
  // lives at the LIST level on purpose: a cancelled or failed ceremony fails
  // actionable(), so its card unmounts and any discard hung off the card can
  // never run — which is precisely how the key survived a terminal ceremony
  // indefinitely. Keyed on the ids rather than the array so the 1500ms poll
  // does not re-run it; discardEphemeral is idempotent regardless.
  const { userId } = useSession();
  const spentKey = all
    .filter(spent)
    .map((c) => c.ceremonyId)
    .join(',');
  useEffect(() => {
    const scope = userId ?? 'anon';
    for (const id of spentKey === '' ? [] : spentKey.split(',')) {
      discardEphemeral(scope, id);
    }
  }, [spentKey, userId]);
  // Recovered plaintext lives HERE, not in the cards: a completed ceremony
  // drops out of the actionable list (its card unmounts), and the content the
  // contact just reconstructed must survive that.
  const [recovered, setRecovered] = useState<Record<string, string[]>>({});

  return (
    <section aria-labelledby="ceremony" className="app-col">
      <header className="page-head">
        <div>
          <div className="hint">{t('ceremony.eyebrow')}</div>
          <h1 id="ceremony" className="h-page">
            {t('ceremony.heading')}
          </h1>
          <p className="small t-2">{t('ceremony.lede')}</p>
        </div>
      </header>

      {ceremonies.length === 0 && (
        <section className="card">
          <div className="empty">
            <div className="empty-line" />
            <p className="small" data-testid="no-ceremony">
              {t('ceremony.none')}
            </p>
          </div>
        </section>
      )}

      {ceremonies.map((c) => (
        <CeremonyCard
          key={c.ceremonyId}
          ceremony={c}
          recovered={recovered[c.ceremonyId] ?? null}
          onRecovered={(contents) =>
            setRecovered((r) => ({ ...r, [c.ceremonyId]: contents }))
          }
          {...(fetchImpl !== undefined ? { fetchImpl } : {})}
        />
      ))}

      {Object.entries(recovered).map(([ceremonyId, contents]) => (
        <article
          key={ceremonyId}
          aria-label={t('ceremony.releasedContent')}
          data-testid="released-content"
          className="vault-item-body mt-md"
        >
          {contents.join('\n')}
        </article>
      ))}
    </section>
  );
}

function CeremonyCard({
  ceremony: c,
  recovered,
  onRecovered,
  fetchImpl,
}: {
  ceremony: CeremonyListItem;
  recovered: string[] | null;
  onRecovered: (contents: string[]) => void;
  fetchImpl?: typeof fetch;
}): JSX.Element {
  const t = useT();
  const serverMessage = useServerMessage();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [provided, setProvided] = useState<number | null>(null);
  const [confirmAffirm, setConfirmAffirm] = useState(false);
  const [confirmDispute, setConfirmDispute] = useState(false);
  // Release-passphrase fallback (+1 factor): revealed on demand when a contact
  // is missing. The passphrase lives in state only until reconstruct, where it
  // is encoded to bytes whose ownership passes to reconstructTierItems (zeroized).
  const [showFallback, setShowFallback] = useState(false);
  const [fallbackPass, setFallbackPass] = useState('');

  // The ceremony ephemeral key is scoped to THIS recipient so two identities in
  // one browser profile don't collide (QA 2026-07-21 D9 shared-session note).
  const { userId } = useSession();
  const ephemeralScope = userId ?? 'anon';

  const reportQ = useQuery({
    queryKey: ['ceremonies', c.ceremonyId, 'continuity-report'],
    queryFn: () => getCeremonyContinuityReport(c.ceremonyId, fetchImpl),
    retry: false,
  });
  const isShamir = c.tier !== 's1';
  const hasEphemeral = receiving || loadEphemeral(ephemeralScope, c.ceremonyId) !== null;
  const isAffirmer = c.myAffirmation !== null;
  // Can THIS recipient still work toward their own retrieval? The ceremony isn't
  // cancelled/failed and they haven't retrieved yet. Crucially this stays true
  // after the ceremony flips to 'released' (the first recipient finished) — the
  // C2 promise (QA 2026-07-21 D9): a lagging recipient must keep every control
  // (register, provide-share, reconstruct), not watch them vanish. The server
  // agrees for as long as the reconstruction gate is open.
  const canStillRetrieve =
    c.status !== 'cancelled' && c.status !== 'failed' && c.myRecipientStatus !== 'released';

  async function run(fn: () => Promise<unknown>, failure: TranslationKey): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['ceremonies'] });
    } catch (err) {
      setError(
        isNotOpenYet(err)
          ? t('ceremony.error.notOpen')
          : serverMessage(err instanceof ApiError ? err.problem.detail : undefined, failure),
      );
    } finally {
      setBusy(false);
    }
  }

  // Volunteer to receive the reconstruction on THIS device: generate (or reuse)
  // the ceremony ephemeral keypair and register its public half.
  async function onPrepareToReceive(): Promise<void> {
    await run(async () => {
      const kp = loadOrCreateEphemeral(ephemeralScope, c.ceremonyId);
      await registerRecipientEphemeral(c.ceremonyId, toBase64(kp.publicKey), fetchImpl);
      setReceiving(true);
    }, 'ceremony.error.register');
  }

  // Reconstruct the release client-side. With `releasePassphrase`, run the +1
  // fallback: fetch the owner's KDF salt and re-derive the reserved release share
  // to stand in for a contact who never sealed theirs.
  async function onReconstruct(releasePassphrase?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { items } = await getReleasedItems(c.ceremonyId, fetchImpl);
      if (c.tier === 's1') {
        const env = await getS1Envelope(c.ceremonyId, fetchImpl);
        onRecovered(items.map((it) => reconstructS1Item(env.sealedBoxCiphertext, it).content));
      } else {
        const ephemeral = loadEphemeral(ephemeralScope, c.ceremonyId);
        if (ephemeral === null) throw new Error('this device is not registered to receive');
        const shares = await getShares(c.ceremonyId, fetchImpl);
        const fallback =
          releasePassphrase !== undefined && releasePassphrase.length > 0
            ? {
                passphrase: new TextEncoder().encode(releasePassphrase),
                salt: fromBase64((await getReleaseSalt(c.ceremonyId, fetchImpl)).releasePassphraseSalt),
              }
            : undefined;
        onRecovered(reconstructTierItems(shares, ephemeral, items, fallback).contents);
        setFallbackPass('');
      }
      // The content is already recovered on this device — a failed success
      // report must not surface as a reconstruction failure. The ephemeral key
      // is discarded only AFTER the report so a retry still works.
      try {
        await reportReconstructed(c.ceremonyId, fetchImpl);
        if (c.tier !== 's1') discardEphemeral(ephemeralScope, c.ceremonyId);
      } catch {
        /* the recovered content stands; the report retries on a later visit */
      }
      await qc.invalidateQueries({ queryKey: ['ceremonies'] });
    } catch (err) {
      setError(
        isNotOpenYet(err)
          ? t('ceremony.error.notOpen')
          : serverMessage(
              err instanceof ApiError ? err.problem.detail : undefined,
              releasePassphrase !== undefined
                ? 'ceremony.error.reconstructPass'
                : 'ceremony.error.reconstruct',
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack gap-md">
      <section className="card card-pad stack gap-md" data-testid="ceremony-card">
        <div className="row gap-sm middle between">
          <span className="badge" data-testid="ceremony-tier">
            {tierLabel(c.tier, t)}
          </span>
          <span className="badge accent" data-testid="ceremony-status">
            {c.status}
          </span>
        </div>

        {reportQ.data != null && (
          <ContinuityReportPanel
            report={reportQ.data.report}
            generatedAt={reportQ.data.generatedAt}
            narration={reportQ.data.narration ?? null}
          />
        )}

        {isShamir && canStillRetrieve && !hasEphemeral && (
          <div className="row">
            <button
              type="button"
              className="btn secondary"
              data-testid="prepare-to-receive"
              disabled={busy}
              onClick={() => void onPrepareToReceive()}
            >
              {t('ceremony.receive')}
            </button>
          </div>
        )}
        {isShamir && hasEphemeral && c.status !== 'reconstructing' && (
          <p data-testid="receiving" className="small t-2">
            {t('ceremony.receiving')}
          </p>
        )}

        {c.status === 'collecting_affirmations' && c.myAffirmation === 'pending' && (
          <div className="stack gap-sm">
            {!confirmAffirm && (
              <div className="row">
                <button
                  type="button"
                  className="btn primary"
                  data-testid="affirm-btn"
                  disabled={busy}
                  onClick={() => setConfirmAffirm(true)}
                >
                  {t('ceremony.affirm')}
                </button>
              </div>
            )}
            {confirmAffirm && (
              <div className="stack gap-sm">
                <p className="hint" data-testid="affirm-confirm-text">
                  {t('ceremony.affirm.confirmText')}
                </p>
                <div className="row gap-sm">
                  <button
                    type="button"
                    className="btn primary"
                    data-testid="affirm-confirm-btn"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await affirmCeremony(c.ceremonyId, fetchImpl);
                        setConfirmAffirm(false);
                      }, 'ceremony.error.affirm')
                    }
                  >
                    {t('ceremony.affirm.yes')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    data-testid="affirm-cancel-btn"
                    disabled={busy}
                    onClick={() => setConfirmAffirm(false)}
                  >
                    {t('ceremony.affirm.notNow')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {c.status === 'collecting_affirmations' && c.myAffirmation === 'tentative' && (
          <div className="stack gap-sm">
            <p data-testid="affirmed" className="small t-2">
              {c.myRevocationWindowExpiresAt !== null
                ? t('ceremony.affirmed.until', {
                    when: formatDateTime(c.myRevocationWindowExpiresAt),
                  })
                : t('ceremony.affirmed.limited')}
            </p>
            <div className="row">
              <button
                type="button"
                className="btn ghost sm"
                data-testid="revoke-btn"
                disabled={busy}
                onClick={() =>
                  void run(() => revokeCeremony(c.ceremonyId, fetchImpl), 'ceremony.error.revoke')
                }
              >
                {t('ceremony.revoke')}
              </button>
            </div>
          </div>
        )}

        {/* QA 2026-07-21 D5: the tentative block used to just vanish when the
            window closed, which read as a silent no-op. Say what happened, and
            point at the protective action that IS still available. */}
        {c.myAffirmation === 'committed' && !TERMINAL.has(c.status) && (
          <p data-testid="affirmation-committed" className="small t-2">
            {t('ceremony.committed')}
          </p>
        )}

        {isShamir &&
          (c.myAffirmation === 'tentative' || c.myAffirmation === 'committed') &&
          canStillRetrieve && (
            <div className="stack gap-sm">
              <div className="row">
                <button
                  type="button"
                  className="btn secondary"
                  data-testid="provide-share-btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const count = await provideShares(c.ceremonyId, fetchImpl);
                      setProvided(count);
                    }, 'ceremony.error.provideShare')
                  }
                >
                  {t('ceremony.provideShare')}
                </button>
              </div>
              {provided !== null && (
                <p data-testid="share-provided" className="small t-2">
                  {t('ceremony.shareProvided', { count: provided })}
                </p>
              )}
            </div>
          )}

        {gateOpen(c) && (c.tier === 's1' || hasEphemeral) && recovered === null && (
          <div className="stack gap-sm">
            {/* S1 + S2 reconstruct directly. S3 (nested, docs/24) ALWAYS needs
                the release passphrase, so its only path is the form below. */}
            {c.tier !== 's3' && (
              <div className="row">
                <button
                  type="button"
                  className="btn primary"
                  data-testid="reconstruct-btn"
                  disabled={busy}
                  onClick={() => void onReconstruct()}
                >
                  {t('ceremony.reconstruct')}
                </button>
              </div>
            )}

            {/* S3: the owner's offline release passphrase is REQUIRED — any 2 of
                3 contacts' shares plus the passphrase reconstruct; contacts
                alone never can. */}
            {c.tier === 's3' && (
              <div className="stack gap-sm">
                <p className="hint">
                  {t('ceremony.s3.hint')}
                </p>
                <div className="field">
                  <label className="field-label" htmlFor={`recon-release-pass-${c.ceremonyId}`}>
                    {t('ceremony.releasePassphrase')}
                  </label>
                  <input
                    id={`recon-release-pass-${c.ceremonyId}`}
                    className="input"
                    type="password"
                    autoComplete="off"
                    data-testid="s3-release-pass"
                    value={fallbackPass}
                    onChange={(e) => setFallbackPass(e.target.value)}
                  />
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="btn primary"
                    data-testid="s3-reconstruct"
                    disabled={busy || fallbackPass.length === 0}
                    onClick={() => void onReconstruct(fallbackPass)}
                  >
                    {t('ceremony.reconstruct')}
                  </button>
                </div>
              </div>
            )}

            {/* S2 only: optional +1 fallback when a contact is missing. */}
            {c.tier === 's2' && (
              <div className="stack gap-sm">
                <button
                  type="button"
                  className="btn ghost sm"
                  data-testid="use-release-passphrase"
                  onClick={() => setShowFallback((v) => !v)}
                >
                  {t('ceremony.s2.toggle')}
                </button>
                {showFallback && (
                  <div className="stack gap-sm">
                    <p className="hint">
                      {t('ceremony.s2.hint')}
                    </p>
                    <div className="field">
                      <label className="field-label" htmlFor={`recon-release-pass-s2-${c.ceremonyId}`}>
                        {t('ceremony.releasePassphrase')}
                      </label>
                      <input
                        id={`recon-release-pass-s2-${c.ceremonyId}`}
                        className="input"
                        type="password"
                        autoComplete="off"
                        value={fallbackPass}
                        onChange={(e) => setFallbackPass(e.target.value)}
                      />
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="btn secondary"
                        data-testid="s2-fallback-reconstruct"
                        disabled={busy || fallbackPass.length === 0}
                        onClick={() => void onReconstruct(fallbackPass)}
                      >
                        {t('ceremony.s2.reconstruct')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Dispute — the protective abort. Available to any affirming contact at
            any live stage: "the owner is alive" cancels the release and sends
            the account to review. */}
        {isAffirmer && !TERMINAL.has(c.status) && (
          <div className="stack gap-sm">
            {!confirmDispute && (
              <div className="row">
                <button
                  type="button"
                  className="btn ghost sm danger"
                  data-testid="dispute-btn"
                  disabled={busy}
                  onClick={() => setConfirmDispute(true)}
                >
                  {t('ceremony.dispute')}
                </button>
              </div>
            )}
            {confirmDispute && (
              <div className="stack gap-sm">
                <p className="hint" data-testid="dispute-confirm-text">
                  {t('ceremony.dispute.confirmText')}
                </p>
                <div className="row gap-sm">
                  <button
                    type="button"
                    className="btn secondary"
                    data-testid="dispute-confirm-btn"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await disputeCeremony(c.ceremonyId, fetchImpl);
                        setConfirmDispute(false);
                      }, 'ceremony.error.dispute')
                    }
                  >
                    {t('ceremony.dispute.yes')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    data-testid="dispute-cancel-btn"
                    disabled={busy}
                    onClick={() => setConfirmDispute(false)}
                  >
                    {t('ceremony.dispute.goBack')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {error !== null && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  );
}
