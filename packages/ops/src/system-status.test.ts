import { describe, expect, it } from 'vitest';
import type { Database } from '@truecairn/db';
import type { KekProvider } from '@truecairn/vault';
import {
  accountTotals,
  collectSystemStatus,
  recentAlertsSafe,
  resolveBackupAttestation,
  RESTORE_ATTESTATION_STALE_AFTER_DAYS,
  type BackupAttestation,
} from './system-status.js';

// A database that fails every way this module can touch one.
function brokenDb(): Database {
  const boom = (): never => {
    throw new Error('connection terminated unexpectedly');
  };
  return { select: boom, execute: boom } as unknown as Database;
}

// The KEK round-trip is a real wrap/unwrap, so the probe needs a provider that
// actually round-trips. Identity is enough: this file is testing what happens to
// the OTHER checks when the database is gone, not the key hierarchy.
const echoKeks: KekProvider = {
  currentKekId: 'test',
  wrap: async (key: Uint8Array) => key,
  unwrap: async (_id: string, wrapped: Uint8Array) => wrapped,
} as unknown as KekProvider;

// The counting itself is pinned at the HTTP boundary (apps/api ops.test.ts),
// where it can be asserted alongside the rule that matters more: the response
// carries these integers and no user data at all. What lives here is the
// property that has no database of its own to fail against — what the count does
// when it cannot be taken.

describe('account totals', () => {
  it('reports absence, not zero, when the count cannot be taken', async () => {
    // "0 accounts" is a claim. During the database outage that is the only way
    // this fails, it would be a false one — and it would read as a product with
    // no users rather than a dashboard that could not look. Same rule as the
    // fourth check state: absence of evidence is never rendered as a figure.
    const broken = {
      select: () => {
        throw new Error('relation "users" does not exist');
      },
    } as unknown as Database;

    expect(await accountTotals(broken)).toBeNull();
  });
});

// The same rule, applied to the two other things this surface reports that only
// a reachable database can answer. Both were dishonest until 2026-08-06 — one by
// asserting zeros, one by taking the whole dashboard down.
describe('what the dashboard says when the database is gone', () => {
  const deps = {
    outerLayerKeks: echoKeks,
    auditReady: true,
    apiVersion: '0.0.0',
    configuredNotificationTypes: ['email'],
    cryptoReady: () => true,
    backups: { kind: 'none' } as const,
  };

  it('reports queue depths as ABSENT, never as six zeros', async () => {
    // Every one of the six is a database aggregate initialised to 0. Shipping
    // those initialisers said "nothing is queued, no notification is dead-
    // lettered, no action is overdue" during the one outage where none of it can
    // be known — a false all-clear on the numbers an operator would act on.
    const status = await collectSystemStatus({ ...deps, db: brokenDb() });

    expect(status.queues).toBeNull();
    // The component states still come through: this degrades per check, so
    // losing the counts must not cost the diagnosis.
    expect(status.continuityEngine).toBe('down');
    expect(status.checks.find((c) => c.id === 'database')?.state).toBe('down');
    expect(status.checks.find((c) => c.id === 'worker')?.state).toBe('unknown');
    // The crypto and KEK probes need no database and must still be reported.
    expect(status.checks.find((c) => c.id === 'outer_layer_kek')?.state).toBe('ok');
  });

  it('does not claim delivery records are clean when it could not read them', async () => {
    const status = await collectSystemStatus({ ...deps, db: brokenDb() });
    const notifications = status.checks.find((c) => c.id === 'notifications');
    // The CONFIGURATION half is genuinely checked and still counts; the delivery
    // half is not, and the detail has to say so rather than implying zero
    // dead letters.
    expect(notifications?.detail).toMatch(/not readable/);
    expect(notifications?.detail).not.toMatch(/dead-lettered/);
  });

  it('degrades the event feed to null instead of taking the page down', async () => {
    // This one was a 500. The route awaited the throwing reader, so an
    // unreachable database discarded every carefully-degraded check above and
    // served an error page — during the outage the dashboard exists for.
    expect(await recentAlertsSafe(brokenDb())).toBeNull();
  });

  it('separates "could not read the log" from "the log is empty"', async () => {
    // null and [] must not be the same value: one is ignorance, the other is a
    // claim that nothing has happened.
    expect(await recentAlertsSafe(brokenDb())).not.toEqual([]);
  });
});

