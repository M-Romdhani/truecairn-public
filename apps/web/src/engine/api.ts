import type { EngineState } from '@truecairn/shared';
import { api, apiJson } from '../api/client.js';
import { requestWithStepUp, type StepUpDeps } from '../api/stepup.js';

// Engine dashboard API (PHASE4 C5B). Read status + the four user-initiated ops.
// None of these advance the engine toward a release — that is the worker's job
// alone; these only let the user prove liveness (check-in / snooze) or stop a
// release (cancel-release). State display is read-only.

export interface PendingSensitiveAction {
  id: string;
  actionType: string;
  // 'owner' | 'ai' (Phase 2) — an AI-initiated action is labelled so the owner can
  // veto it during the delay window.
  initiatedBy?: string;
  requestedAt: string;
  effectiveAt: string;
}

export interface EngineStatus {
  state: EngineState | null;
  previousState: EngineState | null;
  nextActionAt: string | null;
  snoozeUntil: string | null;
  // How many of the owner's contacts have completed key enrolment. The Arm
  // button is gated on this (audit B2) — the server enforces the same prerequisite.
  enrolledContactCount: number;
  // The owner's current check-in cadence in days. Null before the engine row
  // exists — a UI must render that as "not set yet" rather than echoing the
  // schema default, which would state a value this account does not have.
  inactivityThresholdDays: number | null;
  pendingSensitiveActions: PendingSensitiveAction[];
}

// requireFreshSecondFactor's 403 — a DIFFERENT problem type than requireStepUp's
// step-up-required, which is exactly why cancel-release can't ride the step-up
// interceptor and needs the thin flow below.
const SECOND_FACTOR_REQUIRED_TYPE = 'https://truecairn.app/problems/second-factor-required';

export async function getEngineStatus(fetchImpl?: typeof fetch): Promise<EngineStatus> {
  return apiJson(await api('/v1/engine/status', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }));
}

// AI continuity-readiness briefing (Build with Gemini XPRIZE). Read-only + advisory:
// `briefing` is null when the feature is off or the model is transiently down — the
// dashboard degrades, never breaks. Generated from account METADATA only, server-side.
export interface Briefing {
  briefing: string | null;
  generatedAt: string | null;
  model: string | null;
  stale: boolean;
  reason?: 'disabled' | 'unavailable';
}

export async function getBriefing(fetchImpl?: typeof fetch): Promise<Briefing> {
  return apiJson(await api('/v1/briefing', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }));
}

// The owner's live view of their release ceremonies (transparency that doubles
// as a collusion alarm). Metadata only; contact labels arrive as the ciphertext
// the owner encrypted client-side and are decrypted on this device — the server
// never reads them. Read-only: the protective actions stay check-in/cancel-release.
export interface ReleaseProgressAffirmation {
  // Which key the label above is encrypted under (0068). Optional so an older
  // API instance mid-deploy reads as v1 rather than throwing.
  contactPinVersion?: number;
  contactId: string;
  role: string;
  status: string; // 'pending' | 'tentative' | 'committed' | 'revoked'
  affirmedAt: string | null;
  revocationWindowExpiresAt: string | null;
  committedAt: string | null;
  revokedAt: string | null;
  displayLabelCiphertext: string;
  displayLabelNonce: string;
}

export interface ReleaseProgressRecipient {
  // Which key the label above is encrypted under (0068). Optional so an older
  // API instance mid-deploy reads as v1 rather than throwing.
  contactPinVersion?: number;
  contactId: string;
  role: string;
  status: string; // 'pending' | 'registered' | 'released' | 'failed'
  completedAt: string | null;
  displayLabelCiphertext: string;
  displayLabelNonce: string;
}

export interface ReleaseProgressCeremony {
  ceremonyId: string;
  tier: string;
  status: string;
  threshold: number;
  committed: number;
  initiatedAt: string;
  syncWindowExpiresAt: string;
  outerKeyReleasedAt: string | null;
  reconstructionStartedAt: string | null;
  releasedAt: string | null;
  cancellationReason: string | null;
  failureReason: string | null;
  affirmations: ReleaseProgressAffirmation[];
  recipients: ReleaseProgressRecipient[];
}

export async function getReleaseProgress(
  fetchImpl?: typeof fetch,
): Promise<{ ceremonies: ReleaseProgressCeremony[] }> {
  return apiJson(
    await api('/v1/engine/release-progress', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }),
  );
}

