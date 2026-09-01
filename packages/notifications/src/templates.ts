import { DEFAULT_LOCALE, type Locale, type NotificationPurpose } from '@truecairn/shared';
import { SHELL_ES, TEMPLATES_ES, type ShellStrings } from './templates.es.js';

export interface RenderedTemplate {
  subject: string;
  body: string;
  // Branded HTML alternative (email adapter only). The bare `body` remains the
  // canonical text + fallback; `html` wraps that SAME content in the visual
  // shell (CV-brand pass). Present for every purpose renderTemplate handles.
  html?: string;
  // Positional variables for template-based transports — WhatsApp, whose bodies
  // live pre-approved at Meta and are filled by index (CV-3). This is the SAME
  // content as `body`, decomposed: never a new field, never something the text
  // does not already say. It lives here, not in the adapter, because the adapter
  // must not construct content (docs/cv-adapter-contract.md §1). Empty for every
  // purpose whose body is fully static — which is all but one.
  variables: Readonly<Record<string, string>>;
}

// Server-side, per-purpose templates (PHASE3_5 §f) — the single place a body is
// produced, so no individual enqueuer can leak. Every body says enough to ACT
// (open Truecairn) and carries NO vault content, item title, tier, contact
// identity, or release detail; the actionable detail lives behind auth in the app.
// An email interceptor learns only that the recipient uses Truecairn.
// The static source table. Deliberately NOT RenderedTemplate: `html` and
// `variables` are produced per render (one from the body, one from the params),
// so a literal here could only ever restate them wrongly.
const TEMPLATES: Record<NotificationPurpose, { subject: string; body: string }> = {
  // The opening clause is load-bearing, not throat-clearing. WhatsApp classifies
  // a template by what its copy SAYS, and the terse original ("Open Truecairn to
  // confirm you are active.") was refused as UTILITY and offered only MARKETING —
  // a category that since April 2025 Meta will not deliver to US numbers at all
  // (error 131049) and that everywhere else the recipient can switch off per
  // account. A check-in a category preference can silently suppress is docs/11
  // threat 5.3 rebuilt one layer down, so the category was never negotiable and
  // the copy moved instead: naming the notice's own kind is what makes it read as
  // an account notification rather than re-engagement. The reword passed as
  // UTILITY on first submission. It is reproduced character-for-character in
  // whatsapp-templates.ts and pinned there by test — editing this sentence means
  // re-approval at Meta, not just a tidier line.
  check_in_request: {
    subject: 'Confirm you are active',
    body: 'This is a Truecairn account status notification. Open the app to confirm you are active.',
  },
  escalation_request: {
    subject: 'Confirm you are active',
    body: 'Your account looks inactive. Open Truecairn to confirm you are here.',
  },
  engine_state_change: {
    subject: 'A Truecairn account update',
    body: 'There is an update to your Truecairn account status. Open the app to review.',
  },
  sensitive_action_notice: {
    subject: 'A security-sensitive change was requested',
    body: 'A security-sensitive change to your account was requested and applies in 7 days. Open Truecairn to review or cancel.',
  },
  security_alert: {
    subject: 'Unusual activity on your account',
    body: 'We detected unusual login activity on your Truecairn account. If this was not you, open the app to secure it.',
  },
  // Intentionally has NO auto-producer: invite tokens are a capability the owner
  // delivers OUT OF BAND, and at invite time the contact has no account/verified
  // channel to send to. Kept as a valid purpose (the delivery pipeline could be
  // driven manually by ops) but never enqueued by product code — see
  // apps/api/src/contacts/invite.ts.
  contact_invitation: {
    subject: 'A Truecairn invitation',
    body: 'You have been invited to Truecairn. Open the app to respond.',
  },
  // Reworded for the same reason as check_in_request above, and it was the only
  // other body terse enough to read as re-engagement. Note it has NO producer in
  // product code today (nothing enqueues `health_probe`), so the change reaches
  // no one — but the approved template has to match the repo whether or not
  // anything sends it, or the drift this module exists to prevent starts here.
  health_probe: {
    subject: 'Confirm this channel works',
    body: 'This is a Truecairn notification-channel test. Open the app to confirm this channel is working.',
  },
  // Channel-enrolment code round-trip (CV-0.0). The static entry is the
  // no-params fallback (a retried row whose params were already cleared);
  // renderTemplate injects the code when the delivery carries it. The code is
  // server-generated randomness bound to nothing — an interceptor learns only
  // that the recipient is enrolling a Truecairn channel.
  channel_verification: {
    subject: 'Confirm this channel',
    body: 'Open Truecairn and request a new code to confirm this notification channel.',
  },
  // Contact-facing ceremony notices: maximally bare (PHASE3_5 §g). No owner name,
  // no "someone may be gone", no vault hint — putting that in transport asserts
  // something intimate and possibly false. The auth-gated app reveals the rest.
  ceremony_initiation: {
    subject: 'A trusted-contact request',
    body: 'A trusted-contact request needs your attention in Truecairn. Open the app to respond.',
  },
  ceremony_affirmation_request: {
    subject: 'A trusted-contact request',
    body: 'A trusted-contact request needs your attention in Truecairn. Open the app to respond.',
  },
  ceremony_revocation_window: {
    subject: 'A trusted-contact request',
    body: 'A trusted-contact request needs your attention in Truecairn. Open the app to respond.',
  },
  // Billing lapse (docs/28). Sent once, on the entitled→not-entitled webhook
  // edge, only when paid channels (SMS/WhatsApp) are still enrolled. The body's
  // one job is the safety promise: nothing you rely on stops working. No plan
  // names, prices, or destinations in transport.
  //
  // The upsell sentence that used to close this body ("To add new premium
  // channels again, open Truecairn and upgrade.") was DROPPED in July 2026.
  // Meta refused the template as UTILITY and offered only MARKETING, which has
  // been undeliverable to US numbers since April 2025 — and unlike the check_in
  // reword above, the classifier was RIGHT: a call to upgrade is promotional, and
  // no reframing changes that. It was secondary to the sentence stated as this
  // body's one job, and it survives where it belongs — the Settings downgrade
  // banner, which names the plan and links to /plans behind sign-in. Email and
  // SMS lose it too, because the copy stays unforked (see whatsapp-templates.ts).
  plan_downgraded: {
    subject: 'Your Truecairn plan changed',
    body: 'Your paid plan has ended. Every notification channel you already verified keeps working — nothing that guards your vault was turned off.',
  },
  // Onboarding welcome — the one rich body (still carries NO vault content). Its
  // HTML is built in renderTemplate; this text is the plain-text fallback.
  welcome: {
    subject: 'Welcome to Truecairn',
    body: [
      'Your email is confirmed — this address will now receive your check-in reminders and account notices.',
      '',
      // "master passphrase", not the invented "release-only passphrase" that used
      // to sit here (corrected 2026-08-01). The two are different secrets that
      // fail differently — losing the master one costs the whole vault, losing the
      // release passphrase costs the highest tier — and this body was using the
      // name of one to describe the job of the other. The same conflation was
      // removed from the homepage on 2026-07-31; it survived here because the
      // report that found it quoted the homepage and not this file. Note line
      // "We will never ask for your release passphrase" below is CORRECT and
      // deliberately untouched: that one really is the release passphrase.
      'Truecairn keeps an encrypted vault that reaches the people you choose, only if you go silent. Encryption happens on your device with your master passphrase: you hold the keys, we never see them, and we cannot reset them.',
      '',
      'To finish setting up:',
      // "to start" is load-bearing — it matches /guide §6. A contact needs no
      // account to ACCEPT an invite, but enrolling generates keys on their device,
      // so the unqualified "no account needed" overstated it (UX finding U-8).
      '  1. Add a trusted contact — anyone with an email address; they do not need an account to start.',
      '  2. Put something in your vault — start from a template.',
      '  3. Arm your continuity engine — pick a trigger and a cooldown between 7 and 90 days.',
      '',
      'There is no rush. Any choice you make can be undone: every release runs through a 48-hour revocation window, and every sensitive change waits 7 days before it takes effect.',
      '',
      'We will never ask for your release passphrase — not by email, not by phone. If a message ever does, it is not from us.',
      '',
      'We only ever record whether a message was delivered — never whether you opened or read it.',
    ].join('\n'),
  },
};

