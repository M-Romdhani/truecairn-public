import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans } from 'react-i18next';
import { useState } from 'react';
import { formatDayTime } from '../../lib/dates.js';
import { useT, type TFunction } from '../../i18n/useT.js';
import {
  discardCapture,
  fileCapture,
  listCaptures,
  type FilingPhase,
  type PendingCapture,
} from '../../vault/captures.js';

// Renders the structured phase fileCapture() reports. Exhaustive over the union,
// so adding a phase without giving it a message is a compile error rather than a
// blank progress line.
function phaseLabel(phase: FilingPhase, t: TFunction): string {
  switch (phase.kind) {
    case 'opening':
      return t('vault.captures.phase.opening');
    case 'saving':
      return t('vault.captures.phase.saving');
    case 'reencrypting':
      return t('vault.captures.phase.reencrypting', { n: phase.n, total: phase.total });
    case 'clearing':
      return t('vault.captures.phase.clearing');
  }
}

// The filing queue for captures sent from a phone (docs/34).
//
// Deliberately not styled as a passive inbox. Until a capture is filed it is
// sealed to a master-derived key that no release ceremony reconstructs — so it
// is the one thing in the vault that would NOT reach the owner's trusted
// contacts if the ladder ran (docs/34 D4). That is why filing is an explicit
// act: it needs the master key, which means it needs the owner.
//
// The consequence is stated in a sunken band rather than an alert. It is a
// permanent property of how capture works, not a fault — dressing it in red
// would make the panel cry wolf every time a phone sent something, and the
// sentence that actually matters would stop being read.

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileCaptures({ onFiled }: { onFiled?: () => void }): JSX.Element | null {
  const t = useT();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<FilingPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ id: string; failed: string[] } | null>(null);

  const { data: captures } = useQuery({
    queryKey: ['vault-captures'],
    queryFn: () => listCaptures(),
    // The queue only changes when a phone sends something, which this tab cannot
    // observe. Refetching on every window focus would put a request on the wire
    // each time the owner tabs back, to learn nothing; filing invalidates the
    // query explicitly, and a reload covers the rest.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const file = useMutation({
    mutationFn: (c: PendingCapture) => fileCapture(c, setPhase),
    onSuccess: (result) => {
      setPhase(null);
      if (result.failedAttachments.length > 0) {
        // The item exists and the capture is deliberately still in the queue —
        // say both, rather than reporting a clean success over a partial one.
        setPartial({ id: result.itemId, failed: result.failedAttachments });
      }
      void qc.invalidateQueries({ queryKey: ['vault-captures'] });
      void qc.invalidateQueries({ queryKey: ['vault-items'] });
      onFiled?.();
    },
    onError: () => {
      setPhase(null);
      setError(t('vault.captures.error'));
    },
  });

  const discard = useMutation({
    mutationFn: (id: string) => discardCapture(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['vault-captures'] }),
  });

  // Nothing waiting: no empty state, no explanation of a feature the owner may
  // not use. The panel appears when it has something to say.
  if (!captures || captures.length === 0) return null;

  const busy = file.isPending || discard.isPending;

  return (
    <section aria-labelledby="captures" className="card card-pad">
      <div className="filing-head">
        <h2 id="captures" className="h-section">
          {t('vault.captures.heading')}
        </h2>
        <span className="filing-count">
          {t('vault.captures.count', { count: captures.length })}
        </span>
      </div>

      <p className="small t-2 mt-md">
        {t('vault.captures.waiting', { count: captures.length })}
      </p>

      <div className="filing-note mt-md">
        <p className="small t-2">
          <Trans i18nKey="vault.captures.filingNote" components={{ strong: <strong /> }} />
        </p>
      </div>

      {error !== null && (
        <p className="filing-alert error mt-md" role="alert">
          {error}
        </p>
      )}
      {partial !== null && (
        <p className="filing-alert partial mt-md" role="alert">
          {t('vault.captures.partial', { files: partial.failed.join(', ') })}
        </p>
      )}

      <ul className="filing-list mt-lg">
        {captures.map((c) => {
          const filingThis = file.isPending && file.variables?.id === c.id;
          return (
            <li key={c.id}>
              <div>
                <div className="filing-meta">
                  {c.tier.toUpperCase()} · {humanSize(c.sizeBytes)} ·{' '}
                  {t('vault.captures.sealedBox')}
                </div>
                <div className="small t-3">
                  {t('vault.captures.arrived', { when: formatDayTime(c.createdAt) })}
                </div>
              </div>
              <div className="filing-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setPartial(null);
                    file.mutate(c);
                  }}
                >
                  {filingThis
                    ? phase === null
                      ? t('vault.captures.filing')
                      : phaseLabel(phase, t)
                    : t('vault.captures.file')}
                </button>
                {/* `secondary`, not a bare `.btn`: in this stylesheet a bare
                    .btn is SOLID near-black, so "plain" as the design meant it
                    (quiet, beside the primary) is `.btn.secondary` here — the
                    pairing every other screen uses. Not `.danger` either: a
                    capture has never been under a tier key and has never been
                    reachable by a release, so discarding a mis-scan is tidying
                    up, not destroying vault content. */}
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => discard.mutate(c.id)}
                >
                  {t('vault.captures.discard')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="small t-3 mt-md">{t('vault.captures.privacyNote')}</p>
    </section>
  );
}
