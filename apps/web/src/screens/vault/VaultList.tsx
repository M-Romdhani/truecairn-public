import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VAULT_TIERS, type VaultTier } from '@truecairn/shared';
import { useMemo, useState } from 'react';
import { Trans } from 'react-i18next';
import { getItem, listItems, patchItemMetadata } from '../../vault/api.js';
import { decryptTitle, unwrapItem } from '../../vault/crypto.js';
import { categoryLabel } from '../../lib/labels.js';
import { formatDateTime } from '../../lib/dates.js';
import { useT } from '../../i18n/useT.js';

// The vault list. Titles are decrypted client-side from the tier key alone (the
// list never returns per-item keys or content). Filters by tier, searches by
// title, and expands a row to its metadata — with content revealed only on a
// deliberate second click.
//
// SEARCH IS LOCAL, AND STRUCTURALLY HAS TO BE. Titles arrive as ciphertext and
// are decrypted here; the server holds no readable copy and there is no search
// endpoint. So filtering happens over the already-decrypted rows in memory —
// which costs no request and, more to the point, means the query string never
// leaves the device. A server-side search would turn "what is in my vault" into
// something the server can see, which is the property the product sells. The
// field's own placeholder says where the decryption happened.
//
// REVEAL IS TWO DELIBERATE CLICKS, never one. Expanding a row shows metadata
// only — tier, category, when it was added. The content stays sealed until the
// owner asks for it by name, because a list that decrypted everything it drew
// would put every secret on screen at once the moment the page loaded.

interface Row {
  id: string;
  tier: VaultTier;
  category: string;
  title: string | null;
  updatedAt: string | null;
  clientOrdinal: number | null;
  pendingDeleteAt: string | null;
}

