import type { PagesMessageKey } from './en.js';

// Spanish for the public content pages. Partial, like the other halves: a key
// not yet translated falls back to English rather than rendering a placeholder
// nobody can tell apart from a real translation.
//
// NOT YET REVIEWED BY A NATIVE SPEAKER — the same gate as ../app/es.ts, and the
// reason Spanish is still absent from OFFERED_LOCALES. The glossary lives in the
// header of that file and applies here unchanged.
export const pagesEs: Partial<Record<PagesMessageKey, string>> = {
  // ── Guía de usuario (/guide) ─────────────────────────────────────────────
  //
  // REGLA DE CONTENIDO (vinculante): S3 usa el esquema anidado en el que la
  // frase de liberación es OBLIGATORIA (docs/24). En S2 esa misma frase es un
  // respaldo OPCIONAL. Una traducción que difumine esa diferencia — o que llame
  // a la frase de liberación «opcional» o «solo una parte» en S3 — le dice a
  // quien lee que unos elementos irrecuperables para siempre se pueden
  // recuperar. No suavices §7 ni §11 para que se lean mejor.
  'site.guide.eyebrow': 'ayuda',
  'site.guide.title': 'Guía de usuario',
  'site.guide.intro':
    'Esta guía recorre todo lo que hace Truecairn, pantalla por pantalla. Si solo vas a leer dos secciones, lee <secrets>los secretos que gestionas</secrets> y <tiers>niveles de sensibilidad y liberación</tiers>: entre las dos explican qué se puede recuperar y qué no.',
  'site.guide.contents': 'Contenido',

  'site.guide.overview.title': 'Cómo funciona Truecairn',
  'site.guide.overview.body':
    'Truecairn mantiene cifradas en tu propio dispositivo las partes importantes de tu vida digital y las libera a las personas que elijas —según las reglas que tú escribas— solo si dejas de estar localizable. Nosotros no podemos leer nada de tu bóveda. Tú añades elementos, invitas a contactos de confianza y defines las condiciones de liberación. Si dejas de confirmar tu actividad, un motor de continuidad va escalando poco a poco mediante recordatorios; si llega a la fase de liberación, tus contactos confirman y, entre todos, reconstruyen el acceso. Todo es reversible hasta el último momento.',

  'site.guide.secrets.title': 'Los secretos que gestionas',
  'site.guide.secrets.lede':
    'Tres secretos distintos cumplen tres funciones distintas. Tenerlos claros es lo más importante que puedes entender:',
  'site.guide.secrets.passkey':
    '<strong>Tu clave de acceso</strong> te identifica al iniciar sesión. Vive en tu dispositivo o en tu llave de seguridad. Iniciar sesión abre una sesión, pero <em>no</em> desbloquea la bóveda.',
  'site.guide.secrets.master':
    '<strong>Tu frase maestra</strong> desbloquea la bóveda. Deriva tus claves de cifrado en tu dispositivo y nunca sale de él; no podemos verla ni restablecerla.',
  'site.guide.secrets.release':
    '<strong>Tu frase de liberación</strong> es otra cosa distinta. La guardas sin conexión y fuera de casa, y solo se usa durante una ceremonia de liberación.',
  'site.guide.secrets.recoveryNote':
    '<strong>El código de recuperación es tu red de seguridad.</strong> Al darte de alta guardas un código de recuperación de un solo uso. Si algún día olvidas tu frase maestra, ese código es la única forma de volver a entrar en tu bóveda. Guárdalo en un lugar seguro y sin conexión.',

  'site.guide.account.title': 'Crear tu cuenta',
  'site.guide.account.body':
    'Regístrate con tu correo electrónico y da de alta una clave de acceso. Después realizas una ceremonia de inscripción única: eliges tu frase maestra, tu dispositivo deriva tu material criptográfico (esa breve pausa de «trabajando» es criptografía real ejecutándose en tu navegador) y se te muestra tu código de recuperación. Guárdalo antes de continuar; solo se muestra una vez. Cuando termina la inscripción, tu bóveda queda desbloqueada y lista.',

  'site.guide.unlock.title': 'Bloquear y desbloquear',
  'site.guide.unlock.body':
    'Iniciar sesión y desbloquear son dos pasos. Después de iniciar sesión con tu clave de acceso, introduces tu frase maestra para desbloquear la bóveda durante esa sesión. <strong>Bloquear bóveda</strong> borra la clave de la memoria del navegador pero mantiene la sesión abierta: la próxima vez volverás a introducir la frase maestra. <strong>Cerrar sesión</strong> hace las dos cosas: termina la sesión y borra la clave. La bóveda también se bloquea sola tras un periodo de inactividad. Puedes bloquearla o cerrar sesión desde el menú de cuenta, al final de la barra lateral, o desde Ajustes.',

  'site.guide.vault.title': 'Tu bóveda',
  'site.guide.vault.body':
    'La bóveda guarda tus elementos: notas, credenciales, instrucciones de recuperación, documentos. Añade un elemento, dale una categoría y elige su nivel de sensibilidad (ver la sección siguiente). Puedes adjuntar archivos cifrados. Todo se cifra en tu dispositivo antes de subirse, así que a nuestros servidores solo llega texto cifrado. Abre cualquier elemento para editarlo o cambiarle el nivel.',

  'site.guide.contacts.title': 'Contactos de confianza',
  'site.guide.contacts.body':
    'Los contactos de confianza son las personas que pueden ayudar a liberar tu bóveda si dejas de dar señales. Invita a cualquiera que tenga correo electrónico: no necesitan una cuenta para empezar, solo el enlace firmado que les envías. Etiqueta a cada contacto con un rol (por ejemplo, Personal o Profesional). Los roles importan: una liberación puede exigir contactos de roles <em>distintos</em>, de modo que ni un solo grupo familiar ni un solo entorno de trabajo pueda actuar por su cuenta. Cuando un contacto acepta y se inscribe, su dispositivo genera sus propias claves y pasa a poder custodiar una parte. Recomendamos tener más contactos que el mínimo necesario, para que la liberación pueda seguir adelante si alguien no está disponible.',

  'site.guide.tiers.title': 'Niveles de sensibilidad y liberación',
  'site.guide.tiers.lede':
    'Cada elemento de la bóveda pertenece a uno de tres niveles. El nivel decide cómo se libera el elemento, así que puedes equilibrar facilidad de recuperación y resistencia a la connivencia, elemento por elemento.',
  'site.guide.tiers.s1.title': 'S1 — el más accesible',
  'site.guide.tiers.s1.body':
    'Se libera cuando cualquiera de tus contactos de confianza abre el sobre sellado que le dejaste. Úsalo para lo que deba resultar fácil de alcanzar.',
  'site.guide.tiers.s2.title': 'S2 — sensible',
  'site.guide.tiers.s2.body':
    'Un reparto plano de 2 de 3 entre dos contactos de roles distintos y tu frase de liberación. Dos cualesquiera de esas tres partes lo reconstruyen. Aquí <strong>la frase de liberación es una de las tres partes: un respaldo opcional</strong>; dos contactos pueden recuperar S2 sin ella, así que perder la frase de liberación no hace por sí solo que S2 sea irrecuperable.',
  'site.guide.tiers.s3.title': 'S3 — el más sensible',
  'site.guide.tiers.s3.body':
    'Un esquema anidado. Tu frase de liberación es una <strong>máscara obligatoria</strong> sobre un reparto de 2 de 3 en manos de tres contactos. Reconstruir S3 exige la frase de liberación <strong>y</strong> dos cualesquiera de esos tres contactos. No hay ninguna vía que use solo contactos para S3, y la frase de liberación no es una parte más entre varias: siempre es imprescindible.',
  'site.guide.tiers.note':
    '<strong>La diferencia decisiva.</strong> En S2 la frase de liberación es un respaldo opcional. En S3 es obligatoria: si pierdes tu frase de liberación, tus elementos S3 quedan <strong>irrecuperables para siempre</strong>; unos contactos que se pusieran de acuerdo nunca podrían llegar a ellos, y nosotros no podemos ayudar. Archiva con ese equilibrio en mente todo aquello que no soportarías que se abriera por connivencia, ni perder si desaparece tu frase.',

  'site.guide.plans.title': 'Planes de continuidad',
  'site.guide.plans.body':
    'La pantalla de Planes muestra cómo se libera cada nivel de tu bóveda y a quién: reúne en una sola vista tus niveles, tus contactos y las reglas de liberación. (Explica tus niveles de confianza; no es una página de facturación.) Define un disparador, un periodo de espera y una escalera de fases de liberación, y previsualiza la cronología antes de guardar. Editar las reglas de liberación es el cambio de mayores consecuencias que puedes hacer, así que solo surte efecto tras un retardo, durante el cual sigue vigente el plan anterior y puedes revertirlo.',

  'site.guide.engine.title': 'El motor de continuidad',
  'site.guide.engine.body':
    'El motor es lo que nota que te has quedado en silencio. Mientras estás activo, permanece inactivo. Si te saltas confirmaciones más allá del umbral que hayas configurado, avanza paso a paso —primero te recuerda, luego avisa a tus contactos, luego abre un periodo de espera—, nunca todo a la vez. Confirmas que sigues ahí desde la pantalla del Motor o respondiendo a una solicitud de confirmación. Si sabes que vas a estar ilocalizable (un viaje, un ingreso hospitalario, un retiro), puedes registrar una ausencia para que el motor espere más. El motor se inclina con claridad hacia el «sigue ahí».',

  'site.guide.ceremony.title': 'La ceremonia de liberación',
  'site.guide.ceremony.body':
    'Si el motor llega a la fase de liberación, tus contactos reciben un enlace firmado y se les pide que confirmen o impugnen; una impugnación detiene la liberación y la pasa a revisión, y quien simplemente tenga dudas debería impugnar en lugar de confirmar. Confirmar es provisional al principio: abre una ventana de revocación durante la cual ese contacto —o tú, desde cualquier dispositivo verificado— puede cancelar con un solo toque. Solo cuando pasa esa ventana, se alcanza el umbral de confirmaciones entre roles distintos y termina el periodo de espera sin cancelación, la plataforma libera la clave exterior con cierre temporal para que los contactos que confirmaron puedan reconstruir. En S3 necesitan además tu frase de liberación para retirar la máscara del resultado. Cada acción queda fechada y firmada en el registro de auditoría.',

  'site.guide.recovery.title': 'Recuperación y secretos perdidos',
  'site.guide.recovery.lede': 'Lo que pasa si pierdes un secreto depende de cuál sea:',
  'site.guide.recovery.master':
    '<strong>¿Has olvidado tu frase maestra?</strong> Usa tu código de recuperación de un solo uso para volver a entrar y luego define una frase maestra nueva.',
  'site.guide.recovery.release':
    '<strong>¿Has perdido tu frase de liberación?</strong> Si conservas tu frase maestra (o tu código de recuperación), puedes rotar a una frase de liberación nueva. El efecto de perderla depende del nivel: <strong>S2 sobrevive</strong> —sus dos contactos de roles distintos pueden reconstruir sin ella—, pero <strong>S3 no</strong>, porque la frase de liberación es su máscara obligatoria. No existe ninguna vía de «contactar con soporte» capaz de restaurar S3.',
  'site.guide.recovery.everything':
    '<strong>¿Lo has perdido todo</strong> —frase maestra, frase de liberación y código de recuperación—? Entonces tu cuenta es irrecuperable y no podemos ayudarte. Tus contactos aún pueden completar una liberación S1 o S2 si dejas de estar localizable; S3 necesita además la frase de liberación.',

  'site.guide.privacy.title': 'Seguridad y privacidad',
  'site.guide.privacy.body':
    'Truecairn es de conocimiento cero: el contenido en claro de tu bóveda, tus frases, tu código de recuperación y tus claves nunca llegan a nuestros servidores, ni en un registro, ni en una notificación, ni en ningún sitio. Los cambios sensibles (editar contactos, umbrales o la frase de liberación) exigen un segundo factor reciente y una firma con tu frase, y esperan un retardo con aviso por otra vía, de modo que una sesión secuestrada no pueda reconfigurar tu plan sin que te enteres. Puedes leer el <security>modelo de seguridad</security> completo y el <threat>modelo de amenazas</threat> para conocer los detalles y los límites reales.',

  'site.guide.ai.title': 'El asistente y el guardián de IA',
  'site.guide.ai.lede':
    'Truecairn incluye una IA opcional con una regla estricta, garantizada en el código: solo puede <strong>añadir</strong> seguridad, nunca quitarla. En el producto se traduce en esto:',
  'site.guide.ai.assistant':
    '<strong>Asistente e informe</strong>: responden preguntas y resumen tu cuenta usando solo metadatos (recuentos, estados, periodicidad). Nunca ven tu contenido cifrado, ni los nombres de tus elementos, ni tus claves.',
  'site.guide.ai.proposals':
    '<strong>Propuestas de preparación</strong>: sugerencias en tu panel (por ejemplo, «añade un contacto S3 con otro rol»). Una propuesta no cambia nada hasta que la apruebas, y si la descartas desaparece.',
  'site.guide.ai.autonomy':
    '<strong>Autonomía opcional</strong>: desactivada por defecto. Si la activas en Ajustes, la IA puede poner en cola en tu nombre un intervalo de confirmación más corto —nunca por debajo del mínimo que tú fijes— y el cambio espera en tu lista de pendientes, marcado como propuesto por la IA, donde puedes vetarlo antes de que surta efecto.',
  'site.guide.ai.guardian':
    '<strong>El guardián</strong>: vigila si hay anomalías en una liberación en curso y solo puede hacer una cosa al respecto: pausarla para que la revises. Nunca puede aprobar ni hacer avanzar una liberación.',
  'site.guide.ai.optOut':
    'Un solo interruptor en Ajustes («Desactivar la IA en mi cuenta») desactiva para ti todas las funciones de IA sin tocar tus confirmaciones ni tu plan de liberación. La explicación completa de qué puede ver y hacer la IA está en <ai>Cómo usa Truecairn la IA</ai>.',

  'site.guide.help.title': 'Cómo conseguir ayuda',
  'site.guide.help.body':
    'El Asistente integrado responde preguntas sobre cómo funciona Truecairn y qué hacer a continuación: solo ve los metadatos de tu cuenta, nunca tu contenido cifrado, y nunca deberías pegar en él una frase ni un código de recuperación. Para cuestiones de cuenta, escríbenos desde la <contact>página de contacto</contact>. Y recuerda: nunca te pediremos una frase, un código de recuperación ni nada que esté dentro de tu bóveda.',
  // ── Subnavegación de /security/* ─────────────────────────────────────────
  'site.security.pill.model': 'Modelo de seguridad',
  'site.security.pill.threat': 'Modelo de amenazas',
  'site.security.pill.ai': 'IA',
  'site.security.pill.build': 'Procedencia de la compilación',
  'site.security.pill.limits': 'Límites conocidos',
  'site.security.pill.disclosure': 'Política de divulgación',

  // ── Procedencia de la compilación (/security/build) ──────────────────────
  //
  // LA PÁGINA QUE NO DEBE PROMETER DE MÁS. Tres frases dicen lo que esta página
  // NO puede demostrar: que todavía no existe una certificación firmada, que la
  // propia página podría estar mintiendo si el origen estuviera comprometido, y
  // que nadie ha realizado la comprobación. Cada una de esas advertencias es
  // esencial; suavizarlas o quitarlas reproduce en otro idioma el defecto que ya
  // hubo que corregir aquí una vez.
  'site.build.eyebrow': 'seguridad',
  'site.build.title': 'Procedencia de la compilación',
  'site.build.lede':
    'Truecairn cifra todo en tu navegador, lo que significa que el código que realiza ese cifrado es código que te servimos nosotros. Ese es el punto débil honesto de todo producto cifrado de extremo a extremo basado en navegador, incluido este: si nuestro origen estuviera comprometido o coaccionado, podría servir un paquete modificado a una persona concreta. Preferimos describirlo con claridad y darte algo que comprobar antes que dejar que la expresión «conocimiento cero» haga el trabajo.',
  'site.build.what.title': 'Qué es esta página',
  'site.build.what.body':
    'Cada compilación publica un SHA-256 de cada archivo que entrega, más una huella combinada de todos ellos. Abajo está la huella del paquete <strong>que estás ejecutando ahora mismo</strong> y el código fuente del que se compiló. La compilación es determinista, así que el mismo código con la misma cadena de herramientas fijada produce la misma huella en tu máquina y en la nuestra: esa es la propiedad sobre la que se apoya esta página, y puedes comprobarla tú.',
  'site.build.notShipped':
    '<strong>Lo que todavía no hemos publicado:</strong> una certificación de compilación firmada por versión. El flujo de trabajo que la genera existe y es público, pero no se ha publicado ninguna versión etiquetada, así que hoy no hay nada firmado con lo que puedas contrastar. Preferimos decirlo aquí antes que mandarte a buscar un artefacto que no existe. Hasta entonces, la comprobación de abajo es una recompilación que haces tú: más débil, porque se apoya en tu copia del código y no en una firma de una infraestructura que no controlamos, y aun así vale la pena.',
  'site.build.noManifest':
    'Esta compilación no publicó un manifiesto. Es lo esperable en una compilación local de desarrollo y no lo es en <code>truecairn.app</code>: si lo ves ahí, tómalo como motivo para preguntarnos, no como prueba de nada.',
  'site.build.bundle.title': 'Este paquete',
  'site.build.bundle.digest': 'Huella del paquete',
  'site.build.bundle.commit': 'Commit de origen',
  'site.build.bundle.ref': 'Compilado desde la ref',
  'site.build.bundle.builtAt': 'Compilado el',
  'site.build.bundle.files': 'Archivos',
  'site.build.check.title': 'Cómo comprobarlo',
  'site.build.check.unpublished':
    'El repositorio de código aún no es público, así que hoy puedes anotar esta huella y compararla entre visitas y dispositivos: si el paquete que se te sirve difiere alguna vez del que se sirve a todo el mundo, merece la pena preguntar. La verificación independiente contra una certificación publicada será posible cuando se publique el repositorio; preferimos decirlo así antes que enlazarte a algo que no existe.',
  'site.build.check.step1': 'Clona <repo>el código del cliente publicado</repo>.',
  'site.build.check.step2':
    'Recompila desde el código con la cadena de herramientas fijada: Node 22 y exactamente la versión de pnpm que declara el repositorio, instalando con <code>--frozen-lockfile</code>. Los pasos de compilación y las causas conocidas de variación byte a byte están en <code>docs/BUILDING.md</code>.',
  'site.build.check.step3':
    'Compara el <code>bundleDigest</code> que imprime tu compilación con el que se muestra arriba.',
  'site.build.check.mismatch':
    '<strong>Espera una diferencia si los dos no están en el mismo commit.</strong> El repositorio publicado es una exportación curada del cliente, y este despliegue puede ir por delante. Por sí sola, una discrepancia significa «son versiones distintas» al menos tan a menudo como cualquier otra cosa: contrasta el commit de arriba con la cabecera publicada antes de sacar conclusiones, y pregúntanos si coinciden y aun así las huellas difieren. Decirte que una discrepancia es automáticamente alarmante convertiría esta página en una fuente de falsas alarmas, que es otra forma de deshonestidad.',
  'site.build.proves.title': 'Qué demuestra y qué no',
  'site.build.proves.does':
    '<strong>Sí demuestra</strong> que servir a una sola persona un paquete modificado tiene que sobrevivir a la comparación con una compilación que cualquiera puede hacer desde el código publicado. Una manipulación que antes habría sido silenciosa y negable pasa a ser una manipulación que una sola persona con una terminal puede detectar.',
  'site.build.proves.doesNot':
    '<strong>No demuestra</strong> que esta página no pueda mentirte. El código que calcula y muestra esta huella lo sirvió el mismo origen que el paquete que describe, así que un origen totalmente comprometido podría servir una página falseada con la misma facilidad con la que serviría un paquete falseado. Comprobar solo tiene sentido cuando la comparación ocurre en un sitio que no controlamos: en tu máquina, con código que has descargado tú. Preferimos que entiendas ese límite antes de que te fíes de una marca verde.',
  'site.build.proves.unchecked':
    '<strong>Y tampoco demuestra</strong> que nadie lo haya comprobado de verdad. Ningún tercero ha reproducido esta compilación ni ha publicado el resultado; el estado honesto de esta página es que la comprobación está disponible, no que se haya realizado. La certificación firmada por versión, que te permitiría verificar sin recompilar nada, está todavía por llegar.',
  'site.build.files.title': 'Huellas por archivo',
  'site.build.files.hide': 'Ocultar',
  'site.build.files.show': 'Mostrar los {{count}} archivos',
  'site.build.files.colFile': 'Archivo',
  'site.build.files.colHash': 'SHA-256',
  // ── Modelo de seguridad (/security) ──────────────────────────────────────
  "site.security.model.eyebrow": "seguridad",
  "site.security.model.title": "Modelo de seguridad",
  "site.security.model.lede":
    "Truecairn es un sistema de conocimiento cero. Todo lo que hay en tu bóveda se cifra en tu propio dispositivo antes de subirse, con claves que el servidor nunca guarda. El servidor almacena texto cifrado, claves públicas, sales y cajas selladas: nunca texto en claro, nunca una de tus frases, nunca una clave sin envolver. Su única capacidad criptográfica es liberar una capa exterior (una puerta con cierre temporal) cuando, y solo cuando, el motor de continuidad y tus contactos de confianza coinciden en que se han cumplido las condiciones que tú escribiste.",
  "site.security.model.summary":
    "Esta página es el resumen legible. La especificación criptográfica completa está en los documentos de arquitectura del proyecto, y los adversarios frente a los que diseñamos están catalogados en el <threat>modelo de amenazas</threat>.",
  "site.security.model.secrets.title": "Los tres secretos",
  "site.security.model.secrets.lede":
    "Tres secretos distintos cumplen tres funciones distintas. Mantenerlos separados es el corazón del diseño:",
  "site.security.model.secrets.passkey":
    "<strong>Tu clave de acceso</strong> te identifica en el día a día. Iniciar sesión abre una sesión; por sí solo no desbloquea la bóveda.",
  "site.security.model.secrets.master":
    "<strong>Tu frase maestra</strong> desbloquea la bóveda. Deriva en tu dispositivo todas las claves de cifrado de la bóveda, nunca sale de él y el servidor no puede verla ni restablecerla. Si la olvidas, recuperas el acceso con el código de recuperación de un solo uso que guardaste al darte de alta.",
  "site.security.model.secrets.release":
    "<strong>Tu frase de liberación</strong> es otra cosa distinta. La guardas sin conexión y fuera de casa, y solo se usa durante una ceremonia de liberación (ver los niveles más abajo). El servidor nunca la ve; solo se almacena su sal de derivación de clave.",
  "site.security.model.crypto.title": "Cómo se cifra tu bóveda",
  "site.security.model.crypto.body":
    "El contenido de la bóveda se sella con cifrado autenticado <strong>XChaCha20-Poly1305</strong> (libsodium), con claves aleatorias de 256 bits por elemento y nonces aleatorios por operación. Las claves se derivan de tu frase maestra con <strong>Argon2id</strong> (256 MiB de memoria, 4 pasadas) sobre una sal aleatoria de 16 bytes por cuenta. Las partes de los contactos se envuelven con la clave pública <strong>X25519</strong> de cada contacto; las confirmaciones y las entradas de auditoría se firman con <strong>Ed25519</strong>. Todo esto se ejecuta en el navegador; el papel criptográfico del servidor se limita a almacenar texto cifrado, firmar entradas de auditoría con su propia clave, gestionar la clave exterior con cierre temporal y encaminar mensajes.",
  "site.security.model.tiers.title": "Los niveles de liberación",
  "site.security.model.tiers.lede":
    "Archivas cada elemento de la bóveda en un nivel de sensibilidad. Cada nivel se reconstruye de una forma distinta, así que puedes equilibrar recuperabilidad y resistencia a la connivencia elemento por elemento.",
  "site.security.model.tiers.s1":
    "<strong>S1: el más accesible.</strong> Se libera cuando cualquiera de tus contactos de confianza abre el sobre sellado que le dejaste.",
  "site.security.model.tiers.s2":
    "<strong>S2: sensible.</strong> Un reparto plano de Shamir de 2 de 3 entre dos contactos de roles distintos y tu frase de liberación. Dos cualesquiera de esas tres partes lo reconstruyen, así que la frase de liberación es un <strong>respaldo opcional</strong>: dos contactos pueden recuperar S2 sin ella, y perderla no hace por sí solo que S2 sea irrecuperable.",
  "site.security.model.tiers.s3":
    "<strong>S3: el más sensible.</strong> Un esquema anidado: tu frase de liberación es una <strong>máscara obligatoria</strong> sobre un reparto de 2 de 3 en manos de tres contactos. La reconstrucción exige la frase de liberación <strong>y</strong> dos cualesquiera de los tres contactos. No hay ninguna vía que use solo contactos. Si se pierde la frase de liberación, S3 queda irrecuperable para siempre: unos contactos que se pusieran de acuerdo nunca podrán llegar a él, y el servidor no puede ayudar. Es así por diseño.",
  "site.security.model.gate.title": "La puerta temporal",
  "site.security.model.gate.body":
    "Por encima de las claves de nivel hay una capa exterior que custodia la plataforma: una clave aleatoria que envuelve el texto cifrado almacenado y que solo se libera cuando termina el periodo de espera del motor sin cancelación. Es un <strong>cierre temporal, no una clave de confidencialidad</strong>: quitarlo retira una envoltura, pero las envolturas interiores siguen exigiendo los secretos que el servidor nunca ve. Un único proceso de larga duración es la única vía de código que puede liberarla, y ese proceso es de código abierto.",
  "site.security.model.audit.title": "El registro de auditoría",
  "site.security.model.audit.body":
    "Cada suceso relevante para una liberación —confirmaciones, retiradas, impugnaciones, ediciones, revocaciones— se añade a un registro encadenado por hashes. El servidor firma cada entrada; tu dispositivo firma además las sensibles con una clave derivada de tu frase maestra. Puedes verificar que la cadena está intacta y que las entradas firmadas por el usuario se validan con tu clave publicada. Un servidor que inventara o reordenara entradas produciría firmas que no validan, o una cadena rota: ambas cosas son detectables.",
  "site.security.model.ai.title": "Dónde encaja la IA",
  "site.security.model.ai.body":
    "La IA de Truecairn queda <em>fuera</em> de todo lo anterior. Ve una porción autorizada de metadatos —recuentos, estados, periodicidad— y nunca texto cifrado, nombres, claves ni frases. Su autoridad es unidireccional por construcción: puede sugerir, puede (si tú lo activas) poner en cola un ajuste más estricto que puedes vetar, y puede pausar una liberación en curso para que la revises; nunca puede relajar un control, hacer avanzar una liberación ni descifrar nada. La explicación completa está en <ai>Cómo usa Truecairn la IA</ai>.",
  "site.security.model.windDown.title": "Si Truecairn desaparece",
  "site.security.model.windDown.body":
    "Las partes legítimas —tú, tus contactos, quien custodie la frase de liberación— pueden seguir descifrando con código disponible públicamente. Consulta el <winddown>plan de cierre</winddown> para saber a qué nos comprometemos si la empresa cierra.",
  "site.security.model.audits.title": "Revisiones independientes",
  "site.security.model.audits.none":
    "Todavía no hemos publicado ninguna auditoría de seguridad externa, y no tenemos ninguna certificación de seguridad (ni SOC 2, ni ISO 27001, ni ninguna otra). Preferimos decirlo con claridad antes que enlazar a un informe que no existe. Cuando se complete una revisión independiente y podamos publicarla, el informe —o un resumen y cómo solicitar la versión completa— aparecerá aquí.",
  "site.security.model.audits.report":
    "¿Has encontrado algo antes que nosotros? Nuestra <disclosure>política de divulgación coordinada</disclosure> explica cómo comunicarlo. Nuestro objetivo es acusar recibo en un plazo de {{days}} días hábiles en <email>{{email}}</email>.",
  "site.security.model.notCovered.title": "Lo que esta página no cubre",
  "site.security.model.notCovered.body":
    "Todo lo anterior es lo que el sistema sí protege. La otra mitad —aquello frente a lo que no protegemos, lo que no hemos construido y lo que nadie ha probado todavía— está en <limits>límites conocidos</limits>. Es la más útil de las dos páginas si estás decidiendo si confiarnos algo que importa.",
  // ── Modelo de amenazas (/security/threat-model) ──────────────────────────
  "site.security.threat.eyebrow": "seguridad",
  "site.security.threat.title": "Modelo de amenazas",
  "site.security.threat.lede":
    "Truecairn tira en dos direcciones opuestas. Un <strong>falso positivo</strong> —liberar tu bóveda estando tú vivo y sin tu consentimiento— es irreversible y catastrófico en el nivel superior. Un <strong>falso negativo</strong> —no liberar nunca cuando realmente ya no estás— echa por tierra todo el propósito. Cada medida de abajo se juzga frente a las dos. El motor se inclina hacia el «sigue ahí», porque una liberación indebida no se puede deshacer.",
  "site.security.threat.assumptions":
    "Damos por supuesto que las primitivas criptográficas son sólidas, que tus dispositivos registrados no están comprometidos y que elegiste a tus contactos de buena fe. <strong>No</strong> damos por supuesto que las intenciones de un contacto no cambien, que un dispositivo o un canal concreto siga bajo tu control, ni que quien opera el servicio merezca poder descifrar. La consecuencia recorre todo el diseño: <strong>la autoridad de una sola parte está prohibida</strong> en cualquier punto donde una liberación pueda avanzar.",
  "site.security.threat.t51.title": "5.1 — Un contacto de confianza malicioso",
  "site.security.threat.t51.body":
    "El fallo más probable en la vida real: un contacto que incluiste de buena fe espera a que pase un periodo sin señales tuyas para provocar una liberación que tú no consentirías. Lo contrarrestamos con consenso de varios contactos, una mezcla obligatoria de roles distintos, avisos cruzados entre contactos, la escalera de periodos de espera y una ventana de revocación en la que tú —o cualquier contacto que haya confirmado— podéis cancelar.",
  "site.security.threat.t52.title": "5.2 — Cuenta comprometida",
  "site.security.threat.t52.body":
    "Alguien con tu sesión autenticada, pero sin tu frase ni tus partes, no puede descifrar nada: la credencial de acceso abre el panel, no el texto en claro. Reconfigurar contactos, umbrales o la frase de liberación son acciones sensibles protegidas por un segundo factor reciente, una firma con tu frase sobre el cambio exacto y un retardo de varios días con aviso por otra vía, de modo que una sesión secuestrada no puede reconfigurar tu plan sin que te enteres.",
  "site.security.threat.t53.title": "5.3 — Fallo en las notificaciones",
  "site.security.threat.t53.body":
    "No es un atacante, es entropía: un buzón muerto, un filtro de spam, un proveedor que cambia. Si todos los canales fallan en silencio, el motor podría avanzar cuando simplemente no se te ha localizado. Por eso tratamos el no poder localizarte como motivo para pausar y no para seguir: cuando ningún canal funciona —incluido el caso de que no hayas añadido ninguno—, la escalera se detiene y espera en lugar de escalar. Además escalamos despacio, mostramos el estado en vivo en cada dispositivo que abres y mantenemos el periodo de espera lo bastante largo como para darte tiempo a notarlo y cancelar. Pedimos más de un canal, y lo recomendamos, pero hoy por hoy no nos negamos a activar el sistema sin ninguno.",
  "site.security.threat.t54.title": "5.4 — Contacto comprometido",
  "site.security.threat.t54.body":
    "Quien se apodere de la cuenta de un contacto (phishing, duplicado de SIM, un dispositivo robado) no puede iniciar por su cuenta un episodio de inactividad, y deliberadamente nunca guardamos una parte utilizable dentro de la cuenta de un contacto: las partes solo se desenvuelven en el dispositivo vinculado del contacto y en el momento de la ceremonia. El consenso entre roles distintos hace que un solo contacto comprometido nunca baste.",
  "site.security.threat.t55.title": "5.5 — Inactividad falsa",
  "site.security.threat.t55.body":
    "Estás de retiro, ingresado, de excursión o viajando por algún sitio con restricciones: vivo, pero en silencio más allá de tu umbral. Puedes registrar de antemano ausencias que amplían el umbral, la escalera de periodos de espera gana tiempo y un solo toque desde cualquier dispositivo verificado cancela una liberación en curso en cuanto reapareces.",
  "site.security.threat.t56.title": "5.6 — Connivencia de varios contactos",
  "site.security.threat.t56.body":
    "Que dos o más contactos conspiren es la amenaza para la que existe el esquema de reparto de secretos. En <strong>S3</strong> la garantía es criptográfica: los contactos solo tienen un reparto enmascarado, así que cualquier número de ellos, por paciente que sea, no puede reconstruir sin la frase de liberación que guardas fuera de casa. En <strong>S2</strong> la protección es de procedimiento —roles distintos, visibilidad, auditoría y el periodo de espera— y decimos con honestidad que dos contactos de roles distintos pueden llegar a S2 sin la frase. Archiva como S3 cualquier cosa que no soportarías que se abriera por connivencia.",
  "site.security.threat.ai.title": "Nuestra propia IA, tratada como adversaria",
  "site.security.threat.ai.body":
    "Tratamos a nuestra propia IA como una posible adversaria. Un modelo que alucine, una inyección de instrucciones colada en una pregunta o un proveedor de IA comprometido nunca deben poder hacer avanzar una liberación, así que la autoridad de la IA está limitada por estructura y no por política: su única señal al motor <em>pausa</em> una liberación para que la revise una persona, cada acción que realiza queda registrada bajo su propia identidad en la cadena de auditoría a prueba de manipulaciones, la salida del modelo que podría influir en el comportamiento se valida contra esquemas cerrados (una instrucción inyectada resulta inerte) y nunca se le da contenido: solo recuentos, estados y periodicidad. El peor caso de una IA totalmente comprometida es ruido: una falsa alarma que se descarta o una sugerencia que se veta. Consulta <ai>Cómo usa Truecairn la IA</ai>.",
  "site.security.threat.residual.title": "Riesgo residual: lo que no garantizamos",
  "site.security.threat.residual.body":
    "Somos explícitos sobre los límites. No podemos recuperar tus datos si pierdes tu frase de liberación y dejas de estar localizable: S2 sobrevive gracias a sus contactos, pero S3 no. No podemos obligar a tus contactos a estar disponibles ni a cooperar. No podemos defenderte frente a la coacción de quien custodia una clave, frente a un adversario estatal que os ataque a la vez a ti, a tus contactos y a nuestros proveedores, ni frente a un cliente con puerta trasera que tú mismo instales. Registramos metadatos operativos (la existencia de la cuenta, las horas de inicio de sesión y de cambio de estado del motor, entradas de auditoría firmadas) y entregaremos metadatos y texto cifrado ante una orden legal, pero nunca texto en claro, porque no lo tenemos. Y somos un mecanismo de liberación, no un instrumento jurídico: combínanos con un plan sucesorio en regla.",
  "site.security.threat.residual.deliberate":
    "Estos límites son deliberados. Un servicio que promete más de lo que puede cumplir es la opción más peligrosa para aquello que debería sobrevivirte.",
  // ── Cómo usa Truecairn la IA (/security/ai) ──────────────────────────────
  "site.security.ai.eyebrow": "seguridad",
  "site.security.ai.title": "Cómo usa Truecairn la IA",
  "site.security.ai.lede":
    "Truecairn usa la IA en un papel deliberadamente pequeño y deliberadamente unidireccional. La regla de diseño es sencilla y está garantizada en el código: <strong>la IA solo puede añadir seguridad, nunca quitarla</strong>. Puede sugerirte que endurezcas un ajuste, que añadas un recordatorio o pausar una liberación para que la revises; nunca puede relajar un control, hacer avanzar una liberación ni llegar a tu contenido cifrado. Esta página explica exactamente qué hace y dentro de qué límites funciona.",
  "site.security.ai.sees.title": "Qué puede ver la IA",
  "site.security.ai.sees.body":
    "Estrictamente menos que el servidor. A la IA se le da una porción autorizada de tus <strong>metadatos y nada más</strong>: recuentos (cuántos contactos, cuántos elementos), estados de enumeración cerrada (activado o no, qué nivel) y periodicidad (tu intervalo de confirmación). Nunca se le da —y el servidor está construido para que no se le pueda dar— tu contenido cifrado, los títulos de tus elementos, los nombres de tus contactos, tus claves, tus frases ni tus partes. Todo eso es texto cifrado que el propio servidor nunca guarda (consulta el <model>modelo de seguridad</model>). Las preguntas que escribes al asistente son tus propias palabras, enviadas junto con esos mismos metadatos; el cliente además bloquea el texto con forma evidente de secreto antes de que salga de tu dispositivo.",
  "site.security.ai.can.title": "Qué puede hacer la IA, y qué no",
  "site.security.ai.can.suggest":
    "<strong>Sugerir (propuestas).</strong> Puede mostrar una propuesta de seguridad; por ejemplo: «tu plan S3 necesita un contacto con otro rol». Una propuesta es una sugerencia en tu bandeja; no cambia nada hasta que <strong>tú</strong> la apruebas.",
  "site.security.ai.can.act":
    "<strong>Actuar, pero solo de forma vetable y solo si tú lo activas.</strong> Si activas la autonomía en Ajustes, la IA puede poner en cola un <strong>endurecimiento</strong>: un recordatorio de confirmación adicional o un intervalo de confirmación más corto, nunca por debajo del mínimo que tú fijes. Cada una de esas acciones espera en tu lista de pendientes tras un retardo y puedes vetarla antes de que surta efecto. Solo puede acortar, nunca alargar.",
  "site.security.ai.can.pause":
    "<strong>Pausar una liberación para revisión (guardián).</strong> Si hay una liberación en curso y algo parece anómalo, la IA puede pasarla a estado de <strong>revisión</strong> y avisarte. Esa es la única señal que puede enviar al motor de continuidad, y falla del lado seguro: puede añadir una barrera de revisión, nunca puede abrir una ni liberar nada.",
  "site.security.ai.can.narrate":
    "<strong>Explicar un informe de continuidad (narración).</strong> Cuando se abre una ceremonia de liberación, tus contactos de confianza ven un informe de pruebas congelado: cada intento de contactar contigo, con resultados acreditados por el proveedor. La IA puede añadir una lectura breve en lenguaje llano de esas mismas pruebas. <strong>Explica, nunca decide</strong>: el resultado lo siguen calculando las reglas, las pruebas selladas y su anclaje de auditoría quedan intactos (la narración se guarda al lado, nunca dentro) y, si la IA está apagada, desactivada por ti, fuera de presupuesto o simplemente da una salida con la forma equivocada, el informe determinista se sostiene solo: una liberación nunca se retrasa ni se bloquea por la narración. El motor que dirige las liberaciones no hace ninguna llamada a la IA.",
  "site.security.ai.can.cannot":
    "<strong>No puede</strong> descifrar contenido, quitar una comprobación de seguridad, bajar un umbral, saltarse un retardo, hacer avanzar o completar una liberación, ni actuar en absoluto cuando la has desactivado.",
  "site.security.ai.guarantee.title": "Cómo se garantiza ese límite, y no solo se promete",
  "site.security.ai.guarantee.body":
    "La regla unidireccional se impone por estructura, no por buena voluntad. Cada acción de la IA pasa por un único punto de control cuyos tipos hacen que una señal de «liberar» o «relajar» sea irrepresentable; una batería de pruebas permanente comprueba que la IA solo puede emitir la señal de revisión que falla del lado seguro y nunca un evento que haga avanzar el motor; y cada acción de la IA se escribe en el mismo registro de auditoría a prueba de manipulaciones que todo lo demás, marcada como realizada por la IA, para que puedas ver exactamente qué hizo. El cliente y estos controles son de código abierto: puedes leerlos y recompilarlos (consulta <model>el modelo de seguridad</model>).",
  "site.security.ai.controls.title": "Tus controles",
  "site.security.ai.controls.off":
    "<strong>Desactivada para tu cuenta.</strong> Un solo interruptor en Ajustes desactiva para ti todas las funciones de IA: asistente, propuestas, autonomía y narración del guardián. Tu maquinaria de seguridad (las confirmaciones, la escalera de liberación) no se ve afectada en absoluto.",
  "site.security.ai.controls.autonomy":
    "<strong>La autonomía es opcional y viene desactivada.</strong> La IA no realiza ninguna acción en tu nombre salvo que la actives explícitamente, y aun entonces solo dentro del mínimo que tú fijes y siempre de forma vetable.",
  "site.security.ai.controls.kill":
    "<strong>Un interruptor de emergencia global.</strong> Quien opera el servicio puede desactivar todo el subsistema de IA al instante; cuando está apagado, cada superficie de IA simplemente enmudece y el resto del producto funciona exactamente igual que antes.",
  "site.security.ai.model.title": "El modelo y tu privacidad",
  "site.security.ai.model.body":
    "El asistente y los informes los genera un modelo de lenguaje grande (Google Gemini). Nunca le enviamos tu contenido en claro, y nunca registramos las instrucciones ni la salida del modelo en bruto: la entrada de auditoría de una acción de IA guarda un hash con sal y recuentos de tokens, no las palabras. Si el modelo no está disponible o la petición superara un presupuesto de coste, las superficies de IA se degradan a un estado vacío en lugar de bloquear nada de lo que necesites hacer.",
  "site.security.ai.report":
    "¿Has encontrado una manera de que la IA supere estos límites? Ese es exactamente el tipo de hallazgo para el que existe nuestra <disclosure>política de divulgación coordinada</disclosure>.",

  // ── Divulgación coordinada (/security/disclosure) ────────────────────────
  "site.security.disclosure.eyebrow": "seguridad",
  "site.security.disclosure.title": "Política de divulgación coordinada",
  "site.security.disclosure.lede":
    "Agradecemos a quienes investigan seguridad el tiempo que dedican a encontrar y comunicar vulnerabilidades de forma responsable. Esta política explica cómo contactarnos, qué te pedimos y qué puedes esperar a cambio. Está escrita de buena fe por un equipo pequeño: es un compromiso de cooperar, no un contrato de recompensas por fallos.",
  "site.security.disclosure.how.title": "Cómo comunicarlo",
  "site.security.disclosure.how.body":
    "Escribe a <email>{{email}}</email> con detalle suficiente para reproducir el problema: componente o URL afectados, pasos, impacto y cualquier prueba de concepto. Si quieres cifrar tu informe, pídenos una clave pública vigente en tu primer mensaje. Un informe claro vale más que un aluvión de salida de escáneres automáticos.",
  "site.security.disclosure.ask.title": "Qué te pedimos",
  "site.security.disclosure.ask.window":
    "Danos un plazo razonable para investigar y corregir antes de cualquier divulgación pública.",
  "site.security.disclosure.ask.scope":
    "No accedas, modifiques ni extraigas datos que no sean tuyos, y no lances ataques que degraden el servicio para otras personas (nada de denegación de servicio, nada de spam, nada de ingeniería social con nuestro equipo ni con nuestros usuarios).",
  "site.security.disclosure.ask.testAccounts":
    "Usa solo cuentas de prueba que controles tú, y detente en cuanto confirmes una vulnerabilidad.",
  "site.security.disclosure.ask.minimum":
    "No explotes el problema más allá del mínimo necesario para demostrarlo.",
  "site.security.disclosure.expect.title": "Qué puedes esperar de nosotros",
  "site.security.disclosure.expect.ack":
    "Un acuse de recibo en un plazo de {{days}} días hábiles confirmando que una persona ha recibido tu informe.",
  "site.security.disclosure.expect.assessment":
    "Una valoración honesta de la gravedad y un plazo realista de corrección.",
  "site.security.disclosure.expect.updates":
    "Actualizaciones periódicas mientras trabajamos, y aviso cuando salga la corrección.",
  "site.security.disclosure.expect.credit":
    "Reconocimiento por tu hallazgo si lo quieres (y discreción si no). Si actúas de buena fe conforme a esta política, no emprenderemos acciones legales contra ti.",
  "site.security.disclosure.scope.title": "Alcance",
  "site.security.disclosure.scope.body":
    "Dentro del alcance: la aplicación web de Truecairn y su API. Fuera del alcance: hallazgos que requieran un dispositivo de usuario final comprometido, informes sobre la solidez de las primitivas criptográficas estándar en sí, denegación de servicio volumétrica y sugerencias de buenas prácticas sin impacto demostrable en la seguridad. Ante la duda, envíalo: preferimos triar un informe dudoso a que se nos escape uno real.",
  // ── Límites conocidos (/security/limits) ─────────────────────────────────
  //
  // LAS REGLAS MÁS ESTRICTAS DEL SITIO. El valor de esta página es que no se
  // anda con rodeos, así que la traducción está sujeta a lo mismo que el
  // original: la frase sobre S1/S2 frente a S3 conserva SUS DOS MITADES (la
  // dependencia y la excepción de S3); «acotado» no es «resuelto», así que
  // donde un límite dice que se ha acotado, la parte que sigue abierta se
  // enuncia en la misma frase. El modo de fallo aquí nunca es un error: es una
  // página bien escrita que ya no revela nada.
  "site.security.limits.eyebrow": "seguridad",
  "site.security.limits.title": "Límites conocidos",
  "site.security.limits.lede":
    "Todo lo que hay en esta página es algo frente a lo que no protegemos, que no hemos construido o que no hemos probado nunca. La publicamos porque una página de seguridad que solo enumera puntos fuertes es una página de marketing, y porque no puedes juzgar si este producto te conviene a partir de la mitad de la que estamos orgullosos.",
  "site.security.limits.notBroken":
    "Esta no es una lista de cosas que creamos rotas. Es una lista de cosas sobre las que nadie tiene pruebas, que es una afirmación distinta y más útil.",
  "site.security.limits.safetyNumber.title":
    "La llamada del número de seguridad no se puede exigir",
  "site.security.limits.safetyNumber.what":
    "Cuando le entregas a un contacto de confianza una parte de tu clave de liberación, te pedimos que confirméis un <strong>número de seguridad</strong> por otra vía: en una llamada o en persona, no a través de nosotros. Eso es lo que impide que alguien con acceso a nuestra base de datos sustituya la clave de tu contacto por la suya y reciba una parte destinada a otra persona.",
  "site.security.limits.safetyNumber.unenforceable":
    "<strong>Solo funciona si haces la llamada de verdad, y nada en el sistema puede saber si la hiciste.</strong> El botón registra lo que tú dices haber confirmado. Quien lo pulsa sin llamar a nadie es indistinguible, para nosotros, de quien leyó los dígitos en voz alta y comprobó cada grupo. <strong>Tu protección de S1 y S2 frente a la sustitución de claves depende de esa llamada. S3 no</strong>: una liberación S3 exige además tu frase de liberación sin conexión, un factor que nuestros servidores no pueden custodiar por estructura, así que sustituir la clave de un contacto no abre una bóveda S3.",
  "site.security.limits.safetyNumber.narrowed":
    "Acotado, pero no cerrado: desde agosto de 2026, a quien no ha confirmado nunca ningún contacto se le muestra un aviso en lugar de dejarlo en un callejón sin salida silencioso. La mitad que no se puede verificar —si la confirmación que registraste corresponde a una llamada que hiciste— sigue igual, y no vamos a presentarla como resuelta.",
  "site.security.limits.noHumanRelease.title": "Ninguna persona ha completado nunca una liberación",
  "site.security.limits.noHumanRelease.mechanism":
    "Nuestras pruebas automáticas recorren una liberación completa de principio a fin: una cuenta se queda en silencio, el motor escala por todos los peldaños de la escalera, se abre una ceremonia, los contactos confirman y la bóveda se libera, con toda la secuencia de auditoría detrás. Eso demuestra el <em>mecanismo</em>.",
  "site.security.limits.noHumanRelease.people":
    "<strong>Que personas reales puedan completar una liberación bajo presión es una afirmación distinta, y es para lo que existen nuestros simulacros de recuperación. Todavía no se han realizado.</strong> Nadie se ha sentado como contacto de confianza en pleno duelo, con nuestras instrucciones delante, y ha conseguido abrir una bóveda.",
  "site.security.limits.mobile.title": "La aplicación móvil no se distribuye",
  "site.security.limits.mobile.body":
    "No hay ninguna aplicación de Truecairn en ninguna tienda de aplicaciones. Existe una compilación para Android que se ha instalado y ejecutado en un dispositivo real, pero todo lo que hay detrás de la pantalla de inicio de sesión está sin probar, y el inicio de sesión con clave de acceso en Android está deliberadamente desactivado hasta que exista una identidad de firma de versión. Considera la aplicación de móvil como no disponible al decidir si este producto te encaja.",
  "site.security.limits.singleRegion.title": "Una región, una réplica, una base de datos",
  "site.security.limits.singleRegion.body":
    "Ejecutamos una sola instancia de la aplicación y una sola base de datos Postgres en una región. No hay conmutación por error. Nuestro simulacro de restauración del 10 de agosto de 2026 midió una recuperación de aproximadamente <strong>50 minutos</strong> hasta tener el sistema en marcha, y el punto de recuperación —cuánto podrías perder— en <strong>hasta 24 horas</strong>. Esas 24 horas las marcan los archivos adjuntos, que se respaldan con instantáneas diarias de volumen en vez de de forma continua; la base de datos en sí está en unos cinco minutos. El peor caso es el que conviene tener en cuenta.",
  "site.security.limits.noLoadTest.title": "Ninguna prueba de carga ni de rendimiento",
  "site.security.limits.noLoadTest.body":
    "No se ha hecho ninguna. Eso solo es defendible porque estamos aumentando el número de cuentas despacio a propósito: la progresión lenta es la razón de que todavía no sea un problema, y también la razón de que exista. Las dos mitades de esa frase son ciertas y preferimos enunciarlas juntas.",
  "site.security.limits.noAudit.title": "Sin auditoría externa y sin certificaciones",
  "site.security.limits.noAudit.body":
    "Ninguna empresa de seguridad independiente ha revisado este sistema, y no tenemos ninguna certificación: ni SOC 2, ni ISO 27001, ninguna. El diseño criptográfico está documentado y el cliente es de código abierto y se puede compilar de forma reproducible para que no tengas que fiarte de nuestra palabra, pero eso es una invitación a comprobarlo, no un sustituto de que alguien lo haya comprobado.",
  "site.security.limits.noDefence.title": "Frente a qué no protegemos en absoluto",
  "site.security.limits.noDefence.lede":
    "Dicho con claridad, porque cada una de estas cosas ha pillado a alguien desprevenido en algún sitio:",
  "site.security.limits.noDefence.ownSecrets":
    "<strong>Perder tus propios secretos.</strong> Si pierdes tu frase y tu código de recuperación, tu bóveda desaparece. No podemos restablecerla: eso es el diseño funcionando, no fallando.",
  "site.security.limits.noDefence.coercion":
    "<strong>La coacción.</strong> Si alguien puede obligarte a desbloquear, el cifrado no te ayuda.",
  "site.security.limits.noDefence.device":
    "<strong>Un dispositivo comprometido.</strong> Todo se cifra en tu navegador, así que quien ya esté dentro de tu máquina ve lo mismo que ves tú.",
  "site.security.limits.noDefence.metadata":
    "<strong>Los metadatos.</strong> No podemos leer tu bóveda, pero sí vemos que la tienes, cuántos elementos contiene, cuándo confirmas tu actividad y quiénes son tus contactos.",
  "site.security.limits.noDefence.state":
    "<strong>Un adversario estatal que te ataque personalmente.</strong> No estamos construidos para eso, y decir lo contrario sería deshonesto.",
  "site.security.limits.noDefence.contacts":
    "<strong>Que tus contactos no estén disponibles.</strong> Si las personas que nombraste no pueden o no quieren actuar, no hay liberación.",
  "site.security.limits.noDefence.falseRelease":
    "<strong>Una liberación falsa, rara pero legítima.</strong> Si te quedas en silencio de una forma que se parece exactamente a lo que este producto vigila, y tus contactos están de acuerdo, tu bóveda se abre. Cada peldaño de la escalera lo puedes revertir tú, pero solo si estás ahí para revertirlo.",
  "site.security.limits.noDefence.notExecutor":
    "Tampoco podemos darte autoridad legal sobre la herencia de nadie. Truecairn hace llegar información a las personas que tú elegiste; no las convierte en tus albaceas.",
  "site.security.limits.elsewhere.title": "Dónde mirar además",
  "site.security.limits.elsewhere.body":
    "Nuestro <threat>modelo de amenazas</threat> expone al completo los adversarios frente a los que está diseñado el sistema. Nuestro <winddown>plan de cierre</winddown> separa aquello a lo que nos comprometemos si el servicio cierra de aquello que nuestra arquitectura permite pero no hemos construido. El estado en vivo de los componentes y nuestra disponibilidad medida están en la <status>página de estado</status>, y esa cifra de disponibilidad se mide desde el 8 de agosto de 2026, no desde el día del lanzamiento, porque una comprobación de salud averiada registró su propio fallo como nueve días de caída y preferimos publicar una ventana corta y honesta antes que una larga y engañosa.",
  // ── Familia de empresa: subnavegación ────────────────────────────────────
  "site.company.pill.about": "Quiénes somos",
  "site.company.pill.contact": "Contacto",
  "site.company.pill.press": "Prensa",
  "site.company.pill.status": "Estado",

  // ── Quiénes somos (/company/about) ───────────────────────────────────────
  "site.company.about.eyebrow": "empresa",
  "site.company.about.title": "Sobre Truecairn",
  "site.company.about.p1":
    "Truecairn es un sistema sereno y deliberado para las partes de tu vida digital que deberían sobrevivirte. Ciframos lo que importa en tu propio dispositivo; si te quedas en silencio, un motor de continuidad va escalando mediante confirmaciones, y las personas que elegiste reconstruyen el acceso por consenso, según las reglas que tú escribiste y con marcha atrás en cada paso.",
  "site.company.about.p2":
    "Partimos de una premisa sencilla e incómoda: la información más importante de tu vida está en sitios a los que solo llegas tú, y nada de ello se transfiere solo. La planificación sucesoria lo trata como papeleo. Nosotros lo tratamos como un problema de ingeniería, y diseñamos pensando en el día en que no podamos ayudarte, porque es justo entonces cuando el diseño tiene que aguantar.",
  "site.company.about.p3":
    "El principio que no vamos a negociar es el conocimiento cero: no podemos leer tu bóveda y no podemos recuperar tu frase maestra. Ese es el propósito. Puedes leer exactamente cómo funciona en el <model>modelo de seguridad</model> y frente a qué protegemos y frente a qué no en el <threat>modelo de amenazas</threat>.",

  // ── Contacto (/company/contact) ──────────────────────────────────────────
  "site.company.contact.eyebrow": "empresa",
  "site.company.contact.title": "Contacta con nosotros",
  "site.company.contact.lede":
    "Somos un equipo pequeño y lo leemos todo. El correo electrónico es la forma más rápida de llegar hasta nosotros: no hay ningún formulario de contacto en el que desaparecer.",
  "site.company.contact.general": "<strong>General y soporte</strong>: <email>{{email}}</email>",
  "site.company.contact.security":
    "<strong>Informes de seguridad</strong>: <email>{{email}}</email> (consulta nuestra <disclosure>política de divulgación</disclosure>)",
  "site.company.contact.press": "<strong>Prensa</strong>: consulta <press>prensa</press>",
  "site.company.contact.neverEmail":
    "Un recordatorio que va en serio: nunca nos envíes por correo una de tus frases, un código de recuperación ni nada que esté dentro de tu bóveda. No podemos usarlo, y no queremos tenerlo.",

  // ── Prensa (/company/press) ──────────────────────────────────────────────
  //
  // EL TEXTO APROBADO SE CITA TAL CUAL, y también es el texto que se lee en la
  // página: no hay una segunda versión más favorable. La traducción tiene que
  // sostener exactamente las mismas afirmaciones: el servidor nunca puede
  // descifrar, y Truecairn no puede leer una bóveda ni restablecer una frase.
  "site.company.press.eyebrow": "empresa",
  "site.company.press.title": "Prensa",
  "site.company.press.boilerplateShort":
    "Truecairn es una plataforma de continuidad digital de conocimiento cero: las personas propietarias cifran su información más importante en sus propios dispositivos, y quienes ellas eligieron pueden reconstruir el acceso por consenso si se quedan en silencio.",
  "site.company.press.boilerplateLong":
    "Truecairn es una plataforma de continuidad digital de conocimiento cero para las partes de la vida digital de una persona que deberían sobrevivirle. Las personas propietarias cifran credenciales, documentos e instrucciones en sus propios dispositivos; un motor de continuidad escala mediante confirmaciones si se quedan en silencio; y los contactos de confianza que designaron reconstruyen el acceso mediante ceremonias de consenso, según las reglas que escribió la persona propietaria y con marcha atrás en cada paso. El servidor solo guarda texto cifrado y cajas selladas, y nunca puede descifrarlos: Truecairn no puede leer una bóveda ni restablecer una frase maestra.",
  "site.company.press.lede":
    "Todo lo que necesita un periodista para escribir sobre Truecairn con exactitud, y nada que no podamos respaldar. Todavía no tenemos cobertura que señalar ni financiación que anunciar: esta página son los recursos, los datos y una línea directa con el pequeño equipo que responde por ellos.",
  "site.company.press.brandAssetsCta": "Recursos de marca",
  "site.company.press.oneAddress":
    "Una sola dirección, leída por las personas que construyen esto. No hay gabinete de prensa por el que dar rodeos.",
  "site.company.press.story.title": "Qué es Truecairn",
  "site.company.press.story.p1":
    "Truecairn es una plataforma de continuidad digital de conocimiento cero. Las personas propietarias cifran lo que les importa en sus propios dispositivos; si se quedan en silencio, un motor de continuidad escala mediante confirmaciones, y los contactos de confianza que eligieron reconstruyen el acceso mediante ceremonias de consenso, según las reglas que escribió la persona propietaria y con marcha atrás en cada paso. El servidor solo almacena texto cifrado y cajas selladas, y nunca puede descifrar.",
  "site.company.press.story.p2":
    "La premisa de la que partimos es incómoda: la información más importante de tu vida está en sitios a los que solo llegas tú, y nada de ello se transfiere solo. La planificación sucesoria lo trata como papeleo. Nosotros lo tratamos como un problema de ingeniería, y diseñamos pensando en el día en que no podamos ayudarte, porque es justo entonces cuando el diseño tiene que aguantar.",
  "site.company.press.quotable":
    "La frase que merece la pena citar, porque es el producto entero: <strong>no podemos leer tu bóveda y no podemos restablecer tu frase maestra.</strong> Cualquier artículo que nos describa como capaces de recuperar los datos de una persona propietaria si nos lo pide está describiendo otra empresa.",
  "site.company.press.boilerplate.title": "Texto aprobado",
  "site.company.press.boilerplate.lede":
    "Texto aprobado: úsalo tal cual, sin necesidad de autorización.",
  "site.company.press.boilerplate.shortMeta": "Una frase · {{words}} palabras",
  "site.company.press.boilerplate.longMeta": "Párrafo completo · {{words}} palabras",
  "site.company.press.boilerplate.shortLabel": "el texto aprobado de una frase",
  "site.company.press.boilerplate.longLabel": "el texto aprobado de un párrafo",
  "site.company.press.copy": "Copiar",
  "site.company.press.copied": "Copiado",
  "site.company.press.copyFailed": "Selecciónalo tú",
  "site.company.press.copyAria": "Copiar {{label}}",
  "site.company.press.facts.title": "Ficha de datos",
  "site.company.press.facts.operatedBy.k": "Operado por",
  "site.company.press.facts.operatedBy.v":
    "Una persona a título individual; no se ha constituido ninguna empresa",
  "site.company.press.facts.whatItIs.k": "Qué es",
  "site.company.press.facts.whatItIs.v": "Plataforma de continuidad digital de conocimiento cero",
  "site.company.press.facts.licence.k": "Licencia",
  "site.company.press.facts.licence.v":
    "Apache 2.0; código del cliente y del proceso de liberación publicado",
  "site.company.press.facts.status.k": "Estado",
  "site.company.press.facts.status.v":
    "Núcleo V1 entregado: bóveda cifrada, alta de contactos de confianza, motor de inactividad y ceremonias de liberación de principio a fin",
  "site.company.press.facts.funding.k": "Financiación",
  "site.company.press.facts.funding.v": "Nada anunciado",
  "site.company.press.facts.audit.k": "Auditoría independiente",
  "site.company.press.facts.audit.v":
    "Ninguna auditoría externa publicada y ninguna certificación de seguridad en vigor",
  "site.company.press.facts.contact.k": "Contacto",
  "site.company.press.facts.codename":
    "Truecairn es un nombre en clave provisional; el nombre definitivo del producto aún no está decidido. Si escribes con un plazo en el que eso importe, pregúntanos antes.",
  "site.company.press.assets.title": "Recursos de marca",
  "site.company.press.assets.lede":
    "El símbolo del cairn y el logotipo. Usa el símbolo tal como se entrega: no lo recolorees, no lo gires, no le añadas efectos ni compongas el logotipo en otra tipografía. El logotipo es Poppins SemiBold, escrito <strong>TrueCairn</strong>, con el «ai» en su propio azul (<code>#002FD7</code>, más profundo que nuestro color de acento y por eso listado aparte más abajo): un guiño al <ai>guardián de IA</ai>, y la única ruptura de color permitida en la palabra. Sobre fondos oscuros, el «ai» adopta el azul suave <code>#9DAAFF</code>, porque <code>#002FD7</code> sobre tinta es ilegible.",
  "site.company.press.marks.full.name": "Símbolo — a todo color",
  "site.company.press.marks.full.note": "fondos claros",
  "site.company.press.marks.inverse.name": "Símbolo — inverso",
  "site.company.press.marks.inverse.note": "fondos oscuros",
  "site.company.press.marks.mono.name": "Símbolo — monocromo",
  "site.company.press.marks.mono.note": "impresión a una tinta",
  "site.company.press.marks.icon.name": "Icono de la aplicación",
  "site.company.press.marks.icon.note": "cuadrado, con esquinas redondeadas",
  "site.company.press.downloadSvg": "Descargar SVG",
  "site.company.press.downloadPng": "Descargar PNG",
  "site.company.press.colour.title": "Color y tipografía",
  "site.company.press.swatch.accent": "Acento",
  "site.company.press.swatch.accentHover": "Acento (hover)",
  "site.company.press.swatch.wordmarkAi": "El «ai» del logotipo",
  "site.company.press.swatch.ink": "Tinta",
  "site.company.press.swatch.sheet": "Papel",
  "site.company.press.type":
    "<strong>Poppins SemiBold</strong> compone el logotipo y la tipografía de display; <strong>Inter</strong> compone el texto corrido. Ambas tienen licencia abierta y están disponibles en Google Fonts, así que no necesitas nada nuestro para componer bien un titular.",
  "site.company.press.shots.title": "Capturas del producto",
  "site.company.press.shots.lede":
    "Capturas reales de la interfaz, libres de publicar citando a Truecairn. Todos los valores que aparecen son datos de demostración: en ningún recurso que entregamos aparece la bóveda, los contactos ni el plan de ninguna persona usuaria, y no podríamos producirlo aunque quisiéramos.",
  "site.company.press.shots.dashboard": "Panel de continuidad",
  "site.company.press.shots.vault": "La bóveda",
  "site.company.press.shots.ceremony": "Ceremonia de liberación",
  "site.company.press.claims.title": "Qué afirmaremos y qué no",
  "site.company.press.claims.lede":
    "Preferimos ser una entrevista aburrida a una entrevista rectificada. Para que no tengas que adivinar cuáles de nuestras afirmaciones son las que sostienen todo:",
  "site.company.press.claims.willSay":
    "<strong>Diremos</strong> que el servidor no puede descifrar una bóveda, y te remitiremos al <model>modelo de seguridad</model>, al <threat>modelo de amenazas</threat> publicado —incluido aquello frente a lo que <em>no</em> protegemos— y a la <build>huella de compilación</build> por versión que permite a cualquiera comprobar el código que servimos.",
  "site.company.press.claims.willNotSay":
    "<strong>No diremos</strong> que somos inexpugnables, ni que lo sea ningún sistema. El modelo de amenazas nombra los ataques que nos derrotan y el riesgo residual que aceptamos.",
  "site.company.press.claims.noCustomers":
    "<strong>No tenemos clientes que exhibir.</strong> Ni logotipos, ni testimonios, ni cifras de usuarios; no por modestia, sino porque publicar quién nos confía su plan de continuidad sería en sí mismo una revelación.",
  "site.company.press.claims.noAudit":
    "<strong>No hemos publicado ninguna auditoría de seguridad externa y no tenemos ninguna certificación de seguridad</strong>: ni SOC 2, ni ISO 27001. Cuando se complete una revisión independiente y podamos publicarla, aparecerá en las <audits>páginas de seguridad</audits> antes que aquí.",
  "site.company.press.claims.noCoverage":
    "<strong>Hasta la fecha, ninguna cobertura y ningún anuncio de financiación.</strong> Lo que aparezca aquí más adelante será un enlace al medio, no un resumen escrito por nosotros.",
  "site.company.press.reach.title": "Cómo localizarnos",
  "site.company.press.reach.press":
    "<strong>Prensa, entrevistas y todo lo demás</strong>: <email>{{email}}</email>",
  "site.company.press.reach.security":
    "<strong>Informes de seguridad</strong>: <email>{{email}}</email>, conforme a nuestra <disclosure>política de divulgación coordinada</disclosure>",
  "site.company.press.reach.deadline":
    "Si vas con el plazo justo, dilo en el asunto y lo trataremos así. Hablaremos sin reservas de la arquitectura, del modelo de amenazas y de lo que todavía no hemos construido; no especularemos sobre la competencia, y no podemos hablar de ninguna cuenta concreta, porque no tenemos nada que contar.",
  // ── Estado del servicio (/status) ────────────────────────────────────────
  //
  // REGLAS DE HONESTIDAD DE LA PÁGINA, vinculantes para la traducción:
  // «unknown» nunca se describe como un grado de funcionamiento; un minuto sin
  // muestra cuenta EN CONTRA de la disponibilidad en lugar de omitirse; y el
  // punto de copias de seguridad informa de una restauración verificada, no de
  // un recuento de instantáneas.
  "site.status.eyebrow": "empresa",
  "site.status.title": "Estado del servicio",
  "site.status.headline.title": "Una caída no puede liberar tu bóveda",
  "site.status.headline.body":
    "Esto es lo que conviene saber antes que nada en esta página. Una interrupción temporal del servicio no dispara una liberación. El motor de continuidad manda desde el servidor y se inclina hacia el <em>«sigue ahí»</em>: solo avanza con pruebas, nunca por la ausencia de un sistema en funcionamiento. Entre cada paso hay periodos de espera largos y una ventana de revocación, así que una caída no puede hacer avanzar una ceremonia sin que te enteres mientras no puedes contactarnos.",
  "site.status.checking": "Comprobando…",
  "site.status.verdict.ok": "Una ceremonia de liberación podría completarse ahora mismo",
  "site.status.verdict.degraded": "Funciona, pero no del todo: detalles abajo",
  "site.status.verdict.down": "Parte de la vía de liberación está fallando",
  "site.status.verdict.unknown": "Ahora mismo no podemos confirmar la vía de liberación",
  "site.status.verdict.unavailable": "Estado no disponible: no pudimos contactar con la API",
  "site.status.live.sub":
    "Una sola pregunta, formulada de forma continua: <strong>¿podría completarse ahora mismo una ceremonia de liberación?</strong> El veredicto es la conjunción de las comprobaciones críticas para la liberación que hay abajo y de nada más: para un producto que actúa en nombre de alguien que no puede quejarse, «la web funciona» no vale casi nada.",
  "site.status.live.stale":
    "Esta lectura es la última que pudimos cargar; la actualización más reciente falló.",
  "site.status.watched.title": "Qué monitorizamos",
  "site.status.watched.lede":
    "Cada componente de abajo se comprueba <em>haciendo</em> la cosa, no confirmando que exista un ajuste: la puerta de liberación se verifica con un ciclo real de envolver y desenvolver sobre la clave en uso, no anotando que hay una clave configurada. El punto es el estado actual; los componentes críticos para la liberación son las únicas entradas del veredicto de arriba.",
  "site.status.tag.critical": "Crítico para la liberación",
  "site.status.tag.supporting": "De apoyo",
  "site.status.dotAria": "{{name}}: {{state}}",
  "site.status.watch.worker.name": "Proceso de liberación: el motor de continuidad",
  "site.status.watch.worker.detail":
    "El proceso que detecta el silencio y hace avanzar cada ceremonia. Lo vigila un latido en la base de datos que demuestra que cada ciclo se completó, más un servicio externo que avisa a una persona cuando no llega un ping. Un proceso vivo pero atascado a mitad de ciclo se informa como fallando, no como sano.",
  "site.status.watch.database.name": "Base de datos",
  "site.status.watch.database.detail":
    "El almacén duradero de texto cifrado, cajas selladas y estado del motor. Su accesibilidad se comprueba de forma continua; nada relacionado con una liberación puede avanzar sin ella, así que un fallo aquí falla del lado seguro en vez de suponer nada.",
  "site.status.watch.outerLayerKek.name": "Clave exterior: la puerta de liberación",
  "site.status.watch.outerLayerKek.detail":
    "La única capacidad criptográfica que tiene el servidor. Se verifica abriendo de verdad una clave que este despliegue tiene almacenada; no comprobando que exista un ajuste, y no sellando algo para volver a abrirlo acto seguido. Esa segunda prueba merece nombrarse: cualquier clave con aspecto válido la pasa, así que habría demostrado que la clave funcionaba sin demostrar que era la correcta, y una clave equivocada habría parecido sana aquí hasta el último paso de la ceremonia de alguien.",
  "site.status.watch.crypto.name": "Criptografía",
  "site.status.watch.crypto.detail":
    "Si la biblioteca criptográfica se inicializó realmente en este proceso. Si no lo hizo, cualquier operación que toque una clave lanzaría un error, así que se comprueba como condición propia en lugar de darla por hecha tras un arranque correcto.",
  "site.status.watch.auditSigning.name": "Firma de auditoría",
  "site.status.watch.auditSigning.detail":
    "Cada acción significativa aterriza en una cadena encadenada por hashes a prueba de manipulaciones, y esa escritura va en la misma transacción que el cambio que registra. Así que un firmante no disponible no solo pierde el registro: revierte el cambio. Por eso es crítico para la liberación.",
  "site.status.watch.notifications.name": "Entrega de notificaciones",
  "site.status.watch.notifications.detail":
    "Si de verdad se podría localizar a alguien: proveedores configurados, profundidad de la cola y mensajes que agotaron sus reintentos. Si todos los canales hacia ti empiezan a fallar, el motor deja de avanzar deliberadamente en lugar de leer una caída de entrega como tu silencio.",
  "site.status.watch.auditChain.name": "Integridad de la cadena de auditoría",
  "site.status.watch.auditChain.detail":
    "Las cadenas se vuelven a verificar de forma continua en segundo plano, y puedes recalcular la tuya en el navegador desde Ajustes. Deliberadamente NO es crítico para la liberación: una cadena rota es una emergencia forense, pero no hace insegura una liberación legítima, y tratarla como crítica pondría todo el motor en rojo en cada reinicio.",
  "site.status.watch.backups.name": "Copias de seguridad: la restauración, no la instantánea",
  "site.status.watch.backups.detail":
    "Las instantáneas las hace el plano de control de la plataforma de alojamiento, que esta aplicación realmente no puede ver. Así que este punto informa deliberadamente de otra cosa, y mejor: si una persona ha restaurado de verdad a partir de una copia y ha descifrado el resultado, y hace cuánto. Esa es la única propiedad que alguien quiere de una copia de seguridad, y un recuento de instantáneas nunca la demuestra: una copia de la que nadie ha restaurado es una hipótesis. El punto se pone ámbar por sí solo cuando ese simulacro caduca, así que no puede seguir verde por dejadez, y el gris significa que nunca se ha verificado ninguna restauración.",
  "site.status.watch.api.name": "API y aplicación web",
  "site.status.watch.api.detail":
    "Las partes que tocas. Una sonda de vida y otra distinta de disponibilidad que informa de «no lista» cuando la base de datos no es accesible, para que un despliegue a medias nunca se presente como sano.",
  "site.status.availability.title": "Disponibilidad medida",
  "site.status.availability.lede":
    "La cifra de abajo se calcula a partir de muestras de salud registradas con reloj, no de un registro de incidencias escrito a posteriori. Esa distinción es toda la razón por la que merece la pena leerla: una página de estado construida a partir de incidencias registradas solo puede ser tan honesta como el día en que alguien se acordó de escribir una.",
  "site.status.availability.unreachable":
    "No pudimos contactar con la API para cargar la cifra actual.",
  "site.status.availability.loading": "Cargando la cifra actual…",
  "site.status.availability.notStarted":
    "Todavía no hemos empezado a registrar la disponibilidad en este despliegue, así que no hay ninguna cifra que publicar. Habrá una aquí, y solo cubrirá el periodo realmente medido.",
  "site.status.availability.tooEarly":
    "Midiendo desde el {{since}}: todavía no es tiempo suficiente para publicar un porcentaje digno de confianza. Un número calculado a partir de unas pocas horas de datos parecería preciso y no significaría nada, así que preferimos esperar antes que redondear.",
  "site.status.availability.days_one": "{{count}} día",
  "site.status.availability.days_other": "{{count}} días",
  "site.status.availability.figureLabel":
    "de los últimos {{days}}, la vía de liberación completa estuvo operativa",
  "site.status.availability.measuringSince": "Midiendo desde el {{since}}.",
  "site.status.availability.shortWindow":
    "Es menos que la ventana de {{days}} días que queremos publicar, y la cifra cubre solo lo que hemos observado realmente: no extrapolamos hacia atrás.",
  "site.status.availability.unobserved_one":
    "{{count}} minuto de ese periodo no registró ninguna muestra; cuenta <em>en contra</em> de la cifra de arriba en lugar de omitirse, porque un monitor que deja de escribir suele ser un sistema que ha dejado de funcionar.",
  "site.status.availability.unobserved_other":
    "{{count}} minutos de ese periodo no registraron ninguna muestra; cada uno cuenta <em>en contra</em> de la cifra de arriba en lugar de omitirse, porque un monitor que deja de escribir suele ser un sistema que ha dejado de funcionar.",
  "site.status.availability.allObserved":
    "Todos los minutos de ese periodo registraron una muestra.",
  "site.status.availability.trustworthy":
    "Dos propiedades la hacen fiable en vez de halagadora. Cuenta la <strong>vía de liberación completa</strong>, así que un minuto en el que no se pudieron entregar notificaciones no es un minuto verde aunque la web fuera perfectamente accesible. Y un minuto <strong>sin ninguna muestra</strong> cuenta como no disponible: el muestreador vive dentro del proceso de liberación, así que la caída que borraría sus propias pruebas es justo la que más importa, y no puede mejorar nuestra cifra quedándose callada.",
  "site.status.watchdog.title": "El vigilante tiene su propio vigilante",
  "site.status.watchdog.lede":
    "El proceso de liberación es la parte crítica para la seguridad: es lo único que detecta tu silencio, y es el componente cuyo fallo silencioso nadie denunciaría. Por eso se monitoriza dos veces, de dos maneras distintas, dando por supuesto que cualquiera de las dos puede fallar.",
  "site.status.watchdog.inside.label": "Dentro",
  "site.status.watchdog.inside.body":
    "Cada ciclo completado escribe un registro de vida en la base de datos, siempre activo e imposible de desactivar por una mala configuración. Demuestra <strong>ciclos</strong>, no que exista un proceso, que es lo que detecta un proceso vivo pero atascado a mitad de ciclo: el fallo en el que las liberaciones se detienen en silencio mientras todos los monitores de procesos siguen en verde.",
  "site.status.watchdog.outside.label": "Fuera",
  "site.status.watchdog.outside.body":
    "Un servicio de latido externo espera un ping según un horario y nos avisa cuando alguno no llega. Se ejecuta en infraestructura que no es nuestra, así que la alarma no depende de aquello que vigila, incluido el caso en que todo nuestro despliegue haya desaparecido.",
  "site.status.watchdog.durability":
    "<strong>Aquí la durabilidad importa más que el tiempo en línea.</strong> El motor trabaja en escalas de días y semanas, no de segundos. Una hora en la que la aplicación no cargue es una molestia; una caja sellada perdida, o un proceso que dejó de latir hace tres semanas sin que nadie lo notara, es el fallo imperdonable. Nuestra monitorización está ponderada en consecuencia, y también lo está dónde invertimos tiempo de ingeniería.",
  "site.status.unknown.title": "Por qué nunca verás una casilla verde que no nos hayamos ganado",
  "site.status.unknown.lede":
    "Los puntos de esta página tienen cuatro estados, y el cuarto es la razón por la que los otros tres valen algo. Todo lo que no podemos observar de verdad se informa como «unknown» en vez de verde, y «unknown» se considera peor que «ok», así que nunca desaparece discretamente dentro de un total sano, ni en el veredicto de arriba ni en la cifra de disponibilidad.",
  "site.status.state.ok.label": "ok",
  "site.status.state.ok.meaning": "comprobado, funcionando",
  "site.status.state.degraded.label": "degradado",
  "site.status.state.degraded.meaning": "funciona, pero mal",
  "site.status.state.down.label": "caído",
  "site.status.state.down.meaning": "comprobado, fallando",
  "site.status.state.unknown.label": "desconocido",
  "site.status.state.unknown.meaning": "nadie lo ha observado",
  "site.status.unknown.twoThings": "Dos cosas que preferimos nombrar antes que redondear:",
  "site.status.unknown.backups":
    "<strong>Las copias de seguridad se atestiguan, no se sondean.</strong> Las instantáneas viven en el plano de control de la plataforma de alojamiento, que esta aplicación no puede ver, así que un punto verde ahí no significa «anoche se hizo una copia». Significa que una persona restauró a partir de una, descifró el resultado y anotó la fecha. Publicamos eso en lugar de lo que no podemos comprobar; y como una fecha puede quedarse vieja, el punto caduca solo y se pone ámbar en lugar de quedarse verde para siempre.",
  "site.status.unknown.attachments":
    "<strong>Almacenamiento de archivos adjuntos cifrados.</strong> Almacenamiento de objetos que guarda los adjuntos cifrados, ilegibles para nosotros y para el proveedor. Su disponibilidad todavía no está instrumentada por separado, así que no tiene ningún punto; un fallo se manifestaría como un error al subir o descargar, no como una alarma.",
  "site.status.unknown.publishesLess":
    "Un panel que adivina a tu favor es peor que no tener panel. Por eso esta página publica menos que la nuestra interna en lugar de más: estás viendo estados de componentes y una cifra medida, no profundidades de cola, números de versión ni un historial de incidencias, porque eso es detalle operativo sobre el que no puedes actuar y un mapa de cuándo estamos menos capacitados para responder.",
  "site.status.outage.title": "Si algo parece ir mal",
  "site.status.outage.lede":
    "Escribe a <email>{{email}}</email> y responderemos lo más rápido que podamos. Ayuda mucho que incluyas qué estabas haciendo, más o menos cuándo y el texto exacto del error, pero envíalo aunque no tengas nada de eso.",
  "site.status.outage.lockedOut":
    "<strong>No puedes entrar y te preocupa que el reloj esté corriendo.</strong> No corre en tu contra: el motor necesita pruebas positivas para avanzar. Una confirmación desde cualquier dispositivo lo reinicia, y si ya ha empezado una liberación, abrir tu bóveda la pausa y te ofrece una confirmación de un solo toque que la detiene del todo.",
  "site.status.outage.unexpectedPrompt":
    "<strong>Has recibido una solicitud de confirmación que no esperabas.</strong> Eso es el motor haciendo su trabajo pronto y en alto, no una liberación. Confirma que estás ahí y se detiene.",
  "site.status.outage.channelsFailing":
    "<strong>Todos tus canales están fallando.</strong> El motor pausa en lugar de leer una caída de entrega como tu silencio, pero no para siempre: pasados 30 días, no poder localizarte de forma sostenida se trata a su vez como prueba y la escalera se reanuda en el paso de escalado. Eso no es un atajo hacia la liberación. Un canal que funcione y un toque lo detienen todo, el retardo de escalado completo sigue teniendo que transcurrir, y tus contactos siguen teniendo que ponerse de acuerdo.",
  "site.status.outage.securityProblem":
    "<strong>Sospechas de un problema de seguridad</strong> y no de una caída: eso va a <email>{{email}}</email> conforme a nuestra <disclosure>política de divulgación</disclosure>, que se compromete a una ventana de primera respuesta.",
  "site.status.outage.midCeremony":
    "<strong>Eres un contacto de confianza en mitad de una ceremonia</strong> y algo ha fallado. Dilo en el asunto y cuéntanos más o menos cuándo: cada paso de una ceremonia queda registrado en el rastro de auditoría, así que podemos decirte exactamente dónde se detuvo.",
  "site.status.planned.title": "Trabajo planificado y qué publicamos",
  "site.status.planned.body":
    "En un producto como este no programamos ventanas de mantenimiento si podemos evitarlo, y hasta la fecha no hemos necesitado ninguna. Cuando lo hagamos, se anunciará aquí y por correo a las personas propietarias primero, nunca se descubrirá.",
  "site.status.planned.changelog":
    "Cada cambio visible para las personas usuarias que publicamos —incluido el trabajo de seguridad y fiabilidad, que redactamos con la misma claridad que las funciones— aterriza en el <changelog>registro de cambios</changelog> en el mismo conjunto de cambios que lo entrega. Si quieres saber qué se movió y cuándo, ese es el registro honesto; esta página trata solo de si funciona ahora. También puedes comprobar la huella exacta de la aplicación que ejecuta tu navegador en la página de <build>procedencia de la compilación</build>.",
};
