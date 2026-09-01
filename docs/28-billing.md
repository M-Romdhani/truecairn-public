# 28 — Billing (LemonSqueezy)

**Status:** implemented (first slice — paid-channel gating). Free-only until the
env is configured; flags-off behaviour is byte-for-byte "everyone is free."

## What's paid

One paid plan, **Truecairn Pro** (shown as **Personal** in the UI), sold monthly
or annually (the split is a price/variant difference in LemonSqueezy, not a
distinct entitlement). The gating philosophy (owner-ratified): **never paywall
core safety.** Free covers the full safety machinery on the channels that cost
nothing — but it is deliberately a *small* tier, so the difference between Free
and Personal is real, not just the paid channels.

| | Free | Personal |
|---|---|---|
| Trusted contacts | **2** | unlimited |
| Vault items | **5** | unlimited |
| Encrypted-attachment storage | **10 MB** | **5 GB** |
| Channels | Email + Web Push | **+ SMS** |
| Core continuity (check-ins, escalation, ceremonies, report) | ✓ | ✓ |
| Release tiers, diverse-role consensus | **S1 & S2** | **S1–S3** |

**The release-tier row is DERIVED, not written down** (corrected 2026-08-10).
It used to read "All release tiers (S1–S3) ✓ ✓" and that was false of Free: S3's
nested scheme needs exactly **three** contacts (`TIER_CONTACT_COUNT`, now beside
`PLAN_LIMITS` in `packages/shared/src/billing.ts`) and Free caps contacts at
**two**, so the S3 share split has never been assignable on it. The claim sat on
the landing page, the upgrade page and this table — the three surfaces someone
reads while deciding to pay.

The failure mode is worse than an unavailable feature, which is why the copy
matters here. Filing an item into S3 is NOT gated — the tier is an attribute of
the item, and gating it would strand items existing accounts have already put
there. Only the *share split* is blocked. So an S3 item on a two-contact plan is
stored, sealed, and permanently unreleasable, on the most sensitive rung, with
no error at the time it is filed. `releaseTiersFor(plan)` now derives the
reachable tiers from the two constants, the pricing copy renders that, the
Contacts share form names the plan cap instead of advising an owner to enrol a
third contact they cannot add, and `release-tiers.test.ts` fails the build if a
plan surface asserts a tier the plan's own cap cannot reach.

The numbers live in ONE place — `PLAN_LIMITS` in `packages/shared/src/billing.ts`
— which both the server (enforcement) and the site (pricing/upgrade copy) read,
so what's advertised can never drift from what's gated. Enforcement points
(`apps/api/src/billing/limits.ts`), all fail-closed with **402
upgrade-required**:

- **Contacts** — `POST /v1/contacts` (`assertCanAddContact`).
- **Vault items** — `POST /v1/vault/items` (`assertCanAddVaultItem`).
- **Storage** — the attachment-upload reservation caps at
  `min(plan budget, VAULT_MAX_USER_TOTAL_BYTES)`; over-budget returns the
  existing 413 quota problem.

Caps are checked at CREATE only — a downgraded user keeps everything they made
and simply cannot add more until under the Free cap. `GET /v1/account/usage`
returns current counts vs limits for the Plans/Upgrade UI.

Rationale: the per-message channel (SMS) plus generous headroom on contacts,
items, and storage are what a serious user pays for — and nobody's release
safety net sits behind a paywall (see `docs/26` cost analysis).

**The table says SMS, not "SMS and WhatsApp", and that is deliberate.** WhatsApp
was withdrawn from enrolment on 2026-08-01 (`WITHDRAWN_CHANNEL_TYPES`,
`apps/api/src/billing/entitlement.ts`) because Meta refuses to let the account
create the verification template that gates channel setup itself — so no
WhatsApp channel can be created at all, by anyone, on any plan. It was sold as
part of Personal and should not have been; the changelog retracts that publicly,
and a plan table that still listed it would be the same claim made again. It
**stays** in `PRO_CHANNEL_TYPES` below, which is a different thing: that set
carries billing semantics for the grandfathering rules, and a verified WhatsApp
row (if one somehow exists) is a paid channel that keeps delivering. Availability
and billing semantics are separate questions and the sets that answer them are
separate too. `withdrawn-channels.test.ts` pins the plan and pricing surfaces
against `WITHDRAWN_CHANNEL_TYPES`, so a re-add un-gates the copy automatically
rather than leaving it to be remembered.

