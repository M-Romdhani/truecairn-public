import { describe, expect, it, vi } from 'vitest';
import { TwilioMessagingAdapter } from './twilio.js';
import { WhatsappCloudAdapter } from './whatsapp-cloud.js';
import { WebPushAdapter } from './push.js';
import { ProviderError } from './types.js';
import { WHATSAPP_TEMPLATE_KEYS, type WhatsappTemplateSids } from './whatsapp-templates.js';

// Adapter-contract unit tests (docs/cv-adapter-contract.md): transport
// mapping, retryable classification, and channel-type addressing — all
// through the injectable seams (fetch for Twilio and Meta, the library call
// for push).
//
// Note the vendor split under test: Twilio carries SMS, Meta's Cloud API
// carries WhatsApp. That is the docs/04 §4.4 independence property, and the
// suite exercises the two through separate adapters against separate hosts.
// TwilioMessagingAdapter's WhatsApp branch is kept and still tested — the move
// is reversible — but the worker no longer constructs it.

const okResponse = (body: unknown, status = 201): Response =>
  new Response(JSON.stringify(body), { status });

// Every template "approved" — the configured-happy-path fixture.
const ALL_TEMPLATE_SIDS: WhatsappTemplateSids = Object.fromEntries(
  WHATSAPP_TEMPLATE_KEYS.map((k) => [k, `HX_${k}`]),
) as WhatsappTemplateSids;

