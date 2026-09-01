import { hexToBytes, wipe } from '@truecairn/crypto';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { fetchKeyMaterial } from '../account/keyMaterial.js';
import { isMemoryFailure } from '../crypto/memory.js';
import { useSession } from '../crypto/session.js';
import { LanguagePicker } from '../i18n/LanguagePicker.js';
import { useT } from '../i18n/useT.js';

// ── Unlock with the recovery code (QA 2026-08-26 F2) ─────────────────────────
//
// Until this screen existed there was NO way to redeem a recovery code. The
// crypto had shipped and worked — `unlockWithRecovery` sits in the session
// provider and `packages/client-crypto/src/interop.test.ts` proves the code
// round-trips to the same master key — but nothing in the product ever called
// it, and there was no route. So the code was generated, displayed once, the
// master key was wrapped under it in the database, the user was told to save it,
// and it could not be used. Forgetting the passphrase meant losing the vault
// outright, recovery code or not.
//
// TWO FACTORS, NOT ONE. This screen sits behind the same live session every
// other unlock path needs: `fetchKeyMaterial()` 401s without one, so reaching
// here at all takes the passkey. A recovery code on its own — copied from a
// screenshot, found in a notes app — is therefore not enough to open a vault.
// That is deliberate and must stay true: this is the ONE credential a user is
// told to write down and keep, so it is the one most likely to be photographed.
//
// NO SERVER-SIDE THROTTLE, and none is needed: the code is 256 bits, every
// attempt costs a full Argon2id derivation on the user's own device, and the
// server sees only the same key-material fetch that /unlock makes. Nothing here
// tells the server whether an attempt succeeded.
//
// WHAT THIS DOES NOT DO, stated plainly in the copy: it unlocks, it does not
// re-key. The passphrase is unchanged, so the code is still the way in next
// time. Setting a new passphrase means re-wrapping the master key and storing
// the new wrapper server-side — a separate change (CLAUDE.md backlog #7 owns the
// encoding question alongside it). Promising it here would be the same shape of
// lie this screen exists to fix.

// 32 bytes rendered as hex by Onboarding. Whitespace is stripped first: people
// paste from wherever they wrote it down, and a line break is not a typo.
const RECOVERY_CODE_HEX = /^[0-9a-fA-F]{64}$/;

function safeNext(search: string): string {
  const next = new URLSearchParams(search).get('next');
  if (next !== null && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/vault';
}

export function Recover(): JSX.Element {
  const t = useT();
  const session = useSession();
  const navigate = useNavigate();
  const { search } = useLocation();
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  // A message KEY, never rendered text — same reasoning as Unlock: holding the
  // rendered string would freeze an error in whichever language was active.
  const [error, setError] = useState<'format' | 'code' | 'memory' | null>(null);

  // Same arrival probe as /unlock: a signed-out visitor and an ORPHAN (registered
  // but never enrolled) can both land here and neither can ever succeed. One
  // bootstrap fetch answers both.
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

  if (session.status === 'unlocked') {
    return <Navigate to={safeNext(search)} replace />;
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const typed = (codeRef.current?.value ?? '').replace(/\s+/g, '');

    // Validate BEFORE deriving. hexToBytes is lenient in a way that matters here:
    // Number.parseInt('0z', 16) is 0, not NaN, so a malformed code could parse to
    // the wrong bytes and surface as "that code did not work" — which reads as
    // "you saved the wrong code" when it is really "you mistyped it just now".
    // Those deserve different messages.
    if (!RECOVERY_CODE_HEX.test(typed)) {
      setError('format');
      return;
    }

    let codeBytes: Uint8Array | null = null;
    setBusy(true);
    try {
      codeBytes = hexToBytes(typed);
      if (codeRef.current) codeRef.current.value = '';
      const fetched = await fetchKeyMaterial();
      if (fetched === null) {
        navigate('/onboarding');
        return;
      }
      // unlockWithRecovery wipes codeBytes in its own finally, on success AND on
      // failure, so it must not be touched afterwards.
      const toConsume = codeBytes;
      codeBytes = null;
      session.unlockWithRecovery(toConsume, fetched.material, fetched.userId);
      navigate(safeNext(search));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        navigate('/login', { replace: true });
        return;
      }
      // Argon2id can fail for want of MEMORY rather than because the code is
      // wrong — the same false alarm Unlock.tsx documents at length, and worse
      // here: someone told their correct recovery code is wrong has no third
      // credential to fall back on.
      if (isMemoryFailure(err)) {
        console.error('recovery key derivation ran out of memory', err);
        setError('memory');
        return;
      }
      setError('code');
    } finally {
      // Only reached with a non-null value when we threw before handing it over.
      if (codeBytes !== null) wipe(codeBytes);
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="recover" className="center-col narrow">
      <div className="card card-pad">
        <h1 id="recover" className="h-auth">
          {t('auth.recover.heading')}
        </h1>
        <p className="small t-2 mt-xs">{t('auth.recover.lede')}</p>
        <form onSubmit={onSubmit} className="stack gap-md mt-lg">
          <div className="field">
            <label className="field-label" htmlFor="recover-code">
              {t('auth.recover.field.code')}
            </label>
            {/* A textarea, not an input: 64 characters wrap, and someone reading
                from paper needs to see the whole thing to check it. autoComplete
                off for the same reason the passphrase is — this must never enter
                a password manager or sync off-device. */}
            <textarea
              id="recover-code"
              className="input"
              ref={codeRef}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              aria-describedby="recover-code-hint"
            />
            <p id="recover-code-hint" className="small t-3 mt-xs">
              {t('auth.recover.field.hint')}
            </p>
          </div>
          {error !== null && (
            <p role="alert" className="alert">
              {error === 'format'
                ? t('auth.recover.error.format')
                : error === 'memory'
                  ? t('auth.recover.error.memory')
                  : t('auth.recover.error.code')}
            </p>
          )}
          <button type="submit" className="btn primary lg w-full center" disabled={busy}>
            {busy ? t('auth.recover.submitBusy') : t('auth.recover.submit')}
          </button>
          {busy && <p className="small t-3">{t('auth.recover.deriving')}</p>}
        </form>
        <p className="small t-3 mt-lg">{t('auth.recover.afterwards')}</p>
        <p className="small t-3 mt-sm">
          <Link to="/unlock">{t('auth.recover.backToUnlock')}</Link>
        </p>
      </div>
      <LanguagePicker className="mt-md" />
    </section>
  );
}
