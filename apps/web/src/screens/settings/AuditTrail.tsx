import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { canonicalBytes, type CanonicalEntry } from '@truecairn/audit/canonical';
import { api, apiJson } from '../../api/client.js';
import { formatDateTime } from '../../lib/dates.js';
import { useT, type TranslationKey } from '../../i18n/useT.js';

// ── Your audit trail, verified on YOUR device ────────────────────────────────
//
// The chain is hash-linked and server-signed, and audit_log is append-only at the
// database layer. None of that is worth anything unless someone can look, which
// is why this exists — and it deliberately does the verification HERE rather than
// trusting the server's own /verify answer, because a server that rewrote your
// history would rewrite that answer too.
//
// The recomputation uses the SAME canonical byte encoding the server signs
// (@truecairn/audit/canonical, the browser-safe subpath), so a mismatch means a
// real divergence and not two implementations disagreeing.
//
// Honest about its limit, and the UI says so: this proves the chain is
// self-consistent and that each entry's hash matches its content. Verifying the
// SIGNATURES against a key we did not also receive from this server would need a
// key you pinned elsewhere — that is the boundary, and pretending otherwise
// would be the same overclaim /security/build refuses to make.

interface AuditEntry {
  seq: number;
  userId: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
  prevEntryHash: string | null;
  serverTimestamp: string;
  serverKeyId: string;
  clientTimestamp: string | null;
  entryHash: string;
  serverSignature: string;
  userSignature: string | null;
  actor: string;
}
interface AuditPage {
  entries: AuditEntry[];
  serverKeys: Record<string, string>;
  nextFromSeq: number | null;
}

type Verdict =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; checked: number }
  // `why` is a message KEY: the verdict is held in state and rendered later, so
  // a rendered sentence would freeze in the language it was computed in.
  | { state: 'broken'; seq: number; why: TranslationKey };

const b64ToBytes = (b: string): Uint8Array => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return new Uint8Array(digest);
}

// Walk the chain exactly as the server does, from the RESPONSE ONLY.
async function verifyOnDevice(entries: AuditEntry[]): Promise<Verdict> {
  let expectedPrev: string | null = null;
  let expectedSeq = entries.length > 0 ? entries[0]!.seq : 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) {
      return { state: 'broken', seq: e.seq, why: 'audit.broken.outOfOrder' };
    }
    if (e.prevEntryHash !== expectedPrev) {
      return { state: 'broken', seq: e.seq, why: 'audit.broken.notLinked' };
    }
    const canonical: CanonicalEntry = {
      seq: BigInt(e.seq),
      userId: e.userId,
      eventType: e.eventType,
      eventPayload: e.eventPayload,
      prevEntryHash: e.prevEntryHash === null ? null : b64ToBytes(e.prevEntryHash),
      serverTimestamp: new Date(e.serverTimestamp),
      serverKeyId: e.serverKeyId,
      clientTimestamp: e.clientTimestamp === null ? null : new Date(e.clientTimestamp),
    };
    const recomputed = bytesToB64(await sha256(canonicalBytes(canonical)));
    if (recomputed !== e.entryHash) {
      return { state: 'broken', seq: e.seq, why: 'audit.broken.badHash' };
    }
    expectedPrev = recomputed;
    expectedSeq = e.seq + 1;
  }
  return { state: 'ok', checked: entries.length };
}

// ── Filter buckets ───────────────────────────────────────────────────────────
//
// Grouped by the part of the product an entry is ABOUT, because that is how
// someone looks for one ("what happened to my contacts?"), not by the module
// that emitted it. Four buckets and All; anything unrecognised lands in
// `account`, so a new event type is filed rather than hidden.
const FAMILIES = ['all', 'vault', 'contacts', 'release', 'account'] as const;
type Family = (typeof FAMILIES)[number];

function familyOf(eventType: string): Exclude<Family, 'all'> {
  if (eventType.startsWith('vault.')) return 'vault';
  if (eventType.startsWith('contact.')) return 'contacts';
  if (
    eventType.startsWith('ceremony.') ||
    eventType.startsWith('release.') ||
    eventType.startsWith('engine.')
  ) {
    return 'release';
  }
  return 'account';
}

// The first 12 characters of a base64 digest. Enough to compare two by eye and
// to see a chain link match, without a wall of base64 in a list row — the full
// value is in the downloaded log, which is the artifact that would be checked
// properly.
const shortHash = (b64: string | null): string => (b64 === null ? '—' : `${b64.slice(0, 12)}…`);

