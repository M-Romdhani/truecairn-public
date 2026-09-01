import { wipe } from '@truecairn/crypto';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { fetchKeyMaterial } from '../account/keyMaterial.js';
import { isMemoryFailure } from '../crypto/memory.js';
import { useSession } from '../crypto/session.js';
import { LanguagePicker } from '../i18n/LanguagePicker.js';
import { useT } from '../i18n/useT.js';

// Where to land after a successful unlock. Honour the ?next= the route guard
// carried over (audit M2), but only ever an INTERNAL path ("/…", not "//…" which
// is protocol-relative) so a crafted ?next can't open-redirect off-site. Falls
// back to the vault home.
function safeNext(search: string): string {
  const next = new URLSearchParams(search).get('next');
  if (next !== null && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/vault';
}

// Unlock screen (PHASE4 §a/R0.5). A logged-in-but-locked user fetches their
// wrapped key material (bootstrap) and re-derives the master key from the
// passphrase. The passphrase is read from an UNCONTROLLED input into bytes, the
// field cleared, and the bytes zeroized by unlock (or by us if we never reach it).
export function Unlock(): JSX.Element {
  const t = useT();
  const session = useSession();
  const navigate = useNavigate();
  const { search } = useLocation();
  const passRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // A message KEY, never rendered text: the two failures below must stay
  // distinguishable, and holding the rendered string would freeze an error in
  // whichever language was active when it happened.
  const [error, setError] = useState<'memory' | 'passphrase' | null>(null);

  // Probe the session AND enrollment state on arrival (audit B3 + QA 2026-07-17
  // issue #4). The client route guard only knows locked/unlocked — two kinds of
  // visitor land here who can never unlock: a signed-out one (dead session ⇒
  // 401 after the KDF wait) and an ORPHAN (registered, passkey works, but
  // enrollment never provisioned key material — e.g. an outage mid-onboarding).
  // The orphan would face a passphrase prompt for a passphrase that does not
  // exist. One bootstrap probe answers both: 401/403 ⇒ sign-in; null (no key
  // material) ⇒ resume onboarding. Non-auth failures (offline, 5xx) are
  // ignored: the submit path still handles them.
  useEffect(() => {
    let live = true;
    fetchKeyMaterial()
      .then((fetched) => {
        if (live && fetched === null) navigate('/onboarding', { replace: true });
      })
      .catch((err: unknown) => {
        if (live && err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          navigate('/login', { replace: true });
        }
      });
    return () => {
      live = false;
    };
  }, [navigate]);

  // Already unlocked (the master key is still resident — e.g. a client-side nav
  // back to /unlock): don't render a misleading "locked" form. The key lives in
  // memory until an explicit lock, the idle auto-lock, pagehide, a full reload,
  // or leaving the authed app (the session provider wipes it on unmount); arriving
  // here unlocked does NOT mean the vault re-locked itself (audit B1). Send the
  // user where they were headed instead.
  if (session.status === 'unlocked') {
    return <Navigate to={safeNext(search)} replace />;
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const pass = passRef.current?.value ?? '';
    if (passRef.current) passRef.current.value = '';
    const passBytes = new TextEncoder().encode(pass);
    setBusy(true);
    try {
      const fetched = await fetchKeyMaterial();
      if (fetched === null) {
        wipe(passBytes);
        navigate('/onboarding'); // registered but not yet enrolled
        return;
      }
      session.unlock(passBytes, fetched.material, fetched.userId); // zeroizes passBytes
      navigate(safeNext(search));
    } catch (err) {
      wipe(passBytes);
      // No live session (signed out / expired): the key-material fetch 401s before
      // the passphrase is ever tried, so blaming the passphrase is wrong — this is
      // the bug behind the audit's "correct passphrase rejected after sign out"
      // (B3). Route to re-authentication instead of showing a passphrase error.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        navigate('/login', { replace: true });
        return;
      }
      // The Argon2id derivation can fail for want of MEMORY, not because the
      // passphrase is wrong (Onboarding has named this case since enrollment
      // shipped; this screen inherited the same KDF and not the same message).
      // Falling through to the passphrase error here told a user holding the
      // CORRECT passphrase that it was wrong — on a low-memory phone, a
      // memory-capped or sandboxed tab, or simply with too many tabs open, and
      // deterministically, so every retry "confirmed" it. For a vault that is
      // the worst false alarm available: it is indistinguishable from having
      // lost the vault, and it invites the one destructive response (burning
      // the recovery code, or re-enrolling over a vault that was fine).
      // Surface the cause in the console for support; nothing secret rides on
      // err — it is an allocation error or an RFC 7807 ApiError.
      if (isMemoryFailure(err)) {
        console.error('unlock key derivation ran out of memory', err);
        setError('memory');
        return;
      }
      setError('passphrase');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="unlock" className="center-col narrow">
      <div className="card card-pad">
        <h1 id="unlock" className="h-auth">
          {t('auth.unlock.heading')}
        </h1>
        <p className="small t-2 mt-xs">{t('auth.unlock.lede')}</p>
        <form onSubmit={onSubmit} className="stack gap-md mt-lg">
          <div className="field">
            <label className="field-label" htmlFor="unlock-pass">
              {t('auth.unlock.field.passphrase')}
            </label>
            {/* autoComplete="off", NOT "current-password": the master passphrase
                must never enter a browser password manager. Saving it syncs it
                off-device (breaking "it never leaves this device"), and a saved+
                autofilled value lets anyone at the keyboard unlock with zero
                knowledge — observed in QA as a phantom "auto-unlock" (audit B1). */}
            <input
              id="unlock-pass"
              className="input"
              ref={passRef}
              type="password"
              autoComplete="off"
            />
          </div>
          {error !== null && (
            <p role="alert" className="alert">
              {error === 'memory'
                ? t('auth.unlock.error.memory')
                : t('auth.unlock.error.passphrase')}
            </p>
          )}
          <button type="submit" className="btn primary lg w-full center" disabled={busy}>
            {busy ? t('auth.unlock.submitBusy') : t('auth.unlock.submit')}
          </button>
          {busy && <p className="small t-3">{t('auth.unlock.deriving')}</p>}
        </form>
        {/* The recovery route (QA 2026-08-26 F2). Always visible, NOT revealed
            only after a failed attempt: someone who has genuinely forgotten
            their passphrase may never type a wrong one — they stop at this
            screen, and until this link existed nothing here told them another
            way in existed at all. (Until the same change, nothing anywhere did:
            the code was issued and displayed at enrolment and had no redemption
            path in the product.) */}
        <p className="small t-3 mt-lg">
          {t('auth.unlock.recoveryPrompt')}{' '}
          <Link to={`/recover${search}`}>{t('auth.unlock.recoveryLink')}</Link>
        </p>
      </div>
      <LanguagePicker className="mt-md" />
    </section>
  );
}
