import type { SiteMessageKey } from './en.js';

// Spanish for the public pages. Partial, like the app catalog: a key not yet
// translated falls back to English rather than rendering a placeholder nobody
// can tell apart from a real translation.
//
// NOT YET REVIEWED BY A NATIVE SPEAKER — the same gate as ../app/es.ts, and the
// reason Spanish is still absent from OFFERED_LOCALES. The glossary lives in the
// header of that file and applies here unchanged.
export const siteEs: Partial<Record<SiteMessageKey, string>> = {
  'settings.language.label': 'Idioma',

  'site.chrome.skipToContent': 'Saltar al contenido principal',
  'site.chrome.signIn': 'Iniciar sesión',
  'site.chrome.getStarted': 'Empezar',
  'site.chrome.backHome': 'Volver al inicio',
  'site.chrome.lastUpdated': 'Última actualización: {{date}}',
  'site.chrome.pillsLabel': 'Páginas de {{section}}',

  'site.footer.tagline':
    'Continuidad para tu vida digital. Cifrada en tu dispositivo. Liberada por las personas que elijas, según las reglas que escribas.',
  'site.footer.product': 'Producto',
  'site.footer.vault': 'Bóveda',
  'site.footer.contacts': 'Contactos de confianza',
  'site.footer.plans': 'Planes de continuidad',
  'site.footer.ceremony': 'Ceremonia de liberación',
  'site.footer.guide': 'Guía de uso',
  'site.footer.changelog': 'Novedades',
  'site.footer.security': 'Seguridad',
  'site.footer.securityModel': 'Modelo de seguridad',
  'site.footer.threatModel': 'Modelo de amenazas',
  'site.footer.ai': 'Cómo usamos la IA',
  'site.footer.reviews': 'Revisiones independientes',
  'site.footer.build': 'Procedencia del código',
  'site.footer.limits': 'Límites conocidos',
  'site.footer.source': 'Código fuente',
  'site.footer.disclosure': 'Política de divulgación',
  'site.footer.company': 'Empresa',
  'site.footer.about': 'Quiénes somos',
  'site.footer.contact': 'Contacto',
  'site.footer.press': 'Prensa',
  'site.footer.status': 'Estado',
  'site.footer.legal': 'Legal',
  'site.footer.privacy': 'Privacidad',
  'site.footer.terms': 'Términos',
  'site.footer.dpa': 'DPA',
  'site.footer.subProcessors': 'Subencargados',
  'site.footer.windDown': 'Plan de cierre',
  'site.footer.licence':
    '© 2026 Truecairn. Distribuido bajo la <licence>Apache 2.0 License</licence>.',

  'site.notFound.title': 'Esa página no existe',
  'site.notFound.lede':
    'No hemos encontrado nada en esta dirección. No ha pasado nada con tu cuenta ni con tu bóveda: es solo un enlace que no lleva a ninguna parte.',
  'site.notFound.attempted': 'La dirección que has probado',
  'site.notFound.sentHeading': 'Si alguien te ha enviado este enlace',
  'site.notFound.sentBody':
    'Los enlaces se rompen por el camino: los programas de correo parten los largos en varias líneas y algunas aplicaciones de chat los cortan. Pide a quien te lo envió que te lo mande otra vez y ábrelo entero, sin volver a teclearlo.',
  'site.notFound.contactWarning':
    '<strong>Si te han pedido que actúes como contacto de confianza</strong>, no crees una cuenta aquí para intentar que funcione. La invitación que te enviaron es lo que te da acceso, y una cuenta nueva no la sustituye. Vuelve al mensaje original o dile a quien te contactó que su enlace no se abre.',
  'site.notFound.whereHeading': 'Adónde ir en su lugar',
  'site.notFound.home': 'La página de inicio',
  'site.notFound.guide': 'La guía',
  'site.notFound.guideNote': ': qué hace Truecairn y cómo funciona',
  'site.notFound.security': 'El modelo de seguridad',
  'site.notFound.emailNote':
    ': si crees que esta dirección debería haber funcionado, envíanosla junto con el mensaje del que la sacaste',
  'site.meta.notFound.title': 'Página no encontrada — Truecairn',
  // ── Per-route <head> metadata ─────────────────────────────────────────────
  //
  // Only the routes published in Spanish. The changelog and the legal pages are
  // deliberately source-language only (see SOURCE_LANGUAGE_ONLY in ./en.ts), so
  // they are absent here on purpose rather than pending.
  'site.meta.home.title': 'Truecairn — Continuidad digital para lo que más importa',
  'site.meta.home.description':
    'Bóvedas cifradas bajo tu control hasta que se cumplan tus condiciones. Sin conocimiento por diseño: no podemos leer tu bóveda ni restablecer tu frase maestra.',
  'site.meta.guide.title': 'Guía — Cómo funciona Truecairn, pantalla a pantalla',
  'site.meta.guide.description':
    'Un recorrido por todo lo que hace Truecairn: los secretos que gestionas, los niveles y la liberación, los contactos de confianza y el motor de continuidad.',
  'site.meta.status.title': 'Estado del servicio — Truecairn',
  'site.meta.status.description':
    'Estado de los componentes y disponibilidad medida, para una pregunta: ¿podría completarse ahora una ceremonia de liberación? Una caída no libera tu bóveda.',
  'site.meta.security.title': 'Modelo de seguridad — Truecairn',
  'site.meta.security.description':
    'Todo se cifra en tu dispositivo, con claves que el servidor nunca tiene. Solo guarda texto cifrado, claves públicas y cajas selladas; nunca texto legible.',
  'site.meta.security.threatModel.title': 'Modelo de amenazas — De qué te protegemos',
  'site.meta.security.threatModel.description':
    'Los adversarios frente a los que está diseñado Truecairn, y los dos fallos por los que se le debe juzgar: liberar una bóveda indebidamente y no liberarla nunca.',
  'site.meta.security.ai.title': 'Cómo usa Truecairn la IA',
  'site.meta.security.ai.description':
    'La IA tiene un papel pequeño y unidireccional: solo puede añadir seguridad, nunca quitarla. No puede relajar un control ni avanzar una liberación.',
  'site.meta.security.build.title': 'Procedencia del código — Comprueba lo que te servimos',
  'site.meta.security.build.description':
    'Ciframos en tu navegador, así que el código que cifra es el que servimos. Cada versión publica una huella de cada archivo, generada por un flujo público.',
  'site.meta.security.limits.title': 'Límites conocidos — De qué no te protegemos',
  'site.meta.security.limits.description':
    'De lo que no protegemos, lo que no hemos construido y lo que nunca hemos probado. Una página que solo enumera virtudes es publicidad: esto es el resto.',
  'site.meta.security.disclosure.title': 'Política de divulgación coordinada — Truecairn',
  'site.meta.security.disclosure.description':
    'Cómo informarnos de una vulnerabilidad, qué pedimos a quien investiga y qué puede esperar de nosotros a cambio, incluido un compromiso de primera respuesta.',
  'site.meta.company.about.title': 'Sobre Truecairn',
  'site.meta.company.about.description':
    'Un sistema sereno para las partes de tu vida digital que deberían sobrevivirte. Diseñamos para el día en que no podamos ayudarte: ahí es cuando debe aguantar.',
  'site.meta.company.contact.title': 'Contactar con Truecairn',
  'site.meta.company.contact.description':
    'Cómo localizarnos: consultas y soporte, informes de seguridad bajo nuestra política de divulgación, y prensa. Correo leído por un equipo pequeño.',
  'site.meta.company.press.title': 'Kit de prensa — Truecairn',
  'site.meta.company.press.description':
    'Texto aprobado, ficha de datos, marcas y capturas libres de publicar, y una lista clara de lo que afirmamos y lo que no sobre nosotros mismos.',

  // ── Landing (marketing) ───────────────────────────────────────────────────
  'site.landing.nav.product': 'Producto',
  'site.landing.nav.security': 'Seguridad',
  'site.landing.nav.useCases': 'Casos de uso',
  'site.landing.nav.pricing': 'Precios',
  'site.landing.nav.faq': 'Preguntas frecuentes',
  'site.landing.nav.openMenu': 'Abrir el menú',

  'site.landing.hero.eyebrow': 'Hecho para la privacidad. Diseñado para la continuidad.',
  'site.landing.hero.title': 'Continuidad digital para tu información más importante.',
  'site.landing.hero.lede':
    'Crea bóvedas cifradas que siguen bajo tu control hasta que se cumplan las condiciones que definas. Seguras, privadas y construidas sobre una arquitectura de conocimiento cero.',
  'site.landing.hero.ctaPrimary': 'Empezar — gratis',
  'site.landing.hero.ctaSecondary': 'Leer el modelo de seguridad',
  'site.landing.hero.badge.encrypted': 'Cifrado de extremo a extremo · XChaCha20-Poly1305',
  'site.landing.hero.badge.zeroKnowledge':
    'Conocimiento cero: no tenemos ninguna clave de tu bóveda',
  'site.landing.hero.badge.revocation': 'Ventana de revocación de 48 horas en cada liberación',

  'site.landing.problem.photoAlt':
    'Un cuaderno cerrado con un bolígrafo y una taza de café sobre un escritorio de noche, con las luces de la ciudad al otro lado de la ventana.',
  'site.landing.problem.eyebrow': 'el problema',
  'site.landing.problem.title': 'Cuando dejas de dar señales, ¿qué pasa con lo que importa?',
  'site.landing.problem.lede':
    'La mayor parte de tu información importante vive en sitios a los que solo llegas tú. El panel de Stripe. El cajón de la cartera de hardware. El correo de recuperación en tu teléfono viejo. Nada de eso se transfiere solo. La planificación patrimonial trata esto como papeleo. Nosotros lo tratamos como un problema de ingeniería.',
  'site.landing.problem.founder.role': 'una fundadora',
  'site.landing.problem.founder.title': 'El equipo no puede pagar las nóminas',
  'site.landing.problem.founder.body':
    'Eres administradora en Stripe, en la gestoría y en la raíz de AWS. Estás ilocalizable dos semanas. Tu socio ve cómo los sistemas la dejan fuera. El reloj de la caja sigue corriendo.',
  'site.landing.problem.crypto.role': 'alguien con criptomonedas',
  'site.landing.problem.crypto.title': 'La frase está en una libreta',
  'site.landing.problem.crypto.body':
    'La cartera de hardware está en un cajón. La frase de recuperación está en una libreta, en otro cajón. Nadie de tu familia sabe en qué libreta, ni que existe una cartera.',
  'site.landing.problem.freelancer.role': 'un autónomo',
  'site.landing.problem.freelancer.title': 'Los clientes no reciben respuesta',
  'site.landing.problem.freelancer.body':
    'La mitad de tus facturas están en negociación. Tu bandeja de entrada es un único punto de fallo. Tu asesoría no tiene acceso permanente. Las devoluciones se atascan. Las renovaciones caducan.',

  'site.landing.product.photoAlt':
    'Una llave de seguridad física apoyada en un cajón de madera oscura, junto a unas llaves de casa.',
  'site.landing.product.eyebrow': 'el producto',
  'site.landing.product.title': 'Un sistema de ingeniería, no una gestoría patrimonial.',
  'site.landing.product.lede':
    'Cuatro piezas básicas, combinadas en reglas que puedes editar y revisar. Cada liberación pasa por una ventana de revocación de 48 horas. Cada cambio espera 7 días antes de surtir efecto. La reversibilidad es una restricción de diseño, no una función.',
  'site.landing.product.vault.eyebrow': 'la bóveda',
  'site.landing.product.vault.title': 'Elementos, organizados por sensibilidad',
  'site.landing.product.vault.body':
    'Añade elementos a partir de plantillas: traspaso del negocio, recuperación de criptomonedas, lo esencial para la familia. El cifrado ocurre en tu dispositivo con tu frase maestra, que nunca vemos. Adjunta archivos. Enlaza elementos en guías que se leen en orden.',
  'site.landing.product.contacts.eyebrow': 'contactos de confianza',
  'site.landing.product.contacts.title': 'Personas que eliges, verificadas por un enlace firmado',
  'site.landing.product.contacts.body':
    'Invita a cualquiera con una dirección de correo. Márcalos como personales o profesionales. No necesitan una cuenta para empezar: aceptar el enlace crea una e inscribe su dispositivo, que es lo que les permite tener una parte. Puedes exigir un mínimo de uno de cada categoría antes de una liberación, para que nunca actúe por su cuenta un solo entorno de trabajo o familiar.',
  'site.landing.product.plans.eyebrow': 'planes de continuidad',
  'site.landing.product.plans.title': 'Qué se libera, a quién y bajo qué condiciones',
  'site.landing.product.plans.body':
    'Define un disparador (inactividad, manual o un evento externo firmado), un periodo de espera (de 7 a 90 días) y una escalera de fases de liberación. Previsualiza la línea de tiempo antes de guardar. Cada edición cumple su propio plazo de 7 días, así que nada cambia a tus espaldas.',
  'site.landing.product.ceremony.eyebrow': 'la ceremonia de liberación',
  'site.landing.product.ceremony.title': 'Lenta, reversible y auditada de principio a fin',
  'site.landing.product.ceremony.body':
    'Si dejas de dar señales, tus contactos reciben un enlace firmado. Confirman u objetan, y una objeción detiene la liberación para revisión. Alcanzar el umbral abre una ventana de revocación de 48 horas. Puedes cancelar desde cualquier dispositivo verificado. Cualquier contacto que haya confirmado puede retirarse. Cada acción lleva marca de tiempo y firma.',

  'site.landing.steps.add.title': 'Añade lo que importa',
  'site.landing.steps.add.body':
    'Empieza con un elemento a partir de una plantilla. El primer plan puede estar activo en 4 minutos.',
  'site.landing.steps.invite.title': 'Invita a tus contactos',
  'site.landing.steps.invite.body':
    'Dos es el mínimo que recomendamos. Uno personal y otro profesional, para un consenso diverso.',
  'site.landing.steps.arm.title': 'Activa el sistema',
  'site.landing.steps.arm.body':
    'Nada te vigila hasta que tú lo dices. Activarlo requiere al menos un contacto inscrito.',
  'site.landing.steps.checkIn.title': 'Confirma cuando te lo pidamos',
  'site.landing.steps.checkIn.body':
    'Un correo. Un toque. Tú fijas el intervalo, 7 días por defecto. No convertimos la racha en un juego.',

  'site.landing.security.eyebrow': 'seguridad',
  'site.landing.security.title': 'Diseñamos para el día en que no podamos ayudarte.',
  'site.landing.security.lede':
    'Tu frase maestra nunca sale de tu dispositivo. No podemos leer tu bóveda. No podemos ayudarte a recuperarla: ese es justamente el objetivo. Abajo está la parte del modelo de seguridad que es fácil de escribir. El resto está en nuestro <threat>modelo de amenazas</threat>.',
  'site.landing.security.claim.zeroKnowledge.label': 'Conocimiento cero.',
  'site.landing.security.claim.zeroKnowledge.body':
    'Tu frase maestra se procesa en tu dispositivo. Solo guardamos la sal de derivación de su clave: nunca la frase maestra, y nunca un hash con el que pudiéramos probar conjeturas. Todo lo que sí guardamos está detallado en nuestra <privacy>política de privacidad</privacy>.',
  'site.landing.security.claim.zeroKnowledge.meta': 'argon2id · 256 MiB · t=4',
  'site.landing.security.claim.encrypted.label':
    'El contenido de la bóveda se cifra antes de salir de tu dispositivo.',
  'site.landing.security.claim.encrypted.body':
    'XChaCha20-Poly1305, con una clave derivada de tu frase maestra mediante Argon2id y una sal ligada a la cuenta.',
  'site.landing.security.claim.encrypted.meta': 'XChaCha20-Poly1305',
  'site.landing.security.claim.contacts.label':
    'Los contactos de confianza demuestran que tienen sus claves.',
  'site.landing.security.claim.contacts.body':
    'Cada contacto tiene su propia cuenta. Al inscribirse se vinculan una clave de firma Ed25519 y una clave de sellado X25519, cada una demostrada mediante un reto que solo su titular puede responder, y tú confirmas su código de seguridad fuera de la aplicación antes de sellarle ninguna parte. Cada confirmación se firma sobre el reto <em>y</em> el identificador de la ceremonia, así que no puede reutilizarse en otra liberación.',
  'site.landing.security.claim.contacts.meta': 'ed25519 · x25519',
  'site.landing.security.claim.audit.label': 'Cada evento de una liberación es auditable.',
  'site.landing.security.claim.audit.body':
    'Las confirmaciones, retiradas, objeciones, ediciones y revocaciones se añaden a un registro encadenado por hashes.',
  'site.landing.security.claim.audit.meta': 'registro encadenado por hashes',
  'site.landing.security.claim.source.labelUnpublished': 'Publicaremos el código del cliente.',
  'site.landing.security.claim.source.bodyUnpublished':
    'Las dependencias están fijadas por hash y la compilación web es reproducible a partir de la especificación de nuestra <build>página de compilación</build>. El repositorio aún no es público, así que tómalo como un compromiso y no como algo que puedas comprobar hoy.',
  'site.landing.security.claim.source.labelPublished': 'El código del cliente está publicado.',
  'site.landing.security.claim.source.bodyPublished':
    'Las dependencias están fijadas por hash y la compilación web es reproducible: clona el <repo>repositorio</repo>, compílalo y compara la huella del paquete con la de nuestra <build>página de compilación</build>. Lo que no hemos publicado es una certificación firmada por versión: la comprobación es la comparación, no una firma.',
  'site.landing.security.claim.source.metaUnpublished': 'aún sin publicar',
  'site.landing.security.claim.source.metaPublished': 'compilación reproducible',
  'site.landing.security.claim.audits.body':
    '<strong>Todavía no hay ninguna auditoría externa, ni certificaciones</strong>: ni SOC 2, ni ISO 27001. Preferimos decirlo claramente antes que señalar un informe que no existe.',
  'site.landing.security.claim.audits.meta': 'ninguna',
  'site.landing.security.claim.recovery.label':
    'La recuperación desde el servidor es imposible por diseño.',
  'site.landing.security.claim.recovery.body':
    'No tenemos ninguna puerta trasera. No vamos a construirla. El plazo de espera de 7 días para las ediciones y la ventana de liberación de 48 horas existen por algo.',
  'site.landing.security.claim.recovery.meta': 'por diseño',

  'site.landing.audience.eyebrow': 'para quién es',
  'site.landing.audience.title': 'Hecho para quienes ya custodian sus propias claves.',
  'site.landing.audience.lede':
    'Truecairn está pensado para personas con soltura técnica que toleran la fricción de la seguridad y quieren que resulte serena. Si ya usas 1Password, Proton y una cartera de hardware, te sentirás en casa en unos diez minutos.',
  'site.landing.audience.whoThisFits': 'a quién le encaja',
  'site.landing.audience.planLabel': 'Plan de continuidad',
  'site.landing.audience.cooldownLabel': 'Espera habitual',
  'site.landing.audience.itemsLabel': 'Elementos incluidos',
  'site.landing.audience.founders.title': 'Fundadores y equipos pequeños',
  'site.landing.audience.founders.body':
    'Eres administrador de las nóminas, los pagos y la infraestructura. Dos semanas de silencio no deberían parar la empresa. Escribe un manual una vez, enlázalo a tu socio y a tu abogado, y revísalo cuando el manual cambie.',
  'site.landing.audience.founders.plan': 'Traspaso del negocio',
  'site.landing.audience.founders.cooldown': '14 días',
  'site.landing.audience.founders.items': 'Stripe · nóminas · dominio · raíz de AWS',
  'site.landing.audience.crypto.title': 'Personas con criptomonedas',
  'site.landing.audience.crypto.body':
    'La autocustodia no sirve de nada si nadie puede recuperar la posición. Deja anotadas las ubicaciones de las carteras, las rutas de derivación y una guía de recuperación de una página escrita para alguien que nunca ha usado una cartera de hardware.',
  'site.landing.audience.crypto.plan': 'Recuperación de criptomonedas',
  'site.landing.audience.crypto.cooldown': '30 días',
  'site.landing.audience.crypto.items':
    'Ubicación de carteras · instrucciones de la semilla · contacto de la asesoría',
  'site.landing.audience.freelancers.title': 'Autónomos y consultores',
  'site.landing.audience.freelancers.body':
    'Tu negocio es tu bandeja de entrada. Si te quedas callado, los contratos se paran, los clientes se van y el dinero se queda retenido. Un plan de traspaso sencillo mantiene en marcha las relaciones más importantes sin ti.',
  'site.landing.audience.freelancers.plan': 'Continuidad con clientes',
  'site.landing.audience.freelancers.cooldown': '14 días',
  'site.landing.audience.freelancers.items':
    'Lista de clientes · facturación · acceso de la asesoría',
  'site.landing.audience.remote.title': 'Profesionales en remoto',
  'site.landing.audience.remote.body':
    'Vives en cuentas en la nube. Tu familia no conoce tu estructura. Un pequeño conjunto de instrucciones claras —dónde está cada cosa, qué leer primero— es el documento más importante que puedes escribir.',
  'site.landing.audience.remote.plan': 'Lo esencial para la familia',
  'site.landing.audience.remote.cooldown': '7 días',
  'site.landing.audience.remote.items': 'Cuentas · seguros · contacto de la empresa',

  'site.landing.pricing.eyebrow': 'precios',
  'site.landing.pricing.title':
    'Un plan para lo que más importa. Gratis si solo necesitas unos pocos.',
  'site.landing.pricing.lede':
    'El precio es por cuenta. Los contactos de confianza nunca pagan: recibir un enlace de liberación siempre es gratis. Cambia de plan cuando quieras. No dejamos la ceremonia de liberación ni los mecanismos de seguridad detrás de un plan de pago.',
  'site.landing.pricing.billingPeriod': 'Periodo de facturación',
  'site.landing.pricing.monthly': 'Mensual',
  'site.landing.pricing.yearly': 'Anual',
  'site.landing.pricing.save': 'Ahorra un {{pct}} %',
  'site.landing.pricing.free': 'Gratis',
  'site.landing.pricing.forever': 'para siempre',
  'site.landing.pricing.freeBlurb':
    'Suficiente para empezar. Suficiente para comprobar que te sirve.',
  'site.landing.pricing.freeCta': 'Crear una cuenta gratuita',
  'site.landing.pricing.freeChannels': 'Confirmaciones por correo y push',
  'site.landing.pricing.popular': 'El más elegido',
  'site.landing.pricing.personal': 'Personal',
  'site.landing.pricing.perMonthAnnually': '/ mes, con facturación anual',
  'site.landing.pricing.perMonthMonthly': '/ mes, con facturación mensual',
  'site.landing.pricing.annualSubline': '{{amount}} en un único pago anual: ahorras {{saved}} frente al pago mensual',
  'site.landing.pricing.monthlySubline': '{{amount}} al año, o ahorra un {{pct}} % pagando anualmente',
  'site.landing.pricing.personalBlurb':
    'Para quien se toma en serio la continuidad, tanto en lo profesional como en lo personal.',
  'site.landing.pricing.personalCta': 'Empezar con Personal',
  'site.landing.pricing.everythingInFree': 'Todo lo del plan gratuito',
  'site.landing.pricing.unlimited': 'ilimitados',
  'site.landing.pricing.trustedContacts': 'Contactos de confianza',
  'site.landing.pricing.vaultItems': 'Elementos de la bóveda',
  'site.landing.pricing.attachments': 'Archivos adjuntos cifrados',
  'site.landing.pricing.releaseTiers': 'Niveles de liberación',
  'site.landing.pricing.sms': 'Verificación por SMS',
  'site.landing.pricing.multichannel': 'Comprobaciones de continuidad multicanal',

  'site.landing.faq.eyebrow': 'preguntas',
  'site.landing.faq.title': 'Lo que la gente pregunta de verdad.',
  'site.landing.faq.passphrase.q': '¿Qué pasa si pierdo una de mis frases?',
  'site.landing.faq.passphrase.a':
    'Hay dos, y fallan de forma distinta. Si pierdes tu <strong>frase maestra</strong> y tu código de recuperación, toda tu bóveda queda irrecuperable: no podemos restablecerla, restaurarla ni sustituirla, y no hay ninguna puerta trasera ni siquiera para nosotros. Si pierdes solo tu <strong>frase de liberación</strong>, el nivel de mayor sensibilidad deja de poder liberarse, mientras que el resto sigue llegando a tus contactos por la liberación normal. Escribe las dos en papel y guárdalas en un sitio que no sea tu casa.',
  'site.landing.faq.contact.q':
    '¿Qué impide que un solo contacto de confianza provoque una liberación por su cuenta?',
  'site.landing.faq.contact.a':
    'Tú fijas un número mínimo de confirmaciones por fase, y puedes exigir que esas confirmaciones vengan de contactos de categorías distintas: al menos un contacto personal y uno profesional, por ejemplo. Así ningún familiar ni ningún entorno de trabajo puede actuar solo. Además, cada liberación pasa por una ventana de revocación de 48 horas durante la cual tú, o cualquier contacto que haya confirmado, podéis cancelarla.',
  'site.landing.faq.unreachable.q':
    '¿Cómo sabéis que estoy ilocalizable de verdad y no simplemente de vacaciones?',
  'site.landing.faq.unreachable.a':
    'No lo sabemos, y no deberíamos saberlo. Truecairn te pide que confirmes tu actividad con el intervalo que tú fijes —7 días por defecto— y después escala despacio: una ventana de confirmación y luego un periodo de espera de 14 días antes de acudir siquiera a tus contactos. Los contactos pueden confirmar u objetar, y una objeción lo detiene todo para revisión. Cuántas confirmaciones hacen falta depende del nivel: la fase menos sensible puede abrirla un contacto que hayas designado, mientras que las fases superiores necesitan un umbral de contactos de categorías distintas más tu frase de liberación. El sistema se inclina con fuerza hacia «sigue aquí».',
  'site.landing.faq.read.q': '¿Podéis leer mi bóveda?',
  'site.landing.faq.read.a':
    'No. Tu bóveda se cifra en tu dispositivo con XChaCha20-Poly1305, usando una clave derivada con Argon2id a partir de tu frase maestra y de una sal propia de tu cuenta. Solo guardamos esa sal: nunca la frase maestra, nunca la clave, y tampoco un hash con el que pudiéramos probar conjeturas. Todavía no tenemos ninguna certificación de seguridad ni hemos publicado ninguna auditoría externa; lo que te protege es el diseño, que puedes leer entero en nuestro modelo de amenazas.',
  'site.landing.faq.cooldown.q':
    '¿Por qué hay un retraso de 7 días al editar un plan de continuidad?',
  'site.landing.faq.cooldown.a':
    'Editar las reglas de liberación es la acción de mayor calado que puedes realizar. Un retraso de 7 días te da (o le da a cualquiera que consiga acceso momentáneo a tu cuenta) una ventana para revertirlo. Durante ese plazo sigue vigente el plan anterior. Optamos por la lentitud siempre que una opción más rápida sería insegura.',
  'site.landing.faq.windDown.q': '¿Qué pasa si Truecairn cierra?',
  'site.landing.faq.windDown.a':
    'Publicamos un plan de cierre junto con nuestros términos. A lo que nos comprometemos hoy: aviso previo, una ventana de solo lectura (objetivo: 180 días) para exportar tus datos, y una exportación firmada de tu registro de auditoría. El plan distingue esos compromisos de las cosas que nuestro diseño permite pero que no hemos construido: una herramienta de descifrado sin conexión, una exportación masiva o de la clave exterior, y la custodia de ceremonias ya en marcha. Tu bóveda no está atada a nosotros por diseño, pero preferimos que leas qué partes están construidas antes de confiar en ellas.',

  'site.landing.closing.title': 'Casi todo esto lo harás una sola vez. El alivio es permanente.',
  'site.landing.closing.lede':
    'Crea una cuenta gratuita. Añade un plan, un contacto y un elemento a la bóveda. Dentro de unos cuatro minutos habrás terminado.',
};
