import type { EngineState } from '@truecairn/shared';
import { LADDER, engineStateLabel, ladderPosition } from '../../engine/states.js';
import { useT } from '../../i18n/useT.js';

// ── The liveness ladder ──────────────────────────────────────────────────────
//
// The engine's whole promise is that going silent escalates SLOWLY and stays
// reversible for a long time. Until now the screen asserted that in prose while
// showing a single status pill, so "how far along is this, and how much room do I
// have left" was a question the owner could not answer by looking.
//
// PRESENTATIONAL ONLY. It reads the state the screen already fetched and renders
// it; there is no query, no action and no side effect here. It cannot advance,
// pause or cancel anything, which is what makes it safe to show on a screen where
// every real control is gated behind a fresh second factor.
//
// It never renders a rung as reached that the engine has not reached. Holds
// (`review_required`) and returns (`returning`) anchor to `release_review` — the
// last rung at which NOTHING has been handed over — and are drawn as an aside
// rather than as progress, because overstating position on this particular
// picture is the one error that would actually frighten someone.

export function LivenessLadder({ state }: { state: EngineState | null }): JSX.Element {
  const t = useT();
  const pos = ladderPosition(state);
  const reachedThrough = pos.kind === 'before' ? -1 : pos.index;

  return (
    <section className="card card-pad stack gap-md" data-testid="liveness-ladder">
      <div className="row between middle gap-md wrap">
        <div>
          <h2 className="h-section">{t('engine.ladder.heading')}</h2>
          <p className="small">{t('engine.ladder.sub')}</p>
        </div>
      </div>

      <ol className="ladder" aria-label={t('engine.ladder.heading')}>
        {LADDER.map((rung, i) => {
          const reached = i <= reachedThrough;
          const current = pos.kind !== 'before' && i === pos.index;
          // The three release rungs are the ones where something has actually
          // been handed over, so a reached rung there reads danger, not progress.
          const tone = i >= LADDER.indexOf('limited_release') ? 'release' : i >= LADDER.indexOf('escalation_pending') ? 'warn' : 'ok';
          return (
            <li
              key={rung}
              className={`ladder-rung${reached ? ' reached' : ''}${current ? ' current' : ''} tone-${tone}`}
              aria-current={current ? 'step' : undefined}
            >
              <span className="ladder-bar" aria-hidden="true" />
              <span className="ladder-label">{engineStateLabel(rung, t)}</span>
              {current && <span className="ladder-current">{t('engine.ladder.current')}</span>}
            </li>
          );
        })}
      </ol>

      {pos.kind === 'aside' && (
        <p className="alert info" role="status" data-testid="ladder-aside">
          {t('engine.ladder.aside', { state: engineStateLabel(pos.state, t) })}
        </p>
      )}
      {pos.kind === 'before' && <p className="small t-3">{t('engine.ladder.before')}</p>}
    </section>
  );
}
