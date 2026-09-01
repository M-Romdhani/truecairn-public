import type { NotificationPurpose } from '@truecairn/shared';

// The WhatsApp template contract (CV-3).
//
// WhatsApp does not let a business START a conversation with free text. A
// business-initiated message — which is what EVERY send of ours is, since the
// recipient never messages us first — must reference a template Meta approved
// in advance. Free text there is accepted by the transport and then dropped by
// Meta: the delivery row says `sent`, the person's phone stays silent. For a
// product whose whole job is reaching someone who may be in trouble, "reported
// delivered, never arrived" is the worst failure we have (docs/11 threat 5.3),
// so the template must be resolved BEFORE the send, and a missing one must fail
// loudly rather than degrade to free text.
//
// PROVIDER-AGNOSTIC ON PURPOSE. This module survived the move off Twilio to the
// Meta Cloud API unchanged in substance: which template a purpose uses, what its
// approved text must say, and how many variables it takes are product decisions,
// not vendor ones. `WhatsappCloudAdapter` reads `name`; the retained
// `TwilioMessagingAdapter` WhatsApp branch reads a per-account SID map. Both
// read the same arity and the same approved text.
//
// TEXT IS COPIED, NEVER INVENTED — with ONE declared exception. Each `text` below
// is the body we submit to Meta, character-for-character the corresponding body in
// `templates.ts` with `{{n}}` where a variable goes. `whatsapp-templates.test.ts`
// re-derives them from `renderTemplate` and fails the build if the two ever drift,
// so an approved template can never quietly say something the rest of the product
// does not. The exception is `channel_verification`: it is registered under Meta's
// AUTHENTICATION category, whose content Meta fixes and we cannot edit, so its text
// is THEIRS rather than ours and is not derivable from `renderTemplate`. It is
// pinned as a golden literal instead — see the entry's own comment and the
// documented carve-out in the test.
//
// THE COUPLING RUNS BOTH WAYS NOW. Because these bodies exist as approved
// artefacts at Meta, editing the copy in `templates.ts` for any purpose mapped
// below stopped being a local change: it desynchronises the repo from a template
// someone already approved, and the drift test fails until Meta approves the new
// wording. Two of them (`check_in`, `health_probe`) were in fact written FROM
// that constraint rather than copied into it, after Meta refused the terse
// originals as UTILITY and offered only MARKETING — see templates.ts for why
// that category was unacceptable. Treat the copy for a mapped purpose as
// versioned at the vendor as well as in git.

export const WHATSAPP_TEMPLATE_KEYS = [
  'check_in',
  'escalation',
  'engine_update',
  'sensitive_action',
  'security_alert',
  'health_probe',
  'channel_verification',
  'trusted_contact',
  'plan_downgraded',
] as const;
export type WhatsappTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

// The language the templates are approved in. Meta treats a template's name and
// its language as ONE identity: a template approved as `en` cannot be sent as
// `en_US`, and the send fails rather than falling back. So it is a named
// constant, not a literal buried in the request builder.
export const WHATSAPP_TEMPLATE_LANGUAGE = 'en';

// The category a template is REGISTERED under at Meta. Repo-owned config for the
// same reason `name` is, and for a sharper one: the category is a product
// decision with delivery consequences (a MARKETING notice is undeliverable to US
// numbers and suppressible everywhere else), and leaving it to live only in a
// vendor console is what let a re-categorisation nearly reach production
// unnoticed. It also changes the wire format — an authentication template is sent
// with a button component the others must not carry — so the adapter reads it
// rather than special-casing a key.
export type WhatsappTemplateCategory = 'utility' | 'authentication';

export interface WhatsappTemplate {
  // The template name registered with Meta. WE choose these at creation time
  // (unlike a per-account SID, which the vendor mints), so the identity of a
  // template is repo-owned config and belongs here rather than in env.
  // Constraint: lowercase letters, digits and underscores only.
  readonly name: string;
  // The category submitted to Meta. Drives the send payload; see the type above.
  readonly category: WhatsappTemplateCategory;
  // Positional variable count Meta approved for this template. The adapter
  // checks the rendered variables against it: a template expecting {{1}} sent
  // with nothing to put there is rejected by Meta, so we reject it first.
  readonly variables: number;
  // The approved body text. `{{n}}` marks a positional variable.
  readonly text: string;
}

