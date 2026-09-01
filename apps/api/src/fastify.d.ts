// Ambient Fastify augmentation. buildApp decorates the instance with the DB
// handles (or null when DB-less); requireSession sets request.session.
declare module 'fastify' {
  interface FastifyInstance {
    db: import('@truecairn/db').Database | null;
    sql: ReturnType<typeof import('@truecairn/db').createClient>['sql'] | null;
    audit: import('@truecairn/engine').AuditLogPort | null;
    // How the resolved audit signing key relates to the chain already in the
    // database, read once at boot (F-5). Separate from `audit` on purpose: that
    // stays the PORT so tests can inject a fake, while this is a fact about the
    // real signer that resolved. Null until onReady, and when there is no DB.
    auditKeyLineage: import('@truecairn/audit').AuditKeyLineage | null;
  }
  interface FastifyRequest {
    session: import('@truecairn/sessions').SessionContext | null;
    stepUp: import('./auth/stepup.js').StepUpContext | null;
    // The address every per-IP control is keyed on, decided once per request by
    // the onRequest hook in `auth/client-ip.ts`. Read it through `clientIp()`,
    // never by re-reading headers — see that module for why.
    trueClientIp: string;
  }
}

export {};
