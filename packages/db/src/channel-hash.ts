import { createHash } from 'node:crypto';

// The canonical derivation of notification_channels.destination_hash.
//
// This lives beside the schema that declares the column because the column, the
// CHECK constraint that validates it (migration 0063) and the function that
// computes it are one fact expressed three times, and they were previously
// expressed in three places that could not see each other:
//
//   * the column,                       packages/db/src/schema/notifications.ts
//   * a private hashDestination(),      apps/api/src/routes/channels.ts
//   * every test fixture,               hand-written bytes, none of them a hash
//
// destination_hash is the DEDUPLICATION KEY — the unique index is on
// (user_id, channel_type, destination_hash) and the enrolment route's
// "already enrolled?" lookup selects on it. A row whose hash does not match its
// destination is invisible to both, so the same destination can enrol twice and
// the verified-duplicate 409 never fires. That is not theoretical: a 2026-08
// drill put a row into PRODUCTION with destination_hash = ASCII 'qa-sms',
// verified, which made it selectable for delivery, guaranteed to fail, and
// therefore a dead-letter — the sole trigger for `notifications` reading
// degraded on the public /status page.
//
// Every writer must use this. The SQL in migration 0063 mirrors it exactly:
//     sha256(convert_to(channel_type::text || ':' || destination, 'UTF8'))
// and channels.test.ts asserts the two produce identical bytes, so neither can
// drift alone — a change here without the matching migration would reject every
// enrolment in production.
export function channelDestinationHash(channelType: string, destination: string): Uint8Array {
  return new Uint8Array(
    createHash('sha256').update(`${channelType}:${destination}`, 'utf8').digest(),
  );
}
