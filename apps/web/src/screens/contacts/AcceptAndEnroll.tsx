import { useState, type FormEvent } from 'react';
import { contactPublicKeys } from '@truecairn/client-crypto';
import { contactSafetyNumber } from '@truecairn/crypto';
import { acceptInvite, enrollAsContact } from '../../contacts/api.js';
import { useSession } from '../../crypto/session.js';
import { Trans } from 'react-i18next';
import { useT } from '../../i18n/useT.js';

// The contact's half of the out-of-band check.
//
// These keys come from THIS user's master key, computed here on this device —
// nothing the server sent is involved in producing this number. That is the
// whole reason it can be compared against what the owner sees, which the server
// DID send. If the two differ, the keys the owner is about to seal a share to
// are not the ones the contact holds.
function MySecurityCode(): JSX.Element {
  const t = useT();
  const { x25519Pubkey, ed25519Pubkey } = contactPublicKeys();
  const code = contactSafetyNumber({
    x25519PublicKey: x25519Pubkey,
    ed25519PublicKey: ed25519Pubkey,
  });
  return (
    <div className="stack gap-sm mt-sm">
      <div className="small t-2">{t('accept.code.label')}</div>
      <div className="code-digits" data-testid="my-security-code">
        {code}
      </div>
      <p className="small t-2">
        <Trans i18nKey="accept.code.instruction" components={{ strong: <strong /> }} />
      </p>
    </div>
  );
}

// Invitee side of the contact ceremony (PHASE4 C4). Paste the one-time invite
// token → accept (binds this user to the contact row, status pending_keygen) →
// enrol: derive the affirmation keypairs from THIS user's master key and PROVE
// possession (sign the Ed25519 challenge + unseal the X25519 nonce). The vault
// must be unlocked — the contact keys are master-key-derived, so enrolment is
// impossible while locked (no server-stored secret to fall back on).
export function AcceptAndEnroll({ fetchImpl }: { fetchImpl?: typeof fetch }): JSX.Element {
  const t = useT();
  const { status: lockStatus } = useSession();
  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<'idle' | 'accepting' | 'enrolling' | 'done'>('idle');
  const [error, setError] = useState<'failed' | null>(null);

  const busy = phase === 'accepting' || phase === 'enrolling';

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      setPhase('accepting');
      const { contactId } = await acceptInvite(token.trim(), fetchImpl);
      // Possession proof runs here: the server accepts only if both proofs check.
      setPhase('enrolling');
      await enrollAsContact(contactId, fetchImpl);
      setPhase('done');
    } catch {
      setPhase('idle');
      setError('failed');
    }
  }

  if (lockStatus !== 'unlocked') {
    return (
      <section aria-labelledby="accept" className="app-col">
        <div className="card card-pad stack gap-sm">
          <h1 id="accept" className="h-section">
            {t('accept.heading')}
          </h1>
          <p role="alert" className="alert">
            {t('accept.locked')}
          </p>
        </div>
      </section>
    );
  }

  if (phase === 'done') {
    return (
      <section aria-labelledby="accept" className="app-col">
        <div className="card card-pad stack gap-sm">
          <h1 id="accept" className="h-section">
            {t('accept.done.heading')}
          </h1>
          <p data-testid="enroll-done" className="small t-2">
            {t('accept.done.body')}
          </p>
          <MySecurityCode />
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="accept" className="app-col">
      <div className="card card-pad">
        <h1 id="accept" className="h-section">
          {t('accept.heading')}
        </h1>
        <p className="small t-2 mt-xs">{t('accept.lede')}</p>
        <form onSubmit={onSubmit} className="stack gap-md mt-lg">
          <div className="field">
            <label className="field-label" htmlFor="invite-token-input">
              {t('accept.field.token')}
            </label>
            <input
              id="invite-token-input"
              className="input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          {error !== null && (
            <p role="alert" className="alert">
              {t('accept.error')}
            </p>
          )}
          <div className="row">
            <button
              type="submit"
              className="btn primary"
              disabled={busy || token.trim().length === 0}
            >
              {phase === 'accepting'
                ? t('accept.accepting')
                : phase === 'enrolling'
                  ? t('accept.enrolling')
                  : t('accept.submit')}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