// F-5 (2026-08-10 restore drill). The audit_signing tile used to say "signer
// resolved" — the same shape of claim the outer-layer KEK check made before F-1,
// and just as weak: a mis-transcribed SERVER_AUDIT_SIGNING_KEY derives a new key
// id, registers cleanly and signs on under a lineage nobody has on paper.
//
// The lineage arrives as a dep because it is read ONCE at boot (the query is a
// scan and /status is a public request path), so this needs no database — which
// is the point of pinning it here rather than in an integration test.
describe('audit signing: the key, not just a key', () => {
  const base = {
    db: brokenDb(),
    outerLayerKeks: echoKeks,
    apiVersion: '0.0.0',
    configuredNotificationTypes: ['email'],
    cryptoReady: () => true,
    backups: { kind: 'none' } as const,
  };
  const auditCheck = async (extra: Record<string, unknown>) =>
    (await collectSystemStatus({ ...base, ...extra } as never)).checks.find(
      (c) => c.id === 'audit_signing',
    )!;

  it('is ok when the configured key signed the most recent entry', async () => {
    const check = await auditCheck({
      auditReady: true,
      auditKeyLineage: { kind: 'current', keyId: 'audit-abc123456789' },
    });
    expect(check.state).toBe('ok');
    expect(check.detail).toContain('audit-abc123456789');
  });

  it('is DEGRADED, not down, on a lineage split', async () => {
    // Degraded rather than down on purpose: this is the expected state right
    // after a legitimate rotation, and retired keys keep verifying. It has to be
    // visible without declaring an outage.
    const check = await auditCheck({
      auditReady: true,
      auditKeyLineage: { kind: 'split', keyId: 'audit-newkey00000', chainKeyId: 'audit-oldkey00000' },
    });
    expect(check.state).toBe('degraded');
    expect(check.detail).toContain('audit-newkey00000');
    expect(check.detail).toContain('audit-oldkey00000');
  });

  it('never reports an unestablished lineage as fine', async () => {
    // Rule 1 of this module: absence of evidence is not evidence of health. An
    // older caller that passes no lineage must not read the same as a proven one.
    const check = await auditCheck({ auditReady: true });
    expect(check.state).toBe('ok'); // the signer really did resolve
    expect(check.detail).toContain('lineage not established');
  });

  it('still reports a missing signer as down, lineage or not', async () => {
    const check = await auditCheck({ auditReady: false });
    expect(check.state).toBe('down');
    expect(check.detail).toContain('cannot commit');
  });
});

