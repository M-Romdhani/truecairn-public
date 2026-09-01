import webpush from 'web-push';
import { ProviderError, type NotificationProvider, type SendInput, type SendResult } from './types.js';

// Web Push adapter (VAPID). The channel's `destination` is the browser's
// PushSubscription serialized as JSON (endpoint + p256dh/auth keys) — captured
// by the SPA's service-worker enrolment flow. Payloads are encrypted to the
// subscription keys by the web-push library (RFC 8291), so the push service
// relays ciphertext it cannot read — consistent with the bare-template rule
// on top: even the plaintext carries no vault content.
//
// Push has no async delivered/bounced callback: a 201 from the push service
// proves acceptance, not display. Deliveries therefore stay at 'sent'
// (indeterminate in the Continuity Report — honest, never inflated to
// 'delivered'). A 404/410 means the subscription is gone: permanent failure,
// the channel degrades and the owner re-enrols the device.

type SendImpl = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<webpush.SendResult>;

export class WebPushAdapter implements NotificationProvider {
  readonly channelType = 'push' as const;
  readonly name = 'web-push';

  constructor(
    private readonly vapid: { publicKey: string; privateKey: string; subject: string },
    // Injectable for tests (web-push owns its own HTTP stack, so the seam is
    // the library call, not fetch).
    private readonly sendImpl: SendImpl = (s, p, o) => webpush.sendNotification(s, p, o),
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    let subscription: webpush.PushSubscription;
    try {
      subscription = JSON.parse(input.destination) as webpush.PushSubscription;
    } catch {
      throw new ProviderError('web-push: destination is not a valid subscription', false);
    }
    try {
      await this.sendImpl(
        subscription,
        JSON.stringify({ title: input.subject, body: input.body }),
        {
          TTL: 24 * 60 * 60,
          vapidDetails: {
            subject: this.vapid.subject,
            publicKey: this.vapid.publicKey,
            privateKey: this.vapid.privateKey,
          },
        },
      );
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        throw new ProviderError('web-push: subscription expired or unsubscribed', false);
      }
      const retryable = status === undefined || status === 429 || status >= 500;
      throw new ProviderError(
        `web-push error${status !== undefined ? ` ${status}` : ''}: ${err instanceof Error ? err.message : String(err)}`,
        retryable,
      );
    }
    // No provider message id exists for push; the delivery-row id keeps the
    // record correlatable and unique.
    return { providerMessageId: `push-${input.idempotencyKey}` };
  }
}
