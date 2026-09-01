import type { ContactRole } from '@truecairn/shared';
import { api, apiJson } from '../api/client.js';

// Owner-facing AI surfaces (Build with Gemini XPRIZE). All advisory + fail-soft:
// a null answer/message or empty steps means the model is off or transiently down,
// and the UI degrades gracefully.

export async function aiAssist(
  question: string,
  fetchImpl?: typeof fetch,
): Promise<{ answer: string | null; reason?: string }> {
  return apiJson(
    await api('/v1/ai/assist', {
      method: 'POST',
      body: { question },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export async function aiDraftInvite(
  role: ContactRole,
  fetchImpl?: typeof fetch,
): Promise<{ message: string | null; reason?: string }> {
  return apiJson(
    await api('/v1/ai/draft-invite', {
      method: 'POST',
      body: { role },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

export type AiPlanKind =
  | 'add_vault_item'
  | 'add_contact'
  | 'enrol_contact'
  | 'assign_shares'
  | 'arm_engine'
  | 'review';

export interface AiPlanStep {
  kind: AiPlanKind;
  title: string;
  why: string;
}

export async function aiPlan(
  fetchImpl?: typeof fetch,
): Promise<{ steps: AiPlanStep[]; reason?: string }> {
  return apiJson(await api('/v1/ai/plan', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }));
}

// Continuity readiness (plan §5). The score and the gaps are DETERMINISTIC — a
// pure scorer over server-visible metadata (apps/api/src/ai/readiness.ts); the model
// only rewrites `explanation`, and falls back to a template. So the dashboard ring
// never depends on a model call. `reason: 'disabled'` means AI_PROPOSER_ENABLED is
// off, in which case the caller keeps its own local estimate.
export type ReadinessSeverity = 'blocker' | 'warning';

export interface AiReadinessGap {
  // One of READINESS_GAP_CODES server-side. Typed as string here because the
  // constant lives in the API app; unknown codes fall back to generic copy.
  code: string;
  severity: ReadinessSeverity;
  tier?: string;
  // Numeric context only (assigned/needed, distinctRoles, count) — never free text.
  detail?: Record<string, number>;
}

export interface AiReadiness {
  score: number;
  gaps: AiReadinessGap[];
  explanation: string;
  llmWritten: boolean;
  model: string | null;
  generatedAt: string;
  reason?: 'disabled';
}

export async function fetchReadiness(fetchImpl?: typeof fetch): Promise<AiReadiness> {
  return apiJson(await api('/v1/ai/readiness', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }));
}

// Per-user AI opt-out (plan §4 task 0.3). When on, no AI call ever includes this
// user's context. Read for the Settings toggle; POST to change it.
export async function fetchAiOptOut(fetchImpl?: typeof fetch): Promise<{ optOut: boolean }> {
  return apiJson(
    await api('/v1/account/ai-settings', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }),
  );
}

export async function setAiOptOut(
  optOut: boolean,
  fetchImpl?: typeof fetch,
): Promise<{ optOut: boolean }> {
  return apiJson(
    await api('/v1/account/ai-opt-out', {
      method: 'POST',
      body: { optOut },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// AI autonomy opt-in (plan §6). Per-user; state changes stay off until the owner
// enables autonomy and sets a check-in floor.
export interface AiAutonomySettings {
  enabled: boolean;
  checkinFloorDays: number | null;
}

export async function fetchAiAutonomy(fetchImpl?: typeof fetch): Promise<AiAutonomySettings> {
  return apiJson(
    await api('/v1/account/ai-autonomy', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }),
  );
}

export async function setAiAutonomy(
  settings: AiAutonomySettings,
  fetchImpl?: typeof fetch,
): Promise<AiAutonomySettings> {
  return apiJson(
    await api('/v1/account/ai-autonomy', {
      method: 'POST',
      body: settings,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}

// AI proposals (plan §5). The AI proposes; the owner decides. Advisory + fail-soft:
// when the proposer flag is off the API returns an empty list with reason 'disabled'.
export interface AiProposal {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export async function listProposals(
  fetchImpl?: typeof fetch,
): Promise<{ proposals: AiProposal[]; reason?: string }> {
  return apiJson(await api('/v1/ai/proposals', { ...(fetchImpl !== undefined ? { fetchImpl } : {}) }));
}

export async function decideProposal(
  id: string,
  decision: 'approve' | 'reject',
  fetchImpl?: typeof fetch,
): Promise<{ id: string; status: string }> {
  return apiJson(
    await api(`/v1/ai/proposals/${id}/decision`, {
      method: 'POST',
      body: { decision },
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  );
}
