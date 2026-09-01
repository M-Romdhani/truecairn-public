// The two clocks that bound a streamed upload, in one place because the whole
// safety argument is the RELATIONSHIP between them (2026-08-08 re-audit, N-2).
//
// THE INVARIANT: a claim may only go stale after the request holding it is
// provably dead. If that is ever false, two live requests can hold the same
// upload slot, stream into the same blob key, and interleave into one corrupt
// file — which for opaque client-encrypted ciphertext is undetectable until a
// beneficiary opens it, possibly decades later, when the owner cannot re-upload.
//
// It was false. STALE_UPLOAD_CLAIM_MS shipped with a comment claiming "bodyLimit
// caps the transfer far below an hour", which conflates a SIZE cap with a
// DURATION cap. Fastify 5 defaults requestTimeout to 0 and then assigns
// `server.requestTimeout = 0` unconditionally, which DISABLES Node's own 300s
// default — so nothing capped duration at all and a slowloris upload could
// outlive its own claim and reach the takeover window.

// How long a request may take to ARRIVE in full. Bounds receiving only, so
// responses — including a 100 MiB attachment download — are unaffected.
//
// Sized against VAULT_MAX_ATTACHMENT_BYTES (100 MiB default): ~0.9 Mbps sustained
// to finish inside the window. A client slower than that gets its stream torn
// down, which surfaces as the same error path as any other transport failure —
// rollback, reservation refunded, status back to a claimable value, retry works.
export const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

// How long an 'uploading' claim can sit before another request may take it over.
// Without a takeover path the claim would introduce a NEW stuck state: a process
// killed mid-stream leaves the row claimed and the owner unable to retry.
//
// Derived, never hand-picked — the 2x margin over REQUEST_TIMEOUT_MS is what
// makes the invariant above hold by construction. A request that could still be
// streaming cannot have a stale claim, because the socket carrying it was torn
// down a full window ago.
export const STALE_UPLOAD_CLAIM_MS = 2 * REQUEST_TIMEOUT_MS;
