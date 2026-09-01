// Client-side guard: stop obviously secret-looking text from ever leaving the
// device to the AI assistant (QA Finding 4 / defence-in-depth beneath the model's
// refusal). Heuristic, tuned to catch this product's actual secrets — the master/
// release passphrase and the 64-hex recovery code — while letting normal questions
// (even ones that mention "passphrase") through.
//
// It fires when EITHER:
//   • a long opaque token appears — ≥24 hex chars (recovery-code-shaped) or a
//     ≥28-char base64/opaque run — which is almost never part of a real question; OR
//   • a secret KEYWORD (passphrase / password / recovery code / secret key) appears
//     AND a credential-shaped token is present (≥10 chars, ≥3 of lower/upper/digit/
//     symbol, no spaces) — e.g. "my master passphrase is QaTest-Truecairn-2026!".

const LONG_HEX = /\b[A-Fa-f0-9]{24,}\b/;
const LONG_OPAQUE = /[A-Za-z0-9+/=_-]{28,}/;
const KEYWORD = /\b(pass\s?phrase|pass\s?word|recovery\s?code|secret\s?key|private\s?key)\b/i;

function charClasses(token: string): number {
  let n = 0;
  if (/[a-z]/.test(token)) n++;
  if (/[A-Z]/.test(token)) n++;
  if (/[0-9]/.test(token)) n++;
  if (/[^A-Za-z0-9]/.test(token)) n++;
  return n;
}

// A whitespace-delimited token that looks like a credential: long enough, mixed
// character classes, and not a URL (which naturally mixes classes).
function hasCredentialShapedToken(text: string): boolean {
  return text.split(/\s+/).some((raw) => {
    const token = raw.replace(/[.,;:!?)"']+$/, '').replace(/^["'(]+/, '');
    if (token.length < 10) return false;
    if (/^https?:\/\//i.test(token) || token.includes('@')) return false; // URLs / emails
    return charClasses(token) >= 3;
  });
}

export function detectSensitiveInput(text: string): boolean {
  if (LONG_HEX.test(text) || LONG_OPAQUE.test(text)) return true;
  if (KEYWORD.test(text) && hasCredentialShapedToken(text)) return true;
  return false;
}
