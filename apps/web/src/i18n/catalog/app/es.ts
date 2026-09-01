import type { AppMessageKey } from './en.js';

// ── Spanish (es) ─────────────────────────────────────────────────────────────
//
// STILL NOT REVIEWED BY A NATIVE SPEAKER — AND NOW SHIPPING ANYWAY (2026-08-26).
//
// This sentence used to read "must be read by one before it ships to anybody".
// It shipped without that, by an owner decision taken with the position stated
// plainly. The sentence is not being softened to match what happened: a gate that
// gets reworded the moment it is inconvenient was never a gate, and the next
// person reading this file should see that the bar was set here and then stepped
// over, rather than a tidy note implying it was met.
//
// What IS true: every string has been checked against its English source for
// meaning (QA-i18n-spanish-2026-08-25.md Part 1), which caught and fixed the
// master passphrase carrying two names. What remains untrue: nobody who speaks
// Spanish has read it.
//
// Two of these strings are the ones a person meets on the worst day they will
// ever use this product, and a translation that is merely grammatical is not good
// enough for them. That has not changed by being shipped. A native-speaker review
// is still owed, and finding it a reader rather than a proofreader is now the
// difference between a correction and an incident.
//
// A STRUCTURED PASS WAS RUN 2026-08-26 against QA-i18n-spanish-2026-08-25.md
// Part 1. It does NOT satisfy the gate above — it was not done by a native
// speaker and cannot answer the question that gate asks, which is whether this
// reads as Spanish rather than as translated English. What it did check is
// narrower and mechanical: does each high-risk string still carry the same claim
// as its English source.
//
// Result: the seven meaning-critical areas it could reach were intact —
// S2-optional vs S3-mandatory (which explicitly negates the forbidden «una parte
// más»), the anti-phishing line naming «frase de liberación» on all four
// surfaces, the by-phone-or-in-person channel restriction, both readiness
// consequence clauses, and the absence statements (no SOC 2, no ISO 27001, no
// audit). The unlock errors stay distinguishable.
//
// One real defect was found and fixed: the master passphrase had TWO names.
// `frase de contraseña` appeared 20× beside `frase maestra` — reintroducing
// «contraseña», the word the glossary below explicitly rejects. It was not
// abstract drift: `onboarding.pass.field` read «Frase maestra» while the confirm
// box directly beneath it read «Confirma la frase de contraseña», and the unlock
// screen labelled the field one way and named it another in its own error. The
// lexicon gate was green throughout, because it enumerated two variants and this
// was a third; it now tracks this one (i18n-lexicon.test.ts).
//
// PARTIAL BY DESIGN. Typed `Partial<...>`, so a key not yet translated is simply
// absent and i18next falls back to the English (see `fallbackLng` in ../index.ts).
// The alternative — a total Record — would force a placeholder for every
// untranslated key, and a placeholder that renders is indistinguishable from a
// real translation. Missing and falling back is visible; a fake is not.
// `catalog.test.ts` reports coverage and fails on a key that exists here and not
// in en.ts (a typo, or a string deleted from the source and left behind here).
//
// GLOSSARY — decided once, applied everywhere. Changing one of these is a
// find-and-replace across every catalog, never a per-string judgement call:
//   vault           → bóveda            (not "caja fuerte": this is a store of
//                                        record, not a strongbox)
//   passkey         → clave de acceso   (the term Apple and Google use in es)
//   master passphrase → frase maestra
//                                       (NOT "contraseña maestra" — the product
//                                        deliberately says passphrase, not
//                                        password, and the distinction is the
//                                        whole security argument)
//   check-in        → confirmación de actividad
//   trusted contact → contacto de confianza
//
// REGISTER: "tú", not "usted". Modern consumer software in both Spain and Latin
// America uses it, and this product is already deliberately plain-spoken in
// English; "usted" would make it read like a bank letter.
//
// REGIONAL NEUTRALITY is a known open question, not a solved one. Where Spain
// and Latin America diverge (pulsar/presionar, ordenador/computadora) this picks
// the widely-understood form rather than splitting into es-ES and es-419. If
// that ever stops being good enough it becomes a NEW entry in LOCALES with its
// own catalog — never a silent regional drift inside this file.
export const appEs: Partial<Record<AppMessageKey, string>> = {
  'auth.field.email': 'Correo electrónico',
  'auth.tagline': 'Continuidad para tu vida digital. Cifrada en tu dispositivo.',

  'auth.login.heading': 'Iniciar sesión',
  'auth.login.lede':
    'Inicia sesión con tu clave de acceso y luego desbloquea tu bóveda con tu frase maestra.',
  'auth.login.submit': 'Iniciar sesión con tu clave de acceso',
  'auth.login.submitBusy': 'Iniciando sesión…',
  'auth.login.waiting':
    'Esperando la solicitud de clave de acceso de tu dispositivo: puede tardar un poco. No actualices la página; puedes cancelar abajo.',
  'auth.login.cancel': 'Cancelar e intentar de nuevo',
  'auth.login.switchPrompt': '¿Nuevo en Truecairn?',
  'auth.login.switchLink': 'Crear una cuenta',
  'auth.login.error.timeout':
    'Se agotó el tiempo de espera de tu clave de acceso. Inténtalo de nuevo o usa otro dispositivo o navegador.',
  'auth.login.error.generic': 'No pudimos iniciar tu sesión. Inténtalo de nuevo.',

  'auth.register.heading': 'Crea tu cuenta',
  'auth.register.lede':
    'Tu bóveda se cifra en tu dispositivo. Solo almacenamos texto cifrado, nunca tus claves.',
  'auth.register.submit': 'Crear cuenta con una clave de acceso',
  'auth.register.submitBusy': 'Creando…',
  'auth.register.switchPrompt': '¿Ya tienes una cuenta?',
  'auth.register.switchLink': 'Iniciar sesión',
  'auth.register.error.conflict':
    'Ya existe una cuenta con este correo electrónico: inicia sesión en su lugar.',
  'auth.register.error.generic': 'No pudimos crear tu cuenta. Inténtalo de nuevo.',

  'auth.unlock.heading': 'Desbloquea tu bóveda',
  'auth.unlock.lede':
    'Introduce tu frase maestra. Nunca sale de este dispositivo: tus claves se derivan aquí.',
  'auth.unlock.field.passphrase': 'Frase maestra',
  'auth.unlock.submit': 'Desbloquear',
  'auth.unlock.submitBusy': 'Desbloqueando…',
  'auth.unlock.deriving': 'Derivando tus claves en este dispositivo: puede tardar unos segundos.',
  // The distinction the English comment protects survives here: "tu frase de
  // contraseña no fue el problema" must stay, and must stay unambiguous against
  // the passphrase error below it.
  'auth.unlock.error.memory':
    'Este dispositivo se quedó sin memoria al desbloquear: tu frase maestra no fue el problema. Cierra otras pestañas o aplicaciones (o prueba con otro navegador) y pulsa Desbloquear de nuevo.',
  'auth.unlock.error.passphrase': 'Esa frase maestra no desbloqueó tu bóveda.',
  'auth.unlock.recoveryPrompt': '¿Perdiste tu frase maestra?',
  'auth.unlock.recoveryLink': 'Usa tu código de recuperación',

  // ── Recuperación ──────────────────────────────────────────────────────────
  // GLOSSARY: recovery code → código de recuperación. The three error messages
  // must stay as distinct here as in English: "no parece" (you mistyped it just
  // now, fixable) is a different fact from "no desbloqueó" (this is not the code
  // for this bóveda), and showing the second for a typo would tell someone they
  // have lost their vault when they have not.
  'auth.recover.heading': 'Desbloquea con tu código de recuperación',
  'auth.recover.lede':
    'El código de 64 caracteres que recibiste al crear tu bóveda. Igual que tu frase maestra, se usa aquí en este dispositivo y nunca se nos envía.',
  'auth.recover.field.code': 'Código de recuperación',
  'auth.recover.field.hint':
    'Los espacios y los saltos de línea no importan: pégalo o escríbelo tal y como lo anotaste.',
  'auth.recover.submit': 'Desbloquear bóveda',
  'auth.recover.submitBusy': 'Desbloqueando…',
  'auth.recover.deriving': 'Derivando tus claves en este dispositivo: puede tardar unos segundos.',
  'auth.recover.error.format':
    'Esto no parece un código de recuperación. Tiene 64 caracteres y solo usa los dígitos 0–9 y las letras a–f. Comprueba si falta o sobra algún carácter.',
  'auth.recover.error.code': 'Ese código de recuperación no desbloqueó esta bóveda.',
  'auth.recover.error.memory':
    'Este dispositivo se quedó sin memoria al desbloquear: tu código de recuperación no fue el problema. Cierra otras pestañas o aplicaciones (o prueba con otro navegador) e inténtalo de nuevo.',
  'auth.recover.afterwards':
    'Esto desbloquea tu bóveda ahora. No cambia tu frase maestra, así que guarda este código en un lugar seguro: por ahora sigue siendo la forma de volver a entrar.',
  'auth.recover.backToUnlock': 'Volver a desbloquear con tu frase maestra',

  'vault.list.heading': 'Tu bóveda',
  'vault.list.loading': 'Cargando…',
  'vault.list.count_one': '{{count}} elemento',
  'vault.list.count_other': '{{count}} elementos',
  'vault.create.close': 'Cerrar',
  'vault.list.searchLabel': 'Buscar títulos',
  'vault.list.searchPlaceholder': 'Descifrados en este dispositivo',
  'vault.list.countFiltered': '{{shown}} de {{total}} visibles',
  'vault.list.emptySearch':
    'No hay coincidencias con «{{q}}». <clear>Quitar la búsqueda</clear> para ver todos los elementos.',
  'vault.list.expand': 'Detalles',
  'vault.list.collapse': 'Ocultar',
  'vault.list.added': 'Añadido el {{date}}',
  'vault.list.updated': 'Última modificación: {{date}}',
  'vault.list.reorder': 'Arrastra para reordenar',
  'vault.list.sealedNote':
    'El contenido sigue sellado. Al abrirlo se descifra solo en este dispositivo: nada se descarga en claro.',
  'vault.list.decrypt': 'Descifrar el contenido',
  'vault.list.decrypting': 'Descifrando…',
  'vault.list.decryptError': 'No pudimos descifrar este elemento en este dispositivo.',
  'vault.list.contentLabel': 'contenido del elemento',
  'vault.list.reseal': 'Volver a sellar',
  'vault.list.openFull': 'Abrir el elemento completo',
  'vault.list.filterLabel': 'Filtrar por nivel',
  'vault.list.allTiers': 'Todos los niveles',
  'vault.list.error': 'No pudimos cargar tu bóveda.',
  'vault.list.emptyAll':
    'Aún no hay elementos. Crea el primero arriba: se cifra en tu dispositivo.',
  'vault.list.emptyFiltered':
    'No hay elementos {{tier}}. <clear>Quitar el filtro</clear> para ver todos los niveles.',
  'vault.list.titleUnavailable': 'Título no disponible: el elemento se puede abrir igualmente',
  'vault.list.pendingDelete': 'eliminación {{date}}',

  'vault.locked.reason.release_review': 'se está revisando una liberación',
  'vault.locked.reason.limited_release': 'hay una liberación en curso',
  'vault.locked.reason.staged_release': 'hay una liberación en curso',
  'vault.locked.reason.full_release': 'se ha completado una liberación',
  'vault.locked.reason.returning': 'estás confirmando tu regreso tras una liberación',
  'vault.locked.reason.review_required': 'tu motor de continuidad está en pausa para revisión',
  'vault.locked.banner':
    'La edición está en pausa porque {{reason}}, así que ahora mismo no se pueden añadir ni cambiar elementos de la bóveda. <engine>Ve a la página del Motor</engine> para confirmar tu actividad o resolverlo: eso vuelve a habilitar la edición.',

  'vault.attach.dropHint': 'Arrastra archivos aquí, o',
  'vault.attach.encryptedNote':
    'Se cifran en este dispositivo antes de subirlos: incluso el nombre del archivo viaja dentro del cifrado.',
  'vault.attach.remove': 'Quitar',

  'vault.create.heading': 'Nuevo elemento de la bóveda',
  'vault.create.lede': 'Se cifra en tu dispositivo antes de salir de él.',
  'vault.create.field.tier': 'Nivel',
  'vault.create.field.category': 'Categoría',
  'vault.create.field.title': 'Título',
  'vault.create.field.content': 'Contenido',
  'vault.create.field.attachments': 'Archivos adjuntos (opcional)',
  'vault.create.guidance.who': 'A quién llega un elemento de <strong>{{category}}</strong>:',
  'vault.create.guidance.pickedTier': ' (el nivel que elegiste)',
  'vault.create.guidance.never': 'Nunca',
  'vault.create.guidance.advisory':
    'Es una sugerencia, no una regla: se aplica el nivel que elijas.',
  'vault.create.phase.saving': 'Cifrando y guardando…',
  'vault.create.phase.uploading': 'Cifrando y subiendo {{n}} de {{total}}…',
  'vault.create.submit': 'Guardar elemento',
  'vault.create.submitBusy': 'Guardando…',
  'vault.create.error.generic': 'No pudimos guardar este elemento. Inténtalo de nuevo.',
  'vault.create.error.limit': 'Has alcanzado el límite de elementos de tu plan gratuito.',
  'vault.create.error.locked':
    'Tu bóveda está bloqueada porque hay una liberación o revisión en curso, así que ahora mismo no se pueden añadir ni editar elementos. Ve a la página del Motor para confirmar tu actividad (o resolver la revisión): eso vuelve a habilitar la edición.',
  'vault.create.upgradeLink': 'Cambiar al plan Personal',
  'vault.create.engineLink': 'Ve a la página del Motor',
  'vault.create.partial_one':
    'Guardado, pero {{count}} archivo no se adjuntó ({{files}}). <open>Abre el elemento</open> para añadirlo.',
  'vault.create.partial_other':
    'Guardado, pero {{count}} archivos no se adjuntaron ({{files}}). <open>Abre el elemento</open> para añadirlos.',

  'vault.captures.heading': 'Enviado desde tu teléfono',
  'vault.captures.count': '{{count}} en espera',
  'vault.captures.waiting_one':
    'Hay un elemento esperando a archivarse. Tu teléfono lo selló con la clave de tu bóveda y no puede volver a abrirlo: solo tu frase maestra, aquí, puede hacerlo.',
  'vault.captures.waiting_other':
    'Hay {{count}} elementos esperando a archivarse. Tu teléfono los selló con la clave de tu bóveda y no puede volver a abrirlos: solo tu frase maestra, aquí, puede hacerlo.',
  'vault.captures.filingNote':
    '<strong>Archivar es lo que incorpora un elemento a tu plan de liberación.</strong> Hasta que lo archives, una captura queda sellada con una clave que solo tú tienes, así que tus contactos de confianza no la recibirían aunque se completara una liberación.',
  'vault.captures.error':
    'No pudimos archivar esa captura. Sigue aquí: no se ha perdido nada. Inténtalo de nuevo.',
  'vault.captures.partial':
    'El elemento se guardó, pero {{files}} no se subió. La captura sigue aquí para que puedas volver a intentarlo.',
  'vault.captures.sealedBox': 'caja sellada',
  'vault.captures.arrived': 'Llegó {{when}}',
  'vault.captures.file': 'Archivarlo',
  'vault.captures.filing': 'Archivando…',
  'vault.captures.phase.opening': 'Abriendo…',
  'vault.captures.phase.saving': 'Guardando en tu bóveda…',
  'vault.captures.phase.reencrypting': 'Volviendo a cifrar el archivo {{n}} de {{total}}…',
  'vault.captures.phase.clearing': 'Borrando la captura…',
  'vault.captures.discard': 'Descartar',
  'vault.captures.privacyNote':
    'Los títulos y contenidos permanecen cifrados hasta que archives: esta lista solo muestra el nivel, el tamaño y cuándo llegó cada uno.',

  'dash.greeting.morning': 'Buenos días.',
  'dash.greeting.afternoon': 'Buenas tardes.',
  'dash.greeting.evening': 'Buenas noches.',
  'dash.newItem': 'Nuevo elemento',
  'dash.summary.idle': 'Este es el estado de tu configuración de continuidad.',
  'dash.summary.unknownReadiness':
    'Tu motor está activo. Tu próxima confirmación de actividad es en {{next}}.',
  'dash.summary.healthy':
    'Todo está en orden. Tu próxima confirmación de actividad es en {{next}}.',
  'dash.summary.blockers_one':
    'Tu motor está funcionando, pero {{count}} cosa impediría completar una liberación. Tu próxima confirmación de actividad es en {{next}}.',
  'dash.summary.blockers_other':
    'Tu motor está funcionando, pero {{count}} cosas impedirían completar una liberación. Tu próxima confirmación de actividad es en {{next}}.',

  'dash.readiness.caption': 'Preparación de continuidad',
  'dash.readiness.blocked': 'Hoy no se podría completar una liberación',

  'dash.tile.vaultItems': 'Elementos de la bóveda',
  'dash.tile.vaultItems.empty': 'Aún no hay nada guardado',
  'dash.tile.vaultItems.sub': 'Cifrados en tu dispositivo',
  'dash.tile.contacts': 'Contactos de confianza',
  'dash.tile.contacts.empty': 'Aún no has añadido ninguno',
  'dash.tile.contacts.sub': '{{count}} inscritos',
  'dash.tile.engine': 'Motor',
  'dash.tile.engine.liveness': 'Estado de actividad',
  'dash.tile.engine.running': 'En marcha',
  'dash.tile.engine.allHealthy': 'Todo en orden',
  'dash.tile.engine.blockers_one': '{{count}} bloqueo',
  'dash.tile.engine.blockers_other': '{{count}} bloqueos',
  'dash.tile.nextCheckIn': 'Próxima confirmación',
  'dash.nextCheckIn.none': '—',
  'dash.nextCheckIn.noneSub': 'Aún no hay ninguna confirmación programada',
  'dash.nextCheckIn.due': 'Pendiente',
  'dash.nextCheckIn.days': '{{days}} d',


  'dash.gap.no_vault_items.title': 'Añade tu primer elemento a la bóveda',
  'dash.gap.no_vault_items.sub': 'Se cifra en tu dispositivo antes de salir de él.',
  'dash.gap.no_vault_items.cta': 'Añadir',
  'dash.gap.no_enrolled_contacts.title': 'Inscribe a un contacto de confianza',
  'dash.gap.no_enrolled_contacts.sub':
    'Recibirán tus instrucciones de liberación si dejas de dar señales.',
  'dash.gap.no_enrolled_contacts.cta': 'Añadir',
  'dash.gap.s1_beneficiary_unset.title': 'Designa un beneficiario para tu nivel S1',
  'dash.gap.s1_beneficiary_unset.sub':
    'Un nivel S1 se libera a un beneficiario designado. Sin uno, no tiene destinatario.',
  'dash.gap.s1_beneficiary_unset.cta': 'Abrir',
  'dash.gap.s2_coverage_insufficient.title': 'Asigna más partes de contacto para S2',
  'dash.gap.s2_coverage_insufficient.sub':
    'Muy pocos contactos tienen una parte como para que este nivel pueda reconstruirse.',
  'dash.gap.s2_coverage_insufficient.cta': 'Asignar',
  'dash.gap.s3_coverage_insufficient.title': 'Asigna más partes de contacto para S3',
  'dash.gap.s3_coverage_insufficient.sub':
    'Muy pocos contactos tienen una parte como para que este nivel pueda reconstruirse.',
  'dash.gap.s3_coverage_insufficient.cta': 'Asignar',
  'dash.gap.s2_role_diversity_unsatisfiable.title': 'Añade un contacto S2 con otro rol',
  'dash.gap.s2_role_diversity_unsatisfiable.sub':
    'Un consenso de liberación debe abarcar dos roles de contacto distintos, así que tal como está este nivel no podrá reconstruirse nunca.',
  'dash.gap.s2_role_diversity_unsatisfiable.cta': 'Añadir',
  'dash.gap.s3_role_diversity_unsatisfiable.title': 'Añade un contacto S3 con otro rol',
  'dash.gap.s3_role_diversity_unsatisfiable.sub':
    'Un consenso de liberación debe abarcar dos roles de contacto distintos, así que tal como está este nivel no podrá reconstruirse nunca.',
  'dash.gap.s3_role_diversity_unsatisfiable.cta': 'Añadir',
  'dash.gap.s2_passphrase_slot_unset.title': 'Configura tu frase de liberación para S2',
  'dash.gap.s2_passphrase_slot_unset.sub':
    'Tu frase de liberación sin conexión es la última parte fija de S2.',
  'dash.gap.s2_passphrase_slot_unset.cta': 'Configurar',
  'dash.gap.engine_not_armed.title': 'Activa tu motor de continuidad',
  'dash.gap.engine_not_armed.sub':
    'Hasta que lo actives, no hay ninguna programación de confirmaciones en marcha.',
  'dash.gap.engine_not_armed.cta': 'Abrir el motor',
  'dash.gap.checkin_overdue.title': 'Confirma que estás activo (confirmación vencida)',
  'dash.gap.checkin_overdue.sub': 'Confirma que estás activo para detener la escalada.',
  'dash.gap.checkin_overdue.cta': 'Confirmar actividad',
  'dash.gap.stale_items.title': 'Revisa los elementos que no has tocado en un tiempo',
  'dash.gap.stale_items.sub':
    'Los elementos que no has revisado en un tiempo pueden estar desactualizados.',
  'dash.gap.stale_items.cta': 'Revisar',
  'dash.gap.no_verified_channel.title': 'Añade una vía verificada de contacto',
  'dash.gap.no_verified_channel.sub':
    'Tu motor está en marcha, pero una solicitud de confirmación no tiene adónde ir. Las confirmaciones sin respuesta escalan hacia una liberación.',
  'dash.gap.no_verified_channel.cta': 'Añadir',
  'dash.gap.contact_key_unconfirmed.title': 'Confirma el código de seguridad de un contacto',
  'dash.gap.contact_key_unconfirmed.sub':
    'Hasta que compares su código de seguridad con esa persona directamente —por teléfono o en persona—, no puede tener una parte de tu liberación.',
  'dash.gap.contact_key_unconfirmed.cta': 'Confirmar',
  'dash.gap.unknown.title': 'Revisa un punto de preparación',
  'dash.gap.unknown.sub': 'Revisa esto para que tu liberación pueda completarse.',
  'dash.gap.unknown.cta': 'Abrir',
  'dash.gap.detail.shares':
    '{{assigned}} de {{needed}} partes de contacto necesarios asignados. {{base}}',
  'dash.gap.detail.awaiting_one': '{{count}} contacto pendiente de confirmación. {{base}}',
  'dash.gap.detail.awaiting_other': '{{count}} contactos pendientes de confirmación. {{base}}',
  'dash.gap.detail.stale_one': '{{count}} elemento sin tocar desde hace más de 180 días. {{base}}',
  'dash.gap.detail.stale_other':
    '{{count}} elementos sin tocar desde hace más de 180 días. {{base}}',

  'dash.checkups.heading': 'Revisiones de continuidad',
  'dash.checkups.none': 'Vas bien: no hay nada que hacer ahora mismo.',
  'dash.checkups.count_one': '{{count}} punto por revisar. Tómatelo con calma.',
  'dash.checkups.count_other': '{{count}} puntos por revisar. Tómatelo con calma.',
  'dash.checkups.emptyBody': 'Tu bóveda, tus contactos y tu motor están todos en buen estado.',
  'dash.checkups.local.noItems.title': 'Añade tu primer elemento a la bóveda',
  'dash.checkups.local.noItems.sub': 'Se cifra en tu dispositivo antes de salir de él.',
  'dash.checkups.local.noContacts.title': 'Añade un contacto de confianza',
  'dash.checkups.local.noContacts.sub':
    'Recibirán tus instrucciones de liberación si dejas de dar señales.',
  'dash.checkups.local.pending.title_one': 'Termina de inscribir a {{count}} contacto',
  'dash.checkups.local.pending.title_other': 'Termina de inscribir a {{count}} contactos',
  'dash.checkups.local.pending.sub':
    'Un contacto solo puede tener una parte de la liberación después de terminar su inscripción y de que confirmes con él su código de seguridad.',
  'dash.checkups.local.secondContact.title': 'Añade un segundo contacto de confianza',
  'dash.checkups.local.secondContact.sub': 'Un consenso de dos entre dos es mucho más sólido que uno.',
  'dash.checkups.cta.add': 'Añadir',
  'dash.checkups.cta.open': 'Abrir',

  'dash.plan.heading': 'Tu plan con IA',
  'dash.plan.sub':
    'Próximos pasos priorizados, elegidos por Gemini a partir de las señales de tu cuenta.',
  'dash.plan.unavailable':
    'No se ha podido generar un plan ahora mismo: prueba a actualizar en un momento.',
  'dash.plan.cta.add_vault_item': 'Abrir la bóveda',
  'dash.plan.cta.add_contact': 'Añadir contacto',
  'dash.plan.cta.enrol_contact': 'Abrir contactos',
  'dash.plan.cta.assign_shares': 'Asignar partes',
  'dash.plan.cta.arm_engine': 'Abrir el motor',
  'dash.plan.cta.review': 'Revisar',
  'dash.plan.cta.fallback': 'Abrir',

  'dash.proposals.heading': 'Propuestas de la IA',
  'dash.proposals.sub':
    'Sugerencias a partir de las señales de tu cuenta. Tú decides: no ocurre nada sin tu aprobación.',
  'dash.proposals.suggested': 'Sugerido el {{date}}',
  'dash.proposals.dismiss': 'Descartar',
  'dash.proposals.accept': 'Aceptar',
  'dash.proposals.label.tighten':
    'Acorta tu intervalo de confirmación de {{from}} a {{to}} días',
  'dash.proposals.label.draftMessage': 'Revisa un mensaje redactado para un contacto',
  'dash.proposals.label.recategorize': 'Plantéate recategorizar algunos elementos',
  'dash.proposals.label.unknown': 'Revisa una sugerencia de la IA',

  'dash.activity.heading': 'Actividad reciente',
  'dash.activity.sub': 'Cada evento va firmado y con marca de tiempo.',
  'dash.activity.empty':
    'Aún no hay nada que mostrar. Aquí aparecerán las confirmaciones, las ediciones, las verificaciones de contactos y los eventos de liberación.',

  'dash.contacts.heading': 'Contactos de confianza',
  'dash.checkups.aiSuggested': 'Sugerido por la IA',
  'dash.checkups.close': 'Cerrar',
  'dash.contacts.finish': 'Terminar',
  'dash.contacts.more': '{{count}} más →',
  'dash.vault.heading': 'Bóveda',
  'dash.vault.count_one': '{{count}} elemento, cifrado en tu dispositivo',
  'dash.vault.count_other': '{{count}} elementos, cifrados en tu dispositivo',
  'dash.vault.new': 'Nuevo',
  'dash.vault.empty':
    'Aún no hay elementos. El primero se cifra en tu dispositivo antes de salir de él.',
  'dash.vault.addFirst': 'Añadir el primer elemento',
  'dash.vault.more': '{{count}} más →',
  'dash.contacts.count_one': '{{count}} contacto · {{enrolled}} inscritos',
  'dash.contacts.count_other': '{{count}} contactos · {{enrolled}} inscritos',
  'dash.contacts.add': 'Añadir',
  'dash.contacts.empty':
    'Aún no has añadido ningún contacto de confianza. Recibirán tus instrucciones de liberación si dejas de dar señales.',
  'dash.contacts.addFirst': 'Añadir el primer contacto',
  'dash.contacts.enrolled': 'Inscrito',
  'dash.role.personal': 'Contacto personal',
  'dash.role.professional': 'Contacto profesional',
  'dash.role.recovery': 'Contacto de recuperación',
  'dash.role.fallback': 'Contacto',

  'engine.loading': 'Cargando…',
  'engine.eyebrow': 'Continuidad',

  // ── Nombres de los estados del motor ──────────────────────────────────────
  'engine.state.none': 'Sin iniciar',
  'engine.state.pre_active': 'Sin armar',
  'engine.state.active': 'Activo',
  'engine.state.check_in_pending': 'Confirmación pendiente',
  'engine.state.notification_stalled': 'Los avisos no están llegando',
  'engine.state.escalation_pending': 'Escalando',
  'engine.state.release_review': 'En revisión',
  'engine.state.limited_release': 'Liberación limitada',
  'engine.state.staged_release': 'Liberación por fases',
  'engine.state.full_release': 'Liberación completa',
  'engine.state.returning': 'Confirmando tu regreso',
  'engine.state.review_required': 'En espera de revisión',

  // ── Escalera de liberación ────────────────────────────────────────────────
  'engine.ladder.heading': 'Escalera de liberación',
  'engine.ladder.sub':
    'Cada paso es lento, reversible y auditado. Puedes detenerlo en cualquier peldaño anterior.',
  'engine.ladder.aside': 'En pausa aquí: {{state}}.',
  'engine.ladder.before': 'Nada de esta escalera se aplica hasta que el motor esté armado.',
  'engine.ladder.current': 'Paso actual',
  'engine.heading': 'Tu motor de continuidad',
  'engine.lede': 'Tu estado de actividad y el próximo paso automático.',

  'engine.unarmed.heading': 'Tu motor de continuidad aún no está activado',
  'engine.unarmed.body':
    'Activarlo pone en marcha la supervisión de actividad: si más adelante dejas de dar señales pasada tu ventana de confirmación, comienza la escalera de liberación, despacio, de forma reversible y con cada paso cancelable. Antes necesitas al menos un contacto de confianza inscrito (alguien a quien liberar); añade también un elemento a la bóveda, para que haya algo que liberar.',
  'engine.unarmed.prereq':
    'Aún no puedes activarlo: primero inscribe a un contacto de confianza, porque una liberación necesita a alguien a quien confiar tu bóveda. <contacts>Añadir un contacto →</contacts>',
  'engine.unarmed.arm': 'Activar el motor',
  'engine.unarmed.arming': 'Activando…',
  'engine.unarmed.setup': 'Ir a la configuración',

  'engine.nextAction': 'Próximo paso automático: {{when}}',
  'engine.snoozedUntil': 'Pospuesto hasta {{when}}',

  'engine.escalating.body':
    'Se está avisando a tus contactos de que quizá no se te pueda localizar. Si es un error, confírmalo abajo para detener la escalada.',
  'engine.escalating.ack': 'Confirmar y registrar mi actividad',

  'engine.checkin.title': 'Confirma que sigues aquí',
  'engine.checkin.sub': 'Un toque reinicia la cuenta atrás de confirmación.',
  'engine.checkin.action': 'Confirmar actividad',
  'engine.snooze.label': 'Días de aplazamiento',
  'engine.snooze.action': 'Aplazar',

  'engine.release.stage.release_review.name': 'Revisión de liberación',
  'engine.release.stage.release_review.atStake':
    'Se está pidiendo confirmación a tus contactos de confianza. Todavía no se ha liberado nada.',
  'engine.release.stage.limited_release.name': 'Liberación limitada (S1)',
  'engine.release.stage.limited_release.atStake':
    'Tu nivel más accesible ya puede ser reconstruido por tus contactos.',
  'engine.release.stage.staged_release.name': 'Liberación por fases (S2)',
  'engine.release.stage.staged_release.atStake':
    'Se está preparando otro nivel para liberarlo a tus contactos.',
  'engine.release.next': 'Siguiente fase: {{when}}',
  'engine.release.warning':
    'Hay una liberación de tu bóveda en curso. Si estás leyendo esto, deténla.',
  'engine.release.cancel': 'Cancelar la liberación',

  'engine.returning.heading': 'Creíamos que ya no estabas: confirma que has vuelto',
  'engine.returning.body':
    'Había una liberación en curso y has iniciado sesión, así que tu motor de continuidad <strong>la ha pausado</strong>. Mientras esté en pausa no se libera nada más.',
  'engine.returning.expiry':
    'Confirma abajo (tu dispositivo te pedirá tu clave de acceso) y la liberación se cancelará por completo, con la supervisión reactivada sobre un nuevo plazo de confirmación. <strong>Si no haces nada, la pausa vence{{when}} y la liberación se reanuda donde se quedó.</strong>',
  'engine.returning.expiryWhen': ' el {{when}}',
  'engine.returning.confirm': 'Estoy aquí: confirmar y cancelar la liberación',

  'engine.review.heading': 'En espera de revisión',
  'engine.review.body':
    'Se detuvo un intento de liberación —falló una ceremonia, o alguien informó de que estás con vida— y tu motor de continuidad está en pausa. <strong>No se está liberando nada.</strong> Las confirmaciones de actividad también están en pausa hasta que resuelvas esto.',
  'engine.review.sub':
    'Si todo está bien, confirma abajo que eres tú (tu dispositivo te pedirá tu clave de acceso) y la supervisión se reactivará con un nuevo plazo de confirmación.',
  'engine.review.resolve': 'Estoy aquí: resolver y reactivar',

  'engine.pending.heading': 'Acciones pendientes',
  'engine.pending.sub':
    'Los cambios delicados esperan 7 días antes de aplicarse: esa espera es la protección. Se pueden cancelar hasta que surtan efecto.',
  'engine.pending.aiBadge': 'Propuesto por la IA',
  'engine.pending.effective': 'surte efecto el {{when}} (cancelable hasta entonces)',
  'engine.pending.effectiveAi':
    'Propuesto por la IA: surte efecto el {{when}} (cancelable hasta entonces)',
  'engine.pending.cancel': 'Cancelar',

  'engine.action.add_contact': 'Dar a un contacto una parte de la liberación',
  'engine.action.remove_contact': 'Eliminar un contacto',
  'engine.action.remove_channel': 'Eliminar un canal de notificación',
  'engine.action.change_contact_role': 'Cambiar el rol de un contacto',
  'engine.action.rotate_contact': 'Rotar las claves de un contacto',
  'engine.action.designate_beneficiary': 'Designar un beneficiario',
  'engine.action.remove_beneficiary': 'Eliminar un beneficiario',
  'engine.action.change_share_composition': 'Cambiar la composición de partes de la liberación',
  'engine.action.change_tier_configuration': 'Cambiar la configuración de un nivel',
  'engine.action.change_inactivity_threshold': 'Cambiar el intervalo de confirmación',
  'engine.action.change_cooldown_window': 'Cambiar el periodo de espera de la liberación',
  'engine.action.rotate_master_passphrase': 'Rotar la frase maestra',
  'engine.action.rotate_release_passphrase': 'Rotar la frase de liberación',
  'engine.action.rotate_recovery_code': 'Rotar el código de recuperación',
  'engine.action.register_hardware_key': 'Registrar una llave de hardware',
  'engine.action.remove_hardware_key': 'Eliminar una llave de hardware',
  'engine.action.change_email': 'Cambiar el correo de la cuenta',
  'engine.action.arm_engine': 'Activar el motor de continuidad',
  'engine.action.delete_account': 'Eliminar la cuenta',
  'engine.action.set_vault_item_tier': 'Mover un elemento de la bóveda a otro nivel',
  'engine.action.delete_vault_item': 'Eliminar un elemento de la bóveda',
  'engine.action.purge_attachment': 'Purgar un archivo adjunto',

  'engine.error.arm': 'No pudimos activar el motor.',
  'engine.error.checkIn': 'No pudimos registrar tu actividad.',
  'engine.error.snooze': 'No pudimos aplazarlo.',
  'engine.error.cancelRelease': 'No pudimos cancelar la liberación.',
  'engine.error.confirmReturn':
    'No pudimos confirmar tu regreso: puede que la confirmación con la clave de acceso fallara. No se ha cambiado nada; inténtalo de nuevo.',
  'engine.error.resolveReview':
    'No pudimos resolver la revisión: puede que la confirmación con la clave de acceso fallara. No se ha cambiado nada; inténtalo de nuevo.',
  'engine.error.cancelAction': 'No pudimos cancelar esa acción.',

  'release.progress.heading': 'Progreso de la liberación',
  'release.progress.lede':
    'El estado en vivo de tus ceremonias de liberación: exactamente qué se está pidiendo a tus contactos y quién ha respondido. Si estás leyendo esto y todo va bien, usa los controles de protección de arriba —confirmar tu actividad, cancelar la liberación o resolver la revisión— y se avisará a tus contactos.',
  'release.progress.tier.s1': 'S1 — sobre sellado',
  'release.progress.tier.s2': 'S2 — consenso de 2 entre 3',
  'release.progress.tier.s3': 'S3 — consenso de 3 entre 4',
  'release.progress.status.initiated': 'Preparando',
  'release.progress.status.collecting_affirmations': 'Esperando a tus contactos',
  'release.progress.status.awaiting_outer_key': 'Consenso alcanzado: espera final',
  'release.progress.status.reconstructing': 'Abierta: los contactos pueden recuperarla',
  'release.progress.status.released': 'Recuperada',
  'release.progress.status.cancelled': 'Cancelada',
  'release.progress.status.failed': 'Detenida de forma segura',
  'release.progress.reason.sync_window_expired_below_threshold':
    'La ventana de recogida se cerró sin suficientes confirmaciones: no se liberó nada.',
  'release.progress.reason.reconstruction_timed_out':
    'La ventana de recuperación venció: la puerta se cerró de nuevo sin ninguna recuperación.',
  'release.progress.reason.user_returned': 'Has vuelto: la liberación se canceló.',
  'release.progress.reason.dispute_raised':
    'Un contacto informó de que estás con vida: la liberación se detuvo para revisión.',
  'release.progress.role.personal': 'Personal',
  'release.progress.role.professional': 'Profesional',
  'release.progress.role.recovery': 'Recuperación',
  'release.progress.unnamedContact': 'Un contacto de confianza',
  'release.progress.consensus': '{{committed}} de {{threshold}} confirmaciones necesarias',
  'release.progress.windowCloses': ' · la ventana de recogida se cierra el {{when}}',
  'release.progress.gateOpened': ' · puerta abierta el {{when}}',
  'release.progress.aff.tentativeUntil': 'Confirmado: aún revocable hasta el {{when}}',
  'release.progress.aff.tentative': 'Confirmado: aún revocable',
  'release.progress.aff.committedAt': 'Confirmado el {{when}}',
  'release.progress.aff.committed': 'Confirmado',
  'release.progress.aff.revokedAt': 'Revocado el {{when}}',
  'release.progress.aff.revoked': 'Revocado',
  'release.progress.aff.none': 'Aún no ha respondido',
  'release.progress.rcp.retrievedAt': 'Recuperó su liberación el {{when}}',
  'release.progress.rcp.retrieved': 'Recuperó su liberación',
  'release.progress.rcp.none': 'Aún no la ha recuperado',

  'ai.disclosure.body':
    'La IA solo puede añadir comprobaciones de seguridad, nunca quitarlas: ve recuentos y ajustes, nunca tu contenido cifrado, tus nombres ni tus claves.',
  'ai.disclosure.link': 'Cómo usa Truecairn la IA →',

  'shell.nav.home': 'Inicio',
  'shell.nav.vault': 'Bóveda',
  'shell.nav.plans': 'Planes',
  'shell.nav.contacts': 'Contactos',
  'shell.nav.engine': 'Motor',
  'shell.nav.ceremony': 'Ceremonia',
  'shell.nav.assistant': 'Asistente',
  'shell.nav.more': 'Más',
  'shell.nav.acceptInvite': 'Aceptar invitación',
  'shell.nav.settings': 'Ajustes',
  'shell.skipToContent': 'Saltar al contenido principal',
  'shell.openNav': 'Abrir el menú de navegación',
  'shell.search': 'Buscar',
  'shell.brandHome': 'Truecairn: inicio',
  'shell.loading': 'Cargando…',

  // ── Paleta de comandos (⌘K) ───────────────────────────────────────────────
  'palette.label': 'Buscar y ejecutar',
  'palette.placeholder': 'Busca acciones, contactos y títulos de la bóveda',
  'palette.esc': 'esc',
  'palette.empty':
    'No hay coincidencias. Prueba con el nombre de un contacto o un título de la bóveda.',
  'palette.hint.move': '↑↓ mover',
  'palette.hint.run': '↵ ejecutar',
  'palette.hint.local': 'Se ejecuta en tu dispositivo. No se envía nada a ninguna parte.',
  'palette.group.go': 'Ir a',
  'palette.group.vault': 'Bóveda',
  'palette.group.contacts': 'Contactos',
  'palette.go.home': 'Ir a Inicio',
  'palette.go.vault': 'Ir a Bóveda',
  'palette.go.plans': 'Ir a Planes',
  'palette.go.contacts': 'Ir a Contactos',
  'palette.go.engine': 'Ir a Motor',
  'palette.go.ceremony': 'Ir a Ceremonia',
  'palette.go.assistant': 'Ir a Asistente',
  'palette.go.settings': 'Ir a Ajustes',
  'palette.go.acceptInvite': 'Ir a Aceptar invitación',

  'account.menu.label': 'Cuenta',
  'account.menu.vaultUnlocked': 'Bóveda desbloqueada',
  'account.menu.vaultLocked': 'Bóveda bloqueada',
  'account.menu.settings': 'Ajustes',
  'account.menu.plans': 'Planes',
  'account.menu.guide': 'Guía de uso',
  'account.menu.signOut': 'Cerrar sesión',
  'account.menu.signingOut': 'Cerrando sesión…',
  'account.menu.yourAccount': 'Tu cuenta',
  'account.plan.personal': 'Personal',
  'account.plan.free': 'Gratis',

  'assistant.eyebrow': 'Ayuda',
  'assistant.heading': 'Asistente',
  'assistant.lede':
    'Pregunta cómo funciona Truecairn o qué hacer a continuación. Solo ve los metadatos de tu cuenta, nunca tu contenido cifrado.',
  'assistant.field.question': 'Tu pregunta',
  'assistant.placeholder': 'p. ej. ¿Cómo añado un contacto de confianza?',
  'assistant.note': 'No pegues aquí contraseñas, frases de contraseña ni códigos de recuperación.',
  'assistant.ask': 'Preguntar',
  'assistant.thinking': 'Pensando…',
  'assistant.suggestion.release': '¿Cómo funciona el proceso de liberación?',
  'assistant.suggestion.passphrase': '¿Qué pasa si pierdo mi frase de liberación?',
  'assistant.suggestion.s2': '¿Cuántos contactos necesito para una liberación S2?',
  'assistant.error.sensitive':
    'Parece que eso contiene una de tus frases o un código de recuperación. Quítalo y haz tu pregunta sin él: el asistente nunca necesita ninguno de tus secretos.',
  'assistant.error.unavailable':
    'El asistente no está disponible ahora mismo. Inténtalo de nuevo en un momento.',
  'assistant.error.generic': 'Algo ha ido mal. Inténtalo de nuevo.',

  'upgrade.back': 'Volver a la bóveda',
  'upgrade.title': 'Planes que protegen lo que importa',
  'upgrade.lead':
    'El plan gratuito cubre toda la maquinaria de seguridad por correo y notificaciones push. Personal añade los canales de verificación de pago, para poder localizarte por todas las vías que hayas configurado cuando de verdad importa.',
  'upgrade.period.label': 'Periodo de facturación',
  'upgrade.period.monthly': 'Mensual',
  'upgrade.period.yearly': 'Anual',
  'upgrade.period.save': 'Ahorra un {{pct}} %',
  'upgrade.free.name': 'Gratis',
  'upgrade.free.per': 'para siempre',
  'upgrade.free.desc':
    'Suficiente para empezar: la ceremonia de liberación completa, por correo y push.',
  'upgrade.free.included': 'Incluido',
  'upgrade.free.yourPlan': 'Tu plan',
  'upgrade.free.feat.contacts': 'Hasta {{count}} contactos de confianza',
  'upgrade.free.feat.items': 'Hasta {{count}} elementos en la bóveda',
  'upgrade.feat.attachments': '{{size}} de archivos adjuntos cifrados',
  'upgrade.feat.tiers': 'Niveles de liberación {{tiers}}',
  'upgrade.free.feat.channels': 'Confirmaciones por correo y push',
  'upgrade.personal.name': 'Personal',
  'upgrade.personal.popular': 'El más elegido',
  'upgrade.personal.per': '/ mes',
  'upgrade.personal.billedYearly': '{{total}} USD facturados al año: ahorras {{saving}} USD',
  'upgrade.personal.billedMonthly': '{{total}} USD facturados al mes',
  'upgrade.personal.desc':
    'Para quien se toma en serio la continuidad, tanto en lo profesional como en lo personal.',
  'upgrade.personal.current': 'Plan actual',
  'upgrade.personal.cta': 'Cambiar al plan Personal',
  'upgrade.personal.opening': 'Abriendo el pago…',
  'upgrade.personal.feat.everything': 'Todo lo del plan gratuito',
  'upgrade.personal.feat.contacts': 'Contactos de confianza ilimitados',
  'upgrade.personal.feat.items': 'Elementos de la bóveda ilimitados',
  'upgrade.personal.feat.sms': 'Verificación por SMS',
  'upgrade.personal.feat.multichannel': 'Comprobaciones de continuidad multicanal',
  'upgrade.renews': 'Tu plan Personal se renueva el {{when}}.',
  'upgrade.error.checkout':
    'No pudimos abrir el pago: puede que las mejoras de plan aún no estén configuradas. Inténtalo más tarde.',
  'upgrade.fineprint':
    'Pago seguro a través de LemonSqueezy. Precios en USD. Cancela cuando quieras: un plan cancelado mantiene el acceso hasta que termine el periodo.',
  'upgrade.manageSubscription': 'Gestionar tu suscripción',

  'onboarding.welcome.heading': 'Configura Truecairn',
  'onboarding.welcome.body':
    'Vas a elegir una frase maestra. Nunca la vemos y no podemos restablecerla: es la única llave de tu bóveda.',
  'onboarding.welcome.begin': 'Empezar',
  'onboarding.pass.heading': 'Elige tu frase maestra',
  'onboarding.pass.lede':
    'Al menos 8 caracteres. Es la única llave de tu bóveda y no se puede restablecer nunca.',
  'onboarding.pass.field': 'Frase maestra',
  'onboarding.pass.confirmField': 'Confirma la frase maestra',
  'onboarding.pass.submit': 'Continuar',
  'onboarding.pass.submitBusy': 'Configurando…',
  'onboarding.pass.working':
    'Configurando tu cifrado en este dispositivo: puede tardar unos segundos.',
  'onboarding.error.tooShort': 'Tu frase maestra debe tener al menos 8 caracteres.',
  'onboarding.error.mismatch': 'Las frases de contraseña no coinciden.',
  'onboarding.error.memory':
    'Tu navegador no ha podido dar a esta página memoria suficiente para configurar tu cifrado. Cierra otras pestañas o ventanas (o prueba con otro navegador) y vuelve a pulsar Continuar.',
  'onboarding.error.generic': 'No pudimos completar la configuración. Inténtalo de nuevo.',
  'onboarding.recovery.heading': 'Guarda tu código de recuperación',
  'onboarding.recovery.lede':
    'Es la única forma de recuperar tu bóveda si olvidas tu frase maestra. Anótalo y guárdalo en un lugar seguro: no podemos volver a mostrarlo.',
  'onboarding.recovery.label': 'código de recuperación',
  'onboarding.recovery.copy': 'Copiar el código',
  'onboarding.recovery.copied': 'Copiado ✓',
  'onboarding.recovery.saved': 'Lo he guardado',
  'onboarding.done.heading': 'Todo listo',
  'onboarding.done.body': 'Tu bóveda está desbloqueada y lista.',
  'onboarding.done.cta': 'Ir a tu bóveda',

  'audit.heading': 'Tu registro de auditoría',
  'audit.lede':
    'Cada acción significativa en tu cuenta, en una cadena a prueba de manipulaciones que puedes comprobar tú mismo.',
  'audit.loading': 'Cargando…',
  'audit.verify': 'Verificar en este dispositivo',
  'audit.download': 'Descargar',
  'audit.verdict.ok_one':
    '✅ Se ha comprobado {{count}} registro en este dispositivo. Cada uno coincide con su propia huella y enlaza con el anterior.',
  'audit.verdict.ok_other':
    '✅ Se han comprobado {{count}} registros en este dispositivo. Cada uno coincide con su propia huella y enlaza con el anterior.',
  'audit.verdict.broken':
    '⚠️ El registro {{seq}} ha fallado: {{why}}. Ponte en contacto con nosotros: esto no debería ocurrir nunca, y es exactamente lo que esta comprobación existe para detectar.',
  'audit.broken.outOfOrder': 'falta una entrada o está fuera de orden',
  'audit.broken.notLinked': 'esta entrada no enlaza con la anterior',
  'audit.broken.badHash': 'el registro no coincide con su propia huella',
  'audit.caveat':
    'La verificación se ejecuta en tu navegador sobre los registros de arriba: no le preguntamos a nuestro propio servidor si ha sido honesto. Confirma que la cadena está intacta y sin alterar. No comprueba las firmas del servidor contra una clave obtenida en otro sitio que no sea este mismo servidor, así que detecta manipulaciones de tu historial, no un servidor que fuera deshonesto desde el principio. El archivo descargado contiene todo lo necesario para comprobarlo en otro lugar.',
  'audit.filterLabel': 'Filtrar por el asunto de la entrada',
  'audit.family.all': 'Todo',
  'audit.family.vault': 'Bóveda',
  'audit.family.contacts': 'Contactos',
  'audit.family.release': 'Liberación',
  'audit.family.account': 'Cuenta',
  'audit.noneInFilter': 'Aún no hay entradas de ese tipo.',
  'audit.noneAtAll': 'Todavía no se ha registrado nada en esta cuenta.',
  'audit.entryHash': 'entrada {{seq}} · sha256 {{hash}}',
  'audit.prevHash': 'anterior {{hash}}',
  'audit.chainNote':
    'Cada entrada lleva el hash de la anterior, así que modificar una entrada previa rompe todos los hashes posteriores. Verificar en este dispositivo recalcula la cadena entera.',
  'audit.byAssistant': 'por el asistente',
  'audit.truncated':
    'Se muestran los primeros 200 registros. Descarga el archivo para ver el registro completo.',

  'plans.eyebrow': 'Continuidad',
  'plans.heading': 'Planes de continuidad',
  'plans.lede':
    'Cómo se libera cada nivel de tu bóveda, y a quién, cuando se cumplan tus condiciones.',
  'plans.contacts.title': 'Contactos de confianza',
  'plans.contacts.count_one':
    '{{count}} contacto · {{enrolled}} inscritos y capaces de tener partes',
  'plans.contacts.count_other':
    '{{count}} contactos · {{enrolled}} inscritos y capaces de tener partes',
  'plans.contacts.manage': 'Gestionar contactos',
  'plans.ladder.s1.name': 'El más accesible',
  'plans.ladder.s1.rule':
    'Se libera cuando cualquiera de tus contactos de confianza abre el sobre sellado que le dejaste.',
  'plans.ladder.s1.need': 'Cualquier contacto',
  'plans.ladder.s2.name': 'Delicado',
  'plans.ladder.s2.rule':
    'Un reparto de Shamir de 2 entre 3 repartido entre dos contactos de roles distintos y tu frase de liberación sin conexión. Dos cualesquiera de esas tres partes lo reconstruyen; ninguna parte por sí sola, ni dos contactos del mismo rol, pueden hacerlo. Aquí la frase de liberación es un recurso opcional: dos contactos pueden recuperar S2 sin ella.',
  'plans.ladder.s2.need':
    'Dos de tres partes cualesquiera (2 contactos o la frase de liberación)',
  'plans.ladder.s3.name': 'El más delicado',
  'plans.ladder.s3.rule':
    'Un esquema anidado: tu frase de liberación sin conexión es una máscara obligatoria sobre un reparto de 2 entre 3 en manos de tres contactos de roles distintos. Reconstruirlo requiere la frase de liberación Y dos cualesquiera de esos tres contactos: no existe ninguna vía solo con contactos y, si se pierde la frase de liberación, S3 queda irrecuperable para siempre.',
  'plans.ladder.s3.need':
    'Frase de liberación (siempre obligatoria) + 2 de 3 contactos cualesquiera',
  'plans.tier.items_one': '{{count}} elemento',
  'plans.tier.items_other': '{{count}} elementos',
  'plans.tier.need': 'La liberación necesita: {{need}}',
  'plans.tier.categories': 'Categorías: {{categories}}',
  'plans.tier.openVault': 'Abrir la bóveda',
  'plans.footnote':
    'Asigna qué contacto tiene la parte de cada nivel en Contactos; mueve elementos entre niveles desde el propio elemento de la bóveda.',

  'plans.sub.proName': 'Truecairn Personal',
  'plans.sub.active': 'activo',
  'plans.sub.proBlurb':
    'Tienes desbloqueados contactos y elementos de bóveda ilimitados, {{storage}} de archivos adjuntos cifrados y la verificación por SMS. Gracias por apoyar a Truecairn.',
  'plans.sub.usage': 'Estás usando {{used}} de {{limit}} de almacenamiento.',
  'plans.sub.endsOn': 'Tu plan está previsto que finalice el {{when}}.',
  'plans.sub.renews': 'Se renueva el {{when}}.',
  'plans.sub.manage': 'Gestionar la suscripción',
  'plans.sub.freeBlurb':
    'Estás en el plan gratuito. Personal elimina los límites —contactos de confianza y elementos de bóveda ilimitados, y mucho más almacenamiento para archivos adjuntos cifrados— y añade la verificación por SMS, para poder localizarte por todas las vías que hayas configurado cuando de verdad importa.',
  'plans.sub.stat.contacts': 'Contactos de confianza',
  'plans.sub.stat.items': 'Elementos de la bóveda',
  'plans.sub.stat.storage': 'Almacenamiento de adjuntos',
  'plans.sub.upgrade': 'Mejorar el plan',
  'plans.sub.upgradeHint': 'Compara los dos planes, elige mensual o anual y ahorra.',

  'continuity.outcome.channels_unconfigured':
    'No había ningún canal de notificación verificado por el que localizar al titular.',
  'continuity.outcome.unreachable_all_channels':
    'Todos los intentos de localizar al titular fallaron de forma comprobada: todos los canales configurados rebotaron o dieron error.',
  'continuity.outcome.partial_delivery_no_checkin':
    'Algunos intentos llegaron a los canales del titular (otros quedaron sin confirmar o fallaron), y no hubo ninguna confirmación de actividad después.',
  'continuity.outcome.delivered_no_checkin':
    'Los mensajes llegaron de forma comprobada a los canales del titular, y aun así no hubo ninguna confirmación de actividad.',
  'continuity.outcome.quietButHealthy':
    'En esta ventana no ha hecho falta ningún intento de verificación: tus canales están listos.',
  'continuity.heading.live': 'Estado de verificación actual',
  'continuity.heading.frozen': 'Informe de verificación de continuidad',
  'continuity.lede.live':
    'Lo que el sistema está haciendo para localizarte ahora mismo: los recuentos se actualizan a medida que los proveedores confirman las entregas.',
  'continuity.lede.frozen':
    'Congelado en el momento en que se abrió esta ceremonia{{when}}: el registro de todos los intentos de localizar antes al titular. Las confirmaciones de los proveedores que llegaron después de ese momento no se reflejan aquí, así que un intento reciente puede figurar como enviado pero aún no entregado.',
  'continuity.lede.frozenWhen': ' ({{when}})',
  'continuity.narration.label': 'En lenguaje sencillo (generado por IA):',
  'continuity.lastActive': 'Última actividad confirmada: {{when}}',
  'continuity.never': 'nunca',
  'continuity.checkInRequested': 'Confirmación solicitada: {{when}}',
  'continuity.escalated': 'Verificación intensificada: {{when}}',
  'continuity.noChannels': 'No había ningún canal de notificación configurado.',
  'continuity.channelName': 'Canal de {{type}}',
  'continuity.channelNameUnverified': 'Canal de {{type}} (sin verificar)',
  'continuity.channelStats_one':
    '{{count}} intento · {{delivered}} entregados · {{bounced}} rebotados · {{failed}} fallidos{{last}}',
  'continuity.channelStats_other':
    '{{count}} intentos · {{delivered}} entregados · {{bounced}} rebotados · {{failed}} fallidos{{last}}',
  'continuity.lastDelivered': ' · última liberación el {{when}}',
  'continuity.recovered': 'El titular volvió durante esta ventana (el {{when}}).',
  'continuity.noTracking':
    'Cada línea de arriba está probada por el proveedor (entregado o rebotado). Truecairn nunca registra si un mensaje se abre o se lee.',

  'accept.heading': 'Aceptar una invitación de contacto de confianza',
  'accept.locked':
    'Desbloquea primero tu bóveda: la inscripción usa claves que solo tu frase maestra puede derivar.',
  'accept.lede':
    'Pega el código de un solo uso que te compartió quien te invitó. Registramos tus claves de confirmación demostrando —nunca revelando— que las tienes.',
  'accept.field.token': 'Código de invitación',
  'accept.submit': 'Aceptar e inscribirme',
  'accept.accepting': 'Aceptando…',
  'accept.enrolling': 'Demostrando la posesión de las claves…',
  'accept.error': 'No pudimos aceptar esta invitación ni completar la inscripción.',
  'accept.done.heading': 'Ya estás inscrito',
  'accept.done.body':
    'Tus claves de confirmación están registradas. Queda un paso antes de que quien te invitó pueda confiarte una parte de la liberación.',
  'accept.code.label': 'Tu código de seguridad',
  'accept.code.instruction':
    'Quien te invitó te leerá un código y te preguntará si coincide con este. <strong>Hazlo por teléfono o en persona</strong>, no por correo ni por chat. Si los códigos no coinciden, díselo y no continúes: significa que las claves que le han dado para ti no son las tuyas.',

  'item.loading': 'Cargando…',
  'item.error.open': 'No pudimos abrir este elemento.',
  'item.back': '← Volver a la bóveda',
  'item.tier': 'Nivel: {{tier}}',
  'item.contentLabel': 'contenido del elemento',
  'item.immutable':
    'Este registro es inmutable: su título y su contenido no se pueden editar después de crearlo, porque se conserva como registro auditado. Para cambiarlos, mueve su nivel o elimínalo y crea un elemento nuevo. Los archivos adjuntos de abajo se gestionan por separado.',
  'item.pendingDeletion':
    'Eliminación programada: este elemento se borra el {{when}}. Sigue siendo legible hasta entonces, y puedes cancelarla desde la <engine>página del Motor</engine>.',
  'item.pendingAction':
    '{{label}} pendiente: cancelable durante 7 días, surte efecto el {{when}}.',
  'item.pending.attachmentRemoval': 'Eliminación del archivo adjunto',
  'item.pending.tierChange': 'Cambio al nivel {{tier}}',
  'item.pending.deletion': 'Eliminación',
  'item.actions': 'Acciones',
  'item.moveTier': 'Mover al nivel',
  'item.requestTierChange': 'Solicitar el cambio de nivel',
  'item.requesting': 'Solicitando…',
  'item.delete': 'Eliminar',
  'item.revert': 'Restaurar la copia de seguridad',
  'item.reverting': 'Restaurando…',
  'item.reverted': 'Se ha restaurado tu última copia de seguridad.',
  'item.attachments': 'Archivos adjuntos',
  'item.attachments.lede':
    'Los archivos se pueden añadir o quitar con independencia del registro de arriba. Cada uno se cifra en este dispositivo antes de subirlo: el servidor guarda bytes ilegibles, e incluso el nombre del archivo viaja dentro del cifrado. Los nombres aparecen cuando los descargas y descifras.',
  'item.attachment.row': 'Archivo cifrado · {{size}} · añadido el {{when}}',
  'item.attachment.download': 'Descargar',
  'item.attachment.decrypting': 'Descifrando…',
  'item.attachment.pendingRemoval':
    'Eliminación programada: se aplica el {{when}}; puedes cancelarla desde la página del Motor.',
  'item.attachment.remove': 'Quitar (7 días)',
  'item.attachment.uploading': 'Cifrando y subiendo…',
  'item.attachment.attachNone': 'Adjuntar archivo',
  'item.attachment.attach_one': 'Adjuntar {{count}} archivo',
  'item.attachment.attach_other': 'Adjuntar {{count}} archivos',
  'item.attachment.stored_one': '{{count}} archivo cifrado y guardado.',
  'item.attachment.stored_other': '{{count}} archivos cifrados y guardados.',
  'item.attachment.chooseFirst': 'Elige primero un archivo.',
  'item.attachment.failed_one':
    'No se pudo guardar {{count}} archivo ({{files}}): puede que superen el almacenamiento de tu plan. No se ha subido nada sin cifrar.',
  'item.attachment.failed_other':
    'No se pudieron guardar {{count}} archivos ({{files}}): puede que superen el almacenamiento de tu plan. No se ha subido nada sin cifrar.',
  'item.error.lockedUpload':
    'Tu bóveda está bloqueada porque hay una liberación o revisión en curso, así que ahora mismo no se pueden añadir archivos adjuntos. Resuélvelo desde la página del Motor (confirma tu actividad o resuelve la revisión) y vuelve a intentarlo. No se ha subido nada.',
  'item.error.decrypt': 'No pudimos descifrar ese archivo adjunto.',
  'item.error.removal':
    'No pudimos solicitar la eliminación: puede que la confirmación de seguridad fallara.',
  'item.error.tierChange': 'No pudimos solicitar el cambio de nivel. Inténtalo de nuevo.',
  'item.error.deletion': 'No pudimos solicitar la eliminación. Inténtalo de nuevo.',
  'item.error.revert': 'No pudimos restaurar este elemento. Inténtalo de nuevo.',

  'ceremony.eyebrow': 'Continuidad',
  'ceremony.heading': 'Ceremonia de liberación',
  'ceremony.lede':
    'Donde tus contactos de confianza actúan sobre una liberación: despacio, de forma reversible y con registro de auditoría.',
  'ceremony.none': 'No hay ninguna liberación sobre la que debas actuar.',
  'ceremony.releasedContent': 'contenido liberado',
  'ceremony.tier.s1': 'S1 — Lo esencial',
  'ceremony.tier.s2': 'S2 — Personal',
  'ceremony.tier.s3': 'S3 — Bóveda profunda',
  'ceremony.receive': 'Recibir en este dispositivo',
  'ceremony.receiving': 'Este dispositivo está registrado para recibir la liberación.',
  'ceremony.affirm': 'Confirmar la liberación',
  'ceremony.affirm.confirmText':
    'Estás confirmando que el titular ha fallecido o está ilocalizable y que su bóveda debería liberarse. Aún podrás cambiar de opinión durante la ventana de revocación posterior.',
  'ceremony.affirm.yes': 'Sí, confirmo la liberación',
  'ceremony.affirm.notNow': 'Ahora no',
  'ceremony.affirmed.until': 'Has confirmado. Puedes cambiar de opinión hasta el {{when}}.',
  'ceremony.affirmed.limited':
    'Has confirmado. Todavía puedes cambiar de opinión durante un tiempo limitado.',
  'ceremony.revoke': 'Revocar mi confirmación',
  'ceremony.committed':
    'Tu confirmación es firme: la ventana para cambiar de opinión se ha cerrado. Si el titular está realmente con vida, aún puedes detener esta liberación con la acción de abajo.',
  'ceremony.provideShare': 'Aportar tu parte',
  'ceremony.shareProvided': 'Tu parte se ha sellado para {{count}} dispositivo(s) destinatario(s).',
  'ceremony.reconstruct': 'Reconstruir',
  'ceremony.s3.hint':
    'S3 requiere la frase de liberación sin conexión del titular junto con las partes de los contactos de confianza. Nunca se nos envía.',
  'ceremony.releasePassphrase': 'Frase de liberación',
  'ceremony.s2.toggle': '¿Falta un contacto? Usa la frase de liberación',
  'ceremony.s2.hint':
    'Introduce la frase de liberación sin conexión del titular. Combinada con la parte de un contacto, reconstruye la liberación. Nunca se nos envía.',
  'ceremony.s2.reconstruct': 'Reconstruir con la frase de liberación',
  'ceremony.dispute': 'El titular está con vida: detener esta liberación',
  'ceremony.dispute.confirmText':
    'Esto aborta de inmediato la liberación para todos los contactos y marca la cuenta para revisión. Hazlo si crees que el titular está con vida o que algo va mal.',
  'ceremony.dispute.yes': 'Sí, detener la liberación',
  'ceremony.dispute.goBack': 'Volver',
  'ceremony.error.notOpen': 'La liberación aún no está abierta. Vuelve a comprobarlo más tarde.',
  'ceremony.error.affirm': 'No pudimos registrar tu confirmación.',
  'ceremony.error.revoke': 'No pudimos revocar tu confirmación.',
  'ceremony.error.provideShare': 'No pudimos aportar tu parte.',
  'ceremony.error.dispute': 'No pudimos registrar la objeción.',
  'ceremony.error.register': 'No pudimos registrar este dispositivo para recibir.',
  'ceremony.error.reconstructPass':
    'No pudimos reconstruir con esa frase de liberación. Compruébala e inténtalo de nuevo.',
  'ceremony.error.reconstruct':
    'No pudimos reconstruir la liberación. Si falta un contacto, prueba con la frase de liberación de abajo.',

  'settings.eyebrow': 'Cuenta',
  'settings.heading': 'Ajustes',
  'settings.lede': 'Gestiona tu sesión y las protecciones de tu cuenta.',

  'settings.session.heading': 'Sesión',
  'settings.session.sub':
    'La clave de tu bóveda desbloqueada vive solo en la memoria de este navegador.',
  'settings.session.signedInAs': 'Sesión iniciada como',
  'settings.session.unlocked': 'La bóveda está desbloqueada',
  'settings.session.explain':
    'Bloquéala para borrar la clave de la memoria sin cerrar sesión: la próxima vez volverás a introducir tu frase maestra. Cierra sesión para terminar además esta sesión allí donde esté guardada.',
  'settings.session.lock': 'Bloquear la bóveda',
  'settings.session.signOut': 'Cerrar sesión',
  'settings.session.signingOut': 'Cerrando sesión…',

  'settings.ai.heading': 'Asistencia con IA',
  'settings.ai.optOut.title': 'Desactivar la IA en mi cuenta',
  'settings.ai.optOut.sub':
    'Cuando está activado, ninguna función de IA se ejecuta para ti: ni asistente, ni resúmenes, ni propuestas, ni explicaciones del guardián. Tu maquinaria de seguridad (confirmaciones de actividad, escalera de liberación) no se ve afectada.',
  'settings.ai.optOut.group': 'La IA en mi cuenta',
  'settings.ai.on': 'IA activada',
  'settings.ai.off': 'IA desactivada',
  'settings.ai.autonomy.title': 'Permitir que la IA actúe en mi nombre (con derecho a veto)',
  'settings.ai.autonomy.sub':
    'Cuando está activado, la IA puede enviar recordatorios de confirmación adicionales y proponer un intervalo de confirmación más corto en tu nombre. Cada acción queda esperando en tu lista de pendientes y puedes vetarla antes de que surta efecto. La IA solo puede reforzar la protección, nunca reducirla.',
  'settings.ai.autonomy.group': 'Permitir que la IA actúe en mi nombre',
  'settings.ai.autonomy.on': 'Activado',
  'settings.ai.autonomy.off': 'Desactivado',
  'settings.ai.floor.title': 'No acortar nunca por debajo de',
  'settings.ai.floor.sub':
    'El límite hacia el que la IA puede acortar tu intervalo de confirmación, nunca por debajo.',
  'settings.ai.floor.current': ' Límite actual: {{days}} días.',
  'settings.ai.floor.none':
    ' Sin límite fijado: la IA enviará recordatorios pero no cambiará tu programación.',
  'settings.ai.floor.placeholder': 'días',
  'settings.ai.floor.label': 'Intervalo mínimo de confirmación en días',
  'settings.ai.floor.save': 'Guardar el límite',

  'settings.protections.heading': 'Protecciones de la cuenta',
  'settings.protections.sub':
    'Doble factor, claves de acceso y correo de recuperación.',
  'settings.protections.body':
    'Los controles específicos de seguridad de la cuenta llegarán aquí. Por ahora, las claves de acceso se gestionan al iniciar sesión y, una vez activado tu motor, confirmas que sigues aquí desde la página del Motor.',

  'settings.delete.heading': 'Eliminar esta cuenta',
  'settings.cadence.heading': 'Frecuencia de confirmación',
  'settings.cadence.sub':
    'Cuánto tiempo puedes estar en silencio antes de que preguntemos. Cambiarlo es una acción sensible: espera el plazo habitual, y hasta entonces sigue vigente el ajuste actual.',
  'settings.cadence.current': 'Ahora: {{days}} días',
  'settings.cadence.label': 'Intervalo (días)',
  'settings.cadence.hint': 'Entre 1 y 365.',
  'settings.cadence.unarmed':
    'Tu motor aún no está armado, así que no hay frecuencia que cambiar. Ármalo primero desde la página Motor.',
  'settings.cadence.delayNote':
    'Los cambios en cola esperan antes de aplicarse, y puedes cancelarlos desde la página Motor en cualquier momento. Optamos por la lentitud siempre que un valor por defecto más rápido no sería seguro.',
  'settings.cadence.pending':
    'Ya hay un cambio de frecuencia en cola, con efecto el {{when}}. Cancélalo desde la página Motor para poner otro.',
  'settings.cadence.save': 'Guardar con tu clave de acceso',
  'settings.cadence.saving': 'Poniendo en cola…',
  'settings.cadence.unchanged': 'Esa ya es tu frecuencia.',
  'settings.cadence.outOfRange': 'Elige un número entero de días entre 1 y 365.',
  'settings.cadence.error': 'No pudimos poner ese cambio en cola.',
  'settings.delete.sub':
    'Es permanente: se eliminan tu bóveda, tus contactos y tus planes de continuidad. Como todo cambio destructivo, espera 7 días y se puede cancelar desde la página del Motor.',
  'settings.delete.pending':
    'Eliminación de la cuenta pendiente: surte efecto el {{when}}. Hasta entonces puedes cancelarla desde las acciones pendientes de la página del Motor, y podrás seguir iniciando sesión.',
  'settings.delete.request': 'Solicitar la eliminación',
  'settings.delete.confirmWord': 'DELETE',
  'settings.delete.instruction':
    'Escribe <strong>{{word}}</strong> para confirmar y después aprueba con tu clave de acceso. No se elimina nada durante 7 días.',
  'settings.delete.inputLabel': 'Escribe DELETE para confirmar la eliminación de la cuenta',
  'settings.delete.button': 'Eliminar la cuenta',
  'settings.delete.busy': 'Eliminando: confirma con tu clave de acceso…',
  'settings.delete.error':
    'No pudimos solicitar la eliminación: puede que la confirmación con la clave de acceso fallara o caducara. No se ha aplicado nada; inténtalo de nuevo.',

  'settings.profile.heading': 'Tu nombre',
  'settings.profile.sub':
    'Se muestra en tu menú de cuenta. Es opcional: déjalo en blanco para mostrar solo tu correo. Es únicamente para mostrar; nunca se usa para desbloquear, liberar ni verificar nada.',
  'settings.profile.title': 'Tratamiento',
  'settings.profile.titleNone': 'Ninguno',
  'settings.profile.name': 'Nombre',
  'settings.profile.namePlaceholder': 'p. ej. Alex Rivera',
  'settings.profile.save': 'Guardar el nombre',
  'settings.profile.saving': 'Guardando…',
  'settings.profile.saved': 'Guardado.',
  'settings.profile.error': 'No pudimos guardar tu nombre. Inténtalo de nuevo.',

  'settings.channels.heading': 'Canales de notificación',
  'settings.channels.sub':
    'Los recordatorios de confirmación y los avisos de la cuenta se envían a todos los canales que verifiques aquí. Solo registramos lo que el proveedor demuestra —entregado o rebotado— y nunca registramos si abres o lees nada.',
  'settings.channels.downgrade':
    'Tu plan de pago ha terminado, pero todos los canales que ya habías verificado —{{channels}}— siguen protegiéndote exactamente igual que antes. No se ha desactivado nada. Añadir <em>nuevos</em> canales de SMS requiere <plans>Truecairn Personal</plans>.',
  'settings.channels.push': 'Notificaciones push (este navegador)',
  'settings.channels.verifiedCount_one': '{{count}} verificado',
  'settings.channels.verifiedCount_other': '{{count}} verificados',
  'settings.channels.state.verified': 'Verificado',
  'settings.channels.state.unverified': 'Sin verificar',
  'settings.channels.verified': 'Canal de {{type}} verificado',
  'settings.channels.codeSent': 'Se ha enviado un código de verificación: introdúcelo abajo.',
  'settings.channels.unverified':
    'Sin verificar: vuelve a enviar un código para terminar la inscripción.',
  'settings.channels.codePlaceholder': 'código de 6 dígitos',
  'settings.channels.codeLabel': 'Código de verificación de 6 dígitos',
  'settings.channels.verify': 'Verificar',
  'settings.channels.resend': 'Reenviar el código',
  'settings.channels.removalPending':
    'Eliminación programada: se aplica el {{when}}; puedes cancelarla desde la página del Motor.',
  'settings.channels.remove': 'Quitar',
  'settings.channels.add.title': 'Añadir un canal',
  'settings.channels.add.sub':
    'Enviamos un código de 6 dígitos por el propio canal —un correo o un mensaje de texto— y tú lo escribes aquí para demostrar que te llega.',
  'settings.channels.add.smsLocked': 'El SMS está en <plans>Truecairn Personal</plans>.',
  'settings.channels.add.typeLabel': 'Tipo de canal',
  'settings.channels.add.email': 'Correo electrónico',
  'settings.channels.add.sms': 'SMS',
  'settings.channels.add.emailPlaceholder': 'tu@ejemplo.com',
  'settings.channels.add.phonePlaceholder': '+34600123456',
  'settings.channels.add.emailLabel': 'Dirección de correo que añadir',
  'settings.channels.add.phoneLabel': 'Número de teléfono que añadir',
  'settings.channels.add.button': 'Añadir el canal',
  'settings.channels.add.sending': 'Enviando el código…',
  'settings.channels.pushCard.title': 'Notificaciones push en este dispositivo',
  'settings.channels.pushCard.sub':
    'Tu navegador te pedirá permiso y después una notificación llevará el código de 6 dígitos para confirmar que el canal funciona de extremo a extremo.',
  'settings.channels.pushCard.enable': 'Activar las notificaciones push',
  'settings.channels.pushCard.enabling': 'Activando…',
  'settings.channels.error.add':
    'No pudimos añadir ese canal. Revisa la dirección e inténtalo de nuevo.',
  'settings.channels.error.push':
    'No pudimos activar las notificaciones push en este dispositivo: puede que se haya denegado el permiso de notificaciones.',
  'settings.channels.error.verify':
    'Ese código no se ha aceptado: puede que haya caducado. Vuelve a enviar un código e inténtalo de nuevo.',
  'settings.channels.error.remove':
    'No pudimos quitar ese canal: o se rechazó la confirmación con la clave de acceso, o la comprobación de seguridad no se completó. No se ha programado nada; inténtalo de nuevo.',

  'settings.matrix.heading': 'Para qué se usa cada canal',
  'settings.matrix.sub':
    'Si desactivas un canal para un propósito, los mensajes rutinarios de ese tipo dejan de enviarse ahí. Las solicitudes de confirmación, las solicitudes de escalada y las alertas de seguridad se entregan siempre: ningún ajuste puede silenciarlas.',
  'settings.matrix.unverified': ' — sin verificar (nunca se selecciona hasta que se verifique)',
  'settings.matrix.owner_verification.title': 'Rondas de verificación',
  'settings.matrix.owner_verification.hint':
    'Las rondas adicionales de «¿estás ahí?» mientras una confirmación sigue sin respuesta.',
  'settings.matrix.owner_notices.title': 'Avisos de la cuenta',
  'settings.matrix.owner_notices.hint':
    'Actualizaciones rutinarias: cambios del motor, acciones delicadas pendientes, avisos del plan.',
  'settings.matrix.contact_notices.title': 'Solicitudes de ceremonia',
  'settings.matrix.contact_notices.hint':
    'Solicitudes que recibes como contacto de confianza de OTRA persona.',
  'settings.matrix.error': 'No pudimos guardar esa preferencia. Inténtalo de nuevo.',

  'contacts.eyebrow': 'Continuidad',
  'contacts.heading': 'Contactos de confianza',
  'contacts.progress': '{{done}} de 3: invitar, inscribir, confirmar',
  'contacts.lede':
    'Personas que pueden reconstruir el acceso cuando se cumplan tus condiciones de liberación.',

  'contacts.invite.heading': '¿Quién debería recibir esto si se cumplen las condiciones?',
  'contacts.invite.sub':
    'Elige el tipo de destinatario: eso decide qué partes de tu bóveda le llegan y cuándo. Se inscriben desde su propio dispositivo demostrando que tienen sus claves.',
  'contacts.invite.kind': 'Tipo de destinatario',
  'contacts.invite.countsAs': 'Cuenta como un contacto {{role}}.',
  'contacts.invite.labelNote':
    'La etiqueta se sella con la clave de tu nivel S1: nosotros nunca la vemos.',
  'contacts.invite.label': 'Etiqueta',
  'contacts.invite.create': 'Crear la invitación',
  'contacts.invite.draft': 'Redactar un mensaje con IA',
  'contacts.invite.drafting': 'Redactando…',
  'contacts.invite.upgradeLink': 'Cambiar al plan Personal',
  'contacts.invite.token': 'Comparte este código de invitación de un solo uso con tu contacto:',
  'contacts.invite.draftLede':
    'Mensaje sugerido para enviar junto con el código de invitación; edítalo antes de enviarlo:',

  'contacts.list.heading': 'Tus contactos',
  'contacts.list.count_one':
    '{{count}} contacto · {{enrolled}} inscritos · {{confirmed}} confirmados',
  'contacts.list.count_other':
    '{{count}} contactos · {{enrolled}} inscritos · {{confirmed}} confirmados',
  'contacts.list.unconfirmed_one': '{{count}} por confirmar',
  'contacts.list.unconfirmed_other': '{{count}} por confirmar',
  'contacts.list.empty':
    'Aún no hay contactos. Invita a alguien arriba; se inscribirá desde su propio dispositivo.',
  'contacts.list.sharePending':
    'Parte pendiente: cancelable durante 7 días (efectivo el {{when}})',
  'contacts.list.pending': 'Pendiente',
  'contacts.list.cancelInvite': 'Cancelar la invitación',
  'contacts.role.personal': 'Personal',
  'contacts.role.professional': 'Profesional',
  'contacts.role.recovery': 'Recuperación',

  'contacts.key.no_keys':
    'Este contacto aún no ha terminado de inscribirse, así que no hay claves que confirmar.',
  'contacts.key.unverified':
    'Confirma antes el código de seguridad de este contacto con esa persona: compáralo por teléfono o en persona, no a través de esta aplicación.',
  'contacts.key.changed':
    'Las claves de este contacto han cambiado desde que las confirmaste, y no se anunció ninguna rotación de claves. No le asignes ninguna parte. Ponte en contacto con esa persona directamente y volved a comparar el código de seguridad antes de hacer nada más.',
  'contacts.key.tampered':
    'No pudimos leer tu confirmación guardada para este contacto. Trátalo como un aviso, no como un fallo: confirma el código de seguridad con esa persona directamente antes de asignarle nada.',
  'contacts.key.verified': 'Las claves de este contacto están confirmadas.',
  'contacts.key.showCode': 'Código de seguridad',
  'contacts.key.hideCode': 'Ocultar el código de seguridad',
  'contacts.key.confirmedAt': 'Confirmado el {{when}}',
  'contacts.key.assignS1': 'Asignar la parte S1',
  'contacts.key.assigning': 'Asignando…',
  'contacts.key.badge.changed': 'Las claves han cambiado: no asignar',
  'contacts.key.badge.tampered': 'Confirmación ilegible',
  'contacts.key.badge.unverified': 'Sin confirmar',

  'contacts.code.changedAlert':
    '<strong>Estas claves no son las que confirmaste.</strong> Las claves de un contacto solo cambian cuando esa persona las rota, y una rotación te llega como aviso con siete días de antelación. No has recibido ninguno. No le asignes ninguna parte a este contacto. Llámale —a un número que ya tuvieras, no a uno de esta página— y comparad el código de abajo antes que nada.',
  'contacts.code.tamperedAlert':
    '<strong>No pudimos leer tu confirmación guardada.</strong> Confirma el código con este contacto directamente antes de asignarle nada.',
  'contacts.code.label': 'Código de seguridad de {{name}}',
  'contacts.code.instruction':
    'Léeselo a {{name}} <strong>por teléfono o en persona</strong> y comprueba que coincide con el código de su pantalla. No lo compares por correo ni por una aplicación de chat: si alguien puede cambiar lo que ves aquí, también puede cambiar lo que ves allí. Los códigos solo coinciden si las claves que tenemos para esa persona son realmente suyas.',
  'contacts.code.match': 'Los códigos coinciden',
  'contacts.code.saving': 'Guardando…',
  'contacts.code.notNow': 'Ahora no',

  'contacts.split.heading': 'Repartir un nivel superior entre varios contactos',
  'contacts.split.sub.s2':
    '{{count}} contactos de roles distintos tienen una parte cada uno; tu frase de liberación (guardada sin conexión, nunca almacenada) es la parte adicional. No podemos recuperarla.',
  'contacts.split.sub.s3':
    '{{count}} contactos de roles distintos tienen una parte cada uno, y tu frase de liberación (guardada sin conexión, nunca almacenada) es necesaria para combinarlos: dos contactos cualesquiera más la frase de liberación lo reconstruyen. No podemos recuperar la frase de liberación.',
  'contacts.split.tier': 'Nivel',
  'contacts.split.tierGroup': 'Nivel del reparto',
  'contacts.split.holders': 'Quién tiene las partes',

  // ── «Este reparto, tal como está» ─────────────────────────────────────────
  // S2: la frase de liberación es un respaldo OPCIONAL. S3: es una máscara
  // OBLIGATORIA. Describir la de S3 como opcional le diría a alguien que sus
  // elementos irrecuperables se pueden recuperar. Alineado con /guide §7 y §11.
  'contacts.split.state.heading': 'Este reparto, tal como está',
  'contacts.split.state.thresholdS2':
    'S2: un reparto de 2 de 3. Dos cualesquiera de estas tres partes lo reconstruyen; ni una sola parte, ni dos contactos del mismo rol, pueden. Aquí la frase de liberación es un respaldo opcional.',
  'contacts.split.state.thresholdS3':
    'S3: un esquema anidado. Tu frase de liberación es una máscara obligatoria sobre un reparto de 2 de 3 en manos de tres contactos: reconstruir exige la frase y dos cualesquiera de los tres. No hay ninguna vía que use solo contactos.',
  'contacts.split.chip.empty': 'Parte vacía',
  'contacts.split.chip.passphraseS2': 'Frase de liberación',
  'contacts.split.chip.passphraseS3': 'Frase de liberación: imprescindible',
  'contacts.split.check.holders': '{{picked}} de {{need}} titulares elegidos',
  'contacts.split.check.roles':
    'Dos roles distintos: una connivencia tendría que abarcar la vida personal y la profesional',
  'contacts.split.check.confirmed':
    'Las claves de cada titular confirmadas fuera de la aplicación',
  'contacts.split.check.passphrase':
    'Frase de liberación fijada y confirmada (8 caracteres o más)',
  'contacts.split.passphraseNote':
    'Se guarda fuera de línea y nunca se almacena. No podemos recuperarla, y en S3 hace falta siempre, así que perderla deja S3 irrecuperable para siempre.',
  'contacts.split.blocked.changed': 'las claves han cambiado; confírmalas otra vez antes de usarlas',
  'contacts.split.blocked.tampered': 'confirmación ilegible; confírmala otra vez',
  'contacts.split.blocked.unverified': 'confirma antes su código de seguridad',
  'contacts.split.noEnrolled':
    'Aún no hay contactos inscritos: invita e inscribe a algunos primero.',
  'contacts.split.noneConfirmed':
    'Confirma los códigos de seguridad de tus contactos en la lista de arriba antes de repartir entre ellos la clave de un nivel.',
  'contacts.split.passphrase': 'Frase de liberación',
  'contacts.split.passphraseConfirm': 'Confirma la frase de liberación',
  'contacts.split.submit': 'Asignar las partes de {{tier}}',
  'contacts.split.assigning': 'Asignando: confirma con tu clave de acceso…',
  'contacts.split.needPlan':
    '{{tier}} necesita {{needed}} contactos y tu plan incluye {{cap}}. <upgrade>Mejora el plan</upgrade> para poder asignarlo.',
  'contacts.split.needMore': 'Inscribe {{needed}} contactos para repartir {{tier}}.',
  'contacts.split.pending':
    'Asignación de partes del nivel pendiente, cancelable durante 7 días (efectiva el {{when}})',

  'contacts.beneficiary.heading': 'Designar un beneficiario',
  'contacts.beneficiary.sub':
    'Designa a un contacto inscrito para recibir una liberación: hereda el contenido sin tener una parte ni confirmar nada. Quienes tienen las partes siguen alcanzando el consenso. Para S1 le sellamos ahora su propia copia; para S2 y S3, quienes tienen las partes vuelven a sellar en el momento de la liberación. Es un cambio con 7 días de espera y cancelable.',
  'contacts.beneficiary.tier': 'Nivel del beneficiario',
  'contacts.beneficiary.contact': 'Beneficiario',
  'contacts.beneficiary.select': 'Elige un contacto inscrito…',
  'contacts.beneficiary.noteS1':
    'En S1 le sellamos ahora su propia copia, así puede abrirla tras una liberación sin tener una parte ni afirmar.',
  'contacts.beneficiary.noteS2S3':
    'S2 y S3 no envían ningún material de claves desde aquí: la persona beneficiaria recibe su nivel solo mediante una liberación completada.',
  'contacts.beneficiary.pickFirst': 'Elige un contacto inscrito.',
  'contacts.beneficiary.submit': 'Designar beneficiario',
  'contacts.beneficiary.designating': 'Designando: confirma con tu clave de acceso…',
  'contacts.beneficiary.pending':
    'Designación de beneficiario pendiente, cancelable durante 7 días (efectiva el {{when}})',

  'contacts.error.invite': 'No pudimos crear la invitación.',
  'contacts.error.draftUnavailable': 'El redactor con IA no está disponible ahora mismo.',
  'contacts.error.draft': 'No pudimos redactar un mensaje.',
  'contacts.error.cancelInvite': 'No pudimos cancelar la invitación.',
  'contacts.error.confirm': 'No pudimos guardar esa confirmación.',
  'contacts.error.assignS1':
    'No pudimos asignar la parte: puede que la confirmación con la clave de acceso fallara o caducara. No se ha aplicado nada; inténtalo de nuevo.',
  'contacts.error.roleDiversity':
    'Elige contactos de al menos dos roles distintos: el consenso de liberación lo exige.',
  'contacts.error.passTooShort':
    'La frase de liberación debe tener al menos 8 caracteres.',
  'contacts.error.passMismatch': 'Las frases de contraseña de liberación no coinciden.',
  'contacts.error.unconfirmedPick':
    'Uno de los contactos elegidos tiene una clave sin confirmar.',
  'contacts.error.assignTier':
    'No pudimos asignar las partes del nivel: puede que la confirmación con la clave de acceso fallara o caducara. Volver a enviarlo es seguro: una asignación que ya se completara no se duplicará.',
  'contacts.error.pickBeneficiary': 'Elige un contacto inscrito para designarlo como beneficiario.',
  'contacts.error.designate':
    'No pudimos designar al beneficiario: puede que la confirmación con la clave de acceso fallara o caducara. No se ha aplicado nada; inténtalo de nuevo.',

};
