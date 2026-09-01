declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type ContactId = Brand<string, 'ContactId'>;
export type VaultItemId = Brand<string, 'VaultItemId'>;
export type ReleaseShareId = Brand<string, 'ReleaseShareId'>;
export type OuterLayerKeyId = Brand<string, 'OuterLayerKeyId'>;
export type AuditLogId = Brand<string, 'AuditLogId'>;
export type SensitiveActionId = Brand<string, 'SensitiveActionId'>;
export type ReleaseCeremonyId = Brand<string, 'ReleaseCeremonyId'>;
export type CeremonyAffirmationId = Brand<string, 'CeremonyAffirmationId'>;
export type NotificationChannelId = Brand<string, 'NotificationChannelId'>;
export type NotificationDeliveryId = Brand<string, 'NotificationDeliveryId'>;
export type DeviceRegistrationId = Brand<string, 'DeviceRegistrationId'>;
export type SessionId = Brand<string, 'SessionId'>;