// `params` is the ONE narrow content channel from an enqueuer into a body, and
// it only exists for channel_verification (the code the recipient types back).
// Every other purpose ignores params entirely — the static template stands.
//
// Every purpose also gets a branded `html` shell: for the bare notices it wraps
// the IDENTICAL text (no new content — the shell is threat-neutral, an
// interceptor already sees "Truecairn"); welcome gets a richer body. The email
// adapter uses `html`; SMS/WhatsApp/push ignore it and send `body`.
// ── Locale (docs/40 Phase 3) ─────────────────────────────────────────────────
//
// PARTIAL OVERRIDES over the English above, exactly like the web catalogs: a
// purpose with no translation renders in the source language rather than as a
// placeholder. `locale` defaults to the source language, so every existing call
// site is byte-identical without touching it — and `renderTemplate(purpose)`,
// which whatsapp-templates.test.ts uses to pin the Meta-approved copy, keeps
// meaning "the English body" no matter what any translation says.
//
// WHATSAPP IS STRUCTURALLY UNAFFECTED and that is not an accident worth relying
// on quietly: the Cloud adapter builds its message from the approved template
// NAME plus positional `variables` and never reads `body` (see
// whatsapp-cloud.ts), because Meta accepts free text and silently drops it.
// Template identity there is (name, language) and the approved language is
// pinned by test, so a translated body cannot reach it even by mistake.
const LOCALE_TEMPLATES: Partial<
  Record<Locale, Partial<Record<NotificationPurpose, { subject: string; body: string }>>>
