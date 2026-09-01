import { Route, Routes } from 'react-router-dom';
import { loadPagesCatalog } from './i18n/index.js';
import { pagesEn } from './i18n/catalog/pages/en.js';
import { pagesEs } from './i18n/catalog/pages/es.js';
import { Guide } from './screens/guide/Guide.js';
import { NotFound } from './site/NotFound.js';
import { BuildProvenance } from './screens/public/build.js';
import { Changelog } from './screens/public/Changelog.js';
import { About, Contact, Press, Status } from './screens/public/company.js';
import { Dpa, Privacy, SubProcessors, Terms, WindDown } from './screens/public/legal.js';
import {
  AiTransparency,
  Disclosure,
  KnownLimits,
  SecurityModel,
  ThreatModel,
} from './screens/public/security.js';

// The PUBLIC content pages, in their OWN lazy chunk (main.tsx). This module must
// import ONLY public-page components — nothing from the authed graph (no
// useSession / SessionProvider, no AuthedApp, no api client, no
// @truecairn/client-crypto). That keeps libsodium and the crypto key code out of
// the chunk a prospect loads to read /security, /guide, the legal pages, etc.
// Verified at build time: the public chunk does not reference the libsodium chunk.
// Registered at MODULE level, not in the component: the prerenderer calls
// renderToString directly on this tree, and a component-body call would run
// after React had already begun rendering children that ask for these keys.
loadPagesCatalog(pagesEn, pagesEs);

export default function PublicPages(): JSX.Element {
  return (
    <Routes>
      <Route path="/guide" element={<Guide />} />
      <Route path="/security" element={<SecurityModel />} />
      <Route path="/security/threat-model" element={<ThreatModel />} />
      <Route path="/security/ai" element={<AiTransparency />} />
      <Route path="/security/build" element={<BuildProvenance />} />
      <Route path="/security/limits" element={<KnownLimits />} />
      <Route path="/security/disclosure" element={<Disclosure />} />
      <Route path="/legal/privacy" element={<Privacy />} />
      <Route path="/legal/terms" element={<Terms />} />
      <Route path="/legal/dpa" element={<Dpa />} />
      <Route path="/legal/sub-processors" element={<SubProcessors />} />
      <Route path="/legal/wind-down" element={<WindDown />} />
      <Route path="/company/about" element={<About />} />
      <Route path="/company/contact" element={<Contact />} />
      <Route path="/company/press" element={<Press />} />
      <Route path="/status" element={<Status />} />
      <Route path="/changelog" element={<Changelog />} />
      {/* An unknown /security|/legal|/company subpath RENDERS a 404 — it does not
          redirect. The server already answers these with a real 404 status and the
          pristine shell; bouncing to "/" threw that away and destroyed the URL that
          failed before anyone could read or report it (QA P3-1). */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
