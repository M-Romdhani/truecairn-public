import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HONORIFIC_TITLES } from '@truecairn/shared';
import { requestAccountDeletion, updateProfile } from '../../account/api.js';
import {
  addChannel,
  fetchChannelPreferences,
  fetchChannels,
  removeChannel,
  requestChannelRemoval,
  setChannelPreference,
  subscribeThisBrowser,
  verifyChannel,
  type ChannelInfo,
  type EnrollableChannelType,
  type PurposeClass,
} from '../../account/channels.js';
import { fetchAccount } from '../../account/keyMaterial.js';
import { getEngineStatus, setCheckInCadence } from '../../engine/api.js';
import { AuditTrail } from './AuditTrail.js';
import './settings.css';
import { fetchAiAutonomy, fetchAiOptOut, setAiAutonomy, setAiOptOut } from '../../ai/api.js';
import { AiDisclosure } from '../../ai/AiDisclosure.js';
import { useSignOut } from '../../auth/useSignOut.js';
import { useSession } from '../../crypto/session.js';
import { formatDateTime } from '../../lib/dates.js';
import { Trans } from 'react-i18next';
import { LanguagePicker, hasLanguageChoice } from '../../i18n/LanguagePicker.js';
import { useT, type TranslationKey } from '../../i18n/useT.js';

// The word typed to confirm account deletion. A CONSTANT, and deliberately NOT a
// translated string: it is compared against what the user typed, and translating
// one side of that comparison without the other leaves the button permanently
// disabled for that language — a bug that only appears for readers of the
// language nobody testing the feature reads. Both the placeholder and the
// instruction interpolate this same value, so the word shown and the word
// required cannot drift.
//
// It stays English on purpose. Translating it AND the comparison together would
// work, but it would mean the confirmation word changes when the language does —
// so a user who set up in one language and confirms in another would be told to
// type a word that no longer matches what they remember.
const DELETE_CONFIRM_WORD = 'DELETE';

