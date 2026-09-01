import {
  VAULT_CATEGORIES,
  VAULT_TIERS,
  recipientsForCategory,
  type VaultCategory,
  type VaultTier,
} from '@truecairn/shared';
import { useState, type FormEvent } from 'react';
import { Trans } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import { createItem } from '../../vault/api.js';
import { uploadAttachment } from '../../vault/attachments.js';
import { AttachmentPicker } from '../../vault/AttachmentPicker.js';
import { categoryLabel, recipientTypeLabel } from '../../lib/labels.js';
import { useT } from '../../i18n/useT.js';
import { useServerMessage } from '../../i18n/useServerMessage.js';
import { ITEM_AAD_VERSION_CURRENT } from '@truecairn/keys';

// Create a vault item, optionally with attachments in the SAME flow. The content
// + title are CONTROLLED inputs (unlike the master passphrase — this is vault
// data the user is actively editing, not the key to everything). The
// zero-knowledge guarantee is upheld at the boundary: createItem wraps everything
// client-side, and attachments are encrypted under the item's own per-item key
// before upload — only ciphertext leaves the browser.
//
// Attachments can't ride the SAME request (a file must reference an existing item
// id), so the honest sequence is: create the item, then upload each encrypted
// file. If a file fails (network, or the 402 storage cap), the item still exists —
// we surface a link to it so the user retries there rather than silently losing
// the file. onCreated(id, hadAttachments) lets the shell navigate to the item on
// a clean attach so the freshly-stored files are visible immediately.
export function CreateItem({
  onCreated,
  // When supplied, the card gains a Close control. The form is collapsible on the
  // vault page so a full list is not pushed below a form nobody is filling in;
  // it stays permanently open anywhere that does not pass this.
  onCancel,
}: {
  onCreated?: (id: string, hadAttachments: boolean) => void;
  onCancel?: () => void;
}): JSX.Element {
  const t = useT();
  const serverMessage = useServerMessage();
  const [tier, setTier] = useState<VaultTier>('s1');
  // Defaults to the NARROWEST category docs/03 defines: personal_archive is S3 for
  // the only two recipient types that may see it at all. An item whose category the
  // owner has not thought about yet should sit where it reaches fewest people, and
  // be widened deliberately — the same direction of default as every other gate here.
  const [category, setCategory] = useState<VaultCategory>('personal_archive');
  // The docs/03 matrix row for the chosen category, recomputed as they change it.
  const guidance = recipientsForCategory(category);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  // Progress line while encrypting + uploading (files can be multi-MB and
  // encryption is synchronous WASM — the user needs to see forward motion).
  // Structured rather than a rendered sentence: the counters are data, and a
  // language change mid-upload must re-render the line instead of freezing it in
  // whichever language it started in.
  const [phase, setPhase] = useState<
    { kind: 'saving' } | { kind: 'uploading'; n: number; total: number } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the create is blocked by the Free-plan cap (402): show the reason +
  // an upgrade link instead of the generic error.
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  // Set when the vault is locked because a release/review is in progress (409):
  // a generic "try again" reads as a plan/limit bug (QA 2026-07-23 F5), so name
  // the real cause and point at the Engine page where it's resolved.
  const [lockedMsg, setLockedMsg] = useState<string | null>(null);
  // On partial attachment failure: the item WAS created — point the user at it.
  const [partial, setPartial] = useState<{ id: string; failed: string[] } | null>(null);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setLimitMsg(null);
    setLockedMsg(null);
    setPartial(null);
    setBusy(true);
    try {
      setPhase(files.length > 0 ? { kind: 'saving' } : null);
      const created = await createItem({ tier, category, title, content });

      const failed: string[] = [];
      if (files.length > 0) {
        const itemKeyRef = {
          tier,
          id: created.id,
          aadVersion: ITEM_AAD_VERSION_CURRENT,
          wrappedPerItemKey: created.wrappedPerItemKey,
          wrappedPerItemKeyNonce: created.wrappedPerItemKeyNonce,
        };
        let n = 0;
        for (const f of files) {
          n += 1;
          setPhase({ kind: 'uploading', n, total: files.length });
          try {
            const bytes = new Uint8Array(await f.arrayBuffer());
            await uploadAttachment(created.id, itemKeyRef, {
              bytes,
              name: f.name,
              type: f.type || 'application/octet-stream',
            });
          } catch {
            failed.push(f.name);
          }
        }
      }

      // Reset the form for the next item either way.
      setTitle('');
      setContent('');
      setFiles([]);
      if (failed.length > 0) {
        // The item exists; some files didn't attach. Stay put and surface the
        // retry path rather than navigating away and hiding the loss.
        setPartial({ id: created.id, failed });
        onCreated?.(created.id, false);
      } else {
        onCreated?.(created.id, files.length > 0);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setLimitMsg(serverMessage(err.problem.detail, 'vault.create.error.limit'));
      } else if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.problem.type === 'https://truecairn.app/problems/vault-locked-during-release'
      ) {
        setLockedMsg(t('vault.create.error.locked'));
      } else {
        setError(t('vault.create.error.generic'));
      }
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  return (
    <section aria-labelledby="vault-new" className="card card-pad">
      <div className="row between middle gap-md">
        <div>
          <h1 id="vault-new" className="h-section">
            {t('vault.create.heading')}
          </h1>
          <p className="small t-2 mt-xs">{t('vault.create.lede')}</p>
        </div>
        {onCancel !== undefined && (
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            {t('vault.create.close')}
          </button>
        )}
      </div>
      <form onSubmit={onSubmit} className="stack gap-md mt-lg">
        <div className="row gap-md">
          <div className="field">
            <label className="field-label" htmlFor="item-tier">
              {t('vault.create.field.tier')}
            </label>
            <select
              id="item-tier"
              className="select"
              value={tier}
              onChange={(e) => setTier(e.target.value as VaultTier)}
            >
              {VAULT_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="field flex-1">
            <label className="field-label" htmlFor="item-category">
              {t('vault.create.field.category')}
            </label>
            <select
              id="item-category"
              className="select"
              value={category}
              onChange={(e) => setCategory(e.target.value as VaultCategory)}
            >
              {VAULT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Advisory only (docs/03). The release path never consults this; it
            answers "who is this for?" at the one moment the owner is deciding,
            where the alternative is an unguided guess whose consequences arrive
            when they are not there to correct them. */}
        <div className="field" data-testid="category-guidance">
          <p className="small t-2">
            <Trans
              i18nKey="vault.create.guidance.who"
              values={{ category: categoryLabel(category) }}
              components={{ strong: <strong /> }}
            />
          </p>
          <ul className="small t-2 mt-xs">
            {VAULT_TIERS.filter((x) => guidance.byTier[x].length > 0).map((tierOption) => (
              <li key={tierOption}>
                <strong>{tierOption.toUpperCase()}</strong> —{' '}
                {guidance.byTier[tierOption].map(recipientTypeLabel).join(', ')}
                {tierOption === tier ? t('vault.create.guidance.pickedTier') : ''}
              </li>
            ))}
            {guidance.excluded.length > 0 ? (
              <li>
                <strong>{t('vault.create.guidance.never')}</strong> —{' '}
                {guidance.excluded.map(recipientTypeLabel).join(', ')}
              </li>
            ) : null}
          </ul>
          <p className="small t-2 mt-xs">{t('vault.create.guidance.advisory')}</p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="item-title">
            {t('vault.create.field.title')}
          </label>
          <input
            id="item-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="item-content">
            {t('vault.create.field.content')}
          </label>
          <textarea
            id="item-content"
            className="textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <span className="field-label">{t('vault.create.field.attachments')}</span>
          <AttachmentPicker files={files} onChange={setFiles} disabled={busy} idPrefix="new-attach" />
        </div>

        {phase !== null && (
          <p role="status" data-testid="create-progress" className="small t-2">
            {phase.kind === 'saving'
              ? t('vault.create.phase.saving')
              : t('vault.create.phase.uploading', { n: phase.n, total: phase.total })}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        {limitMsg !== null && (
          <p role="alert" className="alert" data-testid="item-limit">
            {limitMsg}{' '}
            <Link to="/upgrade" className="link">
              {t('vault.create.upgradeLink')}
            </Link>
          </p>
        )}
        {lockedMsg !== null && (
          <p role="alert" className="alert" data-testid="item-locked">
            {lockedMsg}{' '}
            <Link to="/engine" className="link">
              {t('vault.create.engineLink')}
            </Link>
          </p>
        )}
        {partial !== null && (
          <p role="status" data-testid="create-partial" className="alert">
            <Trans
              i18nKey="vault.create.partial"
              count={partial.failed.length}
              values={{ files: partial.failed.join(', ') }}
              components={{ open: <Link to={`/vault/${partial.id}`} className="link" /> }}
            />
          </p>
        )}
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? t('vault.create.submitBusy') : t('vault.create.submit')}
          </button>
        </div>
      </form>
    </section>
  );
}