> = { es: TEMPLATES_ES };

const LOCALE_SHELL: Partial<Record<Locale, ShellStrings>> = { es: SHELL_ES };

function templateFor(
  purpose: NotificationPurpose,
  locale: Locale,
): { subject: string; body: string } {
  return LOCALE_TEMPLATES[locale]?.[purpose] ?? TEMPLATES[purpose];
}

// The shell's own chrome, resolved key by key so a partial translation degrades
// per string rather than dropping the whole locale back to English.
function shellFor(locale: Locale): ShellStrings | undefined {
  return LOCALE_SHELL[locale];
}

export function renderTemplate(
  purpose: NotificationPurpose,
  params?: Readonly<Record<string, string>>,
  locale: Locale = DEFAULT_LOCALE,
): RenderedTemplate {
  const base = templateFor(purpose, locale);
  const shell = shellFor(locale);
  if (purpose === 'welcome') {
    return {
      subject: base.subject,
      body: base.body,
      html: renderWelcomeHtml(locale, shell),
      variables: {},
    };
  }
  let body = base.body;
  const variables: Record<string, string> = {};
  if (purpose === 'channel_verification' && params?.['code'] !== undefined) {
    const code = params['code'];
    body =
      shell === undefined
        ? `Your Truecairn channel verification code is ${code}. Enter it in the app to confirm this channel.`
        : shell.verificationBody.replace('{{code}}', code);
    // {{1}} of the approved WhatsApp template (whatsapp-templates.ts). Same code
    // the sentence above carries — the two are pinned equal by test. The CODE is
    // language-neutral, which is why a translated sentence around it cannot put
    // the WhatsApp template out of step.
    variables['1'] = code;
  }
  return {
    subject: base.subject,
    body,
    html: renderNoticeHtml(purpose, base.subject, body, locale, shell),
    variables,
  };
}

