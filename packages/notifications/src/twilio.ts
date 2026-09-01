// Twilio error codes worth naming, with OUR OWN descriptions. Deliberately not
// the provider's message: see the throw site for why (invariant 1).
//
// These four are the whole operator-facing surface today. Each needs a different
// action, and before 2026-08-31 all four were indistinguishable:
//   21408 — enable the destination country in messaging geo permissions
//   30034 — register the US A2P 10DLC brand (gates US-bound traffic only)
//   21211 — reject the number earlier, at enrolment
//   21610 — recipient sent STOP; never retry, and the channel is effectively dead
const TWILIO_ERROR_CODES: Record<number, { detail: string; retryable: boolean }> = {
  21408: { detail: 'destination country not enabled in geo permissions', retryable: false },
  30034: { detail: 'US A2P 10DLC brand not registered', retryable: false },
  21211: { detail: 'invalid destination number', retryable: false },
  21610: { detail: 'recipient opted out (STOP)', retryable: false },
};

import { ProviderError, type NotificationProvider, type SendInput, type SendResult } from './types.js';
import {
  WHATSAPP_TEMPLATES,
  whatsappTemplateKeyFor,
  type WhatsappTemplateSids,
} from './whatsapp-templates.js';

// Twilio Messages adapter. **In production this carries SMS only.**
//
// The 'whatsapp' branch below is MOTHBALLED, kept deliberately: WhatsApp moved
// to Meta's Cloud API directly (see whatsapp-cloud.ts) because SMS and WhatsApp
// sharing one vendor made docs/04 §4.4 — "any single channel can fail… we never
// depend on one channel" — false by correlated failure. Nothing constructs this
// class for 'whatsapp' any more; the code and its tests stay so the move is
// reversible without archaeology. **Do not re-wire it without reading docs/04
// §4.4 first: putting both channels back behind one vendor is a threat-model
// change, not a simplification.**
//
// Both channel types POST the same Messages resource with the same basic auth;
// what differs is the payload, and the difference is not cosmetic:
//
//   - SMS carries our text directly, in `Body`.
//   - WhatsApp carries a REFERENCE to a Meta-approved template, in `ContentSid`
//     + `ContentVariables`. Every send of ours is business-initiated (the
//     recipient has not messaged us), so free-form `Body` is only accepted
//     inside a 24h customer-service window or the sandbox. Outside those, Twilio
//     still returns 201 with a SID and Meta silently drops the message. That is
//     why the WhatsApp path never sets `Body` and never falls back to it: a
//     delivery row reading `sent` for a message that never arrived is the one
//     failure this product cannot afford (docs/11 threat 5.3).
//
// Follows the CV adapter contract (docs/cv-adapter-contract.md): injectable
// fetch, 10s timeout, retryable classification, providerMessageId (the Twilio
// SID) for status-callback correlation.
//
// One honest caveat, by provider design: Twilio's Messages API has NO
// idempotency key, so a crash between send and record re-sends on reclaim (the
// delivery row's stuck-'sending' path). Bounded and rare; the bare templates
// make a duplicate harmless.
export class TwilioMessagingAdapter implements NotificationProvider {
  readonly channelType: 'sms' | 'whatsapp';
  readonly name: string;

  constructor(
    private readonly opts: {
      channelType: 'sms' | 'whatsapp';
      accountSid: string;
      authToken: string;
      from: string;
      // Our /v1/notifications/webhook/twilio URL — Twilio posts per-message
      // status callbacks (delivered/undelivered/failed) here when set.
      statusCallbackUrl?: string;
      // Mothballed WhatsApp branch only: the approved template SID per template
      // key. No env supplies this any more (the TWILIO_WHATSAPP_TEMPLATE_* vars
      // were removed with the move to the Cloud API, where template identity is
      // a name we own rather than a per-account id). Absent or partial remains a
      // supported state — the messages it does not cover fail closed below
      // instead of degrading to an undeliverable Body.
      //
      // REVERSIBILITY CAVEAT, recorded rather than fixed: this branch predates
      // channel_verification moving to Meta's AUTHENTICATION category (docs/26).
      // The Cloud API expresses that as an extra button component; Twilio's
      // Content API models authentication templates as their own content type,
      // not as ContentVariables on a text template. So reinstating THIS path for
      // WhatsApp would need that one purpose re-solved — the other eight are
      // unaffected. Left alone because nothing constructs this adapter for
      // whatsapp, and guessing at a vendor shape we cannot currently test would
      // be worse than naming the gap.
      whatsappTemplateSids?: WhatsappTemplateSids;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.channelType = opts.channelType;
    this.name = opts.channelType === 'sms' ? 'twilio-sms' : 'twilio-whatsapp';
  }

  async send(input: SendInput): Promise<SendResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    // Built before the request so a WhatsApp send with no usable template throws
    // without touching the network — nothing is sent, nothing is charged, and
    // the dead-letter names the missing config.
    const form =
      this.channelType === 'whatsapp' ? this.whatsappForm(input) : this.smsForm(input);

    let res: Response;
    try {
      res = await doFetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization:
              'Basic ' +
              Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`, 'utf8').toString(
                'base64',
              ),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (err) {
      throw new ProviderError(
        `${this.name} transport error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { sid?: string };
      return { providerMessageId: data.sid ?? input.idempotencyKey };
    }
    // 5xx / 429 transient; other 4xx (bad number, unverified sender) permanent.
    //
    // The numeric code is the entire diagnostic surface for this subsystem, and
    // without it every failure below looks identical to an operator: a geo
    // permission gap, an unregistered US brand, a malformed number and an opted
    // out recipient all read "provider returned 400" and all need different
    // action. Carried structurally on the error and prefixed onto the message.
    //
    // ONLY the code. Twilio's own `message` field embeds the destination phone
    // number ("...the region indicated by the 'To' number: +216..."), and this
    // string is persisted to notification_deliveries.last_error AND logged. So
    // it is paired with OUR static description and the provider's prose is
    // dropped on the floor — the same rule the WhatsApp branch below already
    // follows: never a variable value (invariant 1).
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'number' ? body.code : undefined;
    const known = code === undefined ? undefined : TWILIO_ERROR_CODES[code];
    throw new ProviderError(
      code === undefined
        ? `${this.name} provider returned ${res.status}`
        : `${this.name} provider returned ${res.status} (code ${code}${known === undefined ? '' : `: ${known.detail}`})`,
      // A code we recognise is authoritative about retryability; anything else
      // falls back to the status, so an unknown code cannot accidentally become
      // permanent and silently stop retrying a transient fault.
      known?.retryable ?? (res.status >= 500 || res.status === 429),
      code,
    );
  }

