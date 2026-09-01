import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EngineState } from '@truecairn/shared';
import { useState } from 'react';
import { Trans } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  armEngine,
  cancelRelease,
  cancelSensitiveAction,
  checkIn,
  confirmReturn,
  getEngineStatus,
  getReleaseProgress,
  resolveReview,
  snooze,
} from '../../engine/api.js';
import { LivenessLadder } from './LivenessLadder.js';
import { ReleaseProgressPanel } from './ReleaseProgressPanel.js';
import { AiDisclosure } from '../../ai/AiDisclosure.js';
import { ContinuityReportPanel } from '../../components/ContinuityReportPanel.js';
import { getVerificationStatus } from '../../continuity/api.js';
import { formatDateTime } from '../../lib/dates.js';
import { engineStateLabel } from '../../engine/states.js';
import { useT, type TFunction, type TranslationKey } from '../../i18n/useT.js';

// Human labels for the pending-actions list (QA Pass 2 Finding B: a raw
// `add_contact` read as "a contact is still being added" when the contact was
// long enrolled — what's actually pending is the 7-day-delayed grant). Unknown
// types fall back to the raw name rather than hiding anything.
const LABELLED_ACTIONS = [
  'add_contact',
  'remove_contact',
  'remove_channel',
  'change_contact_role',
  'rotate_contact',
  'designate_beneficiary',
  'remove_beneficiary',
  'change_share_composition',
  'change_tier_configuration',
  'change_inactivity_threshold',
  'change_cooldown_window',
  'rotate_master_passphrase',
  'rotate_release_passphrase',
  'rotate_recovery_code',
  'register_hardware_key',
  'remove_hardware_key',
  'change_email',
  'arm_engine',
  'delete_account',
  'set_vault_item_tier',
  'delete_vault_item',
  'purge_attachment',
] as const;

// An unknown action type falls back to its raw name rather than hiding anything:
// a pending change the owner cannot see is worse than one labelled awkwardly.
function actionLabel(actionType: string, t: TFunction): string {
  return (LABELLED_ACTIONS as readonly string[]).includes(actionType)
    ? t(`engine.action.${actionType as (typeof LABELLED_ACTIONS)[number]}`)
    : actionType;
}

// The continuity-engine dashboard (PHASE4 C5B). Shows the engine state, the next
// automatic step, and any pending (cancellable) sensitive actions, and offers the
// user-initiated ops gated EXACTLY as the server gates them:
//   • escalation_pending — contacts already notified. We show the escalating state
//     and offer ONLY a deliberate "Acknowledge and check in" (sends the ack). There
//     is NO routine check-in in this state, so a one-tap can't silently clear an
//     escalation (the 3.4 deliberate-dismissal property, at the UI layer).
//   • release ladder — the protective "Cancel release" via the passkey fresh-factor
//     tap (C5A primitive). full_release is terminal (the engine can't un-release).
const RELEASE_STATES: ReadonlySet<EngineState> = new Set<EngineState>([
  'release_review',
  'limited_release',
  'staged_release',
]);
const ROUTINE_CHECKIN_STATES: ReadonlySet<EngineState> = new Set<EngineState>([
  'active',
  'check_in_pending',
  'notification_stalled',
]);

// Owner-facing names + plain "what's at stake" copy for each rung of the release
// ladder (PHASE4 C6 increment). release_review is the consensus hold — nothing is
// out yet; limited/staged release have progressively handed over tiers.
const RELEASE_STAGES = ['release_review', 'limited_release', 'staged_release'] as const;
type ReleaseStage = (typeof RELEASE_STAGES)[number];
const isReleaseStage = (state: string): state is ReleaseStage =>
  (RELEASE_STAGES as readonly string[]).includes(state);

