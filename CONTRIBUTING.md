# Contributing to Truecairn

Thanks for taking the time. Truecairn protects things that are meant to outlast
their owners, so we hold changes to a high bar — not to be precious, but because a
subtle regression here can be catastrophic and irreversible. This guide is how to
work with the grain of the project.

New to the codebase? Read this file in full, then the relevant `docs/`. The
`docs/` tree is the source of truth: threat model (`docs/04`–`docs/17`,
consolidated in `docs/THREAT-MODEL.md`), crypto architecture (`docs/18`, public
summary in `docs/CRYPTO.md`), the AI subsystem (`docs/AI.md`), and the
environment-variable contract (`docs/21`). Start at
[`docs/00-README.md`](docs/00-README.md), which maps the tree and names the
documents this mirror does not carry.

## Reporting security issues — not here

**Do not open a public issue or PR for a vulnerability.** Follow `SECURITY.md`
(GitHub private vulnerability reporting, or `security@truecairn.app`). The whole
point of the design is a boundary attackers shouldn't cross; help us close a gap
before it's public.

## The hard invariants — don't weaken these

These are load-bearing. A change that erodes one is a bug even if every test still
passes, and several are pinned by negative tests that a "fix" must not flip.
These are the ones that bite newcomers most:

1. **Zero-knowledge boundary.** No plaintext content, passphrase, private key, or
   unwrapped share may reach a server code path, an audit payload, a notification
   body, or a log line. Keep new fields out of logs *by construction*, not by
   after-the-fact redaction.
2. **Fail closed.** Release gates return 403 before `reconstructing`; below
   threshold or without diverse-role consensus, the engine must never advance.
3. **No test-mode branches.** Tests compress time via env-driven CONFIG and
   DB-precondition writes — never `if (test)` in product code.
4. **The AI can only add safety, never remove it.** Every AI action goes through
   the `packages/ai-authority` chokepoint; the AI may emit only the fail-closed
   `review_required` signal and vetoable tightenings. See `docs/AI.md`.
5. **The worker is the sole release driver.** Nothing else releases outer keys or
   advances ceremonies.

If a change seems to require weakening one of these, that's a design discussion to
raise in an issue first — not something to route around.

## Development setup

```bash
pnpm install
docker compose up -d postgres            # or any Postgres 16 + DATABASE_URL
pnpm db:migrate
pnpm --filter @truecairn/api start        # API on :3001
pnpm --filter @truecairn/worker start     # the release worker
pnpm --filter @truecairn/web dev          # SPA on :5173, /v1 proxied to the API
```

To build and verify the client reproducibly (matching the served bundle to a
tagged commit), see `docs/BUILDING.md`.

## The gates — run these before you push

Green on every CI job is the definition of done:

```bash
pnpm install
pnpm db:migrate
pnpm -r typecheck
DATABASE_URL=postgresql://truecairn:truecairn@localhost:5432/truecairn_dev pnpm test
pnpm --filter @truecairn/web build
```

CI (`.github/workflows/ci.yml`) runs the full vitest workspace against real
Postgres and the Playwright enrollment E2E on real Chromium (real WASM libsodium).
Chromium often can't run in a sandbox — if you can't run the E2E locally, lean on
CI and check its conclusion.

## House conventions

- **Commits:** scope-prefixed, and explain the **why**, not just the what
  (e.g. `feat(ai): fail-closed review_required through the chokepoint`).
- **SQL:** tagged-template only — never string-concatenate a query.
- **Route bodies:** JSON Schema with `additionalProperties: false` on every one.
- **Secrets in memory:** hold them in `Uint8Array`s and wipe them in `finally`.
- **Comments** explain a constraint the code can't show — not narration, and not a
  note to the reviewer about why your change is correct.
- **Match the surrounding code** — its naming, its idiom, its comment density.

## Pull requests

Keep a PR to one coherent change. In the description, say what changed and *why*,
call out any invariant it touches and how you preserved it, and paste the gate
results (or the CI run conclusion). If it changes behaviour that a `docs/` file
describes, update that doc in the same PR — the docs are authoritative, so they
can't be allowed to drift.

## Code of conduct

Participation is governed by `CODE_OF_CONDUCT.md`. Be decent; assume good faith.
