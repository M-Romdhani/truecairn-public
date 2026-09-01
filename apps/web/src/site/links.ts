// Public-facing contact addresses, kept in ONE place so the footer, the
// disclosure policy, and the company pages can't drift. They are not secrets (a
// published security contact is the whole point of a disclosure policy).
//
// STATUS (2026-07-29): the primary domain moved truecairn.xyz → truecairn.app,
// which RESET what these addresses promise. security@ was live and monitored on
// .xyz; the .app mailboxes must be provisioned (or the old ones forwarded)
// before /security/disclosure is advertised again, because that page commits to
// a response window on whatever address is printed here. The rule stands: if
// hello@ or privacy@ are not yet provisioned, provision them rather than adding
// a caveat, because every page that prints them is already making a promise to
// a reader.
export const SECURITY_EMAIL = 'security@truecairn.app';
export const CONTACT_EMAIL = 'hello@truecairn.app';
export const PRIVACY_EMAIL = 'privacy@truecairn.app';

// The expected first-response window quoted in the disclosure policy. Honest and
// generic — a small team's good-faith commitment, not an SLA.
export const DISCLOSURE_RESPONSE_DAYS = 3;

// The public source repository. Published 2026-07-25 as a curated mirror of the
// production source: the full apps/, packages/, docs/ and CI needed to rebuild
// and verify, with internal-only material (deployment topology, the recovery
// drill, the audit-scope weakness table, legal posture, the build log) held
// back. It reproduces the deployed bundle byte-for-byte — that is the property
// /security/build depends on, and the only one that matters here.
//
// Setting this lights up BOTH the footer source link and the "rebuild and
// compare" instructions on /security/build, which degrade honestly while null.
export const REPO_URL: string | null = 'https://github.com/M-Romdhani/truecairn-public';