  private smsForm(input: SendInput): URLSearchParams {
    const form = new URLSearchParams();
    form.set('To', input.destination);
    form.set('From', this.opts.from);
    // SMS carries no subject line — the body alone must say enough to act,
    // which the bare templates already guarantee.
    form.set('Body', input.body);
    this.setStatusCallback(form);
    return form;
  }

  private whatsappForm(input: SendInput): URLSearchParams {
    const form = new URLSearchParams();
    form.set('To', `whatsapp:${input.destination}`);
    form.set('From', `whatsapp:${this.opts.from}`);
    const { sid, variables } = this.resolveTemplate(input);
    // NO `Body`. Twilio ignores it whenever ContentSid is present, so sending
    // both would only make the code look safer than it is.
    form.set('ContentSid', sid);
    if (Object.keys(variables).length > 0) {
      form.set('ContentVariables', JSON.stringify(variables));
    }
    this.setStatusCallback(form);
    return form;
  }

  private setStatusCallback(form: URLSearchParams): void {
    if (this.opts.statusCallbackUrl !== undefined) {
      form.set('StatusCallback', this.opts.statusCallbackUrl);
    }
  }

  // Fail-closed template resolution. Every rejection here is PERMANENT: each one
  // is a configuration or mapping fault that no amount of backoff repairs, so
  // burning the retry ladder would only delay the dead-letter that tells an
  // operator what to fix. The delivery lands in `failed`, which is what the
  // Continuity Report and /status already read as "did not arrive".
  //
  // Error messages carry the purpose and the template key — both enums, both
  // already on the delivery row — and NEVER a variable value. `lastError` is
  // persisted and logged, and one of these variables is a verification code.
  private resolveTemplate(input: SendInput): {
    sid: string;
    variables: Readonly<Record<string, string>>;
  } {
    const key = whatsappTemplateKeyFor(input.purpose);
    if (key === null) {
      throw new ProviderError(
        `${this.name} has no WhatsApp template for purpose '${input.purpose}' — this notice is not deliverable on WhatsApp`,
        false,
      );
    }
    const sid = this.opts.whatsappTemplateSids?.[key];
    if (sid === undefined || sid === '') {
      throw new ProviderError(
        `${this.name} template '${key}' (purpose '${input.purpose}') has no approved ContentSid configured`,
        false,
      );
    }

    const template = WHATSAPP_TEMPLATES[key];
    const variables = input.templateVariables ?? {};
    // Arity + shape check against what Meta approved. A template expecting
    // {{1}} sent with nothing to substitute is rejected by Meta after Twilio
    // has already accepted it — the exact silent drop this module exists to
    // prevent — so it is caught here instead. The one real path to it: a
    // channel_verification retry whose payload params were already cleared.
    for (let i = 1; i <= template.variables; i += 1) {
      const value = variables[String(i)];
      if (value === undefined || value === '') {
        throw new ProviderError(
          `${this.name} template '${key}' expects ${template.variables} variable(s); variable ${i} is missing`,
          false,
        );
      }
      // Meta rejects newlines, tabs, and runs of 4+ spaces inside a variable.
      if (/[\n\r\t]|\s{4,}/.test(value)) {
        throw new ProviderError(
          `${this.name} template '${key}' variable ${i} contains whitespace WhatsApp rejects`,
          false,
        );
      }
    }
    if (Object.keys(variables).length !== template.variables) {
      throw new ProviderError(
        `${this.name} template '${key}' expects exactly ${template.variables} variable(s), got ${Object.keys(variables).length}`,
        false,
      );
    }
    return { sid, variables };
  }
}
