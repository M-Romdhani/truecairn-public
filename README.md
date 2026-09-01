# Truecairn

Zero-knowledge digital continuity platform. Owners encrypt everything on
their own devices; if they go silent, trusted contacts reconstruct access
through consensus ceremonies. The server stores only ciphertext and sealed
boxes and can never decrypt.

## Why this repository is public

Truecairn's central claim is that the server never sees plaintext — but every
byte of the cryptography that makes that true is JavaScript the server itself
hands your browser. A compromised or coerced origin could serve one targeted
user a modified bundle, and nothing inside the product could detect it. That is
the structural weakness of all browser-delivered end-to-end encryption, and it
is the cheapest attack on this product.

Publishing the source does not eliminate that. Nothing served from the same
origin can, because the checker is served by the thing it checks. What it
changes is the economics: a tampered bundle has to survive comparison against an
artifact built from source you can read, by a public workflow, signed by
infrastructure the attacker does not control. Silent, targeted, deniable
tampering becomes tampering that leaves evidence.

**This is the production source, not a demonstration.** The client here is the
client `truecairn.app` serves. If it were not, the verification below would be
theatre.

**Read this before you start verifying.** Two honest limits, stated here rather
than discovered halfway through:

1. **No release has been tagged, so there is no signed attestation yet.** The
   workflow that produces one (`.github/workflows/release.yml`) is in this
   repository and is real, but it has never run. Until it does, the check below
   is a rebuild you perform yourself — weaker than a signature from
   infrastructure we do not control, and still worth doing.
2. **This repository is a curated export and can lag the deployment.** Compare
   the commit below against the `Source commit` shown on `/security/build`
   before drawing any conclusion from a digest mismatch: if they differ, the
   digests are expected to differ, and that is a version gap rather than
   evidence of tampering.

## Verify the client you are running

```bash
git log -1 --format=%H                    # note the commit you are building
corepack enable && corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @truecairn/web build
node -p "require('./apps/web/dist/build-manifest.json').bundleDigest"
```

Compare that digest against the one shown at `/security/build` on the live site,
having first checked that the commit above matches the one that page reports.
Full method, including the known sources of nondeterminism:
[`docs/BUILDING.md`](docs/BUILDING.md).

## Layout

```
├── CONTRIBUTING.md      ← Invariants, gates, conventions. Read before changing anything.
├── SECURITY.md          ← How to report a vulnerability.
├── docs/                ← Threat model + architecture. The source of truth.
│   ├── THREAT-MODEL.md  ← Consolidated public threat model.
│   ├── CRYPTO.md        ← Public crypto spec.
│   ├── BUILDING.md      ← Reproduce the client and compare digests.
│   └── AI.md            ← What the AI can see/do/never do (+ RUNBOOK-AI.md for ops).
├── apps/                ← api (Fastify) · web (Vite/React) · worker (release driver + AI sweeps)
└── packages/            ← crypto, keys, ceremony, engine, ai-authority, db, … (pnpm workspace)
```

## Quickstart (dev)

```bash
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm -r typecheck && pnpm test        # the vitest gate (needs DATABASE_URL)
pnpm --filter @truecairn/api start    # API on :3001
pnpm --filter @truecairn/worker start # the release worker
pnpm --filter @truecairn/web dev      # SPA on :5173, /v1 proxied to the API
```

Copy `.env.example` to `.env.local` for the knobs. In production the API
refuses to start without its durable secrets — `docs/21` documents every
variable and, more usefully, what happens when each one is absent. Every value
in `.env.example` is a placeholder.

## What is not mirrored here

The security-relevant code is complete: the client, the API, the release worker,
the ceremony state machine, the crypto packages, the migrations and the test
suite are all here. What is held back is operational, pre-decisional, or about
work that has not shipped — the deployment topology and edge configuration, the
recovery-drill protocol, the third-party-audit scoping packet, the legal brief,
the internal build log and QA records, the mobile client, and the design source.
[`docs/00-README.md`](docs/00-README.md) lists them by name with the reason for
each.

The boundary is not a judgement call made per sync. It is a manifest, and a file
matching no rule in it fails CI rather than defaulting either way — which is the
specific failure this export has had before.

Two consequences worth stating plainly:

- **Other documents cite the withheld ones by number.** Those citations are
  accurate; the files simply live elsewhere. A dangling `docs/23` is deliberate,
  not a broken link.
- **Nothing excluded is load-bearing for a claim made on the public pages.** If
  you think something missing here *is*, that is a finding — please report it
  (`SECURITY.md`).

## Status

V1 core complete and CI-green: client-side-encrypted vault (3 tiers),
contact enrolment with possession proofs, the inactivity engine, sensitive
actions with cooldowns, and release ceremonies end-to-end — S1 sealed
envelopes and S2/S3 Shamir reconstruction (2-of-3 / 3-of-4), proven by the
workspace test suite plus multi-browser E2Es. (A count used to be quoted here;
it said ~720 against an actual figure more than double that, so it has been
removed rather than replaced with another number nobody will update.)

The **AI Guardian subsystem** is code-complete behind flags (off by default):
a metadata-only AI that can only ever *add* safety — readiness proposals the
owner approves, opt-in vetoable tightenings through the existing
sensitive-action pipeline, and deterministic guardian detectors that can pause
(never advance) a release. Structural guarantee + transparency: `docs/AI.md`;
ops: `docs/RUNBOOK-AI.md`.

No third-party security audit has been commissioned or performed. The
`/security` page says so plainly, and that stays true until one has.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).
Do not open a public issue for a security finding.

## License

[Apache License 2.0](LICENSE).
