import type { ContactRole } from '@truecairn/shared';

// Draft the invitation message an owner sends to someone they're asking to be a
// trusted contact. Input is the ROLE enum only — metadata, no labels/secrets — so
// this stays fully within the zero-knowledge boundary. Matches the rules' "AI
// creates comms/marketing assets" example; the owner edits before sending.
export const INVITE_SYSTEM_INSTRUCTION =
  'You write a short invitation message that a Truecairn owner sends to someone they ' +
  'are asking to become a trusted contact for their digital-continuity plan. The ' +
  'recipient will later "enrol" by proving on their own device that they hold a key, ' +
  'and may one day help release the owner’s vault if the owner goes silent. RULES: ' +
  '2 to 4 short sentences, warm and clear, written in the first person as the owner. ' +
  'Explain plainly what is being asked (to be a trusted contact in this role) and ' +
  'that it is a position of trust — not a request for money, passwords, or personal ' +
  'data now. Do NOT include any invite code, link, real names, or private details — ' +
  'the owner adds the one-time invite token themselves. Output only the message text, ' +
  'no markdown and no preamble.';

export function buildInvitePrompt(role: ContactRole): string {
  const roleDesc: Record<ContactRole, string> = {
    personal: 'a personal contact — someone close, such as family or a close friend',
    professional: 'a professional contact — for example a lawyer, accountant, or executor',
    recovery: 'a recovery contact — a steady, reliable person who helps restore access',
  };
  return `Write the invitation for the owner to send to ${roleDesc[role]}. Tailor the tone and framing to that role.`;
}
