// Notification-channel enrolment (Continuity Verification CV-0.0). Plain
// session-gated calls — no key material involved: the server stores only the
// destination + a hashed verification code, and the code round-trip proves the
// owner can read the destination.

import { api, apiJson } from '../api/client.js';
import { requestWithStepUp, type StepUpDeps } from '../api/stepup.js';

export type EnrollableChannelType = 'email' | 'sms' | 'whatsapp' | 'push';

export interface ChannelInfo {
  id: string;
  channelType: EnrollableChannelType | 'webhook';
  destination: string;
  verified: boolean;
  health: 'healthy' | 'degraded' | 'failing';
  createdAt: string;
  pendingVerification: boolean;
}

export interface ChannelList {
  channels: ChannelInfo[];
  // VAPID public key when the deployment supports web push; null hides the UI.
  pushPublicKey: string | null;
  // The caller's plan + the channel types they may enrol (paid channels are
  // pro-gated). The picker renders from enrollableChannelTypes.
  plan: 'free' | 'pro';
  enrollableChannelTypes: EnrollableChannelType[];
}

export async function fetchChannels(fetchImpl?: typeof fetch): Promise<ChannelList> {
  const res = await api('/v1/settings/channels', fetchImpl !== undefined ? { fetchImpl } : {});
  return apiJson(res);
}

// Add a new channel, or re-request a code for an unverified/removed one —
// the server treats the destination idempotently either way. The code always
// travels OUT through the channel itself (email body, SMS/WhatsApp text, push
// notification) and is typed back here.
export async function addChannel(
  channelType: EnrollableChannelType,
  destination: string,
  fetchImpl?: typeof fetch,
): Promise<{ id: string; verified: boolean }> {
  const res = await api('/v1/settings/channels', {
    method: 'POST',
    body: { channelType, destination },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  return apiJson(res);
}

// Subscribe THIS browser for web push and return the subscription JSON to
// enrol as a channel destination. Throws on refusal (no permission / no SW
// support) — the caller shows the error.
export async function subscribeThisBrowser(pushPublicKey: string): Promise<string> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('push is not supported in this browser');
  }
  const registration = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('notification permission was not granted');
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(pushPublicKey) as unknown as BufferSource,
  });
  return JSON.stringify(subscription.toJSON());
}

function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function verifyChannel(
  id: string,
  code: string,
  fetchImpl?: typeof fetch,
): Promise<{ id: string; verified: boolean }> {
  const res = await api(`/v1/settings/channels/${id}/verify`, {
    method: 'POST',
    body: { code },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  return apiJson(res);
}

// Immediate removal — UNVERIFIED channels only (a typo'd destination is a
// one-click cleanup; it was never selected for notices). The server answers
// 409 for a verified channel: those go through requestChannelRemoval below.
export async function removeChannel(id: string, fetchImpl?: typeof fetch): Promise<void> {
  const res = await api(`/v1/settings/channels/${id}`, {
    method: 'DELETE',
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  await apiJson(res);
}

// Removing a VERIFIED channel is a SENSITIVE action (docs/26 §4): step-up
// (fresh second factor + passphrase signature over this exact body) then a
// 7-day delay, cancellable from the Engine page — a stolen session can never
// instantly silence check-in reminders.
export async function requestChannelRemoval(
  channelId: string,
  deps: StepUpDeps,
): Promise<{ sensitiveActionId: string; effectiveAt: string }> {
  const res = await requestWithStepUp(
    { url: '/v1/settings/channels/remove', method: 'POST', body: { channelId } },
    deps,
  );
  return apiJson(res);
}

// ── The channel matrix (docs/26 §3.1) ────────────────────────────────────────
// Which channel serves which purpose class. Absent preference = enabled — the
// server returns the EFFECTIVE grid; PUT flips one cell. The matrix can only
// narrow delivery: check-in requests, escalation requests, and security alerts
// are exempt at selection time (the safety floor), which the UI states.

export type PurposeClass = 'owner_verification' | 'owner_notices' | 'contact_notices';

export interface MatrixChannel {
  id: string;
  channelType: string;
  destination: string;
  verified: boolean;
  classes: Record<PurposeClass, boolean>;
}

export async function fetchChannelPreferences(
  fetchImpl?: typeof fetch,
): Promise<{ channels: MatrixChannel[] }> {
  const res = await api(
    '/v1/settings/channels/preferences',
    fetchImpl !== undefined ? { fetchImpl } : {},
  );
  return apiJson(res);
}

export async function setChannelPreference(
  channelId: string,
  purposeClass: PurposeClass,
  enabled: boolean,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const res = await api('/v1/settings/channels/preferences', {
    method: 'PUT',
    body: { channelId, purposeClass, enabled },
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  await apiJson(res);
}
