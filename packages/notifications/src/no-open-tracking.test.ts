import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// D2 enforced mechanically (docs/26 §10): Truecairn commits publicly to never
// tracking whether a notification is opened or read — no pixels, no read
// receipts, on any channel. This gate fails the build if open/read-tracking
// vocabulary creeps into the notification pipeline or the report contracts.
// The webhook deliberately treats provider 'opened' events as un-modelled
// (acknowledged, no state change) — the ONE allowed mention is that handler's
// test fixture, excluded below by excluding *.test.ts.

const FORBIDDEN = [
  /\bopenedAt\b/,
  /\bopened_at\b/,
  /\breadAt\b/,
  /\bread_at\b/,
  /\breadReceipt/i,
  /tracking[-_ ]?pixel/i,
];

const here = dirname(fileURLToPath(import.meta.url));
const SCANNED_DIRS = [
  here, // packages/notifications/src — the delivery pipeline
  join(here, '..', '..', 'shared', 'src'), // the report payload contract
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(dir, e.name));
}

describe('no open/read tracking — the D2 gate', () => {
  it('keeps open/read-tracking fields out of the notification pipeline and report contracts', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(dir)) {
        const body = readFileSync(file, 'utf8');
        for (const pattern of FORBIDDEN) {
          if (pattern.test(body)) offenders.push(`${file} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
