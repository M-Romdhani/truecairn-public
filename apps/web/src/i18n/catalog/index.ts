import { appEn } from './app/en.js';
import { pagesEn } from './pages/en.js';
import { siteEn } from './site/en.js';

// The three halves, unioned back into ONE key space (docs/40 Phase 2).
//
// The split is about DELIVERY — which bundle a string ships in — and deliberately
// not about naming. Screens call `t('vault.list.heading')` exactly as before and
// never say which half a key lives in, so moving a string between them is a
// delivery change with no call-site churn. All three are merged into i18next's
// single 'translation' namespace at runtime.
//
//   site/  — eager, in the bundle every landing visitor downloads
//   app/   — lazy with AuthedApp (product UI)
//   pages/ — lazy with PublicPages (guide, security, company: the long-form copy)
export type MessageKey = keyof typeof siteEn | keyof typeof appEn | keyof typeof pagesEn;

// The shape `t()` is typed against. All three halves at once: the type layer describes
// what the app CAN say, while the runtime decides what has been loaded yet.
// A key from the app half used on a public page would typecheck and then render
// as its own dotted name — which is why the fence and the catalog test both run
// over the real files rather than trusting the union alone.
export type Catalog = typeof siteEn & typeof appEn & typeof pagesEn;
