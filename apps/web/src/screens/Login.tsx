import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { loginPasskey } from '../auth/passkey.js';
import { IconLock } from '../components/icons.js';
import { LanguagePicker } from '../i18n/LanguagePicker.js';
import { useT } from '../i18n/useT.js';

// The passkey ceremony (navigator.credentials.get) can hang forever if no
// authenticator ever responds (a closed OS prompt, an automated browser, a broken
// device). Cap the whole flow so the button can never get stuck in a silent
// spinner (QA Finding 3).
const SIGN_IN_TIMEOUT_MS = 60_000;

// Passkey login (PHASE4 C2). Logging in establishes a session but does NOT unlock
// the vault — the user still needs their master passphrase (login ≠ unlock, R0.5),
// so we route to the unlock screen on success.
export function Login(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  // The error is held as a message KEY, not as rendered text: a language change
  // while an error is on screen must re-render it in the new language, and a
  // stored string could not. Same reason every other screen keeps keys in state.
  const [error, setError] = useState<'timeout' | 'generic' | null>(null);
  // Set when the user cancels an in-flight attempt: the underlying ceremony may
  // still settle in the background, but we ignore its result so the UI recovers.
  const cancelledRef = useRef(false);

  function stopWaiting(): void {
    cancelledRef.current = true;
    setBusy(false);
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    cancelledRef.current = false;
    setBusy(true);
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), SIGN_IN_TIMEOUT_MS),
      );
      await Promise.race([loginPasskey(email), timeout]);
      if (cancelledRef.current) return; // user bailed out — don't navigate
      navigate('/unlock');
    } catch (err) {
      if (cancelledRef.current) return;
      setError((err as Error).message === 'timeout' ? 'timeout' : 'generic');
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  }

  return (
    <section aria-labelledby="login" className="center-col narrow">
      <div className="card card-pad">
        <h1 id="login" className="h-auth">
          {t('auth.login.heading')}
        </h1>
        <p className="small t-2 mt-xs">{t('auth.login.lede')}</p>
        <form onSubmit={onSubmit} className="stack gap-md mt-lg">
          <div className="field">
            <label className="field-label" htmlFor="login-email">
              {t('auth.field.email')}
            </label>
            <input
              id="login-email"
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
              {error === 'timeout' ? t('auth.login.error.timeout') : t('auth.login.error.generic')}
            </p>
          )}
          <button type="submit" className="btn primary lg w-full center" disabled={busy}>
            <IconLock width={16} height={16} />
            {busy ? t('auth.login.submitBusy') : t('auth.login.submit')}
          </button>
          {busy && (
            <>
              {/* Progress messaging (QA 2026-07-21 E5): the ceremony can take
                  tens of seconds on some devices — without a line saying the
                  wait is normal, users assume failure and refresh, resetting
                  the whole flow. */}
              <p className="small t-2" role="status">
                {t('auth.login.waiting')}
              </p>
              {/* Escape hatch so a stalled passkey prompt is never a dead end. */}
              <button type="button" className="btn ghost sm w-full center" onClick={stopWaiting}>
                {t('auth.login.cancel')}
              </button>
            </>
          )}
        </form>
        <p className="small t-2 mt-lg text-center">
          {t('auth.login.switchPrompt')}{' '}
          <Link to="/register" className="link">
            {t('auth.login.switchLink')}
          </Link>
        </p>
      </div>
      <p className="auth-tagline">{t('auth.tagline')}</p>
      <LanguagePicker className="mt-md" />
    </section>
  );
}
