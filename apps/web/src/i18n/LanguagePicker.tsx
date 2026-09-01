import { LOCALE_LABELS, OFFERED_LOCALES, isLocale, type Locale } from '@truecairn/shared';
import { currentLocale, setLocale } from './index.js';
import { useT } from './useT.js';

// The language control (docs/40 Phase 0).
//
// IT LIVES ON THE AUTH SCREENS, not only in Settings, and that placement is the
// point. Settings is behind sign-in and behind unlock; someone who cannot read
// the sign-in page cannot reach it. The one screen where a language picker has
// to exist is the first one a stranger lands on.
//
// The options are ENDONYMS from LOCALE_LABELS — each language named in itself —
// so the list is readable to the very reader who cannot read the current one.
//
// RENDERS NOTHING while only one language is offered. A one-item dropdown is a
// promise the product does not keep: it invites a reader to look for their
// language and shows them it is not there. Until OFFERED_LOCALES grows, saying
// nothing is the honest interface.
//
// `locales` is injectable so the multi-language behaviour is under test BEFORE
// the constant is flipped — the same seam Settings uses for `fetchImpl`.
// Flipping OFFERED_LOCALES must turn on a control that already works.
// Whether the control will render anything at all.
//
// Exported because a CALLER may need to know — Settings wraps the picker in its
// own `<section className="card">` with a "Language" heading, and a heading over
// a null child renders an empty card. That is what production showed for as long
// as only English was offered: a titled box with nothing in it, which reads as a
// broken setting rather than as an absent choice, and was reported as exactly
// that (2026-08-25).
//
// The threshold lives here rather than being re-tested as `length < 2` at each
// call site, because two copies of a rule are how the heading and the control
// come apart again.
export function hasLanguageChoice(locales: readonly Locale[] = OFFERED_LOCALES): boolean {
  return locales.length >= 2;
}

export function LanguagePicker({
  className,
  locales = OFFERED_LOCALES,
}: { className?: string; locales?: readonly Locale[] } = {}): JSX.Element | null {
  const t = useT();
  const active = currentLocale();
  if (!hasLanguageChoice(locales)) return null;
  return (
    <label className={`row gap-sm middle small t-2${className === undefined ? '' : ` ${className}`}`}>
      <span>{t('settings.language.label')}</span>
      <select
        className="select sm"
        value={active}
        data-testid="language-picker"
        onChange={(e) => {
          const next = e.target.value;
          // Guarded rather than cast: the value comes off a DOM element, and a
          // stale option (a language retired between page load and change)
          // must not reach changeLanguage as an unknown tag.
          if (isLocale(next) && next !== active) void setLocale(next);
        }}
      >
        {locales.map((locale) => (
          <option key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}
