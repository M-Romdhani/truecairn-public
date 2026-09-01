import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { Locale } from '@truecairn/shared';
import { setAccountLocale } from '../account/api.js';
import { fetchAccount, type AccountInfo } from '../account/keyMaterial.js';
import { currentLocale, readStoredLocale, setLocale } from './index.js';
import { useActiveLocale } from './useT.js';

// Keeps the browser's language and the ACCOUNT's stored language in step
// (docs/40 Phase 1). Mounted once, high in the authed tree.
//
// Three states, and the third is the one worth being careful about:
//
//  1. The account HAS a stored language → adopt it. The account is the
//     cross-device truth; that is the entire reason the column exists. Someone
//     who chose Spanish on their laptop should not meet English on their phone.
//
//  2. The account has NONE and this browser holds an EXPLICIT choice → push it
//     up. That migrates every preference made before the column existed, without
//     ever asking the owner to choose twice.
//
//  3. The account has NONE and this browser holds no explicit choice → DO
//     NOTHING. It is tempting to write the language we happen to be rendering,
//     which is almost always the default, and it would quietly restate every
//     account in existence as having CHOSEN English. NULL means "never chose",
//     and a value written by an effect nobody triggered is not a choice. The
//     column stays NULL until a person picks something.
//
// After the first reconciliation, a later switch by the owner is written up.
export function useLocaleSync(): void {
  const queryClient = useQueryClient();
  // The same key Settings and the account menu already use, so this shares one
  // in-flight request rather than issuing a second /v1/account/me.
  const accountQ = useQuery({ queryKey: ['account', 'me'], queryFn: () => fetchAccount() });
  // Subscribes to i18next, so this hook re-runs when the language changes.
  const active = useActiveLocale();

  const saveM = useMutation({
    mutationFn: (locale: Locale) => setAccountLocale(locale),
    onSuccess: (res) =>
      queryClient.setQueryData(['account', 'me'], (prev: AccountInfo | undefined) =>
        prev === undefined ? prev : { ...prev, locale: res.locale },
      ),
  });

  // The last language known to AGREE with the account. Everything hinges on
  // this rather than on comparing `active` to `stored` directly, and the first
  // version of this hook got it wrong in a way the tests caught: during
  // reconciliation the two legitimately differ for a render or two, so a bare
  // `active !== stored` fired a write for the reconciliation itself — adopting
  // 'es' from the account immediately wrote 'en' back over it, and state 3 wrote
  // a default nobody chose. A write must mean "the owner changed this SINCE we
  // agreed", which is a question only this ref can answer.
  const syncedTo = useRef<Locale | null>(null);
  const reconciled = useRef(false);
  const stored = accountQ.data?.locale ?? null;
  const loaded = accountQ.data !== undefined;

  useEffect(() => {
    if (!loaded || reconciled.current) return;
    reconciled.current = true;

    if (stored !== null) {
      // State 1: the account decides.
      syncedTo.current = stored;
      if (stored !== currentLocale()) void setLocale(stored);
      return;
    }

    const explicit = readStoredLocale();
    if (explicit !== null) {
      // State 2: migrate this browser's real choice up, and make sure we are
      // actually rendering it before the push effect below compares anything.
      syncedTo.current = explicit;
      if (explicit !== currentLocale()) void setLocale(explicit);
      saveM.mutate(explicit);
      return;
    }

    // State 3: nobody has chosen. Record what we are rendering so that a later
    // switch AWAY from it reads as a choice — but write nothing. The column
    // stays NULL.
    syncedTo.current = currentLocale();
    // saveM is a stable mutation object; depending on its identity would re-fire
    // the adoption write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, stored]);

  useEffect(() => {
    // Only a change made after we agreed with the account is a choice worth
    // storing.
    if (!reconciled.current || syncedTo.current === active || saveM.isPending) return;
    syncedTo.current = active;
    saveM.mutate(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