export function AuditTrail({ fetchImpl }: { fetchImpl?: typeof fetch }): JSX.Element {
  const t = useT();
  const [verdict, setVerdict] = useState<Verdict>({ state: 'idle' });
  const [family, setFamily] = useState<Family>('all');
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  const { data, isLoading } = useQuery<AuditPage>({
    queryKey: ['account-audit'],
    queryFn: async () =>
      apiJson<AuditPage>(
        await api('/v1/account/audit?limit=200', {
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        }),
      ),
  });

  // Newest first — an audit trail is read from the most recent thing that
  // happened. Memoised because the filter re-renders on every click and the list
  // can be 200 entries.
  const shown = useMemo(() => {
    const rows = [...(data?.entries ?? [])].reverse();
    return family === 'all' ? rows : rows.filter((e) => familyOf(e.eventType) === family);
  }, [data, family]);

  const download = (): void => {
    if (data === undefined) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'truecairn-audit-trail.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card" data-testid="audit-trail">
      <header className="card-h">
        <div>
          <h2 className="h-section">{t('audit.heading')}</h2>
          <p className="small">{t('audit.lede')}</p>
        </div>
      </header>

      <div className="card-pad stack gap-sm">
        {isLoading && <p className="body">{t('audit.loading')}</p>}

        {data !== undefined && (
          <>
            {/* Verify and Download pushed to opposite ends. They are different
                kinds of act — one checks the record here, the other takes a copy
                away — and sitting them side by side read as a pair of equal
                buttons where the left one happens to be blue. */}
            <div className="row between middle gap-md wrap">
              <button
                type="button"
                className="btn primary"
                data-testid="verify-btn"
                disabled={verdict.state === 'running'}
                onClick={() => {
                  setVerdict({ state: 'running' });
                  void verifyOnDevice(data.entries).then(setVerdict);
                }}
              >
                {t('audit.verify')}
              </button>
              <button type="button" className="btn" onClick={download} data-testid="download-btn">
                {t('audit.download')}
              </button>
            </div>

            {verdict.state === 'ok' && (
              <p className="body" data-testid="verdict-ok">
                {t('audit.verdict.ok', { count: verdict.checked })}
              </p>
            )}
            {verdict.state === 'broken' && (
              <p className="body" data-testid="verdict-broken">
                {t('audit.verdict.broken', { seq: verdict.seq, why: t(verdict.why) })}
              </p>
            )}

            <p className="small t-2">{t('audit.caveat')}</p>

            {/* Newest first, and filtered by what the entry is about. The event
                type is shown VERBATIM rather than translated into prose: this is
                the forensic record, and the whole claim of the card is that it
                shows what is actually stored. A friendly rewording here would be
                a second, unverifiable account of the same row. */}
            <div className="row gap-sm wrap" role="group" aria-label={t('audit.filterLabel')}>
              {FAMILIES.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`btn secondary sm${family === f ? ' selected' : ''}`}
                  aria-pressed={family === f}
                  onClick={() => setFamily(f)}
                >
                  {t(`audit.family.${f}`)}
                </button>
              ))}
            </div>

            <ul className="list audit-list" data-testid="audit-entries">
              {shown.length === 0 && (
                <li className="list-row">
                  {/* "No entries of THAT KIND" is only true when a filter is
                      narrowing. With All selected an empty list means nothing has
                      been recorded at all, which is a different sentence. */}
                  <p className="small t-3">
                    {family === 'all' ? t('audit.noneAtAll') : t('audit.noneInFilter')}
                  </p>
                </li>
              )}
              {shown.map((e) => {
                const open = openSeq === e.seq;
                return (
                  <li key={e.seq} className="list-row audit-row">
                    <div className="row middle gap-md w-full">
                      <button
                        type="button"
                        className="audit-row-btn flex-1 min-w-0"
                        aria-expanded={open}
                        onClick={() => setOpenSeq(open ? null : e.seq)}
                      >
                        <span className="row-title mono">{e.eventType}</span>
                        <span className="small t-2">
                          #{e.seq} · {t(`audit.family.${familyOf(e.eventType)}`)}
                          {e.actor === 'ai' && ` · ${t('audit.byAssistant')}`}
                        </span>
                      </button>
                      <span className="mono t-3 audit-when">
                        {formatDateTime(e.serverTimestamp)}
                      </span>
                    </div>
                    {open && (
                      <div className="audit-detail" data-testid={`audit-detail-${e.seq}`}>
                        <div className="audit-hash">
                          {t('audit.entryHash', { seq: e.seq, hash: shortHash(e.entryHash) })}
                        </div>
                        <div className="audit-hash">
                          {t('audit.prevHash', { hash: shortHash(e.prevEntryHash) })}
                        </div>
                        <p className="small t-3 mt-sm">{t('audit.chainNote')}</p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {data.nextFromSeq !== null && (
              <p className="small t-3">{t('audit.truncated')}</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