describe('TwilioMessagingAdapter', () => {
  const make = (
    channelType: 'sms' | 'whatsapp',
    fetchImpl: typeof fetch,
    whatsappTemplateSids: WhatsappTemplateSids = ALL_TEMPLATE_SIDS,
  ) =>
    new TwilioMessagingAdapter({
      channelType,
      accountSid: 'ACxxx',
      authToken: 'token',
      from: '+15550001111',
      statusCallbackUrl: 'https://api.example.com/v1/notifications/webhook/twilio',
      whatsappTemplateSids,
      fetchImpl,
    });
  const input = {
    destination: '+15552223333',
    subject: 'Confirm you are active',
    body: 'This is a Truecairn account status notification. Open the app to confirm you are active.',
    purpose: 'check_in_request' as const,
    idempotencyKey: 'delivery-1',
  };

  it('sends an SMS via the Messages API with basic auth and returns the SID', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json');
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe(
        'Basic ' + Buffer.from('ACxxx:token', 'utf8').toString('base64'),
      );
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('To')).toBe('+15552223333');
      expect(form.get('From')).toBe('+15550001111');
      expect(form.get('Body')).toBe(input.body); // body only — SMS has no subject line
      expect(form.get('StatusCallback')).toBe(
        'https://api.example.com/v1/notifications/webhook/twilio',
      );
      return okResponse({ sid: 'SM123' });
    }) as unknown as typeof fetch;
    const result = await make('sms', fetchImpl).send(input);
    expect(result.providerMessageId).toBe('SM123');
  });

  it('sends the SMS form byte-for-byte as it always has', async () => {
    // The CV-3 template pass changed only the WhatsApp branch. This pins the
    // encoded SMS request exactly — field set, order, and encoding — so a later
    // refactor of the shared send path cannot quietly reshape SMS.
    let sent = '';
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = String(init?.body);
      return okResponse({ sid: 'SM123' });
    }) as unknown as typeof fetch;
    await make('sms', fetchImpl).send(input);
    expect(sent).toBe(
      'To=%2B15552223333&From=%2B15550001111' +
        '&Body=This+is+a+Truecairn+account+status+notification.+Open+the+app+to+confirm+you+are+active.' +
        '&StatusCallback=https%3A%2F%2Fapi.example.com%2Fv1%2Fnotifications%2Fwebhook%2Ftwilio',
    );
  });

  it('sends WhatsApp as an approved template — ContentSid, never Body', async () => {
    // The whole point of CV-3's template pass: a business-initiated WhatsApp
    // send that carries `Body` is accepted by Twilio, dropped by Meta, and
    // reported to us as success. So `Body` must be absent, not merely ignored.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('To')).toBe('whatsapp:+15552223333');
      expect(form.get('From')).toBe('whatsapp:+15550001111');
      expect(form.get('ContentSid')).toBe('HX_check_in');
      expect(form.has('Body')).toBe(false);
      // A static template has nothing to substitute — no empty JSON object.
      expect(form.has('ContentVariables')).toBe(false);
      expect(form.get('StatusCallback')).toBe(
        'https://api.example.com/v1/notifications/webhook/twilio',
      );
      return okResponse({ sid: 'SM456' });
    }) as unknown as typeof fetch;
    const adapter = make('whatsapp', fetchImpl);
    expect(adapter.channelType).toBe('whatsapp');
    // The Twilio SID still comes back as providerMessageId — the status webhook
    // correlates on it exactly as it does for SMS (docs/cv-adapter-contract §4).
    expect((await adapter.send(input)).providerMessageId).toBe('SM456');
  });

  it('passes the verification code as a positional ContentVariable', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('ContentSid')).toBe('HX_channel_verification');
      expect(form.get('ContentVariables')).toBe('{"1":"424242"}');
      expect(form.has('Body')).toBe(false);
      return okResponse({ sid: 'SM789' });
    }) as unknown as typeof fetch;
    await make('whatsapp', fetchImpl).send({
      ...input,
      purpose: 'channel_verification',
      body: 'Your Truecairn channel verification code is 424242. Enter it in the app to confirm this channel.',
      templateVariables: { '1': '424242' },
    });
  });

  it('fails closed when a WhatsApp notice has no approved template', async () => {
    // Three ways to arrive with nothing to send, all of which must dead-letter
    // honestly rather than degrade to a Body that Meta will drop. None of them
    // may reach the network: a send that never happens is the safe outcome.
    const cases: readonly [string, Parameters<TwilioMessagingAdapter['send']>[0], WhatsappTemplateSids][] = [
      // 1. Meta has not approved this one yet (SID unconfigured).
      ['unconfigured SID', input, {}],
      // 2. A purpose deliberately mapped to no template at all.
      ['purpose with no template', { ...input, purpose: 'welcome' }, ALL_TEMPLATE_SIDS],
      // 3. A 1-variable template with nothing to substitute at {{1}} — the
      //    channel_verification retry whose payload params were cleared, or a
      //    variable map that does not line up with what Meta approved. Meta
      //    rejects the send AFTER Twilio has accepted it, so we reject first.
      [
        'template variable missing',
        { ...input, purpose: 'channel_verification', templateVariables: { '2': '424242' } },
        ALL_TEMPLATE_SIDS,
      ],
    ];
    for (const [label, sendInput, sids] of cases) {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const adapter = make('whatsapp', fetchImpl, sids);
      const err = await adapter.send(sendInput).catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(ProviderError);
      // Permanent: no backoff repairs missing configuration, and the dead-letter
      // is the signal an operator needs.
      expect(err, label).toMatchObject({ retryable: false });
      // Never leaks the variable value — lastError is persisted and logged, and
      // one of these variables is a verification code.
      expect((err as ProviderError).message, label).not.toContain('424242');
      expect(fetchImpl, label).not.toHaveBeenCalled();
    }
  });

  it('classifies 5xx/429 as retryable and other 4xx as permanent', async () => {
    const status = (code: number) =>
      make('sms', vi.fn(async () => new Response('{}', { status: code })) as unknown as typeof fetch);
    await expect(status(500).send(input)).rejects.toMatchObject({ retryable: true });
    await expect(status(429).send(input)).rejects.toMatchObject({ retryable: true });
    await expect(status(400).send(input)).rejects.toMatchObject({ retryable: false });
    // Transport failure (timeout, DNS) is transient.
    const broken = make('sms', vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch);
    await expect(broken.send(input)).rejects.toMatchObject({ retryable: true });
  });
});

