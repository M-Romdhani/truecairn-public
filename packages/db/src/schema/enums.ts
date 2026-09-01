import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACCOUNT_STATUSES,
  AFFIRMATION_STATUSES,
  CEREMONY_STATUSES,
  CONTACT_KEY_TYPES,
  CONTACT_ROLES,
  CONTACT_STATUSES,
  CV_PURPOSE_CLASSES,
  DELIVERY_STATUSES,
  ENGINE_STATES,
  NOTIFICATION_CHANNEL_HEALTHS,
  NOTIFICATION_CHANNEL_TYPES,
  NOTIFICATION_PURPOSES,
  SENSITIVE_ACTION_STATUSES,
  SENSITIVE_ACTION_TYPES,
  SHARE_TYPES,
  VAULT_TIERS,
} from '@truecairn/shared';

export const accountStatusEnum = pgEnum('account_status', ACCOUNT_STATUSES);
export const contactRoleEnum = pgEnum('contact_role', CONTACT_ROLES);
export const contactStatusEnum = pgEnum('contact_status', CONTACT_STATUSES);
export const contactKeyTypeEnum = pgEnum('contact_key_type', CONTACT_KEY_TYPES);
export const vaultTierEnum = pgEnum('vault_tier', VAULT_TIERS);
export const engineStateEnum = pgEnum('engine_state', ENGINE_STATES);
export const ceremonyStatusEnum = pgEnum('ceremony_status', CEREMONY_STATUSES);
export const affirmationStatusEnum = pgEnum('affirmation_status', AFFIRMATION_STATUSES);
export const sensitiveActionTypeEnum = pgEnum('sensitive_action_type', SENSITIVE_ACTION_TYPES);
export const sensitiveActionStatusEnum = pgEnum(
  'sensitive_action_status',
  SENSITIVE_ACTION_STATUSES,
);
export const notificationChannelTypeEnum = pgEnum(
  'notification_channel_type',
  NOTIFICATION_CHANNEL_TYPES,
);
export const notificationChannelHealthEnum = pgEnum(
  'notification_channel_health',
  NOTIFICATION_CHANNEL_HEALTHS,
);
export const notificationPurposeEnum = pgEnum('notification_purpose', NOTIFICATION_PURPOSES);
export const deliveryStatusEnum = pgEnum('delivery_status', DELIVERY_STATUSES);
export const cvPurposeClassEnum = pgEnum('cv_purpose_class', CV_PURPOSE_CLASSES);
export const shareTypeEnum = pgEnum('share_type', SHARE_TYPES);
export const recipientReconstructionStatusEnum = pgEnum('recipient_reconstruction_status', [
  'pending',
  'reconstructing',
  'released',
  'failed',
]);
