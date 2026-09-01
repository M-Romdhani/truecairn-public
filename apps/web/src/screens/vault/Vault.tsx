import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreateItem } from './CreateItem.js';
import { FileCaptures } from './FileCaptures.js';
import { VaultList } from './VaultList.js';
import { listItems } from '../../vault/api.js';
import { VaultLockBanner } from './VaultLockBanner.js';
import { useT } from '../../i18n/useT.js';
import './vault.css';

// The unlocked vault home: create an item + browse the list. Creating an item
// invalidates the list query so the new (title-decrypted) row appears. When the
// create included attachments, open the item so the freshly-stored files are
// visible immediately; a plain create stays here so the user can add more.
export function Vault(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // The create form used to sit permanently open above the list, so an owner
  // arriving to FIND something scrolled past a form to reach it, and the more
  // items they had the further down their vault started.
  //
  // It now follows the vault: OPEN while there is nothing to look at — an empty
  // vault has exactly one useful action and burying it behind a button would be
  // worse — and COLLAPSED once there are items, when finding beats adding. An
  // explicit click wins over both and is remembered for the visit.
  //
  // Shares the ['vault-items',''] query key with VaultList, so this costs no
  // extra request.
  const itemsQ = useQuery({ queryKey: ['vault-items', ''], queryFn: () => listItems() });
  const [override, setOverride] = useState<boolean | null>(null);
  const vaultIsEmpty = (itemsQ.data?.items.length ?? 0) === 0;
  const creating = override ?? vaultIsEmpty;
  const setCreating = (next: boolean): void => setOverride(next);
  return (
    <div className="app-col">
      <VaultLockBanner />
      {/* Above the create form: something already captured and waiting is more
          urgent than something not yet written, and it is the only content here
          that a release would not carry (docs/34 D4). */}
      <FileCaptures />
      {creating ? (
        <CreateItem
          onCancel={() => setCreating(false)}
          onCreated={(id, hadAttachments) => {
            void qc.invalidateQueries({ queryKey: ['vault-items'] });
            setCreating(false);
            if (hadAttachments) navigate(`/vault/${id}`);
          }}
        />
      ) : (
        <div className="row between middle gap-md">
          <p className="small t-2">{t('vault.create.lede')}</p>
          <button
            type="button"
            className="btn primary"
            onClick={() => setCreating(true)}
            data-testid="vault-new-item"
          >
            {t('vault.create.heading')}
          </button>
        </div>
      )}
      <VaultList onOpen={(id) => navigate(`/vault/${id}`)} />
    </div>
  );
}
