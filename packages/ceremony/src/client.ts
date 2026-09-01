// Browser-safe surface of @truecairn/ceremony (the '/client' subpath export).
//
// The package root re-exports the processor + bridges, which import
// @truecairn/db (the Node Postgres driver) — unbundleable in the web app. The
// recipient/affirmer device code needs only the pure-crypto modules below
// (@truecairn/crypto + @truecairn/keys, both browser-safe), so the web imports
// from '@truecairn/ceremony/client' and never touches the server modules.
export * from './signing.js';
export * from './ephemeral.js';
export * from './s1-envelope.js';
export * from './reconstruct.js';
