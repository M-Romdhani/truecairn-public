# @truecairn/api

The HTTP API surface (Phase 3). Fastify, plain Node — co-located with the
worker on the same host, sharing the workspace packages (`db`, `keys`,
`audit`, `engine`, `sensitive-actions`, `ceremony`). The client (Phase 4) is a
separate app; this service holds ciphertext + metadata only.

`buildApp(config)` constructs the Fastify instance without listening (so tests
drive it via `app.inject()`); `index.ts` builds it and listens.

## Patterns established in 3.0 (every later endpoint inherits these)

### 1. Error shape — RFC 7807 problem details

Every error response is `application/problem+json` of the shape in
`errors.ts` (`{ type, title, status, detail?, instance }`). Endpoints throw an
`ApiError` or a helper (`badRequest`, `unauthorized`, `forbidden`, `notFound`,
`conflict`, `tooManyRequests`); the app's error handler renders it. JSON Schema
validation failures become a 400 problem; unexpected errors become a generic
500 whose internals are logged but never leaked. 404s use the same shape.
**Do not invent a second error shape in later deliverables.**

### 2. Request logging — what we log, and what we never log

`logging.ts` registers an `onResponse` hook that logs exactly: request id,
method, url path, status code, response time. Query strings and bodies are not
logged. Pino redaction censors `Authorization`/`Cookie` headers and the
`NEVER_LOG_FIELDS` defense-in-depth list.

**Never logged, ever:** passphrases (master/release/recovery), backup recovery
codes, Shamir shares and tier/item/outer-layer keys, vault ciphertext or
plaintext, session tokens, cookies, Authorization headers, WebAuthn private
material. A future endpoint that needs to log something derived from a body
logs only explicitly-chosen non-sensitive fields — never the body object.

### 3. Endpoint + test convention — native JSON Schema + `app.inject()`

Routes declare their request/response shapes as native Fastify JSON Schema in
`schema` (not Zod-via-adapter): Fastify validates + serializes against it, and
the schema is the source for an OpenAPI export if we ever want one. The example
is `routes/health.ts`. Tests build the app and exercise it with `app.inject()`
(in-process; no socket, no supertest) — see `app.test.ts`. Every subsequent
endpoint follows this.

## Not in 3.0 (later deliverables)

- No DB connection yet. `config.databaseUrl` is carried; 3.1 (auth) wires the
  client. `/health` is intentionally DB-free; a DB-backed readiness probe
  arrives with the DB wiring.
- No auth, no sessions, no business routes. Those are 3.1 onward.

## Run

```bash
pnpm --filter @truecairn/api start     # listens on PORT (default 3001)
pnpm --filter @truecairn/api test      # inject-based route tests, no DB needed
```