## How it works

- **Entitlement is derived, never a stored flag.** A user is `pro` exactly when
  they have a `billing_subscriptions` row (migration 0048) whose LemonSqueezy
  status still grants access: `active` / `on_trial` / `past_due`, or `cancelled`
  with `ends_at` in the future (a cancelled plan keeps access until the period
  ends). Absence of a row = `free`. `apps/api/src/billing/entitlement.ts` is the
  single reader.
- **The webhook is the only writer.** `POST /v1/billing/webhook/lemonsqueezy`
  verifies `X-Signature` (hex HMAC-SHA256 over the raw body — same discipline as
  the notification webhooks: verify before parse, fail closed, mounted only when
  the secret is set) and upserts the subscription from the event's
  `data.attributes.status`, keyed to our user by `meta.custom_data.user_id`
  (set on the checkout URL). It trusts the status on every subscription event,
  so any lifecycle transition converges the row to LemonSqueezy's truth.
  Invoice events are a 200 no-op.
- **Test-mode events are refused unless the deployment says otherwise.** Every
  LemonSqueezy payload carries `meta.test_mode`, and nothing read it until
  2026-08-10 — harmless only while the store had never left test mode. Once it
  is live, a stray test-mode event (a replay, a sandbox still pointed at the
  production endpoint, a mis-set dashboard URL) would entitle a real account to
  a plan nobody paid for. A test-mode event is now **ignored** and recorded as a
  `billing_test_mode_event_ignored` security event unless
  `LEMONSQUEEZY_TEST_MODE=true`.
  The guard is deliberately **one-directional**: a LIVE event is never gated by
  it. Failing closed there would be the worse bug — a flag left set after the
  switchover would silently stop entitling paying customers, and a silent
  entitlement failure after a real charge is a refund and an apology. Real money
  always entitles; only the pretend kind needs permission.
  **Ordering, for the switchover.** The pre-launch test purchase is made in test
  mode against the live deployment, so it needs `LEMONSQUEEZY_TEST_MODE=true`
  set for the duration and unset again before going live. The flag is
  deliberately not derived from `NODE_ENV`, which would have refused exactly
  that purchase — the same failure this guard prevents, moved one step earlier
  and onto the person checking that payments work at all.
- **Checkout** is a hosted LemonSqueezy page. `GET /v1/billing/checkout/:plan`
  (`pro_monthly` | `pro_annual`) returns the configured checkout URL with the
  caller's user id + email appended as custom data; the browser redirects to it.
  **No card data ever touches our origin.** No payment PII is stored — only LS
  identifiers + status + period boundaries.
- **Cancelling** goes to LemonSqueezy's own billing page, surfaced as
  `customerPortalUrl` on `GET /v1/billing/status` and rendered as "Manage
  subscription" on the Plans card and beside the `/upgrade` fine print.
  Added 2026-08-10: "Cancel anytime" was promised on the checkout description
  and in that fine print, and the product had **no route to it at all** — the
  only way out was finding the LemonSqueezy receipt email. There is deliberately
  **no cancel API here**: LemonSqueezy owns the subscription, and proxying a
  cancel would mean this service holding a key that can mutate billing. Making
  their portal reachable is the whole fix.
  The URL is the **store's stable billing page** (`LEMONSQUEEZY_CUSTOMER_PORTAL_URL`),
  not the per-subscription `urls.customer_portal` LemonSqueezy puts on every
  webhook payload. That one is a signed link that expires, so persisting it
  would hand someone a dead URL on precisely the day they reach for it — the
  same shape as a recovery code nobody has ever typed back in. It is offered to
  anyone holding a subscription row, entitled or not: someone who has already
  cancelled, or whose payment is failing, is exactly who needs it. Unset ⇒ null
  ⇒ no link, never a broken one.