describe('WhatsappCloudAdapter', () => {
  const make = (fetchImpl: typeof fetch) =>
    new WhatsappCloudAdapter({
      phoneNumberId: '1234567890',
      accessToken: 'system-user-token',
      fetchImpl,
    });
  const input = {
    destination: '+15552223333',
    subject: 'Confirm you are active',
    body: 'This is a Truecairn account status notification. Open the app to confirm you are active.',
    purpose: 'check_in_request' as const,
    idempotencyKey: 'delivery-1',
  };

  it('posts the template message to graph.facebook.com with a bearer token', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      // A DIFFERENT host from Twilio's — the whole point of the move: SMS and
      // WhatsApp no longer share a vendor, so one outage cannot take both
      // (docs/04 §4.4).
      expect(String(url)).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer system-user-token');
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({
        messaging_product: 'whatsapp',
        // E.164 with the leading + stripped — Meta wants bare digits.
        to: '15552223333',
        type: 'template',
        template: {
          name: 'truecairn_check_in',
          language: { code: 'en' },
          // No `components` key at all for a static template: an empty array is
          // not the same thing to Meta as its absence.
        },
      });
      return okResponse({ messages: [{ id: 'wamid.HBgLMTU1NTIyMjMzMzM=' }] }, 200);
    }) as unknown as typeof fetch;
    const adapter = make(fetchImpl);
    expect(adapter.channelType).toBe('whatsapp');
    // The wamid is what the Meta status webhook correlates on.
    expect((await adapter.send(input)).providerMessageId).toBe('wamid.HBgLMTU1NTIyMjMzMzM=');
  });

  it('sends the authentication template with its copy-code button component', async () => {
    // channel_verification is registered under Meta's AUTHENTICATION category
    // (docs/26), which changes the WIRE FORMAT, not just the approved copy: the
    // send must carry a button component whose parameter REPEATS the code already
    // in the body, and Meta rejects the send outright without it.
    //
    // Two details worth pinning rather than trusting, because both fail as a 400
    // at send time — long after approval, on the path that gates all WhatsApp
    // enrolment:
    //   - sub_type is 'url', NOT 'copy_code'. `copy_code` is the MARKETING
    //     coupon-template feature; it renders a similar button and is rejected here.
    //   - index is the string '0', matching Meta's documented example.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        template: { name: string; components?: unknown };
      };
      expect(body.template.name).toBe('truecairn_channel_verification');
      expect(body.template.components).toEqual([
        { type: 'body', parameters: [{ type: 'text', text: '424242' }] },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: '424242' }],
        },
      ]);
      return okResponse({ messages: [{ id: 'wamid.CODE' }] }, 200);
    }) as unknown as typeof fetch;
    await make(fetchImpl).send({
      ...input,
      purpose: 'channel_verification',
      // Our own wording still reaches email and SMS; only WhatsApp is replaced by
      // Meta's fixed authentication body. The adapter never sends this string.
      body: 'Your Truecairn channel verification code is 424242. Enter it in the app to confirm this channel.',
      templateVariables: { '1': '424242' },
    });
  });

  it('never puts a button component on a utility template', async () => {
    // The button is authentication-only. A utility template that carries one is
    // rejected by Meta, so the category must actually gate it rather than the
    // presence of a variable — today those coincide, and a future parameterised
    // utility template is exactly when that would silently break.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { template: { components?: unknown[] } };
      // A static utility template omits `components` entirely (an empty array is
      // not the same thing to Meta as its absence).
      expect(body.template.components).toBeUndefined();
      return okResponse({ messages: [{ id: 'wamid.PLAIN' }] }, 200);
    }) as unknown as typeof fetch;
    await make(fetchImpl).send(input);
  });

  it('fails closed when a notice has no usable template', async () => {
    // Same invariant as the Twilio path, and for the same reason — it never
    // depended on the vendor. The Cloud API does reject an unknown template
    // name rather than dropping the message, but that is Meta's behaviour to
    // change; the pre-flight check is ours.
    const cases: readonly [string, Parameters<WhatsappCloudAdapter['send']>[0]][] = [
      ['purpose with no template', { ...input, purpose: 'welcome' }],
      [
        'template variable missing',
        { ...input, purpose: 'channel_verification', templateVariables: { '2': '424242' } },
      ],
      [
        'too many variables for the approved template',
        { ...input, templateVariables: { '1': '424242' } },
      ],
    ];
    for (const [label, sendInput] of cases) {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const err = await make(fetchImpl)
        .send(sendInput)
        .catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(ProviderError);
      expect(err, label).toMatchObject({ retryable: false });
      // Never leaks the variable value — lastError is persisted and logged, and
      // one of these variables is a verification code.
      expect((err as ProviderError).message, label).not.toContain('424242');
      expect(fetchImpl, label).not.toHaveBeenCalled();
    }
  });

  it('classifies 5xx/429 as retryable and other 4xx as permanent', async () => {
    const status = (code: number) =>
      make(vi.fn(async () => new Response('{}', { status: code })) as unknown as typeof fetch);
    await expect(status(500).send(input)).rejects.toMatchObject({ retryable: true });
    await expect(status(429).send(input)).rejects.toMatchObject({ retryable: true });
    await expect(status(400).send(input)).rejects.toMatchObject({ retryable: false });
    // 401 is the one worth naming: a non-permanent access token expires after
    // 24h and the channel dies overnight. Permanent, so it dead-letters and is
    // visible rather than retrying quietly for a day and a half.
    await expect(status(401).send(input)).rejects.toMatchObject({ retryable: false });
    const broken = make(vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch);
    await expect(broken.send(input)).rejects.toMatchObject({ retryable: true });
  });
});

