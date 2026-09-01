import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initBrowserCrypto } from '@truecairn/client-crypto';
import { useEffect, useState } from 'react';
import { App } from './App.js';
// The AUTHENTICATED half of the catalog (docs/40 Phase 2). i18next itself is
// initialised in main.tsx with the site half, which the landing needs; this adds
// the ~770 product-UI keys behind the same lazy boundary that keeps libsodium off
// the landing, so an anonymous visitor never downloads copy only a signed-in
// screen shows.
import { appEn } from './i18n/catalog/app/en.js';
import { appEs } from './i18n/catalog/app/es.js';
import { loadAppCatalog } from './i18n/index.js';
import { useT } from './i18n/useT.js';

loadAppCatalog(appEn, appEs);
import { SessionProvider } from './crypto/session.js';

// The authenticated application, lazy-loaded (main.tsx) so that NONE of it — the
// session machinery, @truecairn/client-crypto, or the libsodium WASM it pulls — is
// in the bundle an anonymous visitor downloads for the landing page. Crypto is
// initialised here (the old eager bootstrap), gated so the authed screens only
// render once libsodium is ready, exactly as before — just behind the lazy boundary.
const queryClient = new QueryClient();

export default function AuthedApp(): JSX.Element {
  const t = useT();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void initBrowserCrypto().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!ready)
    return (
      <div className="center-col">
        <p className="t-2">{t('shell.loading')}</p>
      </div>
    );
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </QueryClientProvider>
  );
}