export const WHATSAPP_TEMPLATES: Readonly<Record<WhatsappTemplateKey, WhatsappTemplate>> = {
  check_in: {
    name: 'truecairn_check_in',
    category: 'utility',
    variables: 0,
    text: 'This is a Truecairn account status notification. Open the app to confirm you are active.',
  },
  escalation: {
    name: 'truecairn_escalation',
    category: 'utility',
    variables: 0,
    text: 'Your account looks inactive. Open Truecairn to confirm you are here.',
  },
  engine_update: {
    name: 'truecairn_engine_update',
    category: 'utility',
    variables: 0,
    text: 'There is an update to your Truecairn account status. Open the app to review.',
  },
  sensitive_action: {
    name: 'truecairn_sensitive_action',
    category: 'utility',
    variables: 0,
    text: 'A security-sensitive change to your account was requested and applies in 7 days. Open Truecairn to review or cancel.',
  },
  security_alert: {
    name: 'truecairn_security_alert',
    category: 'utility',
    variables: 0,
    text: 'We detected unusual login activity on your Truecairn account. If this was not you, open the app to secure it.',
  },
  health_probe: {
    name: 'truecairn_health_probe',
    category: 'utility',
    variables: 0,
    text: 'This is a Truecairn notification-channel test. Open the app to confirm this channel is working.',
  },
  // AUTHENTICATION, not utility — the reversal ratified July 2026 (docs/26).
  // Meta refused this template as UTILITY, and it gates ALL WhatsApp enrolment:
  // no channel verifies without it, so appealing would have blocked the entire
  // channel for as long as the appeal ran. Authentication is also exempt from the
  // MARKETING delivery pause that forced the check_in reword above.
  //
  // The cost is real, and recorded rather than hidden. Authentication template
  // content is NOT editable: the text below is Meta's own fixed body (with the
  // "security recommendation" toggle ON, which we want), so our sentence "Enter
  // it in the app to confirm this channel." is GONE. This is therefore the one
  // purpose whose WhatsApp text differs from its email and SMS text, and the one
  // entry the drift test cannot pin against `renderTemplate` — see the carve-out
  // in whatsapp-templates.test.ts. It stays exactly checkable, because Meta fixes
  // the wording; what it stops being is *derivable* from ours.
  //
  // Code delivery is COPY CODE, not zero-tap or one-tap autofill. Both autofill
  // modes require an Android package name and an 11-character app signature hash
  // in the console, and the form will not submit without them. Our code is typed
  // into the web app and apps/mobile is undistributed, so autofill is unavailable
  // to us rather than merely unchosen — this is not the "basic" option picked out
  // of laziness, and it should not be "upgraded" without a shipped Android build
  // to bind it to.
  channel_verification: {
    name: 'truecairn_channel_verification',
    category: 'authentication',
    variables: 1,
    text: '{{1}} is your verification code. For your security, do not share this code.',
  },
  // One approved template for all three ceremony notices: their bodies are
  // deliberately IDENTICAL (PHASE3_5 §g — which stage a ceremony reached is not
  // something transport should reveal), so three separate approvals would buy
  // nothing and give an interceptor a distinguisher we chose not to give them.
  trusted_contact: {
    name: 'truecairn_trusted_contact',
    category: 'utility',
    variables: 0,
    text: 'A trusted-contact request needs your attention in Truecairn. Open the app to respond.',
  },
  // The one body Meta was RIGHT to refuse. It used to close with "To add new
  // premium channels again, open Truecairn and upgrade.", which is a promotional
  // call-to-action however it is framed — so unlike check_in, this was not a
  // classifier misreading a terse safety notice, and there was no reword that
  // would have made it utility. The sentence was dropped rather than fought
  // (docs/26); the upgrade path lives in the Settings downgrade banner instead.
  plan_downgraded: {
    name: 'truecairn_plan_downgraded',
    category: 'utility',
    variables: 0,
    text: 'Your paid plan has ended. Every notification channel you already verified keeps working — nothing that guards your vault was turned off.',
  },
};

// The mapping requirement 6 of the CV-3 template pass asks to be explicit: every
// purpose either names a template or is `null`, and `null` means "this can never
// be a WhatsApp send" — enforced, not assumed. A future purpose added to
// NOTIFICATION_PURPOSES will not compile until someone decides which it is.
export const WHATSAPP_TEMPLATE_FOR_PURPOSE: Readonly<
  Record<NotificationPurpose, WhatsappTemplateKey | null>
> = {
  check_in_request: 'check_in',
  escalation_request: 'escalation',
  engine_state_change: 'engine_update',
  sensitive_action_notice: 'sensitive_action',
  security_alert: 'security_alert',
  health_probe: 'health_probe',
  channel_verification: 'channel_verification',
  ceremony_initiation: 'trusted_contact',
  ceremony_affirmation_request: 'trusted_contact',
  ceremony_revocation_window: 'trusted_contact',
  plan_downgraded: 'plan_downgraded',
  // Structurally email-only: enqueued in apps/api/src/routes/channels.ts ONLY on
  // the first verified EMAIL channel, to that channel. It is also the one body
  // that a WhatsApp template could not carry — twelve lines, a numbered setup
  // list, and an HTML shell — and truncating it to fit would be inventing copy.
  // So it stays null: unreachable by construction, and fail-closed if that ever
  // changes, rather than silently shortened.
  welcome: null,
  // No producer at all: invite tokens are a capability the owner delivers out of
  // band, and at invite time the contact has no verified channel to send to
  // (apps/api/src/contacts/invite.ts). Nothing to approve until that changes.
  contact_invitation: null,
};

export function whatsappTemplateKeyFor(purpose: NotificationPurpose): WhatsappTemplateKey | null {
  return WHATSAPP_TEMPLATE_FOR_PURPOSE[purpose];
}

// Per-key SID configuration for the MOTHBALLED Twilio WhatsApp path. Kept
// because that adapter branch is kept (see whatsapp-cloud.ts on why WhatsApp
// moved off Twilio); nothing constructs it for `whatsapp` any more, so nothing
// reads this at runtime. The Cloud API needs no equivalent: template identity is
// `name` above, which we own, rather than a per-account id the vendor mints.
export type WhatsappTemplateSids = Readonly<Partial<Record<WhatsappTemplateKey, string>>>;