// Account settings (design follow-on). Two real account actions the client owns:
// LOCK (wipe the master key from memory, keep the session) and SIGN OUT (end the
// server session + wipe the key). Sign-out lives in the shared useSignOut hook so
// Settings and the sidebar account menu run the exact same flow. Account deletion
// (QA Pass 3 Finding C) enqueues the delete_account sensitive action: step-up +
// 7-day delay, cancellable from the Engine page. The rest is flagged as
// not-yet-built rather than faked. Rendered inside AppShell.
export function Settings({
  proveSecondFactor,
  fetchImpl,
}: {
  proveSecondFactor?: (accepted: string[]) => Promise<void>;
  fetchImpl?: typeof fetch;
} = {}): JSX.Element {
  const t = useT();
  const { lock, userId } = useSession();
  const { signOut, signingOut } = useSignOut();
  const queryClient = useQueryClient();
  const accountQ = useQuery({ queryKey: ['account', 'me'], queryFn: () => fetchAccount() });
  const aiOptOutQ = useQuery({ queryKey: ['account', 'ai-opt-out'], queryFn: () => fetchAiOptOut() });
  const aiOptOutM = useMutation({
    mutationFn: (optOut: boolean) => setAiOptOut(optOut),
    onSuccess: (res) => queryClient.setQueryData(['account', 'ai-opt-out'], res),
  });
  const optedOut = aiOptOutM.isPending
    ? aiOptOutM.variables === true
    : (aiOptOutQ.data?.optOut ?? false);

  // AI autonomy opt-in (Phase 2): per-user, off by default, with a check-in floor.
  const autonomyQ = useQuery({ queryKey: ['account', 'ai-autonomy'], queryFn: () => fetchAiAutonomy() });
  const autonomyM = useMutation({
    mutationFn: (settings: { enabled: boolean; checkinFloorDays: number | null }) =>
      setAiAutonomy(settings),
    onSuccess: (res) => queryClient.setQueryData(['account', 'ai-autonomy'], res),
  });
  const autonomyOn = autonomyQ.data?.enabled ?? false;
  const [floorInput, setFloorInput] = useState<string>('');
  const currentFloor = autonomyQ.data?.checkinFloorDays ?? null;

  // Account deletion (QA Pass 3 Finding C): type-to-confirm, then step-up.
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deletePendingAt, setDeletePendingAt] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Check-in cadence ──────────────────────────────────────────────────────
  // Enqueue only. The current value governs for the whole delay, so this screen
  // shows what is in force AND what is queued, and never conflates the two.
  const engineQ = useQuery({ queryKey: ['engine-status'], queryFn: () => getEngineStatus(fetchImpl) });
  const currentCadence = engineQ.data?.inactivityThresholdDays ?? null;
  const cadencePending = (engineQ.data?.pendingSensitiveActions ?? []).find(
    (a) => a.actionType === 'change_inactivity_threshold',
  );
  const [cadenceDays, setCadenceDays] = useState('');
  const [cadenceBusy, setCadenceBusy] = useState(false);
  const [cadenceError, setCadenceError] = useState<TranslationKey | null>(null);
  const parsedCadence = Number.parseInt(cadenceDays, 10);
  const cadenceValid =
    Number.isInteger(parsedCadence) &&
    parsedCadence >= 1 &&
    parsedCadence <= 365 &&
    parsedCadence !== currentCadence;

  async function onSaveCadence(): Promise<void> {
    if (userId === null || !cadenceValid) return;
    setCadenceError(null);
    setCadenceBusy(true);
    try {
      await setCheckInCadence(parsedCadence, {
        userId,
        proveSecondFactor:
          proveSecondFactor ??
          ((): Promise<void> => Promise.reject(new Error('second-factor prompt not wired'))),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
      setCadenceDays('');
      await queryClient.invalidateQueries({ queryKey: ['engine-status'] });
    } catch {
      setCadenceError('settings.cadence.error');
    } finally {
      setCadenceBusy(false);
    }
  }

  async function onDeleteAccount(): Promise<void> {
    if (userId === null || deleteConfirm !== DELETE_CONFIRM_WORD) return;
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      const result = await requestAccountDeletion({
        userId,
        proveSecondFactor:
          proveSecondFactor ??
          ((): Promise<void> => Promise.reject(new Error('second-factor prompt not wired'))),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
      setDeletePendingAt(result.effectiveAt);
      setDeleteConfirm('');
    } catch {
      setDeleteError(t('settings.delete.error'));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <div className="hint">{t('settings.eyebrow')}</div>
          <h1 className="h-page">{t('settings.heading')}</h1>
          <p className="small t-2">{t('settings.lede')}</p>
        </div>
      </header>

      <div className="stack gap-md">
        <ProfileCard />

        <section className="card">
          <header className="card-h">
            <div>
              <h2 className="h-section">{t('settings.session.heading')}</h2>
              <p className="small">{t('settings.session.sub')}</p>
            </div>
          </header>
          <div className="card-pad stack gap-md">
            <div className="stack min-w-0">
              <div className="hint">{t('settings.session.signedInAs')}</div>
              <div className="row-title" data-testid="account-email">
                {accountQ.data?.email ?? '—'}
              </div>
            </div>
            <div className="row between middle gap-md">
              <div className="stack min-w-0">
                <div className="row-title">{t('settings.session.unlocked')}</div>
                <div className="small t-2">{t('settings.session.explain')}</div>
              </div>
              <div className="row gap-sm middle">
                <button type="button" className="btn secondary" onClick={() => lock()}>
                  {t('settings.session.lock')}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={signingOut}
                  onClick={() => void signOut()}
                >
                  {signingOut ? t('settings.session.signingOut') : t('settings.session.signOut')}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <header className="card-h">
            <div>
              <h2 className="h-section">{t('settings.ai.heading')}</h2>
              <AiDisclosure className="t-2" />
            </div>
          </header>
          <div className="card-pad">
            <div className="row between middle gap-md">
              <div className="stack min-w-0">
                <div className="row-title">{t('settings.ai.optOut.title')}</div>
                <div className="small t-2">{t('settings.ai.optOut.sub')}</div>
              </div>
              {/* Segmented on/off rather than a checkbox: the setting is a state,
                  and both AI rows use the same fixed-width control so their right
                  edges line up. The value shown is the AI's state — "AI on" means
                  not opted out. */}
              <div
                className={`toggle-seg${aiOptOutM.isPending ? ' is-busy' : ''}`}
                role="group"
                aria-label={t('settings.ai.optOut.group')}
              >
                <button
                  type="button"
                  data-testid="ai-opt-out-on"
                  aria-pressed={!optedOut}
                  disabled={aiOptOutQ.isLoading || aiOptOutM.isPending}
                  onClick={() => {
                    if (optedOut) aiOptOutM.mutate(false);
                  }}
                >
                  {t('settings.ai.on')}
                </button>
                <button
                  type="button"
                  data-testid="ai-opt-out-off"
                  aria-pressed={optedOut}
                  disabled={aiOptOutQ.isLoading || aiOptOutM.isPending}
                  onClick={() => {
                    if (!optedOut) aiOptOutM.mutate(true);
                  }}
                >
                  {t('settings.ai.off')}
                </button>
              </div>
            </div>

            {/* AI autonomy opt-in (Phase 2): off by default; the AI may only ever
                tighten (never loosen), and every action is vetoable during a delay. */}
            <div className="row between middle gap-md mt-md" style={{ opacity: optedOut ? 0.5 : 1 }}>
              <div className="stack min-w-0">
                <div className="row-title">{t('settings.ai.autonomy.title')}</div>
                <div className="small t-2">{t('settings.ai.autonomy.sub')}</div>
              </div>
              <div
                className={`toggle-seg${autonomyM.isPending ? ' is-busy' : ''}`}
                role="group"
                aria-label={t('settings.ai.autonomy.group')}
              >
                <button
                  type="button"
                  data-testid="ai-autonomy-on"
                  aria-pressed={autonomyOn}
                  disabled={optedOut || autonomyQ.isLoading || autonomyM.isPending}
                  onClick={() => {
                    if (!autonomyOn) autonomyM.mutate({ enabled: true, checkinFloorDays: currentFloor });
                  }}
                >
                  {t('settings.ai.autonomy.on')}
                </button>
                <button
                  type="button"
                  data-testid="ai-autonomy-off"
                  aria-pressed={!autonomyOn}
                  disabled={optedOut || autonomyQ.isLoading || autonomyM.isPending}
                  onClick={() => {
                    if (autonomyOn) autonomyM.mutate({ enabled: false, checkinFloorDays: currentFloor });
                  }}
                >
                  {t('settings.ai.autonomy.off')}
                </button>
              </div>
            </div>

            {autonomyOn && (
              <div className="row between middle gap-md mt-md">
                <div className="stack min-w-0">
                  <div className="row-title">{t('settings.ai.floor.title')}</div>
                  <div className="small t-2">
                    {t('settings.ai.floor.sub')}
                    {currentFloor !== null
                      ? t('settings.ai.floor.current', { days: currentFloor })
                      : t('settings.ai.floor.none')}
                  </div>
                </div>
                <div className="row gap-sm middle">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    placeholder={
                      currentFloor !== null ? String(currentFloor) : t('settings.ai.floor.placeholder')
                    }
                    value={floorInput}
                    onChange={(e) => setFloorInput(e.target.value)}
                    style={{ width: 80 }}
                    aria-label={t('settings.ai.floor.label')}
                    data-testid="ai-autonomy-floor"
                  />
                  <button
                    type="button"
                    className="btn secondary sm"
                    disabled={autonomyM.isPending}
                    onClick={() => {
                      const n = Number.parseInt(floorInput, 10);
                      autonomyM.mutate({
                        enabled: true,
                        checkinFloorDays: Number.isInteger(n) && n >= 1 ? n : null,
                      });
                      setFloorInput('');
                    }}
                  >
                    {t('settings.ai.floor.save')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* The heading must come and go WITH the control. LanguagePicker renders
            null while only one language is offered, and this section used to
            render regardless — a "Language" card with an empty body, which reads
            as a broken setting rather than as a choice that does not exist yet.
            Reported from production 2026-08-25. */}
        {hasLanguageChoice() && (
          <section className="card">
            <header className="card-h">
              <div>
                <h2 className="h-section">{t('settings.language.label')}</h2>
              </div>
            </header>
            <div className="card-pad">
              <LanguagePicker />
            </div>
          </section>
        )}

        <ChannelsCard
          {...(proveSecondFactor !== undefined ? { proveSecondFactor } : {})}
          {...(fetchImpl !== undefined ? { fetchImpl } : {})}
        />
        <ChannelMatrixCard />

        <section className="card">
          <header className="card-h">
            <div>
              <h2 className="h-section">{t('settings.protections.heading')}</h2>
              <p className="small">{t('settings.protections.sub')}</p>
            </div>
          </header>
          <div className="empty">
            <div className="empty-line" />
            <p className="small">{t('settings.protections.body')}</p>
          </div>
        </section>

        {/* ── Check-in cadence ─────────────────────────────────────────────
            How long the owner may be silent before the engine asks. The applier
            has existed since the engine was built; until now nothing could
            request one, so this was the one setting an owner could not reach.

            Enqueue only, and the copy says so twice: the badge states what is in
            force NOW, and the queued notice states what is coming and when. The
            two are never merged into one number, because during the delay the
            old value is the one that governs. */}
        <section className="card" data-testid="cadence-card">
          <header className="card-h">
            <div>
              <h2 className="h-section">{t('settings.cadence.heading')}</h2>
              <p className="small">{t('settings.cadence.sub')}</p>
            </div>
            {currentCadence !== null && (
              <span className="badge" data-testid="cadence-current">
                {t('settings.cadence.current', { days: currentCadence })}
              </span>
            )}
          </header>
          <div className="card-pad stack gap-md">
            {currentCadence === null ? (
              <p className="small t-3">{t('settings.cadence.unarmed')}</p>
            ) : (
              <>
                {/* Save sits on the interval's own line, at the far right: the
                    field and the action that commits it are one gesture, and
                    the notes below are about what happens AFTER it. */}
                <div className="row between middle gap-md wrap cadence-line">
                  <div className="field cadence-field">
                    <label className="field-label" htmlFor="cadence-days">
                      {t('settings.cadence.label')}
                    </label>
                    <input
                      id="cadence-days"
                      className="input"
                      type="number"
                      min={1}
                      max={365}
                      value={cadenceDays}
                      onChange={(e) => setCadenceDays(e.target.value)}
                      placeholder={String(currentCadence)}
                      data-testid="cadence-input"
                    />
                    <span className="field-hint">{t('settings.cadence.hint')}</span>
                  </div>
                  <div className="row gap-sm middle wrap">
                    {cadencePending === undefined && cadenceDays !== '' && !cadenceValid && (
                      <span className="small t-3">
                        {parsedCadence === currentCadence
                          ? t('settings.cadence.unchanged')
                          : t('settings.cadence.outOfRange')}
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn primary"
                      disabled={cadenceBusy || !cadenceValid || cadencePending !== undefined}
                      onClick={() => void onSaveCadence()}
                      data-testid="cadence-save"
                    >
                      {cadenceBusy ? t('settings.cadence.saving') : t('settings.cadence.save')}
                    </button>
                  </div>
                </div>

                {cadencePending !== undefined ? (
                  <p role="status" className="alert info" data-testid="cadence-pending">
                    {t('settings.cadence.pending', {
                      when: formatDateTime(cadencePending.effectiveAt),
                    })}
                  </p>
                ) : (
                  <p className="alert info">{t('settings.cadence.delayNote')}</p>
                )}

                {cadenceError !== null && (
                  <p role="alert" className="alert">
                    {t(cadenceError)}
                  </p>
                )}

              </>
            )}
          </div>
        </section>

        <AuditTrail {...(fetchImpl !== undefined ? { fetchImpl } : {})} />

        <section className="card">
          <header className="card-h">
            <div>
              <h2 className="h-section">{t('settings.delete.heading')}</h2>
              <p className="small">{t('settings.delete.sub')}</p>
            </div>
          </header>
          <div className="card-pad stack gap-md">
            {deletePendingAt !== null ? (
              <p role="status" className="alert info" data-testid="delete-pending">
                {t('settings.delete.pending', { when: formatDateTime(deletePendingAt) })}
              </p>
            ) : (
              <div className="row between middle gap-md wrap">
                <div className="stack min-w-0">
                  <div className="row-title">{t('settings.delete.request')}</div>
                  <div className="small t-2">
                    <Trans
                      i18nKey="settings.delete.instruction"
                      values={{ word: DELETE_CONFIRM_WORD }}
                      components={{ strong: <strong /> }}
                    />
                  </div>
                </div>
                <div className="row gap-sm middle">
                  <input
                    className="input"
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    placeholder={DELETE_CONFIRM_WORD}
                    autoComplete="off"
                    aria-label={t('settings.delete.inputLabel')}
                    data-testid="delete-confirm"
                    style={{ width: 120 }}
                  />
                  <button
                    type="button"
                    className="btn danger"
                    disabled={deleteBusy || deleteConfirm !== DELETE_CONFIRM_WORD}
                    data-testid="delete-account"
                    onClick={() => void onDeleteAccount()}
                  >
                    {deleteBusy ? t('settings.delete.busy') : t('settings.delete.button')}
                  </button>
                </div>
              </div>
            )}
            {deleteError !== null && (
              <p role="alert" className="alert">
                {deleteError}
              </p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

// Your name (display profile). An optional display name + honorific ("Mr.",
// "Mrs.", …) shown on the account menu — pure personalization, not a security
// control, so it saves with a plain request (no step-up). Saving invalidates the
// shared ['account','me'] query so the sidebar chip updates immediately.
function ProfileCard(): JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const accountQ = useQuery({ queryKey: ['account', 'me'], queryFn: () => fetchAccount() });
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the inputs from the loaded account (and re-seed if it changes on the
  // server after a save). We only depend on the persisted values, so typing in
  // the field is never clobbered mid-edit.
  const loadedTitle = accountQ.data?.title ?? null;
  const loadedName = accountQ.data?.displayName ?? null;
  useEffect(() => {
    setTitle(loadedTitle ?? '');
    setName(loadedName ?? '');
  }, [loadedTitle, loadedName]);

  const saveM = useMutation({
    mutationFn: () =>
      updateProfile({
        displayName: name.trim() === '' ? null : name.trim(),
        title: title === '' ? null : title,
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['account', 'me'] });
    },
    onError: () => setError(t('settings.profile.error')),
  });

  return (
    <section className="card">
      <header className="card-h">
        <div>
          <h2 className="h-section">{t('settings.profile.heading')}</h2>
          <p className="small t-2">{t('settings.profile.sub')}</p>
        </div>
      </header>
      <div className="card-pad stack gap-md">
        <div className="row gap-md wrap">
          <div className="field">
            <label className="field-label" htmlFor="profile-title">
              {t('settings.profile.title')}
            </label>
            <select
              id="profile-title"
              className="input"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setSaved(false);
              }}
              data-testid="profile-title"
              style={{ width: 110 }}
            >
              <option value="">{t('settings.profile.titleNone')}</option>
              {HONORIFIC_TITLES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label className="field-label" htmlFor="profile-name">
              {t('settings.profile.name')}
            </label>
            <input
              id="profile-name"
              className="input"
              value={name}
              maxLength={80}
              placeholder={t('settings.profile.namePlaceholder')}
              autoComplete="name"
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              data-testid="profile-name"
            />
          </div>
        </div>
        <div className="row gap-sm middle">
          <button
            type="button"
            className="btn primary sm"
            disabled={saveM.isPending}
            data-testid="profile-save"
            onClick={() => saveM.mutate()}
          >
            {saveM.isPending ? t('settings.profile.saving') : t('settings.profile.save')}
          </button>
          {saved && !saveM.isPending && (
            <span className="small t-2" role="status" data-testid="profile-saved">
              {t('settings.profile.saved')}
            </span>
          )}
        </div>
        {error !== null && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

// Notification channels (Continuity Verification CV-0.0). The owner enrols the
// channels reminders and account notices go to; each is verified by a code
// round-trip before the engine will ever select it. The explainer line states
// the no-tracking commitment (docs/26 §9) where the choice is made.
function ChannelsCard({
  proveSecondFactor,
  fetchImpl,
}: {
  proveSecondFactor?: (accepted: string[]) => Promise<void>;
  fetchImpl?: typeof fetch;
}): JSX.Element {
  const t = useT();
  const { userId } = useSession();
  const queryClient = useQueryClient();
  const channelsQ = useQuery({
    queryKey: ['settings', 'channels'],
    queryFn: () => fetchChannels(),
  });
  // Channel changes reshape the matrix grid below too — refresh both.
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['settings', 'channels'] });
    void queryClient.invalidateQueries({ queryKey: ['settings', 'channel-matrix'] });
  };
  const [destination, setDestination] = useState('');
  const [addType, setAddType] = useState<Exclude<EnrollableChannelType, 'push'>>('email');
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // Verified-channel removals are 7-day sensitive actions: channelId → the
  // effectiveAt returned on enqueue, so the row can say "removal scheduled".
  const [removalPending, setRemovalPending] = useState<Record<string, string>>({});

  const addM = useMutation({
    mutationFn: (input: { channelType: EnrollableChannelType; destination: string }) =>
      addChannel(input.channelType, input.destination),
    onSuccess: () => {
      setDestination('');
      setError(null);
      invalidate();
    },
    onError: () => setError(t('settings.channels.error.add')),
  });
  // Web push: subscribe THIS browser, then enrol the subscription. The code
  // arrives as a push notification and is typed back like any other channel.
  const pushM = useMutation({
    mutationFn: async (publicKey: string) => {
      const subscription = await subscribeThisBrowser(publicKey);
      return addChannel('push', subscription);
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: () =>
      setError(t('settings.channels.error.push')),
  });
  const verifyM = useMutation({
    mutationFn: (input: { id: string; code: string }) => verifyChannel(input.id, input.code),
    onSuccess: (_res, input) => {
      setCodes((c) => ({ ...c, [input.id]: '' }));
      setError(null);
      invalidate();
    },
    onError: () =>
      setError(t('settings.channels.error.verify')),
  });
  // Two removal lanes (docs/26 §4): an unverified channel deletes immediately
  // (it was never selected for notices); a verified one enqueues the
  // remove_channel sensitive action — step-up + 7-day delay, cancellable from
  // the Engine page — so a stolen session can't silence reminders instantly.
  const removeM = useMutation({
    mutationFn: async (ch: ChannelInfo) => {
      if (!ch.verified) {
        await removeChannel(ch.id);
        return null;
      }
      if (userId === null) throw new Error('not signed in');
      return requestChannelRemoval(ch.id, {
        userId,
        proveSecondFactor:
          proveSecondFactor ??
          ((): Promise<void> => Promise.reject(new Error('second-factor prompt not wired'))),
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
    },
    onSuccess: (res, ch) => {
      setError(null);
      if (res !== null) setRemovalPending((p) => ({ ...p, [ch.id]: res.effectiveAt }));
      invalidate();
    },
    // The copy must fit BOTH shapes of failure (QA 2026-07-21 A4): the passkey
    // prompt was dismissed, OR the security check itself failed without a prompt
    // ever appearing. Claiming "may have been cancelled" reads as a lie in the
    // second case, so state both possibilities and confirm nothing was applied.
    onError: () =>
      setError(t('settings.channels.error.remove')),
  });

  const channels = channelsQ.data?.channels ?? [];
  const pushPublicKey = channelsQ.data?.pushPublicKey ?? null;
  const hasPushChannel = channels.some((ch) => ch.channelType === 'push');
  // Paid channels only appear when the plan allows them. WhatsApp is withdrawn
  // from enrolment entirely (2026-08-01) and the server simply stops listing it,
  // so there is no canAddWhatsapp any more — reading the server's list rather
  // than hardcoding the set is what makes the withdrawal a one-line server
  // change. See WITHDRAWN_CHANNEL_TYPES in apps/api/src/billing/entitlement.ts.
  const enrollable = channelsQ.data?.enrollableChannelTypes ?? ['email'];
  const canAddSms = enrollable.includes('sms');
  const proChannelsLocked = !canAddSms;
  // Downgrade transparency (docs/28, Gap plan G-3): a free-plan account still
  // holding verified paid channels is a LAPSED subscriber — those channels are
  // grandfathered (delivery is plan-blind, never re-gated) and this banner says
  // so, persistently, where the channels live. WhatsApp stays in this filter
  // deliberately: a grandfathered WhatsApp row from before the withdrawal is
  // exactly the kind the banner exists to reassure someone about.
  const residualPaid = channels.filter(
    (ch) =>
      (ch.channelType === 'sms' || ch.channelType === 'whatsapp') && ch.verified,
  );
  const showDowngradeBanner = channelsQ.data?.plan === 'free' && residualPaid.length > 0;

  return (
    <section className="card">
      <header className="card-h">
        <div>
          <h2 className="h-section">{t('settings.channels.heading')}</h2>
          <p className="small t-2">{t('settings.channels.sub')}</p>
        </div>
        {/* More channels is the property that matters here — a single channel is
            a single point of failure for the one message that decides whether an
            absence reads as silence. The count says how many actually work. */}
        {channels.length > 0 && (
          <span
            className={`badge ${channels.some((c: ChannelInfo) => c.verified) ? 'success' : 'warning'}`}
            data-testid="channels-verified-count"
          >
            {t('settings.channels.verifiedCount', {
              count: channels.filter((c: ChannelInfo) => c.verified).length,
            })}
          </span>
        )}
      </header>
      <div className="card-pad stack gap-md">
        {showDowngradeBanner && (
          <p className="alert info" data-testid="downgrade-banner">
            <Trans
              i18nKey="settings.channels.downgrade"
              values={{ channels: residualPaid.map((ch) => ch.destination).join(', ') }}
              components={{ em: <em />, plans: <Link to="/plans" /> }}
            />
          </p>
        )}
        {channels.map((ch: ChannelInfo) => (
          <div key={ch.id} className="channel-row row between middle gap-md wrap" data-testid={`channel-${ch.id}`}>
            <div className="stack min-w-0">
              {/* Destination and state on one line, the way the design has it:
                  the badge is what the eye finds when scanning for the channel
                  that is not finished yet. */}
              <div className="row middle gap-sm wrap">
                <span className="row-title">
                  {ch.channelType === 'push' ? t('settings.channels.push') : ch.destination}
                </span>
                <span className={`badge ${ch.verified ? 'success' : 'warning'}`}>
                  {ch.verified ? t('settings.channels.state.verified') : t('settings.channels.state.unverified')}
                </span>
              </div>
              <div className="small t-2">
                {ch.verified
                  ? t('settings.channels.verified', { type: ch.channelType })
                  : ch.pendingVerification
                    ? t('settings.channels.codeSent')
                    : t('settings.channels.unverified')}
              </div>
            </div>
            <div className="row gap-sm middle wrap">
              {!ch.verified && ch.pendingVerification && (
                <>
                  <input
                    className="input"
                    inputMode="numeric"
                    placeholder={t('settings.channels.codePlaceholder')}
                    autoComplete="one-time-code"
                    value={codes[ch.id] ?? ''}
                    onChange={(e) => setCodes((c) => ({ ...c, [ch.id]: e.target.value }))}
                    style={{ width: 120 }}
                    aria-label={t('settings.channels.codeLabel')}
                    data-testid={`channel-code-${ch.id}`}
                  />
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={verifyM.isPending || (codes[ch.id] ?? '').trim().length < 4}
                    data-testid={`channel-verify-${ch.id}`}
                    onClick={() => verifyM.mutate({ id: ch.id, code: (codes[ch.id] ?? '').trim() })}
                  >
                    {t('settings.channels.verify')}
                  </button>
                </>
              )}
              {!ch.verified && !ch.pendingVerification && ch.channelType !== 'webhook' && (
                <button
                  type="button"
                  className="btn secondary sm"
                  disabled={addM.isPending}
                  data-testid={`channel-resend-${ch.id}`}
                  onClick={() =>
                    addM.mutate({
                      // 'webhook' rows are filtered out by the JSX guard above.
                      channelType: ch.channelType as EnrollableChannelType,
                      destination: ch.destination,
                    })
                  }
                >
                  {t('settings.channels.resend')}
                </button>
              )}
              {removalPending[ch.id] !== undefined ? (
                <span className="small t-2" role="status" data-testid={`channel-removal-pending-${ch.id}`}>
                  {t('settings.channels.removalPending', {
                    when: formatDateTime(removalPending[ch.id]!),
                  })}
                </span>
              ) : (
                <button
                  type="button"
                  className="btn secondary sm"
                  disabled={removeM.isPending}
                  data-testid={`channel-remove-${ch.id}`}
                  onClick={() => removeM.mutate(ch)}
                >
                  {t('settings.channels.remove')}
                </button>
              )}
            </div>
          </div>
        ))}

        <div className="row between middle gap-md wrap">
          <div className="stack min-w-0">
            <div className="row-title">{t('settings.channels.add.title')}</div>
            <div className="small t-2">{t('settings.channels.add.sub')}</div>
            {proChannelsLocked && (
              <div className="small t-2" data-testid="channel-upgrade-hint">
                <Trans
                  i18nKey="settings.channels.add.smsLocked"
                  components={{ plans: <Link to="/plans" /> }}
                />
              </div>
            )}
          </div>
          <div className="row gap-sm middle wrap">
            <select
              className="input"
              value={addType}
              onChange={(e) => setAddType(e.target.value as typeof addType)}
              data-testid="channel-add-type"
              aria-label={t('settings.channels.add.typeLabel')}
            >
              <option value="email">{t('settings.channels.add.email')}</option>
              {canAddSms && <option value="sms">{t('settings.channels.add.sms')}</option>}
            </select>
            <input
              className="input"
              type={addType === 'email' ? 'email' : 'tel'}
              placeholder={
                addType === 'email'
                  ? t('settings.channels.add.emailPlaceholder')
                  : t('settings.channels.add.phonePlaceholder')
              }
              autoComplete={addType === 'email' ? 'email' : 'tel'}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              style={{ width: 220 }}
              aria-label={
                addType === 'email'
                  ? t('settings.channels.add.emailLabel')
                  : t('settings.channels.add.phoneLabel')
              }
              data-testid="channel-add-destination"
            />
            <button
              type="button"
              className="btn primary sm"
              disabled={
                addM.isPending ||
                (addType === 'email' ? !destination.includes('@') : !destination.trim().startsWith('+'))
              }
              data-testid="channel-add"
              onClick={() => addM.mutate({ channelType: addType, destination: destination.trim() })}
            >
              {addM.isPending
                ? t('settings.channels.add.sending')
                : t('settings.channels.add.button')}
            </button>
            {/* Push sat in its own block below the list, so "add a channel" was
                two places depending on which kind you wanted. It is a channel
                like the others — this browser is the destination — so enrolling
                it belongs with them. */}
            {pushPublicKey !== null && !hasPushChannel && (
              <button
                type="button"
                className="btn secondary sm"
                disabled={pushM.isPending}
                data-testid="channel-enable-push"
                onClick={() => pushM.mutate(pushPublicKey)}
              >
                {pushM.isPending
                  ? t('settings.channels.pushCard.enabling')
                  : t('settings.channels.pushCard.enable')}
              </button>
            )}
          </div>
        </div>

        {error !== null && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

// The channel matrix (docs/26 §3.1) — which channel serves which purpose
// class. The server returns the EFFECTIVE grid (absent preference = enabled);
// each checkbox PUTs one cell. The matrix only ever NARROWS routine delivery:
// check-in requests, escalation requests, and security alerts are exempt at
// selection time (the safety floor), stated where the switches live so nobody
// believes they muted more than they did. QA 2026-07-17 issue #3: the API had
// shipped without this UI.
const PURPOSE_CLASSES_ORDER: PurposeClass[] = [
  'owner_verification',
  'owner_notices',
  'contact_notices',
];

function ChannelMatrixCard(): JSX.Element | null {
  const t = useT();
  const queryClient = useQueryClient();
  const matrixQ = useQuery({
    queryKey: ['settings', 'channel-matrix'],
    queryFn: () => fetchChannelPreferences(),
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const toggleM = useMutation({
    mutationFn: (input: { channelId: string; purposeClass: PurposeClass; enabled: boolean }) =>
      setChannelPreference(input.channelId, input.purposeClass, input.enabled),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['settings', 'channel-matrix'] });
    },
    onError: () => setError(t('settings.matrix.error')),
  });

  const channels = matrixQ.data?.channels ?? [];
  // No channels yet ⇒ nothing to configure; the enrolment card above explains.
  if (channels.length === 0) return null;

  return (
    <section className="card" data-testid="channel-matrix">
      <header className="card-h">
        <div>
          <h2 className="h-section">{t('settings.matrix.heading')}</h2>
          <p className="small t-2">{t('settings.matrix.sub')}</p>
        </div>
      </header>
      <div className="card-pad stack gap-md">
        {channels.map((ch) => (
          <div key={ch.id} className="stack gap-sm" data-testid={`matrix-row-${ch.id}`}>
            <div className="row-title">
              {ch.channelType === 'push' ? t('settings.channels.push') : ch.destination}
              {!ch.verified && (
                <span className="small t-2">{t('settings.matrix.unverified')}</span>
              )}
            </div>
            <div className="row gap-md wrap">
              {PURPOSE_CLASSES_ORDER.map((pc) => (
                <label key={pc} className="row middle gap-sm small" title={t(`settings.matrix.${pc}.hint`)}>
                  <input
                    type="checkbox"
                    checked={ch.classes[pc]}
                    disabled={toggleM.isPending}
                    data-testid={`matrix-${ch.id}-${pc}`}
                    onChange={(e) =>
                      toggleM.mutate({ channelId: ch.id, purposeClass: pc, enabled: e.target.checked })
                    }
                  />
                  {t(`settings.matrix.${pc}.title`)}
                </label>
              ))}
            </div>
          </div>
        ))}
        {error !== null && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