// ── Branded email shell ──────────────────────────────────────────────────────
// Table-based, all-inline-styles HTML (the only thing email clients render
// reliably), implementing the 2026 design (design-reference/Emails.dc.html): an
// ink header band carrying the mark and wordmark, a white sheet, a soft
// reassurance band, and an ink footer — with the signature asymmetric corner
// radius (sharp top-left, round bottom-right) on the outer sheet and the button.
//
// TWO CONSTRAINTS THIS MODULE MUST KEEP.
//
// 1. NO IMAGES, EVER. Both the wordmark and the cairn mark are built from styled
//    table cells, not hosted art. That is a brand decision (bulletproof across
//    clients, no asset to serve, renders with images blocked) AND the mechanical
//    guarantee behind our public promise never to detect a read: with no remote
//    image there is nothing for a client to fetch, so there is nothing to
//    observe. templates.test.ts fails the build if `<img` ever appears here.
//
// 2. THE SHELL ADDS PRESENTATION, NEVER INFORMATION. Every notice's HTML says
//    exactly what its one-sentence text body says. The extra copy in the shell —
//    the anti-phishing line, the channel notice, the delivery-only promise — is
//    standing POLICY, true of every send and about us rather than the reader, so
//    an interceptor learns nothing it did not already know from "Truecairn".

const INK = '#12142b';
const SHEET = '#ffffff';
const PAGE = '#eef0f8';
const BAND = '#eff1f8';
const HAIRLINE = '#e1e3ee';
const ACCENT = '#2743f0';
// The soft accent companion, used for the wordmark's "ai" and links on ink where
// #2743f0 has no contrast.
const ON_INK_ACCENT = '#9daaff';
const TEXT = '#4e4b66';
const MUTED = '#6e6b8a';
const ON_INK_TEXT = '#b9bad0';
const ON_INK_MUTED = '#8f91ae';
const ON_INK_LABEL = '#7d7f9e';

const SANS = "'Figtree', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const DISPLAY = "'Poppins', 'Trebuchet MS', Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace";

const P = `margin:0 0 16px;font-size:16px;line-height:1.62;color:${TEXT};`;
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

// Where the buttons and footer links point. Single-origin deploy: the API serves
// the SPA, so one base URL covers the app and the public pages (docs/23 §5).
// Falls back to the production origin — an email whose button is a dead relative
// path is worse than one built from a default.
function baseUrl(): string {
  const configured = process.env['PUBLIC_BASE_URL'] ?? process.env['WEBAUTHN_ORIGIN'];
  return (configured !== undefined && configured !== '' ? configured : 'https://truecairn.app')
    .replace(/\/$/, '');
}

// The small monospace category label in the header band. Deliberately WEAKER than
// the subject line it sits above — it can never be the first place a reader learns
// something — which is what keeps rule 2 above true for every purpose.
const HEADER_LABEL: Record<NotificationPurpose, string> = {
  check_in_request: 'check-in',
  escalation_request: 'check-in',
  engine_state_change: 'account notice',
  sensitive_action_notice: 'security',
  security_alert: 'security alert',
  contact_invitation: 'invitation',
  health_probe: 'channel check',
  channel_verification: 'channel check',
  ceremony_initiation: 'trusted contact',
  ceremony_affirmation_request: 'trusted contact',
  ceremony_revocation_window: 'trusted contact',
  plan_downgraded: 'account notice',
  welcome: 'welcome',
};

// The reassurance band, one line per purpose family. Standing policy, not detail
// about this send. channel_verification gets its own line because "the detail is
// never in an email" would contradict the code that email is carrying.
function reassurance(purpose: NotificationPurpose, shell: ShellStrings | undefined): string {
  if (purpose === 'channel_verification') {
    return (
      shell?.reassuranceVerification ??
      'This code only confirms that this channel reaches you. It grants no access to your vault, and we will never ask for your release passphrase — not by email, not by phone.'
    );
  }
  return (
    shell?.reassuranceDefault ??
    'The detail is in the app, behind your sign-in — never in an email. We will never ask for your release passphrase, and if a message ever does, it is not from us.'
  );
}

