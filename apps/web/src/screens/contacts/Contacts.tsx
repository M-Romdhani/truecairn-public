import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PLAN_LIMITS,
  RECIPIENT_TYPES,
  RECIPIENT_TYPE_ROLE,
  TIER_CONTACT_COUNT,
  type ContactRole,
  type RecipientType,
} from '@truecairn/shared';
import { useMemo, useState, type FormEvent } from 'react';
import { recipientTypeLabel } from '../../lib/labels.js';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import {
  assignS1Share,
  assignTierShares,
  cancelInvite,
  confirmContactKeys,
  designateBeneficiary,
  inviteContact,
  listContacts,
  type ContactRow,
} from '../../contacts/api.js';
import {
  contactRowSafetyNumber,
  evaluateContactKeyState,
  requireVerifiedContactKey,
  type ContactKeyState,
} from '../../contacts/key-pin.js';
import { aiDraftInvite } from '../../ai/api.js';
import { fetchBillingStatus } from '../../billing/api.js';
import { CONTACT_PIN_VERSION_V1_S1_TIER_KEY } from '@truecairn/keys';
import { decryptContactLabel, splitAndSealTierShares } from '../../contacts/crypto.js';
import { useSession } from '../../crypto/session.js';
import { formatDateTime } from '../../lib/dates.js';
import './contacts.css';
import { Trans } from 'react-i18next';
import { useT, type TFunction } from '../../i18n/useT.js';

// TIER_CONTACT_COUNT (the Shamir split's indices 1..N-1; the last index is the
// release-passphrase share) now lives in @truecairn/shared beside PLAN_LIMITS.
// It was local here, which is why nothing could notice that S3's three contacts
// exceed the Free plan's cap of two — every plan surface advertised S3 as a Free
// feature while this form made it unassignable (QA 2026-08-10).

// Sentence-case a role enum for display (audit M13). NOTE: the share-holder
// checkboxes and the beneficiary <option> deliberately keep the raw lowercase
// role in their "label (role)" accessible name — the E2E selects them by it.
const CONTACT_ROLES = ['personal', 'professional', 'recovery'] as const;
const roleLabel = (r: string, t: TFunction): string =>
  (CONTACT_ROLES as readonly string[]).includes(r)
    ? t(`contacts.role.${r as (typeof CONTACT_ROLES)[number]}`)
    : r;


// Why a seal was refused, in the owner's terms. 'changed' and 'tampered' are
// not phrased as errors to retry past: contact keys come from the contact's own
// master key, so they change only on a rotation, which is a sensitive action
// that already arrives with 7 days' notice. An unannounced change is an attack,
// and the copy says so rather than suggesting a refresh.
function keyStateBlockedMessage(kind: ContactKeyState['kind'], t: TFunction): string {
  return t(`contacts.key.${kind}`);
}

// The badge + actions for an enrolled contact, keyed on whether the owner has
// confirmed their keys. The assign button only exists in the 'verified' branch:
// a disabled button invites clicking around the block, while its absence points
// at the thing that actually needs doing.
function KeyStateControls({
  state,
  contactId,
  codeOpen,
  onToggleCode,
  assignDisabled,
  assignBusy,
  onAssign,
}: {
  state: ContactKeyState;
  contactId: string;
  codeOpen: boolean;
  onToggleCode: () => void;
  assignDisabled: boolean;
  assignBusy: boolean;
  onAssign: () => void;
}): JSX.Element {
  const t = useT();
  const codeButton = (
    <button
      type="button"
      className="btn ghost sm"
      data-testid={`security-code-${contactId}`}
      aria-expanded={codeOpen}
      onClick={onToggleCode}
    >
      {codeOpen ? t('contacts.key.hideCode') : t('contacts.key.showCode')}
    </button>
  );

  if (state.kind === 'verified') {
    return (
      <div className="row gap-sm middle">
        <span data-testid={`key-verified-${contactId}`} className="badge success">
          <span className="dot" />
          {t('contacts.key.confirmedAt', { when: formatDateTime(state.confirmedAt) })}
        </span>
        {codeButton}
        <button
          type="button"
          className="btn secondary sm"
          disabled={assignDisabled}
          onClick={onAssign}
        >
          {assignBusy ? t('contacts.key.assigning') : t('contacts.key.assignS1')}
        </button>
      </div>
    );
  }

  // 'changed' and 'tampered' get role="alert": the owner did not do anything to
  // cause this, so it has to announce itself rather than wait to be read.
  const alarm = state.kind === 'changed' || state.kind === 'tampered';
  return (
    <div className="row gap-sm middle">
      <span
        {...(alarm ? { role: 'alert' as const } : {})}
        data-testid={`key-${state.kind}-${contactId}`}
        className={alarm ? 'badge danger' : 'badge warning'}
      >
        <span className="dot" />
        {state.kind === 'changed'
          ? t('contacts.key.badge.changed')
          : state.kind === 'tampered'
            ? t('contacts.key.badge.tampered')
            : t('contacts.key.badge.unverified')}
      </span>
      {codeButton}
    </div>
  );
}

