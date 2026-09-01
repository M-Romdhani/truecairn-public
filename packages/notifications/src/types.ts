import type { NotificationChannelType, NotificationPurpose } from '@truecairn/shared';

// What a provider adapter is handed for one send. idempotencyKey is the delivery
// row id (stable across retries) so a crash-retry can't double-send (PHASE3_5 §d).
export interface SendInput {
  destination: string;
  subject: string;
  body: string;
  // Optional branded HTML alternative (email only). SMS/WhatsApp/push adapters
  // ignore it and send `body`. Content is identical to `body` for the bare
  // continuity notices — the HTML only adds the visual shell (CV-brand pass).
  html?: string;
  // Which notice this is. Adapters that transmit our own text ignore it; the
  // WhatsApp adapter needs it because WhatsApp does not carry our text at all —
  // it carries a reference to a Meta-approved template, and the purpose is what
  // selects one (CV-3, whatsapp-templates.ts). REQUIRED rather than optional on
  // purpose: an adapter that cannot tell which message it is holding can only
  // guess, and the failure mode of guessing here is a send that reports success
  // and never arrives.
  purpose: NotificationPurpose;
  // Positional variables for a template-based transport, straight from
  // `renderTemplate` (see RenderedTemplate.variables). Same content as `body`.
  templateVariables?: Readonly<Record<string, string>>;
  idempotencyKey: string;
}

export interface SendResult {
  providerMessageId: string;
}

// One channel type's transport. The delivery processor calls send() and never
// constructs the body — content discipline lives in templates.ts.
export interface NotificationProvider {
  readonly channelType: NotificationChannelType;
  readonly name: string;
  send(input: SendInput): Promise<SendResult>;
}

// Adapters throw this. `retryable` distinguishes a transient failure (backoff +
// retry — 5xx, timeout) from a permanent one (dead-letter now — bad address, 4xx).
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    // The provider's own numeric error code, when it gives one. Structured so a
    // caller can branch on it without parsing prose. NOTE the deliberate
    // asymmetry: the CODE travels, the provider's MESSAGE never does — Twilio's
    // embeds the destination phone number, and `message` here is persisted to
    // notification_deliveries.last_error and logged (invariant 1).
    readonly code?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
