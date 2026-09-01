import type { Catalog } from './catalog/index.js';

// Types `t()` against the catalog, so `t('auth.login.headnig')` is a COMPILE
// error rather than a screen that renders the key back at the user. That is the
// whole reason the catalog is typed modules and not JSON files: with JSON, a
// mistyped key is only ever found by looking at the page.
//
// The BOTH-HALVES union (catalog/index.ts): the type layer describes what the
// app can say, while the runtime decides which half has loaded. See that file.
//
// `keySeparator`/`nsSeparator` are repeated here because the type layer infers
// key shape independently of the runtime config in ./index.ts — declare them
// false in one place and not the other and every dotted key becomes a type
// error while working perfectly at runtime.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: Catalog };
    keySeparator: false;
    nsSeparator: false;
  }
}
