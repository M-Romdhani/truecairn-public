import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { loginPasskey, registerPasskey } from '../auth/passkey.js';
import { IconLock } from '../components/icons.js';
import { LanguagePicker } from '../i18n/LanguagePicker.js';
import { useT } from '../i18n/useT.js';

// Account creation (PHASE4 C2). Registers a passkey, then logs in to establish a
// session, then sends the user into the enrollment ceremony. The WebAuthn
// ceremony itself runs in @simplewebauthn/browser; it needs a real authenticator,
// so it is exercised by the Playwright E2E (a CDP virtual authenticator), not the
// jsdom gate.
export function Register(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  // Held as a message KEY, not rendered text, so a language change re-renders
  // an error that is already on screen.
  const [error, setError] = useState<'conflict' | 'generic' | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await registerPasskey(email);
      await loginPasskey(email);
      navigate('/onboarding');
    } catch (err) {
      // A 409 means the account exists WITH a passkey — the actionable answer
      // is "sign in", not a generic retry (QA 2026-07-17 issue #7).
      setError(err instanceof ApiError && err.status === 409 ? 'conflict' : 'generic');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="reg" className="center-col narrow">
      <div className="card card-pad">
        <h1 id="reg" className="h-auth">
          {t('auth.register.heading')}
        </h1>
        <p className="small t-2 mt-xs">{t('auth.register.lede')}</p>
        <form onSubmit={onSubmit} className="stack gap-md mt-lg">
          <div className="field">
            <label className="field-label" htmlFor="reg-email">
              {t('auth.field.email')}
            </label>
            <input
              id="reg-email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          {error !== null && (
            <p role="alert" className="alert">
              {error === 'conflict'
                ? t('auth.register.error.conflict')
                : t('auth.register.error.generic')}
            </p>
          )}
          <button type="submit" className="btn primary lg w-full center" disabled={busy}>
            <IconLock width={16} height={16} />
            {busy ? t('auth.register.submitBusy') : t('auth.register.submit')}
          </button>
        </form>
        <p className="small t-2 mt-lg text-center">
          {t('auth.register.switchPrompt')}{' '}
          <Link to="/login" className="link">
            {t('auth.register.switchLink')}
          </Link>
        </p>
      </div>
      <p className="auth-tagline">{t('auth.tagline')}</p>
      <LanguagePicker className="mt-md" />
    </section>
  );
}
