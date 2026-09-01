// Human labels for the docs/03 vocabularies, DERIVED from the enum values rather
// than kept in a map.
//
// The values in VAULT_CATEGORIES and RECIPIENT_TYPES are docs/03's matrix row and
// column headings, lowercased with spaces and slashes turned to underscores. So
// reversing that transform yields the document's own wording, and a computed
// label cannot drift from the vocabulary that packages/shared's drift test pins
// against docs/03. A hand-written map would be a second home for the same copy —
// the mistake whatsapp-templates.ts had to grow a dedicated test to prevent.
//
// Lives in lib/ rather than in @truecairn/shared because it is presentation: the
// shared package carries the vocabulary, the browser decides how to say it. And
// it is shared between the vault and contacts screens, so it belongs to neither.

export function categoryLabel(category: string): string {
  const words = category.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The slashes are restored deliberately: docs/03 writes "Spouse / family
// executor", and the slash carries meaning — either of two people, not a
// compound role.
export function recipientTypeLabel(t: string): string {
  const words = t.replace(/_/g, ' ');
  const sentence = words.charAt(0).toUpperCase() + words.slice(1);
  return sentence
    .replace('Spouse family executor', 'Spouse / family executor')
    .replace('Cofounder business partner', 'Cofounder / business partner')
    .replace('Lawyer accountant', 'Lawyer / accountant');
}
