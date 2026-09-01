import {
  configureAutoLock,
  isUnlocked,
  lock as cryptoLock,
  noteActivity,
  unlock as cryptoUnlock,
  unlockWithRecovery as cryptoUnlockRecovery,
  type KeyMaterial,
} from '@truecairn/client-crypto';
import { rekeyLegacyContactMetadata } from '../contacts/rekey.js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { publishCaptureKey } from '../vault/captures.js';

// Publish the owner's write-only capture PUBLIC key on unlock (docs/34 §5).
//
// Best-effort on purpose. It is a convenience for a phone that may not exist
// yet, and the derivation is deterministic — so a failure here costs nothing but
// a retry on the next unlock, and must never turn a successful unlock into a
// visible error. Idempotent server-side: the same key is a 204 no-op.
async function publishCaptureKeyQuietly(): Promise<void> {
  try {
    await publishCaptureKey();
  } catch {
    // Offline, signed out mid-unlock, or an older server without the route.
  }
}

// Move any pre-0068 contact metadata off the S1 tier key (F1+F2 backfill).
//
// Same shape and same reasoning as publishCaptureKeyQuietly above: this is
// opportunistic housekeeping, not part of unlocking, and a failure must never
// turn a successful unlock into a visible error. It is idempotent server-side —
// the route only ever moves v1 to v2 — so a failure costs a retry on the next
// unlock and nothing else.
//
// Here rather than on a migration screen because PLAN-v1-launch.md §1.2 forbids
// the alternative: forcing owners to re-confirm safety numbers they already
// confirmed would train them to click through `tampered`, the one state that has
// to keep meaning something. Unlock is also the only moment both keys exist —
// the S1 tier key to read v1, the master key to write v2.
async function rekeyLegacyContactMetadataQuietly(uid: string): Promise<void> {
  try {
    await rekeyLegacyContactMetadata(uid);
  } catch {
    // Offline, no contacts yet, or an older server without the route.
  }
}

// React mirror of the @truecairn/client-crypto session singleton (PHASE4 C2/§a).
// The master key NEVER enters React state — only the lock STATUS and the user id
// do. unlock takes ownership of the passphrase bytes (client-crypto zeroizes
// them). The module's auto-lock is bridged to React so the UI flips to the lock
// screen when the key is wiped on idle.

export type SessionStatus = 'locked' | 'unlocked';

interface SessionContextValue {
  status: SessionStatus;
  userId: string | null;
  unlock: (passphrase: Uint8Array, material: KeyMaterial, userId: string) => void;
  unlockWithRecovery: (recoveryCode: Uint8Array, material: KeyMaterial, userId: string) => void;
  lock: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<SessionStatus>(isUnlocked() ? 'unlocked' : 'locked');
  const [userId, setUserId] = useState<string | null>(null);

  const lock = useCallback(() => {
    cryptoLock();
    setUserId(null);
    setStatus('locked');
  }, []);

  const unlock = useCallback((passphrase: Uint8Array, material: KeyMaterial, uid: string) => {
    cryptoUnlock(passphrase, material); // wipes the passphrase
    setUserId(uid);
    setStatus('unlocked');
    void publishCaptureKeyQuietly();
    void rekeyLegacyContactMetadataQuietly(uid);
  }, []);

  const unlockWithRecovery = useCallback(
    (recoveryCode: Uint8Array, material: KeyMaterial, uid: string) => {
      cryptoUnlockRecovery(recoveryCode, material);
      setUserId(uid);
      setStatus('unlocked');
      void publishCaptureKeyQuietly();
      void rekeyLegacyContactMetadataQuietly(uid);
    },
    [],
  );

  // Bridge the module-level auto-lock (a setTimeout outside React) into state, so
  // an idle timeout that memzeroes the key also returns the UI to the lock screen.
  useEffect(() => {
    configureAutoLock({
      onLock: () => {
        setUserId(null);
        setStatus('locked');
      },
    });
  }, []);

  // The auto-lock's inputs, wired here as client-crypto's session module asks:
  // user activity re-arms the idle countdown (so "idle lock" means idle, not
  // "15 minutes since the last crypto call"), and pagehide locks — a page parked
  // in the back/forward cache would otherwise be restored with the master key
  // still in its heap, which reads as the vault "unlocking itself". Unmounting
  // the provider locks too: leaving the authed app (landing/public pages render
  // outside it) wipes the key, keeping the documented promise that leaving the
  // app locks the vault.
  useEffect(() => {
    const onActivity = (): void => noteActivity();
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);
    window.addEventListener('pagehide', lock);
    return () => {
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('pagehide', lock);
      cryptoLock();
    };
  }, [lock]);

  const value = useMemo<SessionContextValue>(
    () => ({ status, userId, unlock, unlockWithRecovery, lock }),
    [status, userId, unlock, unlockWithRecovery, lock],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used within a SessionProvider');
  return value;
}
