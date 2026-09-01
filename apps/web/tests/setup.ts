import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { initCrypto } from '@truecairn/crypto';
import { afterEach } from 'vitest';
import { appEn } from '../src/i18n/catalog/app/en.js';
import { appEs } from '../src/i18n/catalog/app/es.js';
import { pagesEn } from '../src/i18n/catalog/pages/en.js';
import { pagesEs } from '../src/i18n/catalog/pages/es.js';
import { loadAppCatalog, loadPagesCatalog } from '../src/i18n/index.js';

// EVERY CATALOG HALF, because component tests mount screens DIRECTLY rather than
// through AuthedApp or PublicPages — which is where the lazy halves are loaded in
// the running application (docs/40 Phase 2). Without this every authenticated
// screen renders its keys instead of its copy, and 86 assertions across nine
// suites fail at once with "unable to find the text …", which reads like a
// hundred broken components rather than one missing import.
//
// The delivery split exists to keep product-UI and long-form page copy out of the
// landing BUNDLE; a test process is not a bundle, so it simply loads everything.
loadAppCatalog(appEn, appEs);
loadPagesCatalog(pagesEn, pagesEs);

// jsdom's TextEncoder returns a Uint8Array from a DIFFERENT realm than the global
// Uint8Array libsodium validates against — so `crypto_pwhash` rejects it
// ("unsupported input type for password") and wipe() throws. (A `new Uint8Array()`
// literal IS recognised; only TextEncoder output is foreign.) Wrap encode output
// in the global Uint8Array so the WASM crypto accepts the bytes the app + tests
// produce. A real browser has no realm split, so this is a jsdom-only shim.
const NativeTextEncoder = globalThis.TextEncoder;
class RealmSafeTextEncoder extends NativeTextEncoder {
  override encode(input?: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(super.encode(input));
  }
}
globalThis.TextEncoder = RealmSafeTextEncoder as typeof globalThis.TextEncoder;

// jsdom's Blob/File don't implement arrayBuffer() in this version, but the vault
// create + attach flow reads file bytes with File.arrayBuffer(). Back it with
// FileReader so component tests can exercise real File objects; a real browser
// implements this natively, so this is a jsdom-only shim.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = (): void => resolve(fr.result as ArrayBuffer);
        fr.onerror = (): void => reject(fr.error);
        fr.readAsArrayBuffer(this);
      });
    },
  });
}

// Component tests run in jsdom (Node). Initialise crypto via the Node loader —
// the real browser WASM path (initBrowserCrypto) is what the Playwright E2E
// exercises. The shared `sodium` binding is the same either way, so once this
// resolves every @truecairn/client-crypto call works in the component gate.
await initCrypto();

afterEach(() => {
  cleanup();
});
