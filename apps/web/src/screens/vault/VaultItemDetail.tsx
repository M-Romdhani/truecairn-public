import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VAULT_TIERS, type VaultTier } from '@truecairn/shared';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { requestWithStepUp } from '../../api/stepup.js';
import { ApiError, apiJson } from '../../api/client.js';
import { useSession } from '../../crypto/session.js';
import { downloadAttachment, uploadAttachment } from '../../vault/attachments.js';
import { AttachmentPicker } from '../../vault/AttachmentPicker.js';
import { deleteItem, getItem, moveItemTier, revertItem } from '../../vault/api.js';
import { unwrapItem } from '../../vault/crypto.js';
import { formatDateTime } from '../../lib/dates.js';
import { VaultLockBanner } from './VaultLockBanner.js';
import { formatBytes } from '../../lib/format.js';
import './vault.css';
import { Trans } from 'react-i18next';
import { useT } from '../../i18n/useT.js';
import { useServerMessage } from '../../i18n/useServerMessage.js';

// Item detail: fetch the (outer-unwrapped) ciphertext, decrypt it client-side
// (the zero-knowledge round-trip), and offer the sensitive flows. Tier-move and
// delete are 7-DAY-DELAYED sensitive actions: they go through the step-up
// interceptor and the UI surfaces the PENDING state — it never claims the change
// took effect (PHASE4 C3 property #2). The 2nd-factor prompt is injected
// (proveSecondFactor); the full 2nd-factor modal is wired by the app shell.

// The server already said what went wrong, in RFC 7807. Discarding it and
// printing "Please try again" is worse than unhelpful on a deterministic 4xx:
// trying again produces the identical failure. That preference now lives in the
// shared useServerMessage() hook, which keeps it while the UI is in the source
// language and falls back to this screen's own message otherwise — the server's
// `detail` is always English and there is no stable key to translate it against
// (docs/40).

// The tier the "Move to tier" control should start on. The <select> omits the
// item's CURRENT tier, so a constant default cannot be right for every item: on
// an S2 item `'s2'` matched no option, the browser fell back to rendering the
// first one (S1) while React state stayed `'s2'`, and the request asked to move
// the item to the tier it was already in — a guaranteed 400 from
// tierMovePrecondition. Deriving it makes the rendered option and the submitted
// value the same value by construction.
//
// Direction is deliberate: prefer the next tier UP, and step down only from the
// top. S1 → S2 → S3 is increasing protection (a sealed envelope, then 2-of-3
// Shamir, then the nested 3-of-4 with the mandatory release passphrase), and a
// default nobody chose must not quietly reduce an item's protection — this
// control is one click and a seven-day timer away from applying.
function defaultMoveTarget(current: VaultTier): VaultTier {
  const i = VAULT_TIERS.indexOf(current);
  return VAULT_TIERS[i + 1] ?? VAULT_TIERS[i - 1] ?? current;
}

