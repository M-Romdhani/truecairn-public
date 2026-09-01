import { sodium, assertReady } from './init.js';

// Shamir's Secret Sharing over GF(256), per docs/18 §"Secret sharing":
//   3-of-4 for S3, 2-of-3 for S2.
//
// Implementation mirrors the well-known canonical structure
// (Hashicorp Vault's shamir.go and the original Adi Shamir paper):
//   - GF(256) with AES irreducible polynomial x^8 + x^4 + x^3 + x + 1 (0x11b).
//   - Each secret byte split independently using a random polynomial of
//     degree threshold-1 with the secret byte as the constant term.
//   - Shares are evaluations p(x) at distinct non-zero x in {1..n}.
//   - Reconstruction is Lagrange interpolation at x=0.
//
// Share encoding: each share is a Uint8Array of length (1 + secret.length).
//   share[0]      = x index (1..n)
//   share[1..end] = byte-wise evaluations of the per-byte polynomials at x
//
// No optimizations beyond a precomputed log/exp table for GF(256) mul/inv.
// The 256-entry log + 510-entry exp tables are precomputed once at module
// load and used for the rest of the module's life.

// ---------------------------------------------------------------------------
// GF(256) field arithmetic
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(510);
const GF_LOG = new Uint8Array(256);

(function buildTables(): void {
  // Generator g=3 has order 255 in GF(256) with AES poly.
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    // Multiply by 3 in GF(256): x = (x << 1) XOR (x_msb_set ? 0x1b : 0) XOR x
    let next = x << 1;
    if (next & 0x100) next ^= 0x11b;
    next ^= x; // multiply by 3 = (x<<1) XOR x in carry-less; reduction folded above
    x = next & 0xff;
  }
  // Duplicate exp for the [255..509] range so mul can index exp[a+b] without
  // a modulus operation (a,b each in [0..254], sum in [0..508]).
  for (let i = 255; i < 510; i++) GF_EXP[i] = GF_EXP[i - 255]!;
  GF_LOG[0] = 0; // sentinel; mul handles 0 explicitly
})();

export function gfAdd(a: number, b: number): number {
  return (a ^ b) & 0xff;
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('GF(256) division by zero');
  if (a === 0) return 0;
  const diff = GF_LOG[a]! - GF_LOG[b]!;
  return GF_EXP[diff < 0 ? diff + 255 : diff]!;
}