// ── The backups tile (D6, 2026-08-11) ───────────────────────────────────────
//
// It sat at 'unknown' from the day it was written, and that is precisely how the
// original no-backups finding survived: the tile said "not instrumented" whether
// backups existed or not, so it carried no information and nobody read it as a
// warning. docs/38 tracked "reports a date, not unknown" as its own open item.
//
// The property that makes an operator-supplied date safe to render green is that
// it EXPIRES. These tests pin that, because a version of this feature that can
// be set once and stays green forever is the decorative tile rule 1 forbids —
// and it would be worse than the 'unknown' it replaced.
describe('backups: an attestation that expires', () => {
  const base = {
    db: brokenDb(),
    outerLayerKeks: echoKeks,
    auditReady: true,
    apiVersion: '0.0.0',
    configuredNotificationTypes: ['email'],
    cryptoReady: () => true,
  };
  const backupsCheck = async (backups: BackupAttestation, now?: Date) =>
    (await collectSystemStatus({ ...base, backups, now } as never)).checks.find(
      (c) => c.id === 'backups',
    )!;

  const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it('is UNKNOWN with nothing attested — the honest state, and the old one', async () => {
    const check = await backupsCheck({ kind: 'none' });
    expect(check.state).toBe('unknown');
    expect(check.detail).toMatch(/no verified restore recorded/);
    // And it says what to do about it, which the "not instrumented" wording did
    // not: an operator reading this tile should be able to act on it.
    expect(check.detail).toMatch(/BACKUPS_LAST_VERIFIED_RESTORE/);
  });

  it('reports the DATE of a recent verified restore', async () => {
    const at = daysAgo(1);
    const check = await backupsCheck({ kind: 'verified', at });
    expect(check.state).toBe('ok');
    expect(check.detail).toContain(at.toISOString().slice(0, 10));
    expect(check.detail).toMatch(/1 day ago/);
    // Green must not be readable as "a backup ran last night". The tile says
    // what it actually knows and names the half it does not.
    expect(check.detail).toMatch(/operator-attested/);
    expect(check.detail).toMatch(/not observable from here/);
  });

  it('goes DEGRADED on its own once the drill goes stale — nobody has to notice', async () => {
    const check = await backupsCheck({
      kind: 'verified',
      at: daysAgo(RESTORE_ATTESTATION_STALE_AFTER_DAYS + 1),
    });
    expect(check.state).toBe('degraded');
    expect(check.detail).toMatch(/OVERDUE/);
  });

  it('is never release-critical — a stale drill must not fail the release path', async () => {
    // Same rule as the AI tile. The composite answers "could a release complete
    // right now?", and a backup has never been part of completing one. Letting
    // this move the composite would also move the PUBLISHED availability figure,
    // which is computed from release-critical checks alone.
    const stale = await backupsCheck({
      kind: 'verified',
      at: daysAgo(RESTORE_ATTESTATION_STALE_AFTER_DAYS + 1),
    });
    expect(stale.releaseCritical).toBe(false);
  });

  it('treats an unparseable attestation as UNKNOWN and says so', async () => {
    // Never as verified, and never silently as 'none': a typo that reads as
    // "nobody has drilled yet" is indistinguishable from the truth, and a typo
    // that reads as verified is a green tile with nothing behind it.
    const check = await backupsCheck({ kind: 'invalid', why: 'is not a real date' });
    expect(check.state).toBe('unknown');
    expect(check.detail).toMatch(/BACKUPS_LAST_VERIFIED_RESTORE is not a real date/);
  });
});

describe('resolveBackupAttestation', () => {
  const now = new Date('2026-08-11T12:00:00Z');

  it('accepts a plain ISO day and a full timestamp', () => {
    expect(resolveBackupAttestation('2026-08-10', now)).toEqual({
      kind: 'verified',
      at: new Date('2026-08-10T00:00:00Z'),
    });
    expect(resolveBackupAttestation('2026-08-10T09:30:00Z', now)).toEqual({
      kind: 'verified',
      at: new Date('2026-08-10T09:30:00Z'),
    });
  });

  it('treats unset and blank as nothing attested', () => {
    expect(resolveBackupAttestation(undefined, now).kind).toBe('none');
    expect(resolveBackupAttestation('   ', now).kind).toBe('none');
  });

  it('rejects loose date-ish values rather than guessing', () => {
    // `new Date('2026')` is a valid January 1st and `new Date('true')` is not a
    // date at all. Both are operator typos; neither may become a confident
    // wrong answer on a tile about data loss.
    expect(resolveBackupAttestation('2026', now).kind).toBe('invalid');
    expect(resolveBackupAttestation('true', now).kind).toBe('invalid');
    expect(resolveBackupAttestation('10/08/2026', now).kind).toBe('invalid');
  });

  it('rejects a future date — the one value that could pin the tile green', () => {
    // A date in the future never goes stale, so it would disable the expiry that
    // is the whole reason this attestation is allowed to be green.
    expect(resolveBackupAttestation('2027-01-01', now)).toEqual({
      kind: 'invalid',
      why: 'is dated in the future',
    });
  });
});