// The cairn mark: five stacked stones as styled table cells (see rule 1 — no
// hosted image). Widths/heights taper the way the SVG mark does.
function cairnMark(): string {
  const stones: readonly [number, number, string][] = [
    [9, 4, '#495080'],
    [15, 5, '#5e67a0'],
    [21, 5, '#737dbf'],
    [27, 6, '#8894df'],
    [34, 6, ON_INK_ACCENT],
  ];
  const rows = stones
    .map(([w, h, color], i) => {
      const gap = i === stones.length - 1 ? '0' : '0 0 2px';
      const radius = h > 5 ? 3 : 2;
      return (
        `<tr><td align="center" style="padding:${gap}">` +
        `<table ${TABLE} align="center"><tr>` +
        `<td width="${w}" height="${h}" bgcolor="${color}" style="width:${w}px;height:${h}px;background:${color};border-radius:${radius}px;font-size:0;line-height:${h}px">&nbsp;</td>` +
        '</tr></table></td></tr>'
      );
    })
    .join('');
  return `<table ${TABLE} width="34" align="left" style="width:34px">${rows}</table>`;
}

// The header band: mark, wordmark, category label. The "ai" in TrueCairn is
// accented (a nod to the AI guardian — see docs/AI.md), matching the SPA's
// Wordmark component; on ink it takes the soft companion rather than #2743f0.
function headerBand(label: string, padding: string): string {
  return (
    `<tr><td bgcolor="${INK}" style="background:${INK};padding:${padding};border-radius:0 32px 0 0">` +
    `<table ${TABLE} width="100%" style="width:100%"><tr>` +
    `<td width="38" valign="middle" style="width:38px;vertical-align:middle;padding-right:10px">${cairnMark()}</td>` +
    `<td valign="middle" style="vertical-align:middle;font-family:${DISPLAY};font-size:19px;font-weight:600;letter-spacing:-0.02em;color:#ffffff">TrueC<span style="color:${ON_INK_ACCENT}">ai</span>rn</td>` +
    `<td align="right" valign="middle" style="vertical-align:middle;font-family:${MONO};font-size:10.5px;letter-spacing:0.06em;text-transform:uppercase;color:${ON_INK_LABEL}">${escapeHtml(label)}</td>` +
    '</tr></table>'
  );
}

// The ink call-to-action. A bare origin link with no token or identifier in it —
// the reader signs in on the other side, which is also why it is safe to click
// and why we can tell them the detail is never in the email.
function cta(label: string, path: string): string {
  return (
    `<table ${TABLE} style="border-radius:0 26px">` +
    `<tr><td bgcolor="${INK}" align="center" style="background:${INK};border-radius:0 26px;padding:15px 30px">` +
    `<a href="${baseUrl()}${path}" style="display:block;font-family:${DISPLAY};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:-0.01em">${escapeHtml(label)}&nbsp;&nbsp;&rarr;</a>` +
    '</td></tr></table>'
  );
}

// The soft band under the sheet: standing policy the reader benefits from seeing
// on every message, phrased so it is true of every send.
function reassuranceBand(paragraphs: readonly string[]): string {
  const inner = paragraphs
    .map((text, i) => {
      const style =
        i === 0
          ? `margin:0;font-size:15px;line-height:1.6;color:${INK};`
          : `margin:10px 0 0;font-size:13.5px;line-height:1.6;color:${TEXT};`;
      return `<p style="${style}">${text}</p>`;
    })
    .join('');
  return (
    `<tr><td bgcolor="${BAND}" style="background:${BAND};padding:22px 40px;border-left:1px solid ${HAIRLINE};border-right:1px solid ${HAIRLINE};border-top:1px solid ${HAIRLINE}">${inner}</td></tr>`
  );
}

// The ink footer. Names the only opt-out that makes sense for a continuity
// product — removing the channel in Settings — and restates the delivery-only
// promise. No postal address: we will not print an office we do not have.
function footerBand(shell: ShellStrings | undefined): string {
  const base = baseUrl();
  const link = (href: string, text: string): string =>
    `<td style="padding-right:16px;font-size:12.5px"><a href="${href}" style="color:${ON_INK_ACCENT};text-decoration:none;font-weight:600">${text}</a></td>`;
  return (
    `<tr><td bgcolor="${INK}" style="background:${INK};padding:24px 40px 28px;border-radius:0 0 32px 0">` +
    `<p style="margin:0 0 14px;font-size:12.5px;line-height:1.65;color:${ON_INK_MUTED}">${
      shell?.footerNotice ??
      'You are receiving this because this address is a notification channel on your Truecairn account. You can manage or remove your channels anytime in Settings. We record only whether a message was delivered — never whether you opened or read it.'
    }</p>` +
    `<table ${TABLE}><tr>` +
    link(`${base}/settings`, shell?.footerSettings ?? 'Notification settings') +
    link(`${base}/security`, shell?.footerSecurity ?? 'Security model') +
    link(`${base}/guide`, shell?.footerHelp ?? 'Help') +
    '</tr></table></td></tr>'
  );
}

