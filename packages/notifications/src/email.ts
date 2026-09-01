import { ProviderError, type NotificationProvider, type SendInput, type SendResult } from './types.js';

// Real transactional-email adapter (Resend-shaped). The worker constructs it from
// RESEND_API_KEY + NOTIFICATIONS_FROM. The delivery id rides as the Idempotency-Key
// so a crash-retry is deduped provider-side and never double-sends (PHASE3_5 §d).
// fetchImpl is injectable for tests; a 10s timeout keeps a hung provider from
// stalling the worker.
export class ResendEmailAdapter implements NotificationProvider {
  readonly channelType = 'email' as const;
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
        },
        // `text` always rides along (deliverability + accessibility + a fallback
        // for clients that won't render HTML); `html` is the branded shell when
        // the template produced one. No open/click tracking is requested — we
        // never phone home on a read (docs/26 D2).
        body: JSON.stringify({
          from: this.from,
          to: input.destination,
          subject: input.subject,
          text: input.body,
          ...(input.html !== undefined ? { html: input.html } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Transport error / timeout — transient, retry.
      throw new ProviderError(
        `email transport error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: data.id ?? input.idempotencyKey };
    }
    // 5xx / 429 are transient; 4xx (bad address, rejected) is permanent.
    throw new ProviderError(`email provider returned ${res.status}`, res.status >= 500 || res.status === 429);
  }
}
