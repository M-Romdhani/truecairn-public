import { useTranslation } from 'react-i18next';
import type { Locale } from '@truecairn/shared';
import { currentLocale } from './index.js';
import type { MessageKey } from './catalog/index.js';

// Values interpolated into a message ({{count}}, {{name}}, …). Deliberately not
// `any`: a message can carry numbers and strings and nothing else, because
// anything richer belongs in the component, not in a translatable string a
// translator has to reason about.
export interface TValues {
  readonly [placeholder: string]: string | number;
}

// i18next resolves a PLURAL by suffixing the key it is given: `t('x.count', {
// count: 3 })` looks up 'x.count_other'. So the callable key set is the catalog's
// own keys PLUS the bases of every `_one`/`_other` pair — derived here rather
// than hand-listed, so adding a plural to the catalog makes it callable and
// nothing can drift.
//
// Spanish pluralises one/other exactly as English does, so this buys nothing
// today. It is here because the alternative — `n === 1 ? t(a) : t(b)` at each
// call site — hard-codes that assumption into every screen, and it is wrong for
// Arabic (six forms), Polish and Russian (three). Fixing that later would mean
// revisiting every plural in the app; the machinery costs nothing now.
type PluralBase<K> = K extends `${infer B}_other` ? B : never;
export type TranslationKey = MessageKey | PluralBase<MessageKey>;

export type TFunction = (key: TranslationKey, values?: TValues) => string;

// The translate function, typed to the catalog. Screens import one short name:
// `const t = useT();` then `t('auth.login.heading')`.
//
// Components subscribe through react-i18next's context, so changing the language
// re-renders every mounted screen; nothing reloads.
export function useT(): TFunction {
  const { t } = useTranslation();
  return t as unknown as TFunction;
}

// The active language, as a value that re-renders its component when it changes.
// `currentLocale()` alone reads the i18next singleton and would go stale — the
// useTranslation() call is what subscribes this component to a language change.
export function useActiveLocale(): Locale {
  useTranslation();
  return currentLocale();
}
