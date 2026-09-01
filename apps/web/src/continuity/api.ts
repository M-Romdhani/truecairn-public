// Continuity Verification client (docs/26). Both fetchers are deliberately
// tolerant: a 404 (feature off, pre-CV ceremony, no report yet) or any failure
// resolves to null and the panel simply doesn't render — the report is
// evidence for humans, never a dependency of the ceremony actions themselves.

import type { ContinuityReportPayload } from '@truecairn/shared';
import { api } from '../api/client.js';

export interface FrozenReport {
  ceremonyId: string;
  generatedAt: string;
  report: ContinuityReportPayload;
  // AI narration (Gap plan G-1): present only when the server has
  // CV_NARRATION_ENABLED; null when the guards declined or generation failed.
  // Absent/null either way ⇒ the deterministic panel stands alone.
  narration?: string | null;
}

export async function getCeremonyContinuityReport(
  ceremonyId: string,
  fetchImpl?: typeof fetch,
): Promise<FrozenReport | null> {
  try {
    const res = await api(
      `/v1/ceremonies/${ceremonyId}/continuity-report`,
      fetchImpl !== undefined ? { fetchImpl } : {},
    );
    if (!res.ok) return null;
    return (await res.json()) as FrozenReport;
  } catch {
    return null;
  }
}

export async function getVerificationStatus(
  fetchImpl?: typeof fetch,
): Promise<ContinuityReportPayload | null> {
  try {
    const res = await api(
      '/v1/engine/verification-status',
      fetchImpl !== undefined ? { fetchImpl } : {},
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { report: ContinuityReportPayload };
    return body.report;
  } catch {
    return null;
  }
}