// The out-of-band step, which is the only part of this feature that actually
// establishes anything. The copy has one job: get the owner onto a different
// channel. If they "confirm" by reading the number back over a chat window the
// server relays, they have verified nothing and this whole path is theatre.
function SecurityCodePanel({
  contact,
  state,
  busy,
  onConfirm,
  onDismiss,
}: {
  // The row as the list renders it: ContactRow plus the label the component
  // decrypted from the S1 tier key.
  contact: ContactRow & { label: string };
  state: ContactKeyState;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const t = useT();
  const code = contactRowSafetyNumber(contact);
  return (
    <div className="card card-pad stack gap-sm mt-sm w-full" data-testid={`code-panel-${contact.contactId}`}>
      {state.kind === 'changed' && (
        <p role="alert" className="alert">
          <Trans i18nKey="contacts.code.changedAlert" components={{ strong: <strong /> }} />
        </p>
      )}
      {state.kind === 'tampered' && (
        <p role="alert" className="alert">
          <Trans i18nKey="contacts.code.tamperedAlert" components={{ strong: <strong /> }} />
        </p>
      )}
      <div className="stack gap-xs">
        <div className="small t-2">{t('contacts.code.label', { name: contact.label })}</div>
        <div className="code-digits" data-testid={`code-digits-${contact.contactId}`}>
          {code ?? '—'}
        </div>
      </div>
      <p className="small t-2">
        <Trans
          i18nKey="contacts.code.instruction"
          values={{ name: contact.label }}
          components={{ strong: <strong /> }}
        />
      </p>
      <div className="row gap-sm">
        <button
          type="button"
          className="btn primary sm"
          disabled={busy || code === null}
          data-testid={`confirm-code-${contact.contactId}`}
          onClick={onConfirm}
        >
          {busy ? t('contacts.code.saving') : t('contacts.code.match')}
        </button>
        <button type="button" className="btn ghost sm" onClick={onDismiss}>
          {t('contacts.code.notNow')}
        </button>
      </div>
    </div>
  );
}

// Owner contacts: list (labels decrypted from the S1 tier key), invite, and the
// S1 share-assignment. Assignment is a 7-day step-up action; the UI surfaces the
// pending state, never "armed now".
//
// Two separate gates stand between a contact and a share, and they are easy to
// confuse:
//
//   * ENROLLED — the contact proved to the SERVER that they hold the secrets for
//     the keys it stored. Everything below keys off this for "is there a key at
//     all", and it is all this screen used to check.
//   * CONFIRMED — the OWNER compared a security code with the contact out of
//     band and the client pinned the result. Only this one says the keys the
//     server is serving are actually that contact's, and only this one lets a
//     seal happen (requireVerifiedContactKey, key-pin.ts).
export function Contacts({
  fetchImpl,
  proveSecondFactor,
}: {
  fetchImpl?: typeof fetch;
  proveSecondFactor?: (accepted: string[]) => Promise<void>;
}): JSX.Element {
  const t = useT();
  const { userId } = useSession();
  const qc = useQueryClient();
  // The owner picks a recipient TYPE (docs/03); the security role is derived from
  // it and never chosen directly. Two professional types collapse to one role on
  // purpose — see RECIPIENT_TYPE_ROLE and docs/14. Deriving it here means the UI
  // cannot produce a pair the database would refuse.
  const [recipientType, setRecipientType] = useState<RecipientType>('spouse_family_executor');
  const role: ContactRole = RECIPIENT_TYPE_ROLE[recipientType];
  const [label, setLabel] = useState('');
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  // AI-drafted invitation message (Build with Gemini XPRIZE). Metadata-only: the
  // draft is generated from the selected ROLE, never from any label or secret.
  const [draft, setDraft] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // Set when adding a contact is blocked by the Free-plan cap (402).
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  // S2/S3 assignment (Checkpoint B): tier + chosen contacts + the deferred
  // release-passphrase capture (Q8). The passphrase lives in component state
  // only until submit, where ownership passes to the split (zeroized inside).
  const [shareTier, setShareTier] = useState<'s2' | 's3'>('s2');
  const [picked, setPicked] = useState<string[]>([]);
  const [releasePass, setReleasePass] = useState('');
  const [releasePassConfirm, setReleasePassConfirm] = useState('');
  const [tierPending, setTierPending] = useState<string | null>(null);
  // Designated beneficiary (backlog #2): a non-affirming recipient of a tier.
  const [benTier, setBenTier] = useState<'s1' | 's2' | 's3'>('s2');
  const [benContact, setBenContact] = useState('');
  const [benPending, setBenPending] = useState<string | null>(null);
  // Every step-up mutation on this screen shows a busy state while the passkey
  // confirmation + enqueue run (QA Pass 2 Finding A — a stalled step-up must
  // never look like nothing happened).
  const [assignBusy, setAssignBusy] = useState<'s1' | 'tier' | 'beneficiary' | null>(null);
  // Which contact's security-code panel is open, and whether a confirmation is
  // in flight. Opening the panel is not confirming — the owner has to compare
  // the digits with the contact and then say so.
  const [codeOpen, setCodeOpen] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState<string | null>(null);

  // Contacts enrol from THEIR OWN devices — poll so invited→enrolled flips
  // appear here without a manual reload (same idiom as the ceremony portal).
  const { data } = useQuery({
    queryKey: ['contacts'],
    queryFn: () => listContacts(fetchImpl),
    refetchInterval: 5_000,
  });
  const rows = useMemo(
    () =>
      (data?.contacts ?? []).map((c) => ({
        ...c,
        label: decryptContactLabel(c.displayLabelCiphertext, c.displayLabelNonce, c.contactPinVersion ?? CONTACT_PIN_VERSION_V1_S1_TIER_KEY),
      })),
    [data],
  );
  // The plan decides whether a tier is reachable at all: S3 needs three contacts
  // and Free caps at two, so the share form must be able to say which wall the
  // owner has hit.
  const billingQ = useQuery({
    queryKey: ['billing', 'status'],
    queryFn: () => fetchBillingStatus(fetchImpl),
  });

  // Opening every pin costs one AEAD per contact, so do it once per fetch
  // rather than per render. Recomputed whenever the list changes — which is
  // what makes a key that changed behind the owner's back show up on the next
  // load rather than at the moment they try to seal.
  const keyStates = useMemo<Record<string, ContactKeyState>>(() => {
    if (userId === null) return {};
    const out: Record<string, ContactKeyState> = {};
    for (const c of rows) out[c.contactId] = evaluateContactKeyState(userId, c);
    return out;
  }, [rows, userId]);

  async function onInvite(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setLimitMsg(null);
    // Clear any previous invitation's token immediately: the displayed token is
    // one-time, so showing a stale one while the new invitation is created would
    // hand the user (or a test) the WRONG token.
    setInviteToken(null);
    try {
      const result = await inviteContact({ role, recipientType, label }, fetchImpl);
      setInviteToken(result.inviteToken);
      setLabel('');
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setLimitMsg(err.problem.detail ?? "You've reached your Free plan's contact limit.");
      } else {
        setError(t('contacts.error.invite'));
      }
    }
  }

  // Draft a role-tailored invitation message with Gemini (the owner edits + sends
  // it alongside the one-time token). Only the role leaves the browser.
  async function onDraft(): Promise<void> {
    setError(null);
    setDraftBusy(true);
    try {
      const r = await aiDraftInvite(role, fetchImpl);
      if (r.message === null) setError(t('contacts.error.draftUnavailable'));
      else setDraft(r.message);
    } catch {
      setError(t('contacts.error.draft'));
    } finally {
      setDraftBusy(false);
    }
  }

  // Cancel a not-yet-enrolled invite (the only contacts the UI offers this on —
  // an enrolled contact's removal is the step-up sensitive action). Session-only.
  async function onCancelInvite(contactId: string): Promise<void> {
    setError(null);
    try {
      await cancelInvite(contactId, fetchImpl);
      // Clear the one-time token + AI-draft panels: the displayed token belonged
      // to an invite that no longer exists, so leaving it on screen is misleading
      // (audit m5).
      setInviteToken(null);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    } catch {
      setError(t('contacts.error.cancelInvite'));
    }
  }

  // The owner says the digits matched. Everything of value happened before this
  // call, on a phone line we do not carry; this only records the answer.
  async function onConfirmKeys(c: ContactRow): Promise<void> {
    if (userId === null || c.x25519Pubkey === null || c.ed25519Pubkey === null) return;
    setError(null);
    setConfirmBusy(c.contactId);
    try {
      await confirmContactKeys(
        {
          userId,
          contactId: c.contactId,
          x25519Pubkey: c.x25519Pubkey,
          ed25519Pubkey: c.ed25519Pubkey,
          contactPinVersion: c.contactPinVersion ?? CONTACT_PIN_VERSION_V1_S1_TIER_KEY,
        },
        fetchImpl,
      );
      setCodeOpen(null);
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    } catch {
      setError(t('contacts.error.confirm'));
    } finally {
      setConfirmBusy(null);
    }
  }

  async function onAssign(c: ContactRow): Promise<void> {
    if (userId === null) return;
    setError(null);
    // Mint the sealing token FIRST. This throws unless the owner has confirmed
    // these exact key bytes out of band — the old guard here only checked that
    // the key was non-null, which meant "this contact enrolled", not "this key
    // is theirs".
    let contactKey;
    try {
      contactKey = requireVerifiedContactKey(userId, c);
    } catch {
      setError(keyStateBlockedMessage(evaluateContactKeyState(userId, c).kind, t));
      return;
    }
    setAssignBusy('s1');
    try {
      const result = await assignS1Share(
        { contactKey },
        {
          userId,
          proveSecondFactor:
            proveSecondFactor ??
            ((): Promise<void> => Promise.reject(new Error('second-factor prompt not wired'))),
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        },
      );
      setPending((p) => ({ ...p, [c.contactId]: result.effectiveAt }));
    } catch {
      setError(
        t('contacts.error.assignS1'),
      );
    } finally {
      setAssignBusy(null);
    }
  }

  function togglePicked(contactId: string): void {
    setPicked((prev) =>
      prev.includes(contactId) ? prev.filter((id) => id !== contactId) : [...prev, contactId],
    );
  }

  // Split the tier key across the picked contacts (Q8-deferred release-
  // passphrase capture happens here, on the FIRST higher-tier assignment) and
  // enqueue one step-up assignment per sealed share.
  async function onAssignTier(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (userId === null) return;
    setError(null);
    const need = TIER_CONTACT_COUNT[shareTier];
    const chosen = picked
      .map((id) => rows.find((r) => r.contactId === id))
      .filter((c): c is (typeof rows)[number] => c !== undefined && c.x25519Pubkey !== null);
    if (chosen.length !== need) {
      setError(`Pick exactly ${need} enrolled contacts for ${shareTier.toUpperCase()}.`);
      return;
    }
    if (new Set(chosen.map((c) => c.role)).size < 2) {
      setError(t('contacts.error.roleDiversity'));
      return;
    }
    if (releasePass.length < 8) {
      setError(t('contacts.error.passTooShort'));
      return;
    }
    if (releasePass !== releasePassConfirm) {
      setError(t('contacts.error.passMismatch'));
      return;
    }
    // Every recipient must be verified before the split runs. S2 is 2-of-3 over
    // the tier key, so two substituted keys reach the threshold without the
    // release passphrase — verifying only some of the contacts buys nothing.
    let verified;
    try {
      verified = chosen.map((c) => requireVerifiedContactKey(userId, c));
    } catch {
      const bad = chosen.find((c) => evaluateContactKeyState(userId, c).kind !== 'verified');
      setError(
        bad === undefined
          ? t('contacts.error.unconfirmedPick')
          : keyStateBlockedMessage(evaluateContactKeyState(userId, bad).kind, t),
      );
      return;
    }
    setAssignBusy('tier');
    try {
      const assignments = splitAndSealTierShares(
        shareTier,
        new TextEncoder().encode(releasePass),
        verified,
      );
      setReleasePass('');
      setReleasePassConfirm('');
      const results = await assignTierShares(
        { tier: shareTier, assignments },
        {
          userId,
          proveSecondFactor:
            proveSecondFactor ??
            ((): Promise<void> => Promise.reject(new Error('second-factor prompt not wired'))),
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        },
      );
      setTierPending(results[results.length - 1]?.effectiveAt ?? null);
      setPicked([]);
    } catch {
      setError(
        t('contacts.error.assignTier'),
      );
    } finally {
      setAssignBusy(null);
    }
  }

  // Designate a non-affirming beneficiary for a tier (step-up + 7-day cooldown).
  async function onDesignateBeneficiary(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (userId === null) return;
    setError(null);
    const contact = rows.find((c) => c.contactId === benContact);
    if (contact === undefined || contact.x25519Pubkey === null) {
      setError(t('contacts.error.pickBeneficiary'));
      return;
    }
    // An S1 beneficiary gets the tier key sealed to them directly, so it needs
    // the same confirmation as an S1 share. S2/S3 send no key material from
    // here, so an unconfirmed key cannot leak anything through this path.
    let benKey;
    if (benTier === 's1') {
      try {
        benKey = requireVerifiedContactKey(userId, contact);
      } catch {
        setError(keyStateBlockedMessage(evaluateContactKeyState(userId, contact).kind, t));
        return;
      }
    }
    setAssignBusy('beneficiary');
    try {
      const result = await designateBeneficiary(
        {
          contactId: contact.contactId,
          tier: benTier,
          // S1 has no shares — the owner seals the S1 tier key to the beneficiary
          // here (needs their verified key). S2/S3 send no key material.
          ...(benKey !== undefined ? { contactKey: benKey } : {}),
        },
        {
          userId,
          proveSecondFactor:
            proveSecondFactor ??
            ((): Promise<void> => Promise.reject(new Error('second-factor prompt not wired'))),
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        },
      );
      setBenPending(result.effectiveAt);
      setBenContact('');
    } catch {
      setError(
        t('contacts.error.designate'),
      );
    } finally {
      setAssignBusy(null);
    }
  }

  const enrolled = rows.filter((c) => c.x25519Pubkey !== null);
  const confirmedCount = enrolled.filter(
    (c) => keyStates[c.contactId]?.kind === 'verified',
  ).length;

  // ── "This split, as it stands" ─────────────────────────────────────────────
  //
  // The submit handler already enforces exactly these four conditions and
  // reports the FIRST one that fails, after the click. That is a poor way to
  // learn what a release needs: the owner discovers one requirement per attempt,
  // and the button that refuses them says nothing until pressed.
  //
  // So the same four conditions are rendered live, all at once, from the same
  // state the handler reads. Nothing here validates anything — it is a view of
  // the rules, and onAssignTier remains the only thing that enforces them.
  const need = TIER_CONTACT_COUNT[shareTier];
  const chosenRows = picked
    .map((id) => rows.find((r) => r.contactId === id))
    .filter((c): c is (typeof rows)[number] => c !== undefined && c.x25519Pubkey !== null);
  const splitChecks = [
    {
      ok: chosenRows.length === need,
      text: t('contacts.split.check.holders', { picked: chosenRows.length, need }),
    },
    {
      ok: new Set(chosenRows.map((c) => c.role)).size >= 2,
      text: t('contacts.split.check.roles'),
    },
    {
      ok:
        chosenRows.length > 0 &&
        chosenRows.every((c) => keyStates[c.contactId]?.kind === 'verified'),
      text: t('contacts.split.check.confirmed'),
    },
    {
      ok: releasePass.length >= 8 && releasePass === releasePassConfirm,
      text: t('contacts.split.check.passphrase'),
    },
  ];
  // One chip per share the split will contain: the contact-held shares, then the
  // release passphrase. For S2 the passphrase IS one of the three shares; for S3
  // it is a mandatory mask OVER the split rather than a share in it, so the two
  // tiers label that last chip differently. Getting this wrong is the single
  // most dangerous confusion in the product (docs/24, /guide §7 and §11).
  const shareChips = [
    ...Array.from({ length: need }, (_, i) => {
      const c = chosenRows[i];
      return c === undefined
        ? { key: `empty-${i}`, label: t('contacts.split.chip.empty'), tone: 'warning' }
        : { key: c.contactId, label: c.label, tone: 'success' };
    }),
    {
      key: 'passphrase',
      label:
        shareTier === 's3'
          ? t('contacts.split.chip.passphraseS3')
          : t('contacts.split.chip.passphraseS2'),
      tone: splitChecks[3]!.ok ? 'success' : 'warning',
    },
  ];

  // Whether the selected tier needs more contacts than this plan allows at all —
  // distinct from "you have not enrolled enough yet", which more enrolling fixes.
  // Cached read: /v1/billing/status is already fetched under this key by Plans
  // and Upgrade, so react-query dedupes it.
  const planContactCap = PLAN_LIMITS[billingQ.data?.plan ?? 'free'].maxContacts;
  const tierBeyondPlanCap =
    planContactCap !== null && TIER_CONTACT_COUNT[shareTier] > planContactCap;

  return (
    <section aria-labelledby="contacts" className="app-col">
      <header className="page-head">
        <div>
          <div className="hint">{t('contacts.eyebrow')}</div>
          <h1 id="contacts" className="h-page">
            {t('contacts.heading')}
          </h1>
          <p className="small t-2">{t('contacts.lede')}</p>
        </div>
        {/* Three things have to happen before a contact can hold a share, and
            they happen on three different devices over days. The step count says
            where the owner actually is, rather than leaving "why can I not
            assign a share yet" to be inferred from a disabled button. */}
        <div className="row gap-sm middle">
          <div className="stack gap-xs" style={{ alignItems: 'flex-end' }}>
            <div className="steps" aria-hidden="true">
              {[rows.length > 0, enrolled.length > 0, confirmedCount > 0].map((done, i) => (
                <span key={i} className={`seg${done ? ' done' : ''}`} />
              ))}
            </div>
            <div className="mono t-3" data-testid="contacts-progress">
              {t('contacts.progress', {
                done: [rows.length > 0, enrolled.length > 0, confirmedCount > 0].filter(Boolean)
                  .length,
              })}
            </div>
          </div>
        </div>
      </header>

      <div className="stack gap-md">
        {/* Invite */}
        <section className="card">
          <header className="card-h">
            <div>
              <h2 className="h-section">{t('contacts.invite.heading')}</h2>
              <p className="small">{t('contacts.invite.sub')}</p>
            </div>
          </header>
          <form onSubmit={onInvite} className="card-pad stack gap-md">
            <div className="row gap-md">
              <div className="field">
                <label className="field-label" htmlFor="contact-role">
                  {t('contacts.invite.kind')}
                </label>
                <select
                  id="contact-role"
                  className="select"
                  value={recipientType}
                  onChange={(e) => setRecipientType(e.target.value as RecipientType)}
                >
                  {RECIPIENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {recipientTypeLabel(t)}
                    </option>
                  ))}
                </select>
                <p className="small t-2 mt-xs">
                  {t('contacts.invite.countsAs', { role: roleLabel(role, t) })}
                </p>
              </div>
              <div className="field flex-1">
                <label className="field-label" htmlFor="contact-label">
                  {t('contacts.invite.label')}
                </label>
                <input
                  id="contact-label"
                  className="input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  required
                />
                {/* The one thing an owner might hesitate over when typing a real
                    person's name into someone else's product. Answer it here,
                    not three pages away in the threat model. */}
                <p className="small t-2 mt-xs">{t('contacts.invite.labelNote')}</p>
              </div>
            </div>
            <div className="row gap-sm">
              <button type="submit" className="btn primary">
                {t('contacts.invite.create')}
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={draftBusy}
                onClick={() => void onDraft()}
              >
                {draftBusy ? t('contacts.invite.drafting') : t('contacts.invite.draft')}
              </button>
            </div>
            {/* The plan-limit nudge lives HERE, next to the button that hit it —
                it used to render at the very bottom of the page, below the fold,
                which read as a silent failure (QA 2026-07-21 C1). */}
            {limitMsg !== null && (
              <p role="alert" className="alert" data-testid="contact-limit">
                {limitMsg}{' '}
                <Link to="/upgrade" className="link">
                  {t('contacts.invite.upgradeLink')}
                </Link>
              </p>
            )}
          </form>
          {inviteToken !== null && (
            <p data-testid="invite-token" className="invite-token">
              {t('contacts.invite.token')}
              <br />
              <code>{inviteToken}</code>
            </p>
          )}
          {draft !== null && (
            <div className="card-pad stack gap-sm" data-testid="invite-draft">
              <p className="small t-2">{t('contacts.invite.draftLede')}</p>
              <textarea
                className="input"
                rows={4}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </div>
          )}
        </section>

        {/* Contact list */}
        <section className="card">
          <header className="card-h">
            <div>
              <h2 className="h-section">{t('contacts.list.heading')}</h2>
              <p className="small">
                {t('contacts.list.count', {
                  count: rows.length,
                  enrolled: enrolled.length,
                  confirmed: confirmedCount,
                })}
              </p>
            </div>
            {/* Enrolled is not the number that gates a release — confirmed is.
                Say so where the counts are, not only in the readiness checkup. */}
            {enrolled.length > confirmedCount && (
              <span className="badge warning" data-testid="unconfirmed-badge">
                <span className="dot" />
                {t('contacts.list.unconfirmed', { count: enrolled.length - confirmedCount })}
              </span>
            )}
          </header>
          {rows.length === 0 ? (
            <div className="empty">
              <div className="empty-line" />
              <p className="small">{t('contacts.list.empty')}</p>
            </div>
          ) : (
            <ul className="list">
              {rows.map((c) => (
                <li key={c.contactId} className="list-row list-row-stack">
                  <div className="row middle gap-sm w-full">
                  <div className="stack flex-1 min-w-0">
                    <div className="row-title">{c.label}</div>
                    <div className="small t-2">{roleLabel(c.role, t)}</div>
                  </div>
                  {pending[c.contactId] !== undefined ? (
                    <span role="status" data-testid={`pending-${c.contactId}`} className="badge warning">
                      <span className="dot" />
                      {t('contacts.list.sharePending', {
                        when: formatDateTime(pending[c.contactId]!),
                      })}
                    </span>
                  ) : c.x25519Pubkey !== null ? (
                    <KeyStateControls
                      state={keyStates[c.contactId] ?? { kind: 'no_keys' }}
                      contactId={c.contactId}
                      codeOpen={codeOpen === c.contactId}
                      onToggleCode={() =>
                        setCodeOpen(codeOpen === c.contactId ? null : c.contactId)
                      }
                      assignDisabled={assignBusy !== null}
                      assignBusy={assignBusy === 's1'}
                      onAssign={() => void onAssign(c)}
                    />
                  ) : (
                    // "Pending" matches the Home panel's badge for the same state
                    // (audit M14); the testid keeps the precise "awaiting" meaning.
                    // A not-yet-enrolled invite can be cancelled here (session-only).
                    <div className="row gap-sm middle">
                      <span data-testid={`awaiting-${c.contactId}`} className="badge warning">
                        <span className="dot" />
                        {t('contacts.list.pending')}
                      </span>
                      <button
                        type="button"
                        className="btn ghost sm"
                        data-testid={`cancel-invite-${c.contactId}`}
                        onClick={() => void onCancelInvite(c.contactId)}
                      >
                        {t('contacts.list.cancelInvite')}
                      </button>
                    </div>
                  )}
                  </div>
                  {codeOpen === c.contactId && (
                    <SecurityCodePanel
                      contact={c}
                      state={keyStates[c.contactId] ?? { kind: 'no_keys' }}
                      busy={confirmBusy === c.contactId}
                      onConfirm={() => void onConfirmKeys(c)}
                      onDismiss={() => setCodeOpen(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Higher-tier split */}
        <form onSubmit={onAssignTier} aria-labelledby="tier-shares" className="card">
          <header className="card-h">
            <div>
              <h2 id="tier-shares" className="h-section">
                {t('contacts.split.heading')}
              </h2>
              <p className="small">
                {shareTier === 's3'
                  ? t('contacts.split.sub.s3', { count: TIER_CONTACT_COUNT.s3 })
                  : t('contacts.split.sub.s2', { count: TIER_CONTACT_COUNT.s2 })}
              </p>
            </div>
            {/* The tier sits beside the heading it changes, rather than as the
                first field of the body: everything below — the sub-line, the
                holder count, the threshold sentence and the checks — is a
                function of it, so it reads as the switch for the card and not as
                one more thing to fill in.

                The "(2 contacts)" the old <select> carried is not lost; the
                split panel below now states the count, the threshold and what is
                still missing, which is strictly more than the option text said. */}
            {/* NOT aria-label="Tier": the vault item's own Tier <select> already
                carries that name, and two controls answering to one name is
                ambiguous for anything selecting by accessible name — a screen
                reader's rotor, and the E2E, which resolved this group while it
                meant that select. Named for what it actually picks. */}
            <div className="row gap-sm" role="group" aria-label={t('contacts.split.tierGroup')}>
              {(['s2', 's3'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`btn secondary sm${shareTier === v ? ' selected' : ''}`}
                  aria-pressed={shareTier === v}
                  onClick={() => setShareTier(v)}
                >
                  {v.toUpperCase()}
                </button>
              ))}
            </div>
          </header>
          <div className="card-pad stack gap-md">
            <fieldset className="tier-fieldset">
              <legend className="field-label mb-md">{t('contacts.split.holders')}</legend>
              <div className="stack gap-sm">
                {enrolled.map((c) => {
                  // Unconfirmed contacts are listed but not selectable. Hiding
                  // them would read as "this contact vanished"; showing them
                  // greyed out with the reason attached points at the fix.
                  const st = keyStates[c.contactId] ?? { kind: 'no_keys' as const };
                  const ok = st.kind === 'verified';
                  return (
                    <label key={c.contactId} className="cb-row">
                      <input
                        type="checkbox"
                        checked={picked.includes(c.contactId)}
                        disabled={!ok}
                        onChange={() => togglePicked(c.contactId)}
                      />
                      <span className={ok ? undefined : 't-3'}>
                        {c.label} ({c.role})
                        {!ok && (
                          <span className="small t-3">
                            {' '}
                            —{' '}
                            {st.kind === 'changed'
                              ? t('contacts.split.blocked.changed')
                              : st.kind === 'tampered'
                                ? t('contacts.split.blocked.tampered')
                                : t('contacts.split.blocked.unverified')}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
                {enrolled.length === 0 && (
                  <p className="small t-3">{t('contacts.split.noEnrolled')}</p>
                )}
                {enrolled.length > 0 &&
                  enrolled.every((c) => keyStates[c.contactId]?.kind !== 'verified') && (
                    <p className="small t-3">{t('contacts.split.noneConfirmed')}</p>
                  )}
              </div>
            </fieldset>

            {/* A live reading of what this split currently is, and what it still
                needs. Same four conditions onAssignTier enforces — see above. */}
            <div className="split-state" data-testid="split-state">
              <div className="field-label">{t('contacts.split.state.heading')}</div>
              <div className="row gap-sm middle wrap mt-sm">
                {shareChips.map((chip) => (
                  <span key={chip.key} className={`badge ${chip.tone}`}>
                    {chip.label}
                  </span>
                ))}
              </div>
              <p className="small t-2 mt-md">
                {shareTier === 's3'
                  ? t('contacts.split.state.thresholdS3')
                  : t('contacts.split.state.thresholdS2')}
              </p>
              <ul className="stack gap-xs mt-md split-checks">
                {splitChecks.map((k) => (
                  <li key={k.text} className="row gap-sm middle">
                    <span className={`mono split-mark${k.ok ? ' ok' : ''}`} aria-hidden="true">
                      {k.ok ? '✓' : '·'}
                    </span>
                    <span className={`small${k.ok ? '' : ' t-2'}`}>{k.text}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="row gap-md">
              <div className="field flex-1">
                <label className="field-label" htmlFor="release-pass">
                  {t('contacts.split.passphrase')}
                </label>
                <input
                  id="release-pass"
                  className="input"
                  type="password"
                  value={releasePass}
                  onChange={(e) => setReleasePass(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="field flex-1">
                <label className="field-label" htmlFor="release-pass-confirm">
                  {t('contacts.split.passphraseConfirm')}
                </label>
                <input
                  id="release-pass-confirm"
                  className="input"
                  type="password"
                  value={releasePassConfirm}
                  onChange={(e) => setReleasePassConfirm(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
            {/* The consequence, beside the field that causes it. S3 is the half
                that is permanently unrecoverable, and the sentence says so. */}
            <p className="small t-3">{t('contacts.split.passphraseNote')}</p>
            <div className="row middle gap-md">
              {/* Disable rather than silently no-op when there aren't enough
                  enrolled contacts to form the split (audit M15). */}
              <button
                type="submit"
                className="btn primary"
                disabled={assignBusy !== null || enrolled.length < TIER_CONTACT_COUNT[shareTier]}
              >
                {assignBusy === 'tier'
                  ? t('contacts.split.assigning')
                  : t('contacts.split.submit', { tier: shareTier.toUpperCase() })}
              </button>
              {enrolled.length < TIER_CONTACT_COUNT[shareTier] &&
                (tierBeyondPlanCap ? (
                  // "Enrol 3 contacts" is advice a free owner cannot follow —
                  // the third POST /v1/contacts is a 402. Name the real obstacle
                  // and point at the fix instead of letting them discover the
                  // cap by hitting it.
                  <span className="small t-3">
                    <Trans
                      i18nKey="contacts.split.needPlan"
                      values={{
                        tier: shareTier.toUpperCase(),
                        needed: TIER_CONTACT_COUNT[shareTier],
                        cap: planContactCap,
                      }}
                      components={{ upgrade: <Link to="/upgrade" /> }}
                    />
                  </span>
                ) : (
                  <span className="small t-3">
                    {t('contacts.split.needMore', {
                      needed: TIER_CONTACT_COUNT[shareTier],
                      tier: shareTier.toUpperCase(),
                    })}
                  </span>
                ))}
            </div>
            {tierPending !== null && (
              <p role="status" data-testid="tier-pending" className="small t-2">
                {t('contacts.split.pending', { when: formatDateTime(tierPending) })}
              </p>
            )}
          </div>
        </form>

        {/* Designate a beneficiary (backlog #2) */}
        <form onSubmit={onDesignateBeneficiary} aria-labelledby="beneficiary" className="card">
          <header className="card-h">
            <div>
              <h2 id="beneficiary" className="h-section">
                {t('contacts.beneficiary.heading')}
              </h2>
              <p className="small">{t('contacts.beneficiary.sub')}</p>
            </div>
          </header>
          <div className="card-pad stack gap-md">
            <div className="row gap-md">
              <div className="field">
                <label className="field-label" htmlFor="beneficiary-tier">
                  {t('contacts.beneficiary.tier')}
                </label>
                <select
                  id="beneficiary-tier"
                  className="select"
                  value={benTier}
                  onChange={(e) => setBenTier(e.target.value as 's1' | 's2' | 's3')}
                >
                  <option value="s1">S1</option>
                  <option value="s2">S2</option>
                  <option value="s3">S3</option>
                </select>
              </div>
              <div className="field flex-1">
                <label className="field-label" htmlFor="beneficiary-contact">
                  {t('contacts.beneficiary.contact')}
                </label>
                <select
                  id="beneficiary-contact"
                  className="select"
                  value={benContact}
                  onChange={(e) => setBenContact(e.target.value)}
                >
                  <option value="">{t('contacts.beneficiary.select')}</option>
                  {enrolled.map((c) => (
                    <option key={c.contactId} value={c.contactId}>
                      {c.label} ({c.role})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {/* What this does NOT do. A beneficiary designation moves no key
                material at S2/S3 — the tier arrives only through a completed
                release — and an owner who assumed otherwise would think their
                heir was already provisioned. */}
            <p className="small t-3">
              {benTier === 's1'
                ? t('contacts.beneficiary.noteS1')
                : t('contacts.beneficiary.noteS2S3')}
            </p>
            <div className="row middle gap-md">
              <button
                type="submit"
                className="btn primary"
                disabled={assignBusy !== null || benContact === ''}
              >
                {assignBusy === 'beneficiary'
                  ? t('contacts.beneficiary.designating')
                  : t('contacts.beneficiary.submit')}
              </button>
              {benContact === '' && (
                <span className="small t-3">{t('contacts.beneficiary.pickFirst')}</span>
              )}
            </div>
            {benPending !== null && (
              <p role="status" data-testid="beneficiary-pending" className="small t-2">
                {t('contacts.beneficiary.pending', { when: formatDateTime(benPending) })}
              </p>
            )}
          </div>
        </form>

        {error !== null && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
