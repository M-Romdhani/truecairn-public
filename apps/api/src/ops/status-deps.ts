import { resolveBackupAttestation, type AiSubsystemDeps, type BackupAttestation } from '@truecairn/ops';
import type { ApiConfig } from '../config.js';

// The two status inputs that are pure CONFIGURATION rather than a live probe,
// shared by the admin dashboard (routes/ops.ts) and the public page
// (routes/status.ts) for the same reason configuredNotificationTypes is: the two
// surfaces render the same tiles, and a fact resolved twice is a fact that can
// disagree with itself.

// What an operator has attested about backups. Read from the environment at call
// time (not captured at boot) so re-dating it after a drill takes effect on the
// next redeploy without any further code path caring.
//
// The variable holds a DATE, not a boolean: "backups are on" is a claim the
// application cannot check and would never expire, while "a restore was
// completed on this date" is checkable against a drill record and goes stale on
// its own. See the backups check in packages/ops for why that distinction is
// what makes the tile allowed to be green at all.
export function backupAttestation(now: Date = new Date()): BackupAttestation {
  return resolveBackupAttestation(process.env['BACKUPS_LAST_VERIFIED_RESTORE'], now);
}

// What the AI subsystem is configured to do. Capability names only — never a
// credential, a project id or an endpoint (rule 2 of the ops surface).
export function aiSubsystemStatusDeps(config: ApiConfig): AiSubsystemDeps {
  const capabilities: string[] = [];
  if (config.ai.proposerEnabled) capabilities.push('proposer');
  if (config.ai.autonomyEnabled) capabilities.push('autonomy');
  if (config.ai.guardianEnabled) capabilities.push('guardian');
  if (config.cvNarrationEnabled) capabilities.push('narration');
  return {
    killSwitch: config.ai.enabled,
    // aiBriefing.enabled IS the credential test: resolveAiBriefing sets it from
    // whether the chosen backend's credential resolved (Vertex project, or an
    // API key), never from a flag an operator sets directly.
    credentialResolved: config.aiBriefing.enabled,
    model: config.aiBriefing.model,
    capabilities,
  };
}