// Evaluate the polynomial with given coefficients (lowest-degree first) at x,
// using Horner's method in GF(256). p(x) = c0 + c1*x + c2*x^2 + ...
function gfEval(coeffs: Uint8Array, x: number): number {
  let acc = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    acc = gfAdd(gfMul(acc, x), coeffs[i]!);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Shamir API
// ---------------------------------------------------------------------------

export type RandomBytes = (n: number) => Uint8Array;

export interface ShamirSplitInput {
  secret: Uint8Array;
  threshold: number;
  totalShares: number;
  // Optional deterministic randomness source for KAT tests. Production code
  // omits this and gets libsodium's CSPRNG.
  randomBytes?: RandomBytes;
}

export function shamirSplit(input: ShamirSplitInput): Uint8Array[] {
  assertReady();
  const { secret, threshold, totalShares } = input;
  if (threshold < 2) throw new Error('shamir threshold must be >= 2');
  if (totalShares < threshold) throw new Error('totalShares must be >= threshold');
  if (totalShares > 255) throw new Error('totalShares must be <= 255 (GF(256) limit)');
  if (secret.length === 0) throw new Error('secret must not be empty');

  const rng: RandomBytes = input.randomBytes ?? ((n) => sodium.randombytes_buf(n));

  const shares: Uint8Array[] = [];
  for (let i = 1; i <= totalShares; i++) {
    const share = new Uint8Array(secret.length + 1);
    share[0] = i;
    shares.push(share);
  }

  // For each byte position in the secret: build a polynomial of degree
  // (threshold-1) with that byte as the constant term and (threshold-1) random
  // coefficients above it. Evaluate at each share's x.
  for (let j = 0; j < secret.length; j++) {
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[j]!;
    const randomCoeffs = rng(threshold - 1);
    for (let c = 1; c < threshold; c++) {
      coeffs[c] = randomCoeffs[c - 1]!;
    }
    for (let i = 0; i < totalShares; i++) {
      shares[i]![j + 1] = gfEval(coeffs, shares[i]![0]!);
    }
  }
  return shares;
}

// shamirSplitWithConstraint — like shamirSplit, but constrains the polynomial
// so that p(constraint.shareIndex) equals the supplied constraint.value at
// every byte position. The share at constraint.shareIndex therefore equals
// the supplied value by construction; the other (totalShares - 1) shares
// are determined by the polynomial.
//
// Required for the release-passphrase share scheme: the share value at the
// release-passphrase share index must equal Argon2id(passphrase, ...), so
// the polynomial chosen at split time must accommodate that fixed point.
//
// Polynomial structure (per byte position j):
//   c_0 = secret[j]                              (Shamir's secret-at-0)
//   c_1, c_2, ..., c_{t-1} = polynomial coefficients
//   p(constraint.shareIndex) = constraint.value[j]
//
//   For threshold t, t coefficients. Two constraints fix c_0 and one linear
//   equation in c_1..c_{t-1}. That leaves (t-2) free coefficients. We pick
//   c_2..c_{t-1} at random and solve for c_1:
//     c_1 = ( constraint.value[j] - c_0 - sum_{k=2..t-1}(c_k * r^k) ) / r
//
//   For t=2 (S2 case): zero free coefficients. c_1 is fully determined.
//   For t=3 (S3 case): one free coefficient (c_2). c_1 solved.
export interface ShamirSplitWithConstraintInput {
  secret: Uint8Array;
  threshold: number;
  totalShares: number;
  constraint: {
    shareIndex: number;       // 1..totalShares
    value: Uint8Array;        // length === secret.length
  };
  randomBytes?: RandomBytes;
}

export function shamirSplitWithConstraint(
  input: ShamirSplitWithConstraintInput,
): Uint8Array[] {
  assertReady();
  const { secret, threshold, totalShares, constraint } = input;

  if (threshold < 2) throw new Error('shamir threshold must be >= 2');
  if (totalShares < threshold) throw new Error('totalShares must be >= threshold');
  if (totalShares > 255) throw new Error('totalShares must be <= 255 (GF(256) limit)');
  if (secret.length === 0) throw new Error('secret must not be empty');
  if (constraint.shareIndex < 1 || constraint.shareIndex > totalShares) {
    throw new Error(
      `constraint.shareIndex must be in [1, ${totalShares}], got ${constraint.shareIndex}`,
    );
  }
  if (constraint.value.length !== secret.length) {
    throw new Error(
      `constraint.value length (${constraint.value.length}) must match secret length (${secret.length})`,
    );
  }

  const rng: RandomBytes = input.randomBytes ?? ((n) => sodium.randombytes_buf(n));
  const r = constraint.shareIndex;

  // Precompute r^k for k in [0, threshold-1].
  const rPow: number[] = [1];
  for (let k = 1; k < threshold; k++) {
    rPow.push(gfMul(rPow[k - 1]!, r));
  }

  const shares: Uint8Array[] = [];
  for (let i = 1; i <= totalShares; i++) {
    const share = new Uint8Array(secret.length + 1);
    share[0] = i;
    shares.push(share);
  }

  // For each secret byte position, build a polynomial constrained at r and 0.
  for (let j = 0; j < secret.length; j++) {
    const c0 = secret[j]!;
    const v = constraint.value[j]!;

    const coeffs = new Uint8Array(threshold);
    coeffs[0] = c0;

    // Random coefficients for c_2..c_{threshold-1}. Accumulate their
    // contribution to p(r) so we can solve for c_1 below.
    let randomContribution = 0;
    const freeCount = threshold - 2;
    if (freeCount > 0) {
      const rb = rng(freeCount);
      for (let k = 2; k < threshold; k++) {
        const ck = rb[k - 2]!;
        coeffs[k] = ck;
        randomContribution = gfAdd(randomContribution, gfMul(ck, rPow[k]!));
      }
    }

    // Solve c_1 = (v - c_0 - randomContribution) / r.
    // GF(256) subtraction is XOR (gfAdd).
    const numerator = gfAdd(gfAdd(v, c0), randomContribution);
    coeffs[1] = gfDiv(numerator, r);

    for (let i = 0; i < totalShares; i++) {
      shares[i]![j + 1] = gfEval(coeffs, shares[i]![0]!);
    }
  }

  return shares;
}

export function shamirCombine(shares: Uint8Array[]): Uint8Array {
  assertReady();
  if (shares.length < 2) throw new Error('shamir combine needs at least 2 shares');
  const secretLength = shares[0]!.length - 1;
  if (secretLength < 1) throw new Error('share too short');
  for (const s of shares) {
    if (s.length !== shares[0]!.length) throw new Error('shares have inconsistent length');
    if (s[0] === 0) throw new Error('share index 0 is invalid');
  }
  // Detect duplicate x indices — Lagrange interpolation would divide by zero.
  const seen = new Set<number>();
  for (const s of shares) {
    if (seen.has(s[0]!)) throw new Error('duplicate share index');
    seen.add(s[0]!);
  }

  const out = new Uint8Array(secretLength);
  for (let j = 0; j < secretLength; j++) {
    // Lagrange interpolation at x=0 over the share points (x_i, y_i).
    //   secret_byte = sum_i  y_i  *  prod_{k != i} (-x_k) / (x_i - x_k)
    // In GF(256), subtraction == XOR, and the negation is a no-op.
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      const x_i = shares[i]![0]!;
      const y_i = shares[i]![j + 1]!;
      let num = 1;
      let den = 1;
      for (let k = 0; k < shares.length; k++) {
        if (k === i) continue;
        const x_k = shares[k]![0]!;
        num = gfMul(num, x_k);
        den = gfMul(den, gfAdd(x_i, x_k));
      }
      acc = gfAdd(acc, gfMul(y_i, gfDiv(num, den)));
    }
    out[j] = acc;
  }
  return out;
}
