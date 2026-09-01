import { DEFAULT_LOCALE } from '@truecairn/shared';
import { useActiveLocale, useT, type TranslationKey } from './useT.js';

// Reconciling the API's error text with the screen's own (docs/40, "Server error
// text").
//
// Errors arrive as RFC 7807 problem documents, and `detail` is often more
// specific than anything a screen can say in advance ("a release is in progress
// — use POST /v1/engine/cancel-release" beats "please try again"). Screens have
// therefore preferred it.
//
// It is also English, always. Measured 2026-08-22: of ~280 error sites in
// apps/api, exactly 5 carry a stable machine-readable `type`; the other 275 are
// `about:blank` with English free text. So there is no key to translate the
// server's message against, and adding one to all 280 would be a large change to
// the API for a small gain.
//
// The cheaper answer, and the one taken: while the UI is in the SOURCE language,
// keep preferring the server's more specific sentence — nothing regresses. In any
// other language, use the screen's own message, which is in the catalog like
// everything else. The reader gets something correct and slightly less specific
// instead of something precise in a language they do not read.
//
// If particular errors ever need their full specificity in every language, give
// THOSE a stable `code` and map them. That is a small, targeted change; this is
// what makes it unnecessary today.
export function useServerMessage(): (detail: string | undefined, fallback: TranslationKey) => string {
  const t = useT();
  const locale = useActiveLocale();
  return (detail, fallback) => {
    if (locale === DEFAULT_LOCALE && typeof detail === 'string' && detail.length > 0) return detail;
    return t(fallback);
  };
}