// Hidden preview text — the line a client shows next to the subject in the
// inbox list. Text only; there is no image to fetch, so nothing is observable.
function preheader(text: string): string {
  return `<span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${PAGE}">${escapeHtml(text)}</span>`;
}

// `preview` is the inbox preview line; it comes FIRST in the body so a client
// picks it up ahead of the wordmark in the header band.
function emailDocument(
  title: string,
  preview: string,
  rows: string,
  locale: Locale,
): string {
  return [
    // `lang` drives screen-reader pronunciation and a client's own hyphenation,
    // so it tracks the language the body is actually in rather than sitting at a
    // hardcoded "en" — the same reason the SPA syncs <html lang>.
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeHtml(title)}</title></head>`,
    `<body style="margin:0;padding:0;background:${PAGE};-webkit-font-smoothing:antialiased">`,
    `<table ${TABLE} width="100%" style="width:100%;background:${PAGE}">`,
    `<tr><td align="center" style="padding:36px 16px 56px;font-family:${SANS}">`,
    preheader(preview),
    // The sheet table's own background is the PAGE colour, not white: every row
    // sets its own bgcolor, and the ink bands round one corner each (0 32px 0 0
    // at the top, 0 0 32px 0 at the foot). A white table under them would show
    // through those curves as a hard notch.
    `<table ${TABLE} width="600" style="width:600px;max-width:600px;background:${PAGE}">`,
    rows,
    '</table></td></tr></table></body></html>',
  ].join('');
}

// A bare notice: header band, the one-sentence body, a way in, the standing
// policy, the footer. Same shell for all twelve non-welcome purposes.
function renderNoticeHtml(
  purpose: NotificationPurpose,
  heading: string,
  body: string,
  locale: Locale,
  shell: ShellStrings | undefined,
): string {
  const rows = [
    headerBand(shell?.headerLabel[purpose] ?? HEADER_LABEL[purpose], '22px 40px') + '</td></tr>',
    `<tr><td bgcolor="${SHEET}" style="background:${SHEET};padding:34px 40px 30px;border-left:1px solid ${HAIRLINE};border-right:1px solid ${HAIRLINE}">`,
    `<h1 style="margin:0 0 14px;font-family:${DISPLAY};font-size:23px;line-height:1.28;letter-spacing:-0.012em;font-weight:600;color:${INK}">${escapeHtml(heading)}</h1>`,
    `<p style="margin:0 0 26px;font-size:16px;line-height:1.62;color:${TEXT}">${escapeHtml(body)}</p>`,
    cta(shell?.ctaOpen ?? 'Open Truecairn', '/home'),
    '</td></tr>',
    reassuranceBand([reassurance(purpose, shell)]),
    footerBand(shell),
  ].join('');
  return emailDocument(heading, body, rows, locale);
}

// Welcome — the one rich body. The ink header extends into a hero (eyebrow,
// headline, lede) and the sheet carries the three numbered setup steps, so the
// first email someone gets from us also teaches the shape of the product.
function renderWelcomeHtml(locale: Locale, shell: ShellStrings | undefined): string {
  const w = shell?.welcome;
  const step = (n: string, title: string, detail: string, last: boolean): string => {
    const pad = last ? '4px' : '20px';
    return (
      '<tr>' +
      `<td width="34" valign="top" style="width:34px;vertical-align:top;font-family:${MONO};font-size:13px;color:${ACCENT};padding:2px 0 ${pad}">${n}</td>` +
      `<td valign="top" style="vertical-align:top;padding:0 0 ${pad}">` +
      `<div style="font-family:${DISPLAY};font-size:16px;font-weight:600;color:${INK};letter-spacing:-0.01em">${title}</div>` +
      `<div style="font-size:14.5px;line-height:1.6;color:${TEXT};padding-top:5px">${detail}</div>` +
      '</td></tr>'
    );
  };

  const rows = [
    // Hero: the header band, then the welcome headline in the same ink block.
    headerBand(shell?.headerLabel.welcome ?? 'welcome', '30px 40px 38px'),
    `<div style="font-size:13px;font-weight:600;letter-spacing:0.02em;color:${ON_INK_ACCENT};padding:40px 0 12px">${w?.eyebrow ?? 'welcome to Truecairn'}</div>`,
    `<h1 style="margin:0;font-family:${DISPLAY};font-size:31px;line-height:1.2;letter-spacing:-0.015em;font-weight:600;color:#ffffff">${w?.headline ?? 'Your email is confirmed.'}</h1>`,
    `<p style="margin:18px 0 0;font-size:16.5px;line-height:1.55;color:${ON_INK_TEXT}">${w?.lede ?? 'This address will now receive your check-in reminders and account notices. Nothing else is armed yet — that part is up to you.'}</p>`,
    '</td></tr>',

    // Sheet: what this is, then the three steps.
    `<tr><td bgcolor="${SHEET}" style="background:${SHEET};padding:36px 40px 8px;border-left:1px solid ${HAIRLINE};border-right:1px solid ${HAIRLINE}">`,
    // Mirrors the plain-text body above — see the correction note there. The two
    // are maintained separately, so a wording fix in one is only half a fix.
    `<p style="${P}">${w?.intro ?? 'Truecairn keeps an encrypted vault that reaches the people you choose — only if you go silent. Encryption happens on your device with your master passphrase. You hold the keys; we never see them, and we cannot reset them.'}</p>`,
    `<table ${TABLE} width="100%" style="width:100%">`,
    `<tr><td style="padding:10px 0 20px;font-family:${MONO};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${ACCENT};border-bottom:1px solid #eceefa">${w?.stepsLabel ?? 'to finish setting up'}</td></tr>`,
    '<tr><td style="padding:20px 0 0">',
    `<table ${TABLE} width="100%" style="width:100%">`,
    ...(
      w?.steps ?? [
        [
          'Add a trusted contact',
          "Anyone with an email address. They don't need an account to start — just your signed invite link.",
        ],
        [
          'Put something in your vault',
          'Start from a template: business handover, crypto recovery, family essentials.',
        ],
        [
          'Arm your continuity engine',
          'Pick a trigger and a cooldown between 7 and 90 days. Nothing watches you until you arm it.',
        ],
      ]
    ).map(([title, detail], i, all) =>
      step(String(i + 1).padStart(2, '0'), title, detail, i === all.length - 1),
    ),
    '</table></td></tr></table></td></tr>',

    // Sheet: the way in, plus the one-line architecture claim.
    `<tr><td bgcolor="${SHEET}" style="background:${SHEET};padding:26px 40px 34px;border-left:1px solid ${HAIRLINE};border-right:1px solid ${HAIRLINE}">`,
    cta(shell?.ctaFinishSetup ?? 'Finish setup', '/home'),
    `<div style="font-family:${MONO};font-size:11.5px;line-height:1.7;color:${MUTED};padding-top:22px">${w?.primitives ?? 'End-to-end encrypted &middot; XChaCha20-Poly1305 &middot; zero-knowledge by architecture'}</div>`,
    '</td></tr>',

    reassuranceBand(
      w?.reassurance ?? [
        'There is no rush. Any choice you make can be undone — every release runs through a 48-hour revocation window, and every sensitive change waits 7 days before it takes effect.',
        'We will never ask for your release passphrase — not by email, not by phone. If a message ever does, it is not from us.',
      ],
    ),
    footerBand(shell),
  ].join('');

  return emailDocument(
    templateFor('welcome', locale).subject,
    w?.preview ??
      'Your email is confirmed. Three things left to set up — a trusted contact, a vault item, and your continuity engine.',
    rows,
    locale,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