// Routine check-in carries NO acknowledgedState. From escalation_pending the UI
// calls this with acknowledgedState='escalation_pending' — the DELIBERATE dismissal
// the server (engine.ts) demands; a routine check-in from that state is a 409, so
// the escalation can never be cleared by a one-tap that didn't see it.
export async function checkIn(
  input: { acknowledgedState?: string },
  fetchImpl?: typeof fetch,
): Promise<{ state: string; nextActionAt: string | null }> {
  return apiJson(
    await api('/v1/engine/check-in', {
      method: 'POST',
      body: input.acknowledgedState !== undefined ? { acknowledgedState: input.acknowledgedState } : {},
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function snooze(
  snoozeDays: number,
  fetchImpl?: typeof fetch,
): Promise<{ state: string; nextActionAt: string | null }> {
  return apiJson(
    await api('/v1/engine/snooze', {
      method: 'POST',
      body: { snoozeDays },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// Arm the engine: the explicit owner action that turns on liveness monitoring
// (pre_active → active). Immediate + session-only, like check-in.
export async function armEngine(
  fetchImpl?: typeof fetch,
): Promise<{ state: string; nextActionAt: string | null }> {
  return apiJson(
    await api('/v1/engine/arm', {
      method: 'POST',
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function cancelSensitiveAction(
  sensitiveActionId: string,
  fetchImpl?: typeof fetch,
): Promise<{ cancelled: boolean }> {
  return apiJson(
    await api('/v1/account/sensitive-actions/cancel', {
      method: 'POST',
      body: { sensitiveActionId },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// The protective "I'm alive, stop the release" path (threat 5.5), gated by
// requireFreshSecondFactor. Its own thin flow: POST → on second-factor-required
// prove a fresh factor (the C5A passkey tap — stamps last_stepup_at; no passphrase
// signature, no challenge) → retry. One primitive, the second gate.
export async function cancelRelease(deps: {
  proveSecondFactor: (accepted: string[]) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<{ state: string }> {
  const send = (): Promise<Response> =>
    api('/v1/engine/cancel-release', {
      method: 'POST',
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  const r1 = await send();
  if (r1.status === 403) {
    const problem = (await r1
      .clone()
      .json()
      .catch(() => null)) as { type?: string; secondFactor?: { accepted?: string[] } } | null;
    if (problem !== null && problem.type === SECOND_FACTOR_REQUIRED_TYPE) {
      await deps.proveSecondFactor(problem.secondFactor?.accepted ?? []);
      return apiJson(await send());
    }
  }
  return apiJson(r1);
}

// Confirm a return from RETURNING back to ACTIVE — the owner's exit from the
// state their own vault read parked the engine in during a release. Without it
// the grace window expires and the release RESUMES, so this is a protective
// path: same fresh-second-factor lane as cancelRelease.
export async function confirmReturn(deps: {
  proveSecondFactor: (accepted: string[]) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<{ state: string }> {
  const send = (): Promise<Response> =>
    api('/v1/engine/confirm-return', {
      method: 'POST',
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  const r1 = await send();
  if (r1.status === 403) {
    const problem = (await r1
      .clone()
      .json()
      .catch(() => null)) as { type?: string; secondFactor?: { accepted?: string[] } } | null;
    if (problem !== null && problem.type === SECOND_FACTOR_REQUIRED_TYPE) {
      await deps.proveSecondFactor(problem.secondFactor?.accepted ?? []);
      return apiJson(await send());
    }
  }
  return apiJson(r1);
}

// Resolve a REVIEW_REQUIRED hold back to ACTIVE — the owner's exit from the
// state a failed/disputed ceremony parks the engine in. Same fresh-second-
// factor lane as cancelRelease: prove a factor when the session's is stale,
// then retry.
export async function resolveReview(deps: {
  proveSecondFactor: (accepted: string[]) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<{ state: string }> {
  const send = (): Promise<Response> =>
    api('/v1/engine/resolve-review', {
      method: 'POST',
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  const r1 = await send();
  if (r1.status === 403) {
    const problem = (await r1
      .clone()
      .json()
      .catch(() => null)) as { type?: string; secondFactor?: { accepted?: string[] } } | null;
    if (problem !== null && problem.type === SECOND_FACTOR_REQUIRED_TYPE) {
      await deps.proveSecondFactor(problem.secondFactor?.accepted ?? []);
      return apiJson(await send());
    }
  }
  return apiJson(r1);
}

// Change the check-in cadence. ENQUEUE ONLY — this returns a pending sensitive
// action, and the existing cadence stays in force for the whole delay. Callers
// must show the pending state and must not imply the change has applied.
export async function setCheckInCadence(
  days: number,
  deps: StepUpDeps,
): Promise<{ sensitiveActionId: string; effectiveAt: string }> {
  const res = await requestWithStepUp({ url: '/v1/engine/cadence', method: 'POST', body: { days } }, deps);
  return apiJson(res);
}
