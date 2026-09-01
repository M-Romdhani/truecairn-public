import { Link } from 'react-router-dom';
import { useT } from '../i18n/useT.js';

// The single source of truth for the in-app AI disclosure (trust workstream T7).
// Every AI surface — the assistant, the dashboard proposal card, the settings AI
// section — renders THIS one component, so the promise reads identically
// everywhere and always links out to the full public "How Truecairn uses AI" page
// (/security/ai). Change the wording in one place and it changes everywhere.
//
// The link opens in a new tab (a reference doc) so reading it never interrupts a
// flow the owner is in the middle of — e.g. reviewing a pending AI proposal.
export function AiDisclosure({ className }: { className?: string }): JSX.Element {
  const t = useT();
  return (
    <p className={`small t-3${className !== undefined ? ` ${className}` : ''}`} data-testid="ai-disclosure">
      {t('ai.disclosure.body')}{' '}
      <Link className="link" to="/security/ai" target="_blank" rel="noopener noreferrer">
        {t('ai.disclosure.link')}
      </Link>
    </p>
  );
}
