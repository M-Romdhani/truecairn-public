import { initCrypto, type Sodium } from '@truecairn/crypto';

// Browser initialisation of the SAME @truecairn/crypto used by the server. The
// server's default loader uses node:module (a broken-ESM workaround); the browser
// can't, so we supply a loader that imports the package's default export and lets
// the bundler resolve the WASM. After this resolves, every @truecairn/crypto and
// @truecairn/keys function works in the browser exactly as on the server — the
// interop tests pin that they produce identical bytes.
//
// Pinned to the same libsodium-wrappers-sumo version as the server (package.json
// exact 0.7.16) so client and server run byte-identical primitives; pnpm dedupes
// to one copy and the interop KAT catches any future drift.
export async function initBrowserCrypto(): Promise<void> {
  await initCrypto(async (): Promise<Sodium> => {
    const mod = (await import('libsodium-wrappers-sumo')) as { default?: Sodium } & Sodium;
    // The package may expose the sodium object as the default export (ESM) or as
    // the module namespace itself; prefer default when present.
    return mod.default ?? mod;
  });
}