describe('WebPushAdapter', () => {
  const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@y.z' };
  const subscription = JSON.stringify({
    endpoint: 'https://push.example.com/sub/abc',
    keys: { p256dh: 'p', auth: 'a' },
  });
  const input = {
    destination: subscription,
    subject: 'Confirm this channel',
    body: 'Your Truecairn channel verification code is 123456. Enter it in the app to confirm this channel.',
    // Push transmits our text directly, so it ignores `purpose` entirely — the
    // field exists for the one transport that cannot carry our text (WhatsApp).
    purpose: 'channel_verification' as const,
    idempotencyKey: 'delivery-2',
  };

  it('encrypt-sends the {title, body} payload to the subscription with our VAPID details', async () => {
    const sendImpl = vi.fn(async (sub: { endpoint: string }, payload: string, options: unknown) => {
      expect(sub.endpoint).toBe('https://push.example.com/sub/abc');
      expect(JSON.parse(payload)).toEqual({ title: input.subject, body: input.body });
      expect(options).toMatchObject({ vapidDetails: vapid });
      return { statusCode: 201, body: '', headers: {} };
    });
    const result = await new WebPushAdapter(vapid, sendImpl).send(input);
    expect(sendImpl).toHaveBeenCalledOnce();
    // Push has no provider id — the delivery-row id keeps it correlatable.
    expect(result.providerMessageId).toBe('push-delivery-2');
  });

  it('treats a gone subscription (404/410) as permanent and 5xx as retryable', async () => {
    const failing = (statusCode: number) =>
      new WebPushAdapter(vapid, vi.fn(async () => {
        const err = new Error(`push ${statusCode}`) as Error & { statusCode: number };
        err.statusCode = statusCode;
        throw err;
      }));
    await expect(failing(410).send(input)).rejects.toMatchObject({ retryable: false });
    await expect(failing(404).send(input)).rejects.toMatchObject({ retryable: false });
    await expect(failing(500).send(input)).rejects.toMatchObject({ retryable: true });
    await expect(failing(429).send(input)).rejects.toMatchObject({ retryable: true });
  });

  it('rejects a malformed destination as permanent without calling the transport', async () => {
    const sendImpl = vi.fn();
    const adapter = new WebPushAdapter(vapid, sendImpl);
    await expect(adapter.send({ ...input, destination: 'not-json' })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(sendImpl).not.toHaveBeenCalled();
  });
});

// ── Twilio error codes (2026-08-31) ──────────────────────────────────────────
//
// The numeric code is the only thing distinguishing four failures that need four
// different responses. Until this landed they all read "provider returned 400".
//
// The last test in this block is the important one and is not about diagnostics
// at all: Twilio's error `message` embeds the DESTINATION PHONE NUMBER, and
// ProviderError.message is persisted to notification_deliveries.last_error and
// logged. Invariant 1 says keep that boundary by construction, so the code
// travels and the provider's prose does not.
describe('TwilioMessagingAdapter — error codes', () => {
  const input = {
    destination: '+15552223333',
    subject: 'Confirm you are active',
    body: 'This is a Truecairn account status notification. Open the app to confirm you are active.',
    purpose: 'check_in_request' as const,
    idempotencyKey: 'delivery-err',
  };

  const failing = (code: number | undefined, status = 400, message?: string): typeof fetch =>
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          ...(code === undefined ? {} : { code }),
          message:
            message ??
            `Permission to send an SMS has not been enabled for the region indicated by the 'To' number: ${input.destination}`,
          status,
        }),
        { status },
      ),
    ) as unknown as typeof fetch;

  const adapter = (fetchImpl: typeof fetch) =>
    new TwilioMessagingAdapter({
      channelType: 'sms',
      accountSid: 'ACxxx',
      authToken: 'token',
      from: '+15550001111',
      statusCallbackUrl: 'https://api.example.com/v1/notifications/webhook/twilio',
      whatsappTemplateSids: ALL_TEMPLATE_SIDS,
      fetchImpl,
    });

  const cases: Array<[number, string]> = [
    [21408, 'geo permissions'],
    [30034, 'A2P 10DLC'],
    [21211, 'invalid destination'],
    [21610, 'opted out'],
  ];

  for (const [code, fragment] of cases) {
    it(`names code ${code} and classifies it permanent`, async () => {
      const err = await adapter(failing(code))
        .send(input)
        .then(
          () => null,
          (e: unknown) => e as ProviderError,
        );
      expect(err).toBeInstanceOf(ProviderError);
      expect(err!.code).toBe(code);
      expect(err!.message).toContain(String(code));
      expect(err!.message).toContain(fragment);
      // All four are permanent: retrying a geo block, an unregistered brand, a
      // malformed number or a STOP just burns the retry budget.
      expect(err!.retryable).toBe(false);
    });
  }

  it('falls back to the status when the body carries no code', async () => {
    const err = await adapter(failing(undefined, 500))
      .send(input)
      .then(
        () => null,
        (e: unknown) => e as ProviderError,
      );
    expect(err!.code).toBeUndefined();
    expect(err!.message).toContain('500');
    // Unknown shape must stay retryable on a 5xx — an unrecognised code must
    // never accidentally become permanent and stop retrying a transient fault.
    expect(err!.retryable).toBe(true);
  });

  it('NEVER puts the destination number in the error, though Twilio does', async () => {
    const err = await adapter(failing(21408))
      .send(input)
      .then(
        () => null,
        (e: unknown) => e as ProviderError,
      );
    // The fixture message contains it; ours must not. This string is persisted
    // to last_error and logged.
    expect(err!.message).not.toContain(input.destination);
    expect(err!.message).not.toContain('5552223333');
    // And not the provider's prose either, even the harmless-looking part.
    expect(err!.message).not.toContain('Permission to send');
  });
});
