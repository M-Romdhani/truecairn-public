import type { VaultTier } from './enums.js';

// ─────────────────────────────────────────────────────────────────────────────
// Wire contracts — the response bodies the browser parses.
//
// WHY THIS FILE EXISTS. Three shipped defects share one shape: the server stops
// serializing a field the client needs, and nothing fails. `aadVersion` vanished
// from GET /v1/vault/items and every title in the vault list read "Title
// unavailable" in production (#171). `pendingDeleteAt` is written by the delete
// route and never returned, so a scheduled destruction is invisible from the
// item it will destroy. Neither test layer can see either one: the API tests
// assert the DATABASE, the web tests mock the SERVER, and the response body is
// exactly the seam between them. The suite was green through both.
//
// A contract below is the ONE definition of one response body, enforced three
// times — and all three have to agree:
//
//   1. TYPE — the API serializer's return type IS the contract, so `tsc`
//      rejects a dropped or misspelled field. This layer needs no database and
//      no test runner, so unlike a DB-backed suite it cannot silently skip —
//      which is how the 2026-08-07 near-miss got as far as it did.
//   2. RUNTIME — apps/api/src/routes/response-contract.test.ts drives the real
//      route and asserts the response's key set EXACTLY equals the contract's.
//      It catches what types cannot: a serializer widened to
//      `Record<string, unknown>`, a field whose value serializes to `undefined`
//      (JSON drops the key entirely), and any EXTRA key — not mere tidiness on
//      a zero-knowledge product, where an unplanned field is server metadata
//      nobody decided to publish.
//   3. CLIENT — apps/web imports these types instead of restating them, so the
//      browser cannot consume a field the server never promised.
//
// Adding a field is one edit here and one in the serializer; forget the second
// and the build says so. To cover another response, add its contract here, type
// that serializer, and add one case to the runtime test.
//
// Deliberately NOT done by adding Fastify `response` schemas: fast-json-stringify
// STRIPS anything the schema omits, so a response schema written from a stale
// understanding of the route produces this exact bug at runtime instead of
// preventing it — silently, in production, on a route whose tests still pass.
// Response schemas are also applied inconsistently today (2 of 7 routes in
// vault.ts, 0 of 9 in engine.ts), so they are not a gate anyone can rely on.
// ─────────────────────────────────────────────────────────────────────────────

// Type-level equality. A plain `extends` pair is not enough — it is satisfied by
// a mere subtype, which is precisely the shape of "a field went missing".
// `Assert` then fails to compile when the two key sets differ.
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

// ── GET /v1/vault/items/:id ──────────────────────────────────────────────────

// The attachment metadata embedded in an item. Server-side facts only: id,
// CIPHERTEXT size, lifecycle status — the filename and MIME type live inside the
// encrypted blob and must never appear here.
export interface VaultAttachmentSummaryDto {
  id: string;
  sizeBytes: number;
  status: string;
  // A purge is a 7-day sensitive action that sets this and leaves `status` on
  // 'stored'. Without it the client cannot tell a live attachment from one
  // scheduled for destruction, and renders "Remove (7-day)" on both.
  pendingDeleteAt: string | null;
  createdAt: string;
}

export const VAULT_ATTACHMENT_SUMMARY_DTO_FIELDS = [
  'id',
  'sizeBytes',
  'status',
  'pendingDeleteAt',
  'createdAt',
] as const;

export type VaultAttachmentSummaryDtoField = (typeof VAULT_ATTACHMENT_SUMMARY_DTO_FIELDS)[number];
export type VaultAttachmentSummaryDtoPinned = Assert<
  Equals<keyof VaultAttachmentSummaryDto, VaultAttachmentSummaryDtoField>
>;

