import type { NotificationPurpose } from '@truecairn/shared';

// ── Spanish transactional email/SMS copy (docs/40 Phase 3) ───────────────────
//
// A PARTIAL OVERRIDE, not a parallel catalog. Only the keys present here are
// translated; anything absent falls back to the English in templates.ts, which
// is the same rule the web catalogs follow — a missing translation renders in
// the source language rather than as a placeholder nobody can tell apart from
// real copy.
//
// NOT YET REVIEWED BY A NATIVE SPEAKER, the same gate that keeps Spanish out of
// OFFERED_LOCALES. These bodies reach someone on the worst day they will ever
// use this product, so the gate matters more here than on a marketing page.
//
// THE RULES THESE BODIES OBEY, carried from templates.ts and binding on any
// translation:
//
//   1. NO VAULT CONTENT, no item title, no tier, no contact identity, no
//      release detail. Every body says enough to ACT (open Truecairn) and
//      nothing more; the actionable detail lives behind sign-in. An email
//      interceptor must learn only that the recipient uses Truecairn.
//   2. CONTACT-FACING CEREMONY NOTICES STAY MAXIMALLY BARE. No owner name, no
//      "someone may be gone", no vault hint — putting that in transport asserts
//      something intimate and possibly false.
//   3. "frase de liberación" is the RELEASE passphrase and "frase maestra" the
//      MASTER passphrase. They are different secrets that fail differently, and
//      templates.ts has already had to correct one being used for the other.
//      The anti-phishing line is about the RELEASE passphrase specifically.
//   4. The `plan_downgraded` body's one job is the safety promise — nothing you
//      rely on stopped working. It carries no upsell, deliberately (see the note
//      in templates.ts on why the upsell sentence was dropped).
export const TEMPLATES_ES: Partial<
  Record<NotificationPurpose, { subject: string; body: string }>
> = {
  check_in_request: {
    subject: 'Confirma que sigues activo',
    body: 'Esto es una notificación sobre el estado de tu cuenta de Truecairn. Abre la aplicación para confirmar que sigues activo.',
  },
  escalation_request: {
    subject: 'Confirma que sigues activo',
    body: 'Tu cuenta parece inactiva. Abre Truecairn para confirmar que sigues ahí.',
  },
  engine_state_change: {
    subject: 'Novedades en tu cuenta de Truecairn',
    body: 'Hay una novedad en el estado de tu cuenta de Truecairn. Abre la aplicación para revisarla.',
  },
  sensitive_action_notice: {
    subject: 'Se ha solicitado un cambio sensible para la seguridad',
    body: 'Se ha solicitado un cambio sensible para la seguridad de tu cuenta y se aplicará dentro de 7 días. Abre Truecairn para revisarlo o cancelarlo.',
  },
  security_alert: {
    subject: 'Actividad inusual en tu cuenta',
    body: 'Hemos detectado actividad de inicio de sesión inusual en tu cuenta de Truecairn. Si no has sido tú, abre la aplicación para protegerla.',
  },
  contact_invitation: {
    subject: 'Una invitación de Truecairn',
    body: 'Te han invitado a Truecairn. Abre la aplicación para responder.',
  },
  health_probe: {
    subject: 'Confirma que este canal funciona',
    body: 'Esto es una prueba de un canal de notificación de Truecairn. Abre la aplicación para confirmar que este canal funciona.',
  },
  channel_verification: {
    subject: 'Confirma este canal',
    body: 'Abre Truecairn y solicita un código nuevo para confirmar este canal de notificación.',
  },
  ceremony_initiation: {
    subject: 'Una solicitud como contacto de confianza',
    body: 'Una solicitud como contacto de confianza necesita tu atención en Truecairn. Abre la aplicación para responder.',
  },
  ceremony_affirmation_request: {
    subject: 'Una solicitud como contacto de confianza',
    body: 'Una solicitud como contacto de confianza necesita tu atención en Truecairn. Abre la aplicación para responder.',
  },
  ceremony_revocation_window: {
    subject: 'Una solicitud como contacto de confianza',
    body: 'Una solicitud como contacto de confianza necesita tu atención en Truecairn. Abre la aplicación para responder.',
  },
  plan_downgraded: {
    subject: 'Tu plan de Truecairn ha cambiado',
    body: 'Tu plan de pago ha terminado. Todos los canales de notificación que ya habías verificado siguen funcionando: no se ha desactivado nada de lo que protege tu bóveda.',
  },
  welcome: {
    subject: 'Te damos la bienvenida a Truecairn',
    body: [
      'Tu correo electrónico está confirmado: a partir de ahora, esta dirección recibirá tus recordatorios de confirmación y los avisos de tu cuenta.',
      '',
      'Truecairn guarda una bóveda cifrada que llega a las personas que tú elijas, solo si te quedas en silencio. El cifrado ocurre en tu dispositivo con tu frase maestra: tú tienes las claves, nosotros nunca las vemos y no podemos restablecerlas.',
      '',
      'Para terminar de configurarlo:',
      '  1. Añade un contacto de confianza: cualquier persona con correo electrónico; no necesita una cuenta para empezar.',
      '  2. Guarda algo en tu bóveda: empieza a partir de una plantilla.',
      '  3. Activa tu motor de continuidad: elige un disparador y un periodo de espera de entre 7 y 90 días.',
      '',
      'No hay prisa. Cualquier decisión que tomes se puede deshacer: toda liberación pasa por una ventana de revocación de 48 horas, y todo cambio sensible espera 7 días antes de surtir efecto.',
      '',
      'Nunca te pediremos tu frase de liberación, ni por correo ni por teléfono. Si algún mensaje lo hace, no es nuestro.',
      '',
      'Solo registramos si un mensaje se ha entregado, nunca si lo has abierto o leído.',
    ].join('\n'),
  },
};