export function VaultItemDetail({
  itemId,
  fetchImpl,
  proveSecondFactor,
}: {
  itemId: string;
  fetchImpl?: typeof fetch;
  proveSecondFactor?: (accepted: string[]) => Promise<void>;
}): JSX.Element {
  const t = useT();
  const serverMessage = useServerMessage();
  const { userId } = useSession();
  const queryClient = useQueryClient();
  // null = "the owner has not chosen"; the effective value is derived from the
  // item below, once it has loaded. Seeding this with a tier would reintroduce
  // the same bug, because the item is not known at first render.
  const [newTier, setNewTier] = useState<VaultTier | null>(null);
  const [pending, setPending] = useState<{ label: string; effectiveAt: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which action is in flight — so the exact button the user clicked shows an
  // immediate "…" state and the outcome lands where they acted (QA Finding 1).
  const [busy, setBusy] = useState<null | 'tier' | 'delete' | 'revert'>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['vault-item', itemId],
    queryFn: () => getItem(itemId, fetchImpl),
  });

  const decrypted = useMemo(() => (data ? unwrapItem(data) : null), [data]);

  // Fail toward "nothing is scheduled". The contract makes this field always
  // present, but an API older than this bundle would omit it, and a MISSING
  // field must never render as a scheduled destruction — the honest failure is
  // to show the actions, not to tell someone their item is going away.
  const scheduledDeleteAt =
    typeof data?.pendingDeleteAt === 'string' ? data.pendingDeleteAt : null;

  // Encrypted attachments (QA 2026-07-17 issue #2). Encrypt-before-upload and
  // decrypt-after-download both run here, under the item's own key; the server
  // round-trips opaque bytes. Purge is the existing 7-day sensitive action.
  const [pickFiles, setPickFiles] = useState<File[]>([]);
  const [attBusy, setAttBusy] = useState<string | null>(null);

  async function onUploadAttachments(): Promise<void> {
    if (!data || pickFiles.length === 0) {
      setError(t('item.attachment.chooseFirst'));
      return;
    }
    setError(null);
    setNotice(null);
    setAttBusy('upload');
    const failed: string[] = [];
    let stored = 0;
    // A release/review lock (409) fails EVERY file for the same reason — name it
    // rather than blaming plan storage (QA 2026-07-23 F5).
    let locked = false;
    try {
      for (const file of pickFiles) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await uploadAttachment(
            itemId,
            data,
            { bytes, name: file.name, type: file.type || 'application/octet-stream' },
            fetchImpl,
          );
          stored += 1;
        } catch (err) {
          if (
            err instanceof ApiError &&
            err.status === 409 &&
            err.problem.type === 'https://truecairn.app/problems/vault-locked-during-release'
          ) {
            locked = true;
          }
          failed.push(file.name);
        }
      }
      setPickFiles([]);
      await queryClient.invalidateQueries({ queryKey: ['vault-item', itemId] });
      if (failed.length === 0) {
        setNotice(t('item.attachment.stored', { count: stored }));
      } else if (locked) {
        setError(t('item.error.lockedUpload'));
      } else {
        setError(
          t('item.attachment.failed', { count: failed.length, files: failed.join(', ') }),
        );
      }
    } finally {
      setAttBusy(null);
    }
  }

  async function onDownloadAttachment(attachmentId: string): Promise<void> {
    if (!data) return;
    setError(null);
    setAttBusy(`dl-${attachmentId}`);
    try {
      const { name, type, bytes } = await downloadAttachment(itemId, attachmentId, data, fetchImpl);
      const blobUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = name;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      // A 404/403 from the server and a failed decrypt are different problems
      // with different answers; only the second is about decryption.
      setError(serverMessage(err instanceof ApiError ? err.problem.detail : undefined, 'item.error.decrypt'));
    } finally {
      setAttBusy(null);
    }
  }

  async function onPurgeAttachment(attachmentId: string): Promise<void> {
    setError(null);
    setNotice(null);
    setAttBusy(`purge-${attachmentId}`);
    try {
      const res = await requestWithStepUp(
        { url: '/v1/vault/items/attachments/purge', method: 'POST', body: { attachmentId } },
        stepUpDeps(),
      );
      const enq = await apiJson<{ effectiveAt: string }>(res);
      setPending({ label: t('item.pending.attachmentRemoval'), effectiveAt: enq.effectiveAt });
    } catch (err) {
      setError(
        serverMessage(
          err instanceof ApiError ? err.problem.detail : undefined,
          'item.error.removal',
        ),
      );
    } finally {
      setAttBusy(null);
    }
  }

  function stepUpDeps() {
    if (userId === null) throw new Error('not unlocked');
    return {
      userId,
      proveSecondFactor:
        proveSecondFactor ??
        ((): Promise<void> => Promise.reject(new Error('second-factor prompt not wired'))),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    };
  }

  async function onMoveTier(): Promise<void> {
    if (!data) return;
    const target = newTier ?? defaultMoveTarget(data.tier);
    setError(null);
    setNotice(null);
    setBusy('tier');
    try {
      const result = await moveItemTier(
        {
          itemId,
          oldTier: data.tier,
          newTier: target,
          aadVersion: data.aadVersion,
          wrappedPerItemKey: data.wrappedPerItemKey,
          wrappedPerItemKeyNonce: data.wrappedPerItemKeyNonce,
          // The title moves with the key — it is encrypted under the tier key
          // too, and leaving it behind is what broke every moved item.
          titleCiphertext: data.titleCiphertext,
          titleNonce: data.titleNonce,
        },
        stepUpDeps(),
      );
      setPending({
        label: t('item.pending.tierChange', { tier: target.toUpperCase() }),
        effectiveAt: result.effectiveAt,
      });
    } catch (err) {
      setError(
        serverMessage(
          err instanceof ApiError ? err.problem.detail : undefined,
          'item.error.tierChange',
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy('delete');
    try {
      const result = await deleteItem(itemId, stepUpDeps());
      setPending({ label: t('item.pending.deletion'), effectiveAt: result.effectiveAt });
      // Pick up the server's own pending_delete_at, so the banner survives a
      // reload instead of living only in this component's state.
      await queryClient.invalidateQueries({ queryKey: ['vault-item', itemId] });
    } catch (err) {
      setError(
        serverMessage(
          err instanceof ApiError ? err.problem.detail : undefined,
          'item.error.deletion',
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function onRevert(): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy('revert');
    try {
      await revertItem(itemId, stepUpDeps());
      // Revert is immediate (not a delayed action): refetch so the page reflects
      // the restored content, and confirm on the same screen (QA Finding 1).
      await queryClient.invalidateQueries({ queryKey: ['vault-item', itemId] });
      setNotice(t('item.reverted'));
    } catch (err) {
      setError(
        serverMessage(
          err instanceof ApiError ? err.problem.detail : undefined,
          'item.error.revert',
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  if (isLoading)
    return (
      <div className="app-col">
        <p className="t-2">{t('item.loading')}</p>
      </div>
    );
  if (isError || data === undefined || decrypted === null) {
    return (
      <div className="app-col">
        <p role="alert" className="alert">
          {t('item.error.open')}
        </p>
      </div>
    );
  }

  return (
    <section aria-labelledby="vault-item" className="app-col">
      {/* Back to the list — the sidebar Vault link scrolls to the create form,
          so the detail view needs its own way back (audit M8). */}
      <div className="mb-md">
        <Link to="/vault" className="link-btn">
          {t('item.back')}
        </Link>
      </div>
      <VaultLockBanner {...(fetchImpl !== undefined ? { fetchImpl } : {})} />
      <div className="card card-pad stack gap-md">
        <div>
          <h1 id="vault-item" className="h-section">
            {decrypted.title}
          </h1>
          <p data-testid="item-tier" className="small t-3 mt-xs">
            {t('item.tier', { tier: data.tier.toUpperCase() })}
          </p>
        </div>
        <article aria-label={t('item.contentLabel')} className="vault-item-body">
          {decrypted.content}
        </article>
        {/* Items are write-once by design (audit M9): an immutable record keeps
            the signed audit trail honest. Re-tier or delete instead of editing.
            The copy scopes immutability to the RECORD (title + content) so it does
            not read as if attachments — which ARE add/remove — are frozen too. */}
        <p className="hint">{t('item.immutable')}</p>

        {scheduledDeleteAt !== null ? (
          // The SERVER's copy of the pending state, so it survives a reload —
          // the local `pending` banner below evaporated on re-render, which left
          // a scheduled destruction invisible from the item it would destroy
          // (QA 2026-08-10 F-01). Cancelling lives on the Engine page, so say
          // where rather than leaving the owner to find it.
          <p role="status" data-testid="pending-deletion" className="alert">
            <Trans
              i18nKey="item.pendingDeletion"
              values={{ when: formatDateTime(scheduledDeleteAt) }}
              components={{ engine: <Link to="/engine" /> }}
            />
          </p>
        ) : pending !== null ? (
          // PROPERTY #2: a delayed sensitive action is PENDING — say so honestly,
          // never imply it already applied. It is cancellable during the window.
          // Still local state: tier moves and reverts have no persisted marker on
          // the item, so this is the only feedback for those.
          <p role="status" data-testid="pending-action" className="alert">
            {t('item.pendingAction', {
              label: pending.label,
              when: formatDateTime(pending.effectiveAt),
            })}
          </p>
        ) : (
          <>
            <hr className="divider" />
            <div className="row-title">{t('item.actions')}</div>
            {/* Bottom-align (`end`, not `middle`): the tier <select> carries a
                stacked label, so the whole .field is taller than the button
                group. Centering floated the buttons up against the label; with
                the row bottom-aligned they sit flush with the select's bottom
                edge — the buttons line up with the control, not the label. */}
            <div className="row gap-md end wrap">
              <div className="field">
                <label className="field-label" htmlFor="move-tier">
                  {t('item.moveTier')}
                </label>
                <select
                  id="move-tier"
                  className="select"
                  // Derived, never constant: this must be one of the options
                  // below, and the options exclude data.tier.
                  value={newTier ?? defaultMoveTarget(data.tier)}
                  onChange={(e) => setNewTier(e.target.value as VaultTier)}
                >
                  {VAULT_TIERS.filter((t) => t !== data.tier).map((t) => (
                    <option key={t} value={t}>
                      {t.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row gap-sm end">
                <button
                  type="button"
                  className="btn secondary sm"
                  disabled={busy !== null}
                  onClick={onMoveTier}
                >
                  {busy === 'tier' ? t('item.requesting') : t('item.requestTierChange')}
                </button>
                <button
                  type="button"
                  className="btn danger sm"
                  disabled={busy !== null}
                  onClick={onDelete}
                >
                  {busy === 'delete' ? t('item.requesting') : t('item.delete')}
                </button>
                {/* A real (tertiary) button, not a plain link, to match its
                    siblings (audit M7). */}
                <button
                  type="button"
                  className="btn secondary sm"
                  disabled={busy !== null}
                  onClick={onRevert}
                >
                  {busy === 'revert' ? t('item.reverting') : t('item.revert')}
                </button>
              </div>
            </div>
          </>
        )}
        {/* The outcome lands WHERE THE USER ACTED. These used to render at the
            very bottom of the card, below the whole attachments block — picker,
            upload button and one row per file — so on an item with attachments
            the reply to a click at the top of the card arrived off-screen. The
            2026-08-10 QA pass recorded the tier-change failure as "nothing at
            all appears on screen"; the alert was rendering, just nowhere the
            person who clicked would look. Keep these adjacent to the controls. */}
        {notice !== null && (
          <p role="status" data-testid="item-notice" className="alert success">
            {notice}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        {data.deletedAt === null && (
          <div className="stack gap-sm" data-testid="attachments-section">
            <hr className="divider" />
            <div className="row-title">{t('item.attachments')}</div>
            <p className="small t-2">{t('item.attachments.lede')}</p>
            {(data.attachments ?? [])
              .filter((a) => a.status === 'stored')
              .map((a) => (
                <div key={a.id} className="row between middle gap-md wrap" data-testid={`attachment-${a.id}`}>
                  <div className="small">
                    {t('item.attachment.row', {
                      size: formatBytes(a.sizeBytes),
                      when: formatDateTime(a.createdAt),
                    })}
                  </div>
                  <div className="row gap-sm middle">
                    <button
                      type="button"
                      className="btn secondary sm"
                      disabled={attBusy !== null}
                      data-testid={`attachment-download-${a.id}`}
                      onClick={() => void onDownloadAttachment(a.id)}
                    >
                      {attBusy === `dl-${a.id}`
                        ? t('item.attachment.decrypting')
                        : t('item.attachment.download')}
                    </button>
                    {/* A purge leaves status on 'stored', so without the date
                        this row was indistinguishable from a live file and
                        still offered "Remove (7-day)" on one already going. */}
                    {typeof a.pendingDeleteAt === 'string' ? (
                      <span
                        className="small t-2"
                        role="status"
                        data-testid={`attachment-pending-delete-${a.id}`}
                      >
                        {t('item.attachment.pendingRemoval', {
                          when: formatDateTime(a.pendingDeleteAt),
                        })}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn secondary sm"
                        disabled={attBusy !== null}
                        data-testid={`attachment-purge-${a.id}`}
                        onClick={() => void onPurgeAttachment(a.id)}
                      >
                        {attBusy === `purge-${a.id}`
                          ? t('item.requesting')
                          : t('item.attachment.remove')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            <AttachmentPicker
              files={pickFiles}
              onChange={setPickFiles}
              disabled={attBusy !== null}
              idPrefix="detail-attach"
            />
            <div className="row">
              <button
                type="button"
                className="btn primary sm"
                disabled={attBusy !== null || pickFiles.length === 0}
                data-testid="attachment-upload"
                onClick={() => void onUploadAttachments()}
              >
                {attBusy === 'upload'
                  ? t('item.attachment.uploading')
                  : pickFiles.length > 0
                    ? t('item.attachment.attach', { count: pickFiles.length })
                    : t('item.attachment.attachNone')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