export interface VaultItemDto {
  id: string;
  tier: VaultTier;
  // The client rebuilds the title/content AAD from (tier, id) and must know
  // which construction was used — a v1 title carried no AAD at all, which is not
  // the same as an empty one (F3, migration 0062). `undefined` is not 2.
  aadVersion: number;
  category: string;
  clientOrdinal: number | null;
  contentCiphertext: string;
  contentNonce: string;
  wrappedPerItemKey: string;
  wrappedPerItemKeyNonce: string;
  titleCiphertext: string;
  titleNonce: string;
  contentSizeBytes: number;
  // Already applied — the item is soft-deleted.
  deletedAt: string | null;
  // SCHEDULED, not applied: the delete route sets this to the effective date and
  // the action is cancellable until then. The item is fully readable meanwhile,
  // so this is the only signal that it is going away.
  pendingDeleteAt: string | null;
  attachments: VaultAttachmentSummaryDto[];
  createdAt: string;
  updatedAt: string;
}

export const VAULT_ITEM_DTO_FIELDS = [
  'id',
  'tier',
  'aadVersion',
  'category',
  'clientOrdinal',
  'contentCiphertext',
  'contentNonce',
  'wrappedPerItemKey',
  'wrappedPerItemKeyNonce',
  'titleCiphertext',
  'titleNonce',
  'contentSizeBytes',
  'deletedAt',
  'pendingDeleteAt',
  'attachments',
  'createdAt',
  'updatedAt',
] as const;

export type VaultItemDtoField = (typeof VAULT_ITEM_DTO_FIELDS)[number];
export type VaultItemDtoPinned = Assert<Equals<keyof VaultItemDto, VaultItemDtoField>>;

// ── GET /v1/vault/items ──────────────────────────────────────────────────────

// The list row is deliberately NOT the item minus a few fields: it never carries
// content ciphertext or the wrapped per-item key, because listing must not ship
// the vault. Keep the two contracts separate so that stays a decision rather
// than an accident of reuse.
export interface VaultListItemDto {
  id: string;
  tier: VaultTier;
  aadVersion: number;
  category: string;
  clientOrdinal: number | null;
  titleCiphertext: string;
  titleNonce: string;
  contentSizeBytes: number;
  updatedAt: string;
  deletedAt: string | null;
  pendingDeleteAt: string | null;
}

export const VAULT_LIST_ITEM_DTO_FIELDS = [
  'id',
  'tier',
  'aadVersion',
  'category',
  'clientOrdinal',
  'titleCiphertext',
  'titleNonce',
  'contentSizeBytes',
  'updatedAt',
  'deletedAt',
  'pendingDeleteAt',
] as const;

export type VaultListItemDtoField = (typeof VAULT_LIST_ITEM_DTO_FIELDS)[number];
export type VaultListItemDtoPinned = Assert<Equals<keyof VaultListItemDto, VaultListItemDtoField>>;

export interface VaultListDto {
  items: VaultListItemDto[];
  nextCursor: string | null;
}

export const VAULT_LIST_DTO_FIELDS = ['items', 'nextCursor'] as const;
export type VaultListDtoField = (typeof VAULT_LIST_DTO_FIELDS)[number];
export type VaultListDtoPinned = Assert<Equals<keyof VaultListDto, VaultListDtoField>>;

// ── GET /v1/vault/items/:id/attachments/:attachmentId ────────────────────────

// The standalone attachment read. This one already carried `pendingDeleteAt`
// before the contract existed — it is the pattern the item routes were supposed
// to follow, and it doubles as the runtime test's positive control: a contract
// that only ever fails is indistinguishable from one that is simply wrong.
export interface VaultAttachmentDto {
  id: string;
  vaultItemId: string;
  sizeBytes: number;
  status: string;
  pendingDeleteAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const VAULT_ATTACHMENT_DTO_FIELDS = [
  'id',
  'vaultItemId',
  'sizeBytes',
  'status',
  'pendingDeleteAt',
  'createdAt',
  'updatedAt',
] as const;

export type VaultAttachmentDtoField = (typeof VAULT_ATTACHMENT_DTO_FIELDS)[number];
export type VaultAttachmentDtoPinned = Assert<
  Equals<keyof VaultAttachmentDto, VaultAttachmentDtoField>
>;
