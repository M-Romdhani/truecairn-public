import { describe, expect, it } from 'vitest';
import { NOTIFICATION_PURPOSES } from '@truecairn/shared';
import { renderTemplate } from './templates.js';
import {
  WHATSAPP_TEMPLATES,
  WHATSAPP_TEMPLATE_FOR_PURPOSE,
  WHATSAPP_TEMPLATE_KEYS,
  WHATSAPP_TEMPLATE_LANGUAGE,
} from './whatsapp-templates.js';

// The WhatsApp template contract (CV-3). WhatsApp is the one channel whose text
// does not live in this repo — it lives approved at Meta, and we send a SID. That
// makes drift invisible at runtime: the approved copy could say anything and the
// send would still succeed. These tests are the substitute for seeing it, so the
// declared text stays exactly what templates.ts would have sent.

// The sample used to fill {{n}} when re-deriving a parameterised template. Value
// is irrelevant; only the surrounding sentence is under test.
const SAMPLE = '424242';

describe('WhatsApp template contract', () => {
  it('declares a decision for every notification purpose', () => {
    // Record<NotificationPurpose, …> makes this a compile error too — this is
    // the runtime half, so a purpose added via a looser cast still trips.
    for (const purpose of NOTIFICATION_PURPOSES) {
      expect(WHATSAPP_TEMPLATE_FOR_PURPOSE, purpose).toHaveProperty(purpose);
    }
  });

  it('reproduces the exact body templates.ts would have sent (utility templates)', () => {
    // The no-invented-copy rule. For each purpose that maps to a template, fill
    // the approved text's {{n}} the way the adapter fills the body parameters, and
    // require the result to equal the rendered body character for character.
    //
    // DOCUMENTED CARVE-OUT — authentication templates are skipped, and there is
    // exactly one (the test below pins that, so this exception cannot widen by
    // accident). Meta fixes the content of an authentication template and does not
    // let us edit it, so `channel_verification`'s body is Meta's sentence rather
    // than ours and is not derivable from `renderTemplate`. Email and SMS still say
    // "Your Truecairn channel verification code is X. Enter it in the app to
    // confirm this channel."; WhatsApp says "X is your verification code. For your
    // security, do not share this code." That divergence is the accepted price of
    // the category (docs/26) — it is not drift, and the golden literal below is
    // what keeps it honest in the absence of this check.
    for (const purpose of NOTIFICATION_PURPOSES) {
      const key = WHATSAPP_TEMPLATE_FOR_PURPOSE[purpose];
      if (key === null) continue;
      const template = WHATSAPP_TEMPLATES[key];
      if (template.category === 'authentication') continue;
      const rendered = renderTemplate(
        purpose,
        template.variables > 0 ? { code: SAMPLE } : undefined,
      );
      let filled = template.text;
      for (let i = 1; i <= template.variables; i += 1) {
        filled = filled.replace(`{{${i}}}`, SAMPLE);
      }
      expect(filled, purpose).toBe(rendered.body);
    }
  });

  it('pins the exact bodies that were submitted to Meta for approval', () => {
    // The test above proves the two halves of the REPO agree. This one stands in
    // for the half no file here can see: each string below also exists as an
    // approved artefact in a vendor console, and an approved body cannot be
    // edited from this side. Changing one means a re-approval round trip at Meta,
    // and until it clears, the repo and the live template disagree — sends keep
    // carrying the OLD wording while the drift test happily passes, because both
    // repo halves moved together. Pinning the literals makes a copy edit a
    // deliberate act with a vendor step attached, rather than a tidy-up.
    //
    // `check_in` and `health_probe` read differently from the rest for a reason:
    // they were written FROM Meta's category rules, not for us. Their terse
    // originals were refused as UTILITY and offered only MARKETING — a category
    // Meta has not delivered to US numbers since April 2025, and one the
    // recipient can switch off per account everywhere else. That is docs/11
    // threat 5.3 reappearing at the category layer, so the category was fixed and
    // the copy moved. Naming the notice's own kind is what carries them.
    const bodies = Object.fromEntries(
      WHATSAPP_TEMPLATE_KEYS.map((k) => [k, WHATSAPP_TEMPLATES[k].text]),
    );
    expect(bodies).toEqual({
      check_in:
        'This is a Truecairn account status notification. Open the app to confirm you are active.',
      escalation: 'Your account looks inactive. Open Truecairn to confirm you are here.',
      engine_update:
        'There is an update to your Truecairn account status. Open the app to review.',
      sensitive_action:
        'A security-sensitive change to your account was requested and applies in 7 days. Open Truecairn to review or cancel.',
      security_alert:
        'We detected unusual login activity on your Truecairn account. If this was not you, open the app to secure it.',
      health_probe:
        'This is a Truecairn notification-channel test. Open the app to confirm this channel is working.',
      // Meta's fixed authentication body, with the "security recommendation"
      // toggle ON. Not our sentence and not editable from here — the one entry in
      // this table whose wording the vendor owns outright.
      channel_verification: '{{1}} is your verification code. For your security, do not share this code.',
      trusted_contact:
        'A trusted-contact request needs your attention in Truecairn. Open the app to respond.',
      plan_downgraded:
        'Your paid plan has ended. Every notification channel you already verified keeps working — nothing that guards your vault was turned off.',
    });
  });

  it('agrees with renderTemplate on how many variables each template takes', () => {
    // The adapter's arity check is only as good as this number. Prove it against
    // what renderTemplate actually produces rather than trusting the constant.
    for (const purpose of NOTIFICATION_PURPOSES) {
      const key = WHATSAPP_TEMPLATE_FOR_PURPOSE[purpose];
      if (key === null) continue;
      const declared = WHATSAPP_TEMPLATES[key].variables;
      const produced = renderTemplate(purpose, declared > 0 ? { code: SAMPLE } : undefined);
      expect(Object.keys(produced.variables).length, purpose).toBe(declared);
      // Positional and contiguous from 1 — Meta indexes {{1}}, {{2}}, … and a
      // gap is a rejected send.
      for (let i = 1; i <= declared; i += 1) {
        expect(produced.variables[String(i)], `${purpose} {{${i}}}`).toBeDefined();
      }
    }
  });

  it('declares {{n}} placeholders that are contiguous and none that are unused', () => {
    for (const key of WHATSAPP_TEMPLATE_KEYS) {
      const { text, variables, category } = WHATSAPP_TEMPLATES[key];
      const found = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(found, key).toEqual(Array.from({ length: variables }, (_, i) => i + 1));
      // Meta rejects a template whose body begins or ends with a variable — a
      // constraint on bodies WE author. Meta's own fixed authentication body opens
      // with the variable ("{{1}} is your verification code."), so the rule cannot
      // be applied to the one body we did not write.
      if (category === 'authentication') continue;
      expect(text.trimStart().startsWith('{{'), key).toBe(false);
      expect(text.trimEnd().endsWith('}}'), key).toBe(false);
    }
  });

  it('confines the drift carve-out to exactly one authentication template', () => {
    // The carve-out above is scoped by CATEGORY, so it would widen silently the
    // moment another template were registered as authentication. Nothing else may
    // be: every other notice is ours to word, and this category would replace the
    // body with Meta's verification-code sentence — losing the copy AND, for the
    // engine notices, the delivery guarantees that made us pick utility.
    const authenticated = WHATSAPP_TEMPLATE_KEYS.filter(
      (k) => WHATSAPP_TEMPLATES[k].category === 'authentication',
    );
    expect(authenticated).toEqual(['channel_verification']);
  });

  it('gives every template a distinct, Meta-legal name', () => {
    // Template identity at Meta is (name, language). Names are ours to choose,
    // so they live here rather than in env — but Meta constrains the charset to
    // lowercase letters, digits and underscores, and rejects the whole template
    // at creation time otherwise.
    const names = WHATSAPP_TEMPLATE_KEYS.map((k) => WHATSAPP_TEMPLATES[k].name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n, n).toMatch(/^[a-z0-9_]+$/);
  });

  it('pins the approved language', () => {
    // A template approved as `en` cannot be sent as `en_US` — Meta treats them
    // as different templates and the send fails. Pinned so a "tidy-up" that
    // localises the code has to come with re-approval.
    expect(WHATSAPP_TEMPLATE_LANGUAGE).toBe('en');
  });

  it('carries no vault content, name, or address into an approved template', () => {
    // The same discipline the bare bodies keep (PHASE3_5 §f/§g). Worth asserting
    // separately here because this text is submitted to Meta and reviewed by a
    // third party — it is the copy that leaves our infrastructure permanently.
    for (const key of WHATSAPP_TEMPLATE_KEYS) {
      const { text } = WHATSAPP_TEMPLATES[key];
      // No owner/contact identity, no tier or item hint, no release language.
      expect(text.toLowerCase(), key).not.toMatch(
        /passphrase|vault item|beneficiar|release|deceased|died|passed away/,
      );
    }
  });

  it('gives the three ceremony notices one shared template', () => {
    // Their bodies are identical on purpose — which ceremony stage was reached
    // is not something transport should reveal. Separate approvals would hand an
    // interceptor a distinguisher we deliberately withheld.
    const keys = new Set([
      WHATSAPP_TEMPLATE_FOR_PURPOSE['ceremony_initiation'],
      WHATSAPP_TEMPLATE_FOR_PURPOSE['ceremony_affirmation_request'],
      WHATSAPP_TEMPLATE_FOR_PURPOSE['ceremony_revocation_window'],
    ]);
    expect(keys).toEqual(new Set(['trusted_contact']));
  });

  it('leaves welcome and contact_invitation unmapped rather than truncated', () => {
    // welcome is twelve lines and a numbered list — no template could carry it,
    // and shortening it to fit would be inventing copy. It is email-only by
    // construction (apps/api/src/routes/channels.ts enqueues it on the first
    // verified EMAIL channel), so this is unreachable; if that ever changes it
    // fails closed instead of arriving as a different message.
    expect(WHATSAPP_TEMPLATE_FOR_PURPOSE['welcome']).toBeNull();
    expect(WHATSAPP_TEMPLATE_FOR_PURPOSE['contact_invitation']).toBeNull();
  });
});
