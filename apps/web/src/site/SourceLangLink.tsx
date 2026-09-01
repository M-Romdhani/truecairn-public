import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, SOURCE_LANGUAGE_ONLY_ROUTES, localizePath } from '@truecairn/shared';
import { Link } from 'react-router-dom';

// A link to a page published only in the source language (docs/40 Phase 2).
//
// THE BUG THIS EXISTS FOR, found by reading the built HTML rather than the code:
// the router carries the language as a `basename`, which is what lets every
// ordinary <Link to="/security"> become /es/security on a Spanish page without a
// single call site knowing. It applies to EVERY link — including the ones
// pointing at the changelog and the legal pages, which are deliberately
// published in one language only and therefore have no /es/ file. The Spanish
// pages shipped with six links to URLs the build never produced.
//
// A PLAIN <a>, not a <Link>. The first attempt used <Link reloadDocument>, which
// was still wrong and looked right: reloadDocument changes how a click NAVIGATES
// and not how the href is generated, so the rendered attribute was still
// /es/legal/privacy. Only an anchor escapes the basename, and escaping it is the
// entire point — this is a link OUT of the current language.
//
// Deliberately NOT a general "link to any locale" helper. Its whole purpose is
// that the route list it consults is the one shared by the prerenderer, the
// sitemap and the API's 404 handler — so a page that stops being
// source-language-only becomes an ordinary <Link> by that one list changing, and
// cannot be left behind pointing at a page that moved.
// `children` is optional because this also serves as a <Trans> component: there
// the element is written childless in the `components` map and i18next clones it
// with the translated text, so requiring children would make the one call site
// that most needs this helper unable to use it.
export function SourceLangLink({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const isSourceOnly = SOURCE_LANGUAGE_ONLY_ROUTES.some(
    (route) => to === route || to.startsWith(`${route}#`) || to.startsWith(`${route}?`),
  );
  if (!isSourceOnly) {
    return (
      <Link to={to} {...(className === undefined ? {} : { className })}>
        {children}
      </Link>
    );
  }
  return (
    <a href={localizePath(to, DEFAULT_LOCALE)} {...(className === undefined ? {} : { className })}>
      {children}
    </a>
  );
}