export function VaultList({ onOpen }: { onOpen?: (id: string) => void }): JSX.Element {
  const t = useT();
  const [tier, setTier] = useState<VaultTier | ''>('');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Revealed plaintext, per item, held only while the row is open. Closing the
  // row drops it rather than keeping a decrypted copy around for a list nobody
  // is looking at any more.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const qc = useQueryClient();
  const [dragId, setDragId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['vault-items', tier],
    queryFn: () => listItems(tier === '' ? {} : { tier }),
  });

  // One row's title failing must never take the list with it.
  //
  // This map runs during render, so an uncaught throw here unmounts the whole
  // vault — which is exactly what happened when a tier move left a title sealed
  // under the old tier key: one moved item and the owner's entire vault appeared
  // to be gone, while every byte of it was intact. The tier-move bug is fixed,
  // but the containment belongs here regardless, so the NEXT decrypt failure
  // costs one row instead of everything.
  //
  // Deliberately not silent: the row still renders, still opens, and says plainly
  // that this one title could not be read.
  const rows: Row[] = useMemo(
    () =>
      (data?.items ?? []).map((it) => {
        let title: string | null;
        try {
          title = decryptTitle(it);
        } catch {
          title = null;
        }
        return {
          id: it.id,
          tier: it.tier,
          category: it.category,
          title,
          updatedAt: typeof it.updatedAt === 'string' ? it.updatedAt : null,
          clientOrdinal: typeof it.clientOrdinal === 'number' ? it.clientOrdinal : null,
          // Fail toward "nothing scheduled": a field an older API omits must
          // not render as a scheduled deletion.
          pendingDeleteAt: typeof it.pendingDeleteAt === 'string' ? it.pendingDeleteAt : null,
        };
      }),
    [data],
  );

  // The owner's order, applied here because the SERVER does not apply it: the
  // list comes back updatedAt-first and `client_ordinal` is stored without being
  // sorted on. Items that have never been dragged have no ordinal and keep the
  // server's order, after the ones that do — so an untouched vault looks exactly
  // as it did, and dragging one row does not reshuffle the rest.
  //
  // `order` holds the optimistic sequence during and just after a drag, so the
  // row does not jump back while the PATCHes are in flight.
  const ordered = useMemo(() => {
    const byOptimistic = order;
    if (byOptimistic !== null) {
      const pos = new Map(byOptimistic.map((id, i) => [id, i]));
      return [...rows].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
    }
    const withOrdinal = rows.filter((r) => r.clientOrdinal !== null);
    const without = rows.filter((r) => r.clientOrdinal === null);
    withOrdinal.sort((a, b) => (a.clientOrdinal ?? 0) - (b.clientOrdinal ?? 0));
    return [...withOrdinal, ...without];
  }, [rows, order]);

  // A row whose title could not be decrypted can never match a search, so it
  // would silently vanish the moment anyone typed — the one row that most needs
  // to stay visible. Unreadable rows therefore always survive the filter.
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle === ''
        ? ordered
        : ordered.filter((r) => r.title === null || r.title.toLowerCase().includes(needle)),
    [ordered, needle],
  );

  // Dragging is only offered on the WHOLE list. Reordering a filtered view has no
  // honest meaning — the positions the owner sees are not the positions being
  // written — so the handles disappear rather than silently doing something else.
  const canReorder = needle === '' && tier === '';

  async function commitOrder(ids: string[]): Promise<void> {
    setOrder(ids);
    try {
      // Contiguous from 0, and only the rows whose position actually moved.
      const before = new Map(ordered.map((r, i) => [r.id, i]));
      await Promise.all(
        ids.map(async (id, i) => {
          if (before.get(id) === i) return;
          await patchItemMetadata(id, { clientOrdinal: i });
        }),
      );
    } finally {
      await qc.invalidateQueries({ queryKey: ['vault-items'] });
      // Drop the optimistic sequence once the refetch carries the real ordinals.
      setOrder(null);
    }
  }

  function moveTo(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const ids = shown.map((r) => r.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void commitOrder(ids);
  }

  const toggle = (id: string): void => {
    setRevealError(null);
    setExpanded((cur) => {
      if (cur === id) {
        // Drop any plaintext this row was holding as it closes.
        setRevealed((m) => {
          const { [id]: _drop, ...rest } = m;
          return rest;
        });
        return null;
      }
      return id;
    });
  };

  const reveal = async (id: string): Promise<void> => {
    setRevealing(id);
    setRevealError(null);
    try {
      const item = await getItem(id);
      const { content } = unwrapItem(item);
      setRevealed((m) => ({ ...m, [id]: content }));
    } catch {
      setRevealError(id);
    } finally {
      setRevealing(null);
    }
  };

  return (
    <section aria-labelledby="vault-list" className="card mt-lg">
      <header className="card-h">
        <div>
          <h1 id="vault-list" className="h-section">
            {t('vault.list.heading')}
          </h1>
          {/* Don't flash a literal "0 items" before the list loads (audit M10). */}
          <p className="small">
            {isLoading
              ? t('vault.list.loading')
              : needle === ''
                ? t('vault.list.count', { count: rows.length })
                : t('vault.list.countFiltered', { shown: shown.length, total: rows.length })}
          </p>
        </div>
        <div className="row gap-md middle wrap">
          <div className="field">
            <label className="field-label" htmlFor="v-search">
              {t('vault.list.searchLabel')}
            </label>
            <input
              id="v-search"
              className="input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('vault.list.searchPlaceholder')}
              data-testid="vault-search"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="filter-tier">
              {t('vault.list.filterLabel')}
            </label>
            <select
              id="filter-tier"
              className="select"
              value={tier}
              onChange={(e) => setTier(e.target.value as VaultTier | '')}
            >
              <option value="">{t('vault.list.allTiers')}</option>
              {VAULT_TIERS.map((v) => (
                <option key={v} value={v}>
                  {v.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {isLoading && (
        <div className="empty">
          <p className="small t-3">{t('vault.list.loading')}</p>
        </div>
      )}
      {isError && (
        <div className="empty">
          <p role="alert" className="alert">
            {t('vault.list.error')}
          </p>
        </div>
      )}
      {!isLoading && !isError && rows.length === 0 ? (
        // Distinguish a genuinely empty vault from a filter that matched nothing
        // (audit M5) — the latter offers a one-click way back to all tiers.
        <div className="empty">
          <div className="empty-line" />
          {tier === '' ? (
            <p className="small">{t('vault.list.emptyAll')}</p>
          ) : (
            <p className="small">
              <Trans
                i18nKey="vault.list.emptyFiltered"
                values={{ tier: tier.toUpperCase() }}
                components={{
                  clear: <button type="button" className="link-btn" onClick={() => setTier('')} />,
                }}
              />
            </p>
          )}
        </div>
      ) : !isLoading && !isError && shown.length === 0 ? (
        // Searched to nothing. Same reasoning as the tier case above: say which
        // filter emptied the list, and offer the way back.
        <div className="empty" data-testid="vault-search-empty">
          <div className="empty-line" />
          <p className="small">
            <Trans
              i18nKey="vault.list.emptySearch"
              values={{ q: q.trim() }}
              components={{
                clear: <button type="button" className="link-btn" onClick={() => setQ('')} />,
              }}
            />
          </p>
        </div>
      ) : (
        <ul className="list">
          {shown.map((r) => {
            const isOpen = expanded === r.id;
            const body = revealed[r.id];
            return (
              <li
                key={r.id}
                className={`list-row vault-row${dragId === r.id ? ' dragging' : ''}`}
                draggable={canReorder}
                onDragStart={() => setDragId(r.id)}
                onDragOver={(e) => {
                  if (canReorder && dragId !== null) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (!canReorder || dragId === null) return;
                  e.preventDefault();
                  moveTo(dragId, r.id);
                  setDragId(null);
                }}
                onDragEnd={() => setDragId(null)}
              >
                <div className="row middle gap-md w-full">
                  {canReorder && (
                    // Pointer-only affordance, so it is aria-hidden and the row
                    // stays reachable without it. Keyboard reordering is the
                    // follow-on named in PROGRESS.md; shipping a handle no
                    // keyboard user can operate would be worse if it were the
                    // ONLY way to order, and it is not — an unordered vault is
                    // the default and every other control here is reachable.
                    <span className="vault-grip" aria-hidden="true" title={t('vault.list.reorder')}>
                      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                        <circle cx="2" cy="2" r="1.2" /><circle cx="8" cy="2" r="1.2" />
                        <circle cx="2" cy="7" r="1.2" /><circle cx="8" cy="7" r="1.2" />
                        <circle cx="2" cy="12" r="1.2" /><circle cx="8" cy="12" r="1.2" />
                      </svg>
                    </span>
                  )}
                  <button
                    type="button"
                    className="vault-row-btn flex-1 min-w-0"
                    onClick={() => onOpen?.(r.id)}
                  >
                    {r.title ?? (
                      <span className="t-3" data-testid={`title-unavailable-${r.id}`}>
                        {t('vault.list.titleUnavailable')}
                      </span>
                    )}
                  </button>
                  <span className="vault-meta">
                    {r.tier.toUpperCase()} · {categoryLabel(r.category)}
                    {/* A scheduled deletion is visible from the row, not only from
                        the item — the list is where an owner looks first, and until
                        2026-08-10 nothing anywhere said an item was going away. */}
                    {r.pendingDeleteAt !== null && (
                      <>
                        {' · '}
                        <span className="t-3" data-testid={`row-pending-delete-${r.id}`}>
                          {t('vault.list.pendingDelete', {
                            date: formatDateTime(r.pendingDeleteAt),
                          })}
                        </span>
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    className="btn ghost sm vault-row-expand"
                    aria-expanded={isOpen}
                    aria-controls={`vault-row-${r.id}`}
                    onClick={() => toggle(r.id)}
                    data-testid={`row-expand-${r.id}`}
                  >
                    {isOpen ? t('vault.list.collapse') : t('vault.list.expand')}
                  </button>
                </div>

                {isOpen && (
                  <div className="vault-row-detail" id={`vault-row-${r.id}`}>
                    <div className="row gap-sm middle wrap">
                      <span className="badge">{r.tier.toUpperCase()}</span>
                      <span className="small t-3">{categoryLabel(r.category)}</span>
                      {r.updatedAt !== null && (
                        <>
                          <span className="small t-3">·</span>
                          <span className="mono t-3">
                            {t('vault.list.updated', { date: formatDateTime(r.updatedAt) })}
                          </span>
                        </>
                      )}
                    </div>

                    {body === undefined ? (
                      <div className="dropzone mt-md">
                        <p className="small t-3">{t('vault.list.sealedNote')}</p>
                        <button
                          type="button"
                          className="btn secondary sm mt-sm"
                          disabled={revealing === r.id}
                          onClick={() => void reveal(r.id)}
                          data-testid={`row-reveal-${r.id}`}
                        >
                          {revealing === r.id
                            ? t('vault.list.decrypting')
                            : t('vault.list.decrypt')}
                        </button>
                        {revealError === r.id && (
                          <p role="alert" className="alert mt-sm">
                            {t('vault.list.decryptError')}
                          </p>
                        )}
                      </div>
                    ) : (
                      <>
                        <pre
                          className="vault-item-body mt-md"
                          aria-label={t('vault.list.contentLabel')}
                          data-testid={`row-content-${r.id}`}
                        >
                          {body}
                        </pre>
                        <div className="row gap-sm mt-md wrap">
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() =>
                              setRevealed((m) => {
                                const { [r.id]: _drop, ...rest } = m;
                                return rest;
                              })
                            }
                            data-testid={`row-reseal-${r.id}`}
                          >
                            {t('vault.list.reseal')}
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => onOpen?.(r.id)}
                          >
                            {t('vault.list.openFull')}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
