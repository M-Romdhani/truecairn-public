import { useEffect, useState } from 'react';

// Live data for the public /status page (GET /v1/status).
//
// Deliberately a hand-rolled fetch rather than react-query + the api client: the
// public content pages are a lazy chunk that imports NONE of the authed graph
// (see main.tsx), and pulling the shared client in would drag session machinery
// onto a page anyone can read without an account. Same reason there is no auth
// header here — the route is unauthenticated by design.

export type CheckState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface LiveCheck {
  id: string;
  label: string;
  state: CheckState;
  releaseCritical: boolean;
}

export interface LiveAvailability {
  measuringSince: string | null;
  observedDays: number;
  requestedWindowDays: number;
  // null until enough evidence exists to publish one. The page renders the
  // "measuring since" line instead — never a placeholder number.
  releasePathOkPercent: number | null;
  unobservedMinutes: number;
}

export interface LiveStatus {
  releasePath: CheckState;
  checks: LiveCheck[];
  failing: string[];
  availability: LiveAvailability;
  observedAt: string;
}

// Matches the route's cache TTL, so a visitor never sees a status older than the
// series it quotes.
const REFRESH_MS = 30_000;

export interface LiveStatusResult {
  data: LiveStatus | null;
  // Distinguishes "still asking" from "asked and could not reach the API". The
  // page must render those differently: the second one is itself status
  // information, and showing it as a spinner forever would be a quiet lie.
  failed: boolean;
  loading: boolean;
}

export function useLiveStatus(): LiveStatusResult {
  const [data, setData] = useState<LiveStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch('/v1/status', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as LiveStatus;
        if (cancelled) return;
        setData(body);
        setFailed(false);
      } catch {
        if (cancelled) return;
        // Keep the last good reading on screen and mark it stale rather than
        // blanking the page on one dropped request.
        setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { data, failed, loading };
}