// The email shell's own chrome — the parts that are not the notice body. Same
// partial-override rule: an absent key falls back to English.
export interface ShellStrings {
  headerLabel: Readonly<Partial<Record<NotificationPurpose, string>>>;
  reassuranceDefault: string;
  reassuranceVerification: string;
  ctaOpen: string;
  ctaFinishSetup: string;
  footerNotice: string;
  footerSettings: string;
  footerSecurity: string;
  footerHelp: string;
  verificationBody: string;
  welcome: {
    preview: string;
    eyebrow: string;
    headline: string;
    lede: string;
    intro: string;
    stepsLabel: string;
    steps: readonly (readonly [string, string])[];
    primitives: string;
    reassurance: readonly [string, string];
  };
}

export const SHELL_ES: ShellStrings = {
  // The small monospace category label in the header band. Deliberately WEAKER
  // than the subject above it — it can never be the first place a reader learns
  // something, which is what keeps "the shell adds presentation, never
  // information" true in every language.
  headerLabel: {
    check_in_request: 'confirmación',
    escalation_request: 'confirmación',
    engine_state_change: 'aviso de cuenta',
    sensitive_action_notice: 'seguridad',
    security_alert: 'alerta de seguridad',
    contact_invitation: 'invitación',
    health_probe: 'prueba de canal',
    channel_verification: 'prueba de canal',
    ceremony_initiation: 'contacto de confianza',
    ceremony_affirmation_request: 'contacto de confianza',
    ceremony_revocation_window: 'contacto de confianza',
    plan_downgraded: 'aviso de cuenta',
    welcome: 'bienvenida',
  },
  reassuranceDefault:
    'El detalle está en la aplicación, detrás de tu inicio de sesión; nunca en un correo. Nunca te pediremos tu frase de liberación, y si algún mensaje lo hace, no es nuestro.',
  reassuranceVerification:
    'Este código solo confirma que este canal llega hasta ti. No da ningún acceso a tu bóveda, y nunca te pediremos tu frase de liberación, ni por correo ni por teléfono.',
  ctaOpen: 'Abrir Truecairn',
  ctaFinishSetup: 'Terminar la configuración',
  footerNotice:
    'Recibes esto porque esta dirección es un canal de notificación de tu cuenta de Truecairn. Puedes gestionar o eliminar tus canales cuando quieras en Ajustes. Solo registramos si un mensaje se ha entregado, nunca si lo has abierto o leído.',
  footerSettings: 'Ajustes de notificaciones',
  footerSecurity: 'Modelo de seguridad',
  footerHelp: 'Ayuda',
  verificationBody:
    'Tu código de verificación de canal de Truecairn es {{code}}. Introdúcelo en la aplicación para confirmar este canal.',
  welcome: {
    preview:
      'Tu correo está confirmado. Quedan tres cosas por configurar: un contacto de confianza, un elemento en la bóveda y tu motor de continuidad.',
    eyebrow: 'te damos la bienvenida a Truecairn',
    headline: 'Tu correo está confirmado.',
    lede: 'A partir de ahora, esta dirección recibirá tus recordatorios de confirmación y los avisos de tu cuenta. Todavía no hay nada activado: esa parte depende de ti.',
    intro:
      'Truecairn guarda una bóveda cifrada que llega a las personas que tú elijas, solo si te quedas en silencio. El cifrado ocurre en tu dispositivo con tu frase maestra. Tú tienes las claves; nosotros nunca las vemos y no podemos restablecerlas.',
    stepsLabel: 'para terminar la configuración',
    steps: [
      [
        'Añade un contacto de confianza',
        'Cualquier persona con correo electrónico. No necesita una cuenta para empezar: solo tu enlace de invitación firmado.',
      ],
      [
        'Guarda algo en tu bóveda',
        'Empieza a partir de una plantilla: traspaso de negocio, recuperación de criptomonedas, esenciales familiares.',
      ],
      [
        'Activa tu motor de continuidad',
        'Elige un disparador y un periodo de espera de entre 7 y 90 días. Nada te vigila hasta que lo actives.',
      ],
    ],
    primitives:
      'Cifrado de extremo a extremo &middot; XChaCha20-Poly1305 &middot; conocimiento cero por arquitectura',
    reassurance: [
      'No hay prisa. Cualquier decisión que tomes se puede deshacer: toda liberación pasa por una ventana de revocación de 48 horas, y todo cambio sensible espera 7 días antes de surtir efecto.',
      'Nunca te pediremos tu frase de liberación, ni por correo ni por teléfono. Si algún mensaje lo hace, no es nuestro.',
    ],
  },
};
