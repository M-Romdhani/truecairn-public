import { bytesToHex, wipe } from '@truecairn/crypto';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { isMemoryFailure } from '../crypto/memory.js';
import { useSession } from '../crypto/session.js';
import { provisionAccount } from '../onboarding/enroll.js';
import { useT, type TranslationKey } from '../i18n/useT.js';

type Step = 'welcome' | 'passphrase' | 'recovery' | 'done';

// The enrollment ceremony (PHASE4 C2). The security-critical step is the master
// passphrase (PHASE4 §a): it is read from an UNCONTROLLED input via a ref, never
// held in React state (strings can't be zeroized and would linger in the fiber
// tree / DevTools). On submit we read the field once into bytes, run the
// client-side enrollment + provision, then unlock — which zeroizes the
// passphrase bytes. The inputs are cleared only once enrollment SUCCEEDS: a
// failure here is never the passphrase's fault (the KDF ran out of memory, the
// provision POST failed), so the typed values must survive for the retry.
// Wiping them up front turned every failure into a dead end — the next
// Continue click hit the empty fields and reported the false "at least 8
// characters" error with no network activity (the deployed-QA blocker that
// read as "onboarding validation is broken").
// The recovery code is shown once for the user to record.
//
// `fetchImpl` is a test seam; production uses the global fetch.
export function Onboarding({ fetchImpl }: { fetchImpl?: typeof fetch }): JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('welcome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [recoveryHex, setRecoveryHex] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const t = useT();
  const passRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  async function submitPassphrase(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const pass = passRef.current?.value ?? '';
    const confirm = confirmRef.current?.value ?? '';
    if (pass.length < 8) {
      setError('onboarding.error.tooShort');
      return;
    }
    if (pass !== confirm) {
      setError('onboarding.error.mismatch');
      return;
    }
    const passBytes = new TextEncoder().encode(pass);

    setBusy(true);
    try {
      const { material, recoveryCode, userId } = await provisionAccount(passBytes, fetchImpl);
      // Success — only now clear the inputs (the step change unmounts them, but
      // don't leave the strings behind in the detached nodes).
      if (passRef.current) passRef.current.value = '';
      if (confirmRef.current) confirmRef.current.value = '';
      session.unlock(passBytes, material, userId); // zeroizes passBytes
      setRecoveryHex(bytesToHex(recoveryCode));
      wipe(recoveryCode);
      setStep('recovery');
    } catch (err) {
      wipe(passBytes);
      // Failure keeps the typed passphrases in place — retry must be one click,
      // not a silent dead end (see the header comment). Surface the cause in
      // the console: the on-screen messages are deliberately generic, and a
      // silent catch made this undiagnosable in the field. No secret rides on
      // err — it is an allocation/crypto error or an RFC 7807 ApiError.
      console.error('enrollment provisioning failed', err);
      setError(isMemoryFailure(err) ? 'onboarding.error.memory' : 'onboarding.error.generic');
    } finally {
      setBusy(false);
    }
  }

  // Convenience copy of the one-time recovery code (audit m2). It is already on
  // screen in plaintext for the user to record; copying is a local, client-only
  // action on their own secret (nothing leaves the device).
  async function copyRecovery(): Promise<void> {
    if (recoveryHex === null) return;
    try {
      await navigator.clipboard.writeText(recoveryHex);
      setCopied(true);
    } catch {
      /* Clipboard API may be unavailable/blocked; the code is on screen to copy by hand. */
    }
  }

  if (step === 'welcome') {
    return (
      <section aria-labelledby="ob-welcome" className="center-col">
        <div className="card card-pad stack gap-md">
          <h1 id="ob-welcome" className="h-page">
            {t('onboarding.welcome.heading')}
          </h1>
          <p className="body t-2">{t('onboarding.welcome.body')}</p>
          <div className="row mt-sm">
            <button type="button" className="btn primary lg" onClick={() => setStep('passphrase')}>
              {t('onboarding.welcome.begin')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (step === 'passphrase') {
    return (
      <section aria-labelledby="ob-pass" className="center-col narrow">
        <div className="card card-pad">
          <h1 id="ob-pass" className="h-section">
            {t('onboarding.pass.heading')}
          </h1>
          <p className="small t-2 mt-xs">{t('onboarding.pass.lede')}</p>
          <form onSubmit={submitPassphrase} className="stack gap-md mt-lg">
            {/* autoComplete="off", NOT "new-password": "new-password" invites the
                browser to SAVE the master passphrase into its password manager,
                which syncs it off-device and later autofills it on /unlock — the
                enabler of the QA "auto-unlock" observation (audit B1). Same rule
                as every other secret input in the app. */}
            <div className="field">
              <label className="field-label" htmlFor="passphrase">
                {t('onboarding.pass.field')}
              </label>
              <input
                id="passphrase"
                className="input"
                ref={passRef}
                type="password"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="confirm">
                {t('onboarding.pass.confirmField')}
              </label>
              <input
                id="confirm"
                className="input"
                ref={confirmRef}
                type="password"
                autoComplete="off"
              />
            </div>
            {error !== null && (
              <p role="alert" className="alert">
                {t(error)}
              </p>
            )}
            <button type="submit" className="btn primary lg w-full center" disabled={busy}>
              {busy ? t('onboarding.pass.submitBusy') : t('onboarding.pass.submit')}
            </button>
            {busy && (
              <p className="small t-3">{t('onboarding.pass.working')}</p>
            )}
          </form>
        </div>
      </section>
    );
  }

  if (step === 'recovery') {
    return (
      <section aria-labelledby="ob-rec" className="center-col narrow">
        <div className="card card-pad stack gap-md">
          <h1 id="ob-rec" className="h-section">
            {t('onboarding.recovery.heading')}
          </h1>
          <p className="small t-2">{t('onboarding.recovery.lede')}</p>
          <output aria-label={t('onboarding.recovery.label')} className="recovery-code">
            {recoveryHex}
          </output>
          <div className="row gap-sm middle mt-sm">
            <button type="button" className="btn secondary lg" onClick={() => void copyRecovery()}>
              {copied ? t('onboarding.recovery.copied') : t('onboarding.recovery.copy')}
            </button>
            <button type="button" className="btn primary lg" onClick={() => setStep('done')}>
              {t('onboarding.recovery.saved')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="ob-done" className="center-col">
      <div className="card card-pad stack gap-md">
        <h1 id="ob-done" className="h-page">
          {t('onboarding.done.heading')}
        </h1>
        <p className="body t-2">{t('onboarding.done.body')}</p>
        {/* Client-side navigation — a full reload would drop the in-memory unlock. */}
        <div className="row mt-sm">
          <button type="button" className="btn primary lg" onClick={() => navigate('/vault')}>
            {t('onboarding.done.cta')}
          </button>
        </div>
      </div>
    </section>
  );
}
