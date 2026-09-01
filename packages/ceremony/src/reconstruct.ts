// Client-side tier-key reconstruction for S2/S3 ceremonies.
//
// Runs on the reconstructing recipient's device (never the platform). Given
// the committed shares (already opened from their sealed boxes via
// unwrapShareFromCeremony) and the tier-key check sentinel, it tries
// threshold-sized subsets, validating each candidate against the sentinel,
// until one verifies or the retry cap is hit.
//
// Why subset retry: a committed affirmation can carry a well-formed but WRONG
// share (a superseded generation, or a sabotaging compromised contact). The
// Shamir scheme tolerates up to (n - threshold) such shares; trying alternative
// subsets recovers from them. The cap bounds the work — C(n, k) explodes, so
// we never iterate all of it for degenerate inputs.
//
// S1 does NOT use this path: S1 has no Shamir scheme; it uses
// openS1TierKeyEnvelope. reconstructTierKey is for threshold >= 2.

import { combineTierKey, validateTierKeyCheck, type TierKeyCheck, type TierKeyShare, type UnwrappedTierKey } from '@truecairn/keys';

// The cap on threshold-subsets tried before giving up. It must stay >= C(n, k)
// for every tier we actually ship, or a legitimate recovery could exhaust the
// budget before reaching the correct subset and fail as 'shares_unverifiable' —
// a reconstruction failure that looks like sabotage but is really this constant.
//
// Shipped worst case today is S3 flat (C(4,3) = 4); S2 and nested S3 are C(3,2)
// = 3. Ten leaves room, and reconstruct.test.ts pins the arithmetic so raising a
// tier's share count without revisiting this fails the build rather than
// silently shrinking the number of sabotaging contacts we can tolerate.
export const DEFAULT_MAX_SUBSETS = 10;

export interface ReconstructInput {
  shares: TierKeyShare[];
  threshold: number;
  tierKeyCheck: TierKeyCheck;
  generation: number;
  // Cap on threshold-subsets to try before giving up. Defaults to 10.
  maxSubsets?: number;
  // How a threshold-subset of shares becomes a candidate tier key. Defaults to
  // the flat Shamir combine (S2; legacy flat S3). The nested S3 scheme (docs/24)
  // passes combineTierKeyForS3Nested bound to the release-passphrase mask, so the
  // SAME subset-retry loop validates the masked combine: contacts alone recover
  // only the masked secret and never pass validateTierKeyCheck — fail closed.
  combine?: (subset: TierKeyShare[]) => UnwrappedTierKey;
}

export type ReconstructResult =
  | { ok: true; tierKey: UnwrappedTierKey; subsetsTried: number }
  | {
      ok: false;
      reason: 'insufficient_shares' | 'shares_unverifiable';
      subsetsTried: number;
    };

export function reconstructTierKey(input: ReconstructInput): ReconstructResult {
  const { shares, threshold, tierKeyCheck, generation } = input;
  const cap = input.maxSubsets ?? DEFAULT_MAX_SUBSETS;
  const combine = input.combine ?? combineTierKey;

  if (threshold < 2) {
    throw new Error('reconstructTierKey is for threshold >= 2 (S1 uses the envelope path)');
  }
  if (shares.length < threshold) {
    return { ok: false, reason: 'insufficient_shares', subsetsTried: 0 };
  }

  let tried = 0;
  for (const subset of boundedCombinations(shares, threshold, cap)) {
    tried += 1;
    let candidate: UnwrappedTierKey;
    try {
      candidate = combine(subset);
    } catch {
      // Malformed subset (e.g. duplicate share index). Skip and try the next.
      continue;
    }
    if (validateTierKeyCheck(candidate, tierKeyCheck, generation)) {
      return { ok: true, tierKey: candidate, subsetsTried: tried };
    }
  }
  return { ok: false, reason: 'shares_unverifiable', subsetsTried: tried };
}

// Yields up to `cap` k-combinations of `items` in lexicographic index order.
// Standard combination advance; the cap is the only thing standing between us
// and C(n, k) for large committed-share sets.
function* boundedCombinations<T>(items: T[], k: number, cap: number): Generator<T[]> {
  const n = items.length;
  if (k > n || k <= 0 || cap <= 0) return;

  const idx: number[] = [];
  for (let i = 0; i < k; i++) idx.push(i);

  let count = 0;
  while (count < cap) {
    yield idx.map((i) => items[i]!);
    count += 1;

    // Advance to the next combination (rightmost index that can increment).
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] = idx[i]! + 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
}