- **Gating** is enforced server-side: adding an SMS/WhatsApp channel as a free
  user returns **402** (`.../problems/upgrade-required`). The Settings picker
  reads `enrollableChannelTypes` from `GET /v1/settings/channels` and only shows
  what the plan allows **and what this deployment can actually deliver**;
  the Plans page shows the current plan + usage vs limits
  and a single **Upgrade** button into the dedicated `/upgrade` page (plan value,
  monthly/yearly choice, hosted checkout).

### What `enrollableChannelTypes` actually intersects (2026-08-31)

Three sets, subtracted in this order, and the order is load-bearing:

1. **the plan** — `email`/`push` free, `PRO_CHANNEL_TYPES` on top for pro;
2. **what the deployment can deliver** — `configuredChannelTypes()`, i.e. whether
   the provider credentials are present;
3. **withdrawn types** — `WITHDRAWN_CHANNEL_TYPES`, subtracted LAST so a withdrawn
   type disappears for every plan rather than reading as something a paid plan
   would unlock, and so configuring a provider cannot un-withdraw it.

Step 2 was added on 2026-08-31 and is the same defect the WhatsApp withdrawal
already fixed, reached from the other direction. Entitlement alone used to decide
this, so a pro plan on a deployment with no `TWILIO_*` would offer `sms`, the
verification code would dead-letter, and the channel could **never** become
verified — because the code round-trip *is* how a channel becomes verified. The
comment on `WITHDRAWN_CHANNEL_TYPES` names the property: nobody is sent into a
flow that cannot complete. An unconfigured provider is exactly that flow.

It is derived from `configuredNotificationTypes()` rather than re-reading env, so
the Settings picker and `/status` can never disagree about whether a channel is
deliverable.

**This changes what is OFFERED, never what already exists.** Verified rows are
grandfathered and are never re-gated — same rule as the downgrade behaviour
below, and the same shape as the WhatsApp withdrawal.

## Config

`LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_CHECKOUT_PRO_MONTHLY`,
`LEMONSQUEEZY_CHECKOUT_PRO_ANNUAL`, `LEMONSQUEEZY_TEST_MODE` (see `docs/21`).
All optional — absent ⇒ free-only, never a boot failure.

## Downgrade behaviour (decided July 2026: keep delivering + notify)

The owner-ratified rule: **money can block adding a resource, never retrieving
what exists or silencing a channel that already guards a vault.** So when a
subscription lapses:

- Already-verified paid channels (SMS/WhatsApp) **keep delivering** — nothing
  is soft-disabled, re-gated, or deleted, ever. The per-message cost of a
  grandfathered channel is trivial next to a missed check-in during an
  escalation.
- On the **entitled→not-entitled webhook edge**, if live verified paid
  channels remain, ONE `plan_downgraded` notice is enqueued in the same
  transaction as the subscription-row update (edge detection makes replays
  no-ops). It goes to the owner's matrix-eligible channels (`owner_notices`
  class), preferring email; the body states the safety promise — everything
  verified keeps working — and points at upgrade for NEW premium channels.
- Existing over-cap resources (contacts, items, storage) stay per the CREATE-
  only rule above; only new creates are gated.
- The Settings channels card shows a **persistent banner** while the account is
  free with residual verified paid channels: which destinations are
  grandfathered, the promise that nothing was turned off, and that NEW paid
  channels need Personal (Gap plan G-3).

## Deferred (follow-ons)

- Contact count, vault-item count, and attachment storage are now gated (above);
  gating S2/S3 multi-party release to pro is the remaining entitlement call site.
- A "manage subscription" link to the LemonSqueezy customer portal.
