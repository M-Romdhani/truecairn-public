import type sodiumType from 'libsodium-wrappers-sumo';

// The libsodium handle + the one environment seam in this package.
//
// `sodium` is a LIVE binding: initCrypto assigns it, and every wrapper module
// imports { sodium } and reads `sodium.*` at call time (always after
// assertReady), so the assignment is visible everywhere. It is unset until
// initCrypto resolves; assertReady guards against use-before-init.
//
// initCrypto takes an optional loader so the SAME wrappers run in Node and the
// browser:
//   - Node (default): libsodium-wrappers(-sumo) 0.7.16's ESM dist is broken
//     (its modules-esm/*.mjs imports a file the package doesn't ship), so we
//     require() the CJS build via createRequire — Node-only.
//   - Browser: @truecairn/client-crypto's initBrowserCrypto passes a loader that
//     `import()`s the package's default export (the bundler resolves the WASM).
// The default loader's node:module import is marked @vite-ignore so a browser
// bundler never tries to resolve it (the browser always supplies its own loader,
// so the branch is dead code in a bundle).

export type Sodium = typeof sodiumType;
export type SodiumLoader = () => Promise<Sodium>;

export let sodium!: Sodium;
let ready = false;

const defaultLoader: SodiumLoader = async () => {
  const { createRequire } = await import(/* @vite-ignore */ 'node:module');
  return createRequire(import.meta.url)('libsodium-wrappers-sumo') as Sodium;
};

// initCrypto must be awaited once before any other function in this package is
// called. Omit the loader for the Node CJS path; pass one to supply libsodium
// yourself (the browser does). Idempotent. After it resolves every wrapper is
// synchronous; calling a wrapper before init throws (assertReady).
export async function initCrypto(loader: SodiumLoader = defaultLoader): Promise<void> {
  if (ready) return;
  const mod = await loader();
  await mod.ready;
  sodium = mod;
  ready = true;
}

export function assertReady(): void {
  if (!ready) {
    throw new Error('initCrypto() must be awaited before calling crypto operations');
  }
}

// Non-throwing readiness probe, for callers that want to REPORT the state rather
// than depend on it — the operations dashboard asks "is crypto initialised?" as
// one tile among several, and driving that off a caught exception would make a
// normal condition indistinguishable from a real fault in the logs.
export function isCryptoReady(): boolean {
  return ready;
}
