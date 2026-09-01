import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../crypto/session.js';
import { logout } from './logout.js';

// Single source of truth for the sign-out flow, shared by Settings and the
// sidebar account menu so the behavior can't drift. Sign out = end the session
// server-side, then wipe the master key locally. We navigate to the landing page
// ("/") FIRST so the route guard doesn't bounce through /unlock as the session
// flips to locked ("/" is the crypto-free landing, rendered regardless of session
// state), and we lock even if the network call fails — better to clear the key
// locally than to leave it resident on a "failed" sign-out.
export function useSignOut(): { signOut: () => Promise<void>; signingOut: boolean } {
  const { lock } = useSession();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      /* fall through: still clear locally */
    } finally {
      navigate('/', { replace: true });
      lock();
    }
  }

  return { signOut, signingOut };
}
