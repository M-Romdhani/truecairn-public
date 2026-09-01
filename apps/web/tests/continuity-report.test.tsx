import { render, screen } from '@testing-library/react';
import type { ContinuityReportPayload } from '@truecairn/shared';
import { describe, expect, it } from 'vitest';
import { ContinuityReportPanel } from '../src/components/ContinuityReportPanel.js';

// The Continuity Report panel (docs/26): deterministic rendering of the
// deterministic evidence — outcome in plain language, provider-proven channel
// lines, and the no-tracking commitment stated where the evidence is read.

const base: ContinuityReportPayload = {
  schemaVersion: 1,
  generatedAt: '2026-07-10T12:00:00.000Z',
  window: { from: '2026-06-01T00:00:00.000Z', to: '2026-07-10T12:00:00.000Z' },
  heartbeat: {
    lastCheckInAt: '2026-06-01T00:00:00.000Z',
    inactivityThresholdDays: 30,
    checkInTimeoutDays: 7,
    escalationCooldownDays: 14,
    checkInRequestedAt: '2026-07-01T00:00:00.000Z',
    escalationStartedAt: '2026-07-08T00:00:00.000Z',
  },
  channels: [
    {
      channelId: 'ch-1',
      channelType: 'email',
      verified: true,
      health: 'healthy',
      attempts: 3,
      sent: 0,
      delivered: 3,
      bounced: 0,
      failed: 0,
      lastAttemptAt: '2026-07-09T00:00:00.000Z',
      lastDeliveredAt: '2026-07-09T00:05:00.000Z',
    },
    {
      channelId: 'ch-2',
      channelType: 'email',
      verified: true,
      health: 'failing',
      attempts: 2,
      sent: 0,
      delivered: 0,
      bounced: 2,
      failed: 0,
      lastAttemptAt: '2026-07-09T00:00:00.000Z',
      lastDeliveredAt: null,
    },
  ],
  recovery: { checkedInDuringWindow: false, recoveredAt: null },
  outcome: 'partial_delivery_no_checkin',
};

describe('ContinuityReportPanel', () => {
  it('renders the outcome, evidence lines, and the no-tracking commitment (frozen variant)', () => {
    render(<ContinuityReportPanel report={base} generatedAt={base.generatedAt} />);
    expect(screen.getByTestId('continuity-outcome')).toHaveTextContent(/no check-in followed/i);
    expect(screen.getByText(/3 attempts · 3 delivered · 0 bounced/)).toBeInTheDocument();
    expect(screen.getByText(/2 attempts · 0 delivered · 2 bounced/)).toBeInTheDocument();
    expect(screen.getByText(/never tracks\s+whether a message is opened or read/i)).toBeInTheDocument();
    expect(screen.getByText(/frozen when this ceremony opened/i)).toBeInTheDocument();
    expect(screen.queryByTestId('continuity-recovery')).not.toBeInTheDocument();
  });

  it('renders the live variant with recovery evidence when the owner returned', () => {
    const recovered: ContinuityReportPayload = {
      ...base,
      recovery: { checkedInDuringWindow: true, recoveredAt: '2026-07-10T00:00:00.000Z' },
      outcome: 'delivered_no_checkin',
    };
    render(<ContinuityReportPanel report={recovered} live />);
    expect(screen.getByText(/current verification status/i)).toBeInTheDocument();
    expect(screen.getByTestId('continuity-recovery')).toHaveTextContent(/returned during this window/i);
  });

  it('states plainly when no channels were configured', () => {
    render(
      <ContinuityReportPanel
        report={{ ...base, channels: [], outcome: 'channels_unconfigured' }}
        live
      />,
    );
    expect(screen.getByTestId('continuity-outcome')).toHaveTextContent(
      /no verified notification channel/i,
    );
    expect(screen.getByText(/no notification channels were configured/i)).toBeInTheDocument();
  });
});
