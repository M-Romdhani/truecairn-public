import { ProviderError, type NotificationProvider, type SendInput, type SendResult } from './types.js';
import {
  WHATSAPP_TEMPLATES,
  WHATSAPP_TEMPLATE_LANGUAGE,
  whatsappTemplateKeyFor,
  type WhatsappTemplate,
} from './whatsapp-templates.js';

// WhatsApp via Meta's Cloud API, DIRECTLY — not through Twilio.
//
// WHY THIS IS NOT A VENDOR PREFERENCE. docs/04 §4.4: "Any single channel can
// fail or be intercepted. We never depend on one channel." Sending SMS and
// WhatsApp through one vendor made that assumption false in the only way that
// matters — correlated failure. Two channel types sharing one account, one
// credential pair, one API host and one webhook signing scheme are one channel
// wearing two names: a Twilio outage, a suspended account or a leaked auth token
// took both at once, in precisely the situation the second channel exists for.
// Going direct to Meta restores independence at every layer that can fail
// together. Preserving that separation is the point of this adapter; a future
// "simplification" that routes both through one vendor again re-opens the gap.
//
// Cloud API differs from the Twilio transport in shape as well as origin:
// JSON rather than form-encoded, a phone-number id in the path rather than an
// account SID, a bearer token rather than basic auth, `to` WITHOUT the leading
// `+`, template identity by NAME (which we own) rather than a per-account SID,
// and a `wamid…` message id for status correlation.
//
// Follows the CV adapter contract (docs/cv-adapter-contract.md): injectable
// fetch, 10s timeout, retryable classification, providerMessageId.
//
// Two honest caveats:
//   - No idempotency key exists here either, so a crash between send and record
//     re-sends on reclaim (the delivery row's stuck-'sending' path). Bounded and
//     rare; the bare templates make a duplicate harmless.
//   - Status callbacks are configured app-side in the Meta dashboard, not
//     per-message as Twilio's StatusCallback was. There is nothing to send here;
//     the webhook URL is registered once with the app (docs/21).
const DEFAULT_GRAPH_VERSION = 'v21.0';

export class WhatsappCloudAdapter implements NotificationProvider {
  readonly channelType = 'whatsapp' as const;
  readonly name = 'whatsapp-cloud';

  constructor(
    private readonly opts: {
      // The Cloud API phone-number id (a numeric id from the WhatsApp Manager,
      // NOT the phone number itself).
      phoneNumberId: string;
      // A System User PERMANENT token. A token generated in the app dashboard
      // expires in 24h, and the expiry surfaces as a 401 on the next send —
      // which, for a product that notifies people at the moment they stop
      // responding, means the channel dies silently overnight (docs/21).
      accessToken: string;
      graphVersion?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    // Built before the request so a send with no usable template throws without
    // touching the network — nothing sent, nothing charged, and the dead-letter
    // names the missing template. The Cloud API does reject an unknown template
    // name rather than dropping it silently, but that is the provider's
    // behaviour to change; the pre-flight check is OUR guarantee.
    const payload = this.buildPayload(input);
    const version = this.opts.graphVersion ?? DEFAULT_GRAPH_VERSION;

    let res: Response;
    try {
      res = await doFetch(
        `https://graph.facebook.com/${version}/${this.opts.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.opts.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
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
      const data = (await res.json().catch(() => ({}))) as {
        messages?: { id?: string }[];
      };
      // The wamid the status webhook correlates on. Falling back to the
      // delivery-row id keeps the row unique if Meta ever answers 200 with an
      // unexpected shape — it simply never correlates, which reads as
      // indeterminate rather than delivered.
      const wamid = data.messages?.[0]?.id;
      return { providerMessageId: wamid ?? input.idempotencyKey };
    }
    // 5xx / 429 transient; other 4xx permanent (bad number, unknown template,
    // and — the one worth naming — 401 from an expired non-permanent token).
    throw new ProviderError(
      `${this.name} provider returned ${res.status}`,
      res.status >= 500 || res.status === 429,
    );
  }

  // The Cloud API message body. `to` is E.164 with the leading `+` stripped:
  // our channels store `+E.164` (normalizeDestination), Meta wants the digits.
  private buildPayload(input: SendInput): Record<string, unknown> {
    const { template, variables } = this.resolveTemplate(input);
    const bodyParameters = Array.from({ length: template.variables }, (_, i) => ({
      type: 'text',
      text: variables[String(i + 1)]!,
    }));
    const components: Record<string, unknown>[] =
      bodyParameters.length > 0 ? [{ type: 'body', parameters: bodyParameters }] : [];
    // An AUTHENTICATION template carries a second component the others must not:
    // the copy-code button, whose parameter REPEATS the same code already in the
    // body. Meta rejects an authentication send that omits it, so the shape is
    // load-bearing rather than decorative:
    //
    //   {"type":"button","sub_type":"url","index":"0",
    //    "parameters":[{"type":"text","text":"<CODE>"}]}
    //
    // Two details that are easy to get wrong and expensive to debug, because the
    // failure is a 400 at send time rather than at approval:
    //   - `sub_type` is "url", NOT "copy_code". `copy_code` belongs to MARKETING
    //     coupon templates — a different feature that happens to render a similar
    //     button — and using it here is rejected.
    //   - `index` is the STRING "0", matching Meta's documented example. Their API
    //     also tolerates the number, but there is no reason to differ from the doc.
    //
    // Guarded on `variables > 0` as well as the category so a future
    // authentication template with no code cannot emit a parameterless button.
    if (template.category === 'authentication' && bodyParameters.length > 0) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: variables['1']! }],
      });
    }
    return {
      messaging_product: 'whatsapp',
      to: input.destination.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: template.name,
        language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
        // Omitted entirely for a static template — an empty `components` array
        // is not the same thing to Meta as no components.
        ...(components.length > 0 ? { components } : {}),
      },
    };
  }

  // Fail-closed template resolution — the invariant carried over from the
  // Twilio adapter unchanged, because it never depended on the vendor. Every
  // rejection is PERMANENT: each is a configuration or mapping fault that no
  // backoff repairs, so burning the retry ladder would only delay the
  // dead-letter that tells an operator what to fix. The delivery lands in
  // `failed`, which the Continuity Report and /status already read as "did not
  // arrive".
  //
  // Error messages carry the purpose and the template key — both enums, both
  // already on the delivery row — and NEVER a variable value. `lastError` is
  // persisted and logged, and one of these variables is a verification code.
  private resolveTemplate(input: SendInput): {
    template: WhatsappTemplate;
    variables: Readonly<Record<string, string>>;
  } {
    const key = whatsappTemplateKeyFor(input.purpose);
    if (key === null) {
      throw new ProviderError(
        `${this.name} has no WhatsApp template for purpose '${input.purpose}' — this notice is not deliverable on WhatsApp`,
        false,
      );
    }
    const template = WHATSAPP_TEMPLATES[key];
    if (template.name === '') {
      throw new ProviderError(
        `${this.name} template '${key}' (purpose '${input.purpose}') has no approved template name`,
        false,
      );
    }

    const variables = input.templateVariables ?? {};
    // Arity + shape check against what Meta approved. A template expecting
    // {{1}} sent with nothing to substitute is rejected at Meta, so it is
    // caught here instead. The one real path to it: a channel_verification
    // retry whose payload params were already cleared.
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
    return { template, variables };
  }
}
