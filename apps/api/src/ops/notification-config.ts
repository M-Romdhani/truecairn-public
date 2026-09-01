import type { NotificationChannelType } from '@truecairn/shared';
// Which channel types have a provider configured. Mirrors the worker's registry
// construction in apps/worker/src/main.ts — the worker owns the adapters, but the
// same env decides whether anything can be delivered at all, and "nothing can be
// sent" is the single most important notification fact for both status surfaces.
//
// Shared by the admin dashboard (routes/ops.ts) and the public page
// (routes/status.ts) so the two cannot disagree about whether the owner could be
// warned. Returns TYPE NAMES only — never a key, an endpoint or a from-address.
export function configuredNotificationTypes(): string[] {
  const env = process.env;
  const types: string[] = [];
  if (env['RESEND_API_KEY'] && env['NOTIFICATIONS_FROM']) types.push('email');
  if (env['TWILIO_ACCOUNT_SID'] && env['TWILIO_AUTH_TOKEN'] && env['TWILIO_SMS_FROM']) {
    types.push('sms');
  }
  // WhatsApp is Meta's Cloud API, NOT Twilio (CV-3) — the two channels
  // deliberately share no vendor or credential, so this condition must stay
  // independent of the SMS one above. Reading the old TWILIO_WHATSAPP_* vars
  // here would report the channel unconfigured on a correctly configured
  // deployment, which understates readiness on /status and the ops dashboard.
  if (env['WHATSAPP_CLOUD_PHONE_NUMBER_ID'] && env['WHATSAPP_CLOUD_ACCESS_TOKEN']) {
    types.push('whatsapp');
  }
  if (env['VAPID_PUBLIC_KEY'] && env['VAPID_PRIVATE_KEY']) types.push('push');
  return types;
}

// The same answer as a typed set, for the enrolment surface.
//
// Deliberately DERIVED from configuredNotificationTypes() rather than
// re-reading env: this decides what Settings offers a paying user, and the two
// must never disagree about whether a channel can be delivered. Re-deriving it
// is how /status and the picker end up telling a user different things about
// the same deployment.
export function configuredChannelTypes(): ReadonlySet<NotificationChannelType> {
  return new Set(configuredNotificationTypes() as NotificationChannelType[]);
}
