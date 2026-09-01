import type { PubPill } from './PublicPage.js';
import { useT, type TranslationKey } from '../i18n/useT.js';

// The sub-navigation shared by every /security/* page.
//
// ONE LIST, because two copies had already drifted. This was duplicated
// verbatim into security.tsx and build.tsx, and by 2026-08-23 the build page's
// copy was missing `/security/limits` — so /security/build was the only security
// page from which a reader could not reach Known limits. Nothing failed; the nav
// just quietly had five entries instead of six on one page out of six. Verified
// against the prerendered HTML before the fix, not inferred from the source.
//
// Translating the labels is what forced the reconciliation: a duplicated constant
// is a nuisance, a duplicated constant whose labels must each be looked up in a
// catalog is two places to add the same key.
//
// (A third copy lives beside an unrouted security page — written, deliberately
// not in the router. It joins this list when that page joins the router; until
// then it is unreachable and its drift costs nothing.)
const SECURITY_PILLS: readonly { to: string; labelKey: TranslationKey }[] = [
  { to: '/security', labelKey: 'site.security.pill.model' },
  { to: '/security/threat-model', labelKey: 'site.security.pill.threat' },
  { to: '/security/ai', labelKey: 'site.security.pill.ai' },
  { to: '/security/build', labelKey: 'site.security.pill.build' },
  { to: '/security/limits', labelKey: 'site.security.pill.limits' },
  { to: '/security/disclosure', labelKey: 'site.security.pill.disclosure' },
];

export function useSecurityPills(): readonly PubPill[] {
  const t = useT();
  return SECURITY_PILLS.map(({ to, labelKey }) => ({ to, label: t(labelKey) }));
}
