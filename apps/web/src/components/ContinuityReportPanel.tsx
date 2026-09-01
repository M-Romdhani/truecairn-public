import type { ContinuityReportPayload } from '@truecairn/shared';
import { AiDisclosure } from '../ai/AiDisclosure.js';
import { formatDateTime } from '../lib/dates.js';
import { useT } from '../i18n/useT.js';

// Plain-text rendering of a Continuity Report (docs/26 §3.3). Deterministic
// display of deterministic evidence: the outcome line is the closed enum in
// plain language, the channel lines are provider-proven counts, and the
// explainer states the no-tracking commitment where the evidence is read.
// The panel renders facts; the OPTIONAL `narration` block (Gap plan G-1) adds
// AI prose that EXPLAINS the same facts — clearly labelled, rendered as plain
// React text, and structurally incapable of replacing the evidence lines: the
// deterministic rendering below it is unconditional.

export function ContinuityReportPanel({
  report,
  generatedAt,
  live = false,
  narration = null,
  suppressRecovery = false,
}: {
  report: ContinuityReportPayload;
  generatedAt?: string;
  live?: boolean;
  narration?: string | null;
  // Live view during a release: the recovery line can reflect a check-in from
  // BEFORE the silence that opened the release — showing "the owner returned"
  // next to "a release is in progress" reads as a contradiction (QA
  // 2026-07-17). Display-only; the frozen report is never suppressed.
  suppressRecovery?: boolean;
}): JSX.Element {
  const t = useT();
  // The closed outcome enum says channels_unconfigured both when NO verified
  // channel exists and when verified channels exist but zero verification
  // attempts have been needed yet (a healthy, freshly-armed engine). The
  // second case must not read as a failure (QA 2026-07-17).
  const quietButHealthy =
    report.outcome === 'channels_unconfigured' &&
    report.channels.some((ch) => ch.verified) &&
    report.channels.every((ch) => ch.attempts === 0);
  return (
    <section className="card" data-testid="continuity-report">
      <header className="card-h">
        <div>
          <h2 className="h-section">
            {live ? t('continuity.heading.live') : t('continuity.heading.frozen')}
          </h2>
          <p className="small t-2">
            {live
              ? t('continuity.lede.live')
              : t('continuity.lede.frozen', {
                  when:
                    generatedAt !== undefined
                      ? t('continuity.lede.frozenWhen', { when: formatDateTime(generatedAt) })
                      : '',
                })}
          </p>
        </div>
      </header>
      <div className="card-pad stack gap-md">
        {narration !== null && narration !== '' && (
          <div className="stack gap-sm" data-testid="continuity-narration">
            <div className="small t-2">{t('continuity.narration.label')}</div>
            <p className="row-title">{narration}</p>
            <AiDisclosure />
          </div>
        )}
        <p className="row-title" data-testid="continuity-outcome">
          {quietButHealthy
            ? t('continuity.outcome.quietButHealthy')
            : t(`continuity.outcome.${report.outcome}`)}
        </p>

        <div className="stack gap-sm">
          <div className="small t-2">
            {t('continuity.lastActive', {
              when:
                report.heartbeat.lastCheckInAt !== null
                  ? formatDateTime(report.heartbeat.lastCheckInAt)
                  : t('continuity.never'),
            })}
          </div>
          {report.heartbeat.checkInRequestedAt !== null && (
            <div className="small t-2">
              {t('continuity.checkInRequested', {
                when: formatDateTime(report.heartbeat.checkInRequestedAt),
              })}
            </div>
          )}
          {report.heartbeat.escalationStartedAt !== null && (
            <div className="small t-2">
              {t('continuity.escalated', {
                when: formatDateTime(report.heartbeat.escalationStartedAt),
              })}
            </div>
          )}
        </div>

        {report.channels.length === 0 ? (
          <p className="small t-2">{t('continuity.noChannels')}</p>
        ) : (
          <div className="stack gap-sm">
            {report.channels.map((ch) => (
              <div key={ch.channelId} className="row between middle gap-md wrap">
                <div className="row-title">
                  {ch.verified
                    ? t('continuity.channelName', { type: ch.channelType })
                    : t('continuity.channelNameUnverified', { type: ch.channelType })}
                </div>
                <div className="small t-2">
                  {t('continuity.channelStats', {
                    count: ch.attempts,
                    delivered: ch.delivered,
                    bounced: ch.bounced,
                    failed: ch.failed,
                    last:
                      ch.lastDeliveredAt !== null
                        ? t('continuity.lastDelivered', {
                            when: formatDateTime(ch.lastDeliveredAt),
                          })
                        : '',
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {!suppressRecovery &&
          report.recovery.checkedInDuringWindow &&
          report.recovery.recoveredAt !== null && (
            <p className="alert info" data-testid="continuity-recovery">
              {t('continuity.recovered', {
                when: formatDateTime(report.recovery.recoveredAt),
              })}
            </p>
          )}

        <p className="small t-2">{t('continuity.noTracking')}</p>
      </div>
    </section>
  );
}