export function EngineDashboard({
  fetchImpl,
  proveSecondFactor,
}: {
  fetchImpl?: typeof fetch;
  proveSecondFactor?: (accepted: string[]) => Promise<void>;
}): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [snoozeDays, setSnoozeDays] = useState(7);

  const { data, isLoading } = useQuery({
    queryKey: ['engine-status'],
    queryFn: () => getEngineStatus(fetchImpl),
  });
  // The owner's live Continuity Verification view (docs/26). Resolves to null
  // when the feature is off (404) or unavailable — the card simply hides.
  const verificationQ = useQuery({
    queryKey: ['verification-status'],
    queryFn: () => getVerificationStatus(fetchImpl),
    retry: false,
  });
  // The owner's live release-progress view. Fail-soft like the verification
  // panel: a fetch failure hides the card, never breaks the safety screen.
  const progressQ = useQuery({
    queryKey: ['release-progress'],
    queryFn: () => getReleaseProgress(fetchImpl),
    retry: false,
  });

  // The failure is a message KEY, not a rendered sentence: an error already on
  // screen must re-render when the language changes.
  async function run(fn: () => Promise<unknown>, failure: TranslationKey): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['engine-status'] });
      // The live verification panel reads the same engine facts (last check-in,
      // window) — refresh it too, or "Last confirmed active" shows the stale
      // value right after a check-in (QA 2026-07-17).
      await qc.invalidateQueries({ queryKey: ['verification-status'] });
      // A check-in / cancel-release cancels live ceremonies — refresh the
      // progress panel so it shows the cancellation, not a stale countdown.
      await qc.invalidateQueries({ queryKey: ['release-progress'] });
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  if (isLoading || data === undefined) return <p className="small t-2">{t('engine.loading')}</p>;
  const state = data.state;
  // Arm prerequisite (audit B2): the server refuses to arm without an enrolled
  // contact, so mirror that gate on the button rather than letting the click 409.
  const noEnrolledContact = data.enrolledContactCount === 0;
  const isEscalating = state === 'escalation_pending';
  const isRelease = state !== null && RELEASE_STATES.has(state);
  const stateBadge = isRelease ? 'danger' : isEscalating ? 'warning' : state === 'active' ? 'success' : '';

  return (
    <section aria-labelledby="engine">
      <header className="page-head">
        <div>
          <div className="hint">{t('engine.eyebrow')}</div>
          <h1 id="engine" className="h-page">
            {t('engine.heading')}
          </h1>
          <p className="small t-2">{t('engine.lede')}</p>
        </div>
        <div className="row gap-sm middle">
          {/* Was `{state ?? 'not_armed'}` — the bare enum, so an owner in
              check_in_pending read "check_in_pending" on the one screen whose job
              is telling them what the engine is doing. */}
          <span className={`badge ${stateBadge}`} data-testid="engine-state">
            {engineStateLabel(state, t)}
          </span>
        </div>
      </header>

      <div className="stack gap-md">
        <LivenessLadder state={state} />

        {/* Unarmed engine (audit B2): the status pill alone reads as a raw enum
            ("not_armed"/"pre_active"). Explain in plain language what that means
            and what unlocks the check-in controls, instead of a bare code. */}
        {(state === null || state === 'pre_active') && (
          <section className="card card-pad stack gap-md" data-testid="engine-unarmed">
            <div className="stack gap-sm">
              <p className="h-sub">{t('engine.unarmed.heading')}</p>
              <p className="small t-2">{t('engine.unarmed.body')}</p>
              {noEnrolledContact && (
                // Why the Arm button is unavailable — a prominent callout, not a
                // subtle note, so a disabled button never reads as a silent failure
                // (QA Finding 1). It links straight to the fix.
                <p className="alert info" role="status" data-testid="arm-prereq">
                  <Trans
                    i18nKey="engine.unarmed.prereq"
                    components={{ contacts: <Link to="/contacts" /> }}
                  />
                </p>
              )}
            </div>
            <div className="row gap-sm middle">
              <button
                type="button"
                className="btn primary"
                disabled={busy || noEnrolledContact}
                onClick={() => void run(() => armEngine(fetchImpl), 'engine.error.arm')}
              >
                {busy ? t('engine.unarmed.arming') : t('engine.unarmed.arm')}
              </button>
              <Link className="btn secondary sm" to="/home">
                {t('engine.unarmed.setup')}
              </Link>
            </div>
          </section>
        )}

        {((!isRelease && data.nextActionAt !== null) || data.snoozeUntil !== null) && (
          <section className="card card-pad stack gap-sm">
            {!isRelease && data.nextActionAt !== null && (
              <p data-testid="next-action" className="small t-2">
                {t('engine.nextAction', { when: formatDateTime(data.nextActionAt) })}
              </p>
            )}
            {data.snoozeUntil !== null && (
              <p data-testid="snooze-until" className="small t-2">
                {t('engine.snoozedUntil', { when: formatDateTime(data.snoozeUntil) })}
              </p>
            )}
          </section>
        )}

        {isEscalating && (
          <section className="card card-pad stack gap-md" role="alert" data-testid="escalation-warning">
            <p className="body">{t('engine.escalating.body')}</p>
            <div className="row">
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => checkIn({ acknowledgedState: 'escalation_pending' }, fetchImpl),
                    'engine.error.checkIn',
                  )
                }
              >
                {t('engine.escalating.ack')}
              </button>
            </div>
          </section>
        )}

        {state !== null && ROUTINE_CHECKIN_STATES.has(state) && (
          <section className="card card-pad row between middle gap-md">
            <div className="stack min-w-0">
              <div className="row-title">{t('engine.checkin.title')}</div>
              <div className="small t-2">{t('engine.checkin.sub')}</div>
            </div>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void run(() => checkIn({}, fetchImpl), 'engine.error.checkIn')}
            >
              {t('engine.checkin.action')}
            </button>
          </section>
        )}

        {state === 'check_in_pending' && (
          <section className="card card-pad stack gap-md">
            <div className="field">
              <label className="field-label" htmlFor="snooze-days">
                {t('engine.snooze.label')}
              </label>
              <input
                id="snooze-days"
                className="input"
                type="number"
                min={1}
                value={snoozeDays}
                onChange={(e) => setSnoozeDays(Number(e.target.value))}
              />
            </div>
            <div className="row">
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => void run(() => snooze(snoozeDays, fetchImpl), 'engine.error.snooze')}
              >
                {t('engine.snooze.action')}
              </button>
            </div>
          </section>
        )}

        {isRelease && state !== null && (
          <section className="card card-pad stack gap-sm" role="alert" data-testid="release-warning">
            <p data-testid="release-stage" className="h-sub">
              {isReleaseStage(state) ? t(`engine.release.stage.${state}.name`) : state}
            </p>
            <p className="small t-2">
              {isReleaseStage(state) ? t(`engine.release.stage.${state}.atStake`) : ''}
            </p>
            {data.nextActionAt !== null && (
              <p data-testid="release-next" className="small t-3">
                {t('engine.release.next', { when: formatDateTime(data.nextActionAt) })}
              </p>
            )}
            <p className="body">{t('engine.release.warning')}</p>
            <div className="row">
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      cancelRelease({
                        proveSecondFactor:
                          proveSecondFactor ??
                          ((): Promise<void> =>
                            Promise.reject(new Error('second-factor prompt not wired'))),
                        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
                      }),
                    'engine.error.cancelRelease',
                  )
                }
              >
                {t('engine.release.cancel')}
              </button>
            </div>
          </section>
        )}

        {state === 'returning' && (
          <section className="card card-pad stack gap-md" role="alert" data-testid="returning">
            <p className="h-sub">{t('engine.returning.heading')}</p>
            <p className="body">
              <Trans i18nKey="engine.returning.body" components={{ strong: <strong /> }} />
            </p>
            <p className="small t-2">
              <Trans
                i18nKey="engine.returning.expiry"
                values={{
                  when:
                    data.nextActionAt !== null
                      ? t('engine.returning.expiryWhen', {
                          when: formatDateTime(data.nextActionAt),
                        })
                      : '',
                }}
                components={{ strong: <strong /> }}
              />
            </p>
            <div className="row">
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                data-testid="confirm-return-btn"
                onClick={() =>
                  void run(
                    () =>
                      confirmReturn({
                        proveSecondFactor:
                          proveSecondFactor ??
                          ((): Promise<void> =>
                            Promise.reject(new Error('second-factor prompt not wired'))),
                        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
                      }),
                    'engine.error.confirmReturn',
                  )
                }
              >
                {t('engine.returning.confirm')}
              </button>
            </div>
          </section>
        )}

        {state === 'review_required' && (
          <section className="card card-pad stack gap-md" role="alert" data-testid="review-required">
            <p className="h-sub">{t('engine.review.heading')}</p>
            <p className="body">
              <Trans i18nKey="engine.review.body" components={{ strong: <strong /> }} />
            </p>
            <p className="small t-2">{t('engine.review.sub')}</p>
            <div className="row">
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                data-testid="resolve-review-btn"
                onClick={() =>
                  void run(
                    () =>
                      resolveReview({
                        proveSecondFactor:
                          proveSecondFactor ??
                          ((): Promise<void> =>
                            Promise.reject(new Error('second-factor prompt not wired'))),
                        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
                      }),
                    'engine.error.resolveReview',
                  )
                }
              >
                {t('engine.review.resolve')}
              </button>
            </div>
          </section>
        )}

        <ReleaseProgressPanel ceremonies={progressQ.data?.ceremonies ?? []} />

        {data.pendingSensitiveActions.length > 0 && (
          <section className="card">
            <header className="card-h">
              <div>
                <h2 className="h-section">{t('engine.pending.heading')}</h2>
                <p className="small">{t('engine.pending.sub')}</p>
              </div>
            </header>
            <ul className="list">
              {data.pendingSensitiveActions.map((a) => (
                <li key={a.id} className="list-row" data-testid={`pending-action-${a.id}`}>
                  <div className="stack flex-1 min-w-0">
                    <div className="row-title">
                      {actionLabel(a.actionType, t)}
                      {a.initiatedBy === 'ai' && (
                        <span className="badge warning" style={{ marginLeft: 8 }}>
                          <span className="dot" /> {t('engine.pending.aiBadge')}
                        </span>
                      )}
                    </div>
                    <div className="small t-2">
                      {/* One message per case rather than a translated prefix
                          glued onto a translated sentence: the join is a
                          punctuation and word-order decision the translator has
                          to be able to make. */}
                      {a.initiatedBy === 'ai'
                        ? t('engine.pending.effectiveAi', {
                            when: formatDateTime(a.effectiveAt),
                          })
                        : t('engine.pending.effective', { when: formatDateTime(a.effectiveAt) })}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => cancelSensitiveAction(a.id, fetchImpl),
                        'engine.error.cancelAction',
                      )
                    }
                  >
                    {t('engine.pending.cancel')}
                  </button>
                </li>
              ))}
            </ul>
            {data.pendingSensitiveActions.some((a) => a.initiatedBy === 'ai') && (
              <div className="card-pad">
                <AiDisclosure />
              </div>
            )}
          </section>
        )}

        {verificationQ.data != null && (
          <ContinuityReportPanel report={verificationQ.data} live suppressRecovery={isRelease} />
        )}

        {error !== null && (
          <p role="alert" className="alert">
            {t(error)}
          </p>
        )}
      </div>
    </section>
  );
}
