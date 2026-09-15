# Paz Services — Control de Taller

## Qué es esto

App web para **Paz Services LTDA.** (RUT 77.714.197-K), taller de reparación de
módulos electrónicos de camiones Mercedes Benz, en Talca, Chile.
Dueño: Jonatan Toledo.

Trabajan en un laboratorio y también hacen servicio en terreno. Tienen equipos
Autovei y Xentry para programación y diagnóstico.

**Habla siempre en español chileno, directo y sin rodeos.**

## Por qué existe

Hubo una versión anterior de esta app que **el equipo no usó**. Murió por
fricción: llenar formularios era más lento que mandar un mensaje por WhatsApp.
Esta versión se rehizo con base de datos en la nube y con muy pocos campos.

Regla de diseño que manda sobre todo lo demás: **crear una OT tiene que tomar
menos de 60 segundos en un celular, con las manos sucias y con sol.** Antes de
agregar cualquier campo, preguntar si vale ese costo.

## Stack

- **Frontend:** un solo `index.html`, JS vanilla con módulos ES, sin framework
  ni build. Publicado en GitHub Pages (repo `paz-taller`).
- **Backend:** Supabase (proyecto `PazServices`, región São Paulo).
  Postgres + Auth + Storage. Plan gratis por ahora — **pasar a Pro cuando
  empecemos a guardar datos reales de clientes** (hoy no hay respaldos
  automáticos en el plan gratis).
- **PWA:** `manifest.webmanifest` + `sw.js`, se instala en el celular. El
  `CACHE` de `sw.js` se sube de versión (`paz-taller-vN`) cada vez que hay un
  cambio de fondo en `index.html`, para que el service worker no sirva una
  versión vieja desde caché.
- **Gastos ya es parte de esta app** (sección propia en la barra inferior).
  La app vieja `github.com/jonatoledojt-jpg/Gastos` queda **deprecada**:
  guardaba todo en `localStorage`, o sea solo en el teléfono donde se
  escribía, sin nube, sin login y sin respaldo. No se migraron datos; si
  hace falta algo de ahí, se reingresa a mano.

El `SUPABASE_URL` y la `anon key` están escritos al inicio del `<script>` del
`index.html`. La anon key es pública por diseño y la protege el RLS.
**La `service_role` nunca va en el código.**

## Archivos

```
index.html              la app completa
manifest.webmanifest    PWA
sw.js                   service worker
01-schema.sql           esquema base (ya ejecutado)
02-setup-extra.sql      perfiles, storage, permisos (ya ejecutado)
03-informes.sql         campo observaciones (ya ejecutado)
04-cotizaciones.sql     tablas cotizaciones y cotizacion_items
05-fix-rls.sql          endurece mi_rol() y agrega mi_sesion() de diagnóstico
06-cotizacion-validez.sql  columna validez_dias en cotizaciones
07-cotizacion-multiple.sql  permite varias cotizaciones por orden
08-terreno.sql          tipo_trabajo/sistema, montos y cotizaciones ocultos al técnico
09-agenda.sql           PRIMER intento de agenda (sobre visitas) — reemplazado, ver abajo
09-agenda-simple.sql    agenda SOBRE ordenes (el enfoque que quedó)
10-cotizaciones-vigente.sql  anular cotizaciones + cotización vigente
11-gastos.sql           gastos, costos fijos, rentabilidad, bucket privado
12-nexa.sql             nexa_config, nexa_conversaciones, nexa_mensajes
supabase/functions/nexa/index.ts   Edge Function de Nexa (llama a la IA)
```

**De la 01 a la 12 están todas aplicadas en la base real** (verificado el
14-09-2026 contra `information_schema`). Si alguna vez hay duda, no confiar
en este documento: preguntarle a la base.

`09-agenda.sql` (con tabla `visitas`) se reemplazó por `09-agenda-simple.sql`
(agenda como columnas en `ordenes`) porque el enfoque de `visitas` obligaba a
llenar dos fichas para el mismo trabajo y quedaba desvinculado de las OT. Los
dos archivos quedan en el historial; **no hace falta correr `09-agenda.sql`**
si no se corrió antes — si ya se corrió, no pasa nada, sus tablas y funciones
simplemente quedan sin uso (ver "Agenda" más abajo).

`08-terreno.sql` también agregó `ordenes.observaciones`, que en teoría venía de
`03-informes.sql` pero nunca se había aplicado en la base real (solo la
política de `movimientos_estado` de ese archivo se corrió aparte). Sin esa
columna, guardar el informe técnico fallaba. Ya está al día.

Los `.sql` son historial de migraciones. No se suben a GitHub Pages pero
conviene mantenerlos versionados.

## Modelo de datos

Tablas: `perfiles`, `clientes`, `vehiculos`, `ordenes`, `movimientos_estado`,
`diagnosticos`, `archivos`, `cotizaciones`, `cotizacion_items`.

**`visitas` y `visita_ordenes` existen pero están DEPRECADAS** — no se usan
en la app. Fue el primer intento de agenda; se abandonó porque obligaba a
llenar dos fichas (la visita y la OT) para el mismo trabajo. Se dejaron sin
borrar porque podrían servir a futuro para agrupar varias OT en una sola
salida a terreno (un mismo viaje que retira módulos de varios clientes de
una flota). Si se retoman, hay que revisar `09-agenda.sql` (RPC
`actualizar_visita_tecnico`, `reprogramar_visita`, `cancelar_visita`, y sus
políticas) antes de construir nada encima — puede que ya no encajen con
cómo evolucionó `ordenes` desde entonces.

**Decisiones de diseño que hay que respetar:**

- La tabla se llama `ordenes`, no `modulos`. **Cada fila es un trabajo**, no un
  objeto físico. Un mismo módulo puede tener varias órdenes a lo largo del tiempo.
- **La agenda es una capa sobre `ordenes`, no una entidad aparte.** Agendar =
  crear o editar una OT con fecha planificada. Los datos principales siguen
  viviendo en `ordenes`; la agenda solo agrega cuándo y cómo se planifica la
  atención (`fecha_agendada`, `franja`, `ubicacion_gps`, `tecnico_agendado`,
  `orden_ruta` — ver "Agenda" más abajo).
- Correlativo `OT-2026-0001` generado por trigger, reinicia cada año.
- Todo cambio de estado se registra solo en `movimientos_estado` (trigger).
- `numero_serie` existe en el esquema pero **no se usa**: identifican los
  módulos con sellos de seguridad.
- Una orden puede tener **varias** `cotizacion`, y manda la **vigente**: la
  última guardada que no esté anulada. Ver "Cotizaciones" más abajo.

**`origen` (dónde ocurre) y `tipo_trabajo` (qué se hace) son independientes:**

- `origen`: `terreno` o `laboratorio`.
- `tipo_trabajo`: `modulo` (hay un módulo físico de por medio) o `servicio`
  (reparación directa sobre el camión, sin retirar nada — línea eléctrica
  cortada, aceite en el sistema neumático, etc.). `servicio` siempre es
  `terreno`; no existe `laboratorio` + `servicio`.

Combinaciones reales, con sus tres flujos de estado (`FLUJO` en `index.html`,
mismo criterio en el objeto que en la base):

- `terreno` + `modulo` (retiro): agendado → en_terreno → resuelto_en_terreno →
  retirado → recepcionado → en_diagnostico → cotizado → en_reparacion →
  en_pruebas → listo_entrega → instalado → facturado.
- `terreno` + `servicio` (reparación en el camión): agendado → en_terreno →
  cotizado → en_reparacion → resuelto_en_terreno → facturado. Sin recepción,
  sin laboratorio, sin instalación — más corto a propósito.
- `laboratorio` + `modulo` (llegó al taller): recepcionado → en_diagnostico →
  cotizado → en_reparacion → en_pruebas → listo_entrega → entregado → facturado.

Cuando `tipo_trabajo = servicio`, `tipo_modulo` va `null` y en su lugar se usa
`sistema` (campo libre con `datalist`, igual criterio que `tipo_modulo`:
eléctrico, neumático, hidráulico, motor... se alimenta solo con el uso, sin
listas fijas). Hay un `check` en la base que obliga esto.

Estados (enum `estado_orden`): agendado, en_terreno, resuelto_en_terreno,
retirado, recepcionado, en_diagnostico, cotizado, en_reparacion, en_pruebas,
listo_entrega, instalado, entregado, facturado, irreparable, rechazado, garantia.
No se agregaron estados nuevos para `servicio`: reutiliza los que ya existían.

El estado `resuelto_en_terreno` importa en los dos flujos de terreno: es
trabajo que se factura sin que exista módulo (o sin que se haya retirado
ninguno). Si se pierde, la facturación no cuadra.

## Roles y permisos

`dueno` (Jonatan), `coordinador`, `tecnico`. RLS activo en todas las tablas.
Todos leen todo lo operativo; dueño y coordinador escriben lo operativo; el
técnico solo actualiza las órdenes asignadas a él.

**Importante:** el esquema de roles no distingue "mecánico de terreno" de
"técnico de laboratorio" — ambos son `rol = 'tecnico'`. Si algún día hace
falta separar sus permisos o su pantalla por defecto de verdad (no solo el
tab que abren), va a hacer falta un campo nuevo (por ejemplo `perfiles.area`).
Por ahora la sección Terreno/Módulos es solo de navegación, no de permisos.

**Montos, cotizaciones y precios: el técnico no los ve, de verdad, no solo en
pantalla.** Esto se resolvió a nivel de base, no confiando en el front
(08-terreno.sql):

- `cotizaciones` / `cotizacion_items`: la política de lectura ahora exige
  `mi_rol() in ('dueno','coordinador')`. Antes cualquier autenticado podía
  leerlas (solo la escritura estaba restringida) — ese hueco ya se cerró.
- `ordenes.monto_cotizado` y `ordenes.monto_final` están en la misma tabla
  que cliente/patente/estado, que el técnico sí necesita — no se puede
  resolver con una política de fila. Se revocó el `select` de **toda la
  tabla** para `authenticated` y se volvió a otorgar columna por columna,
  explícitamente, salvo esas dos (Supabase da `select` de tabla completa por
  defecto, y eso le gana a un `revoke` de solo columna — no basta con
  revocar la columna si la tabla completa sigue otorgada). Se abrió un único
  camino de lectura para los montos: la función `ordenes_montos(orden_id)`,
  que decide según `mi_rol()`. Nadie, ni siquiera dueño o coordinador, lee
  esas columnas directo de la tabla; el front llama la función vía
  `db.rpc('ordenes_montos', ...)`. **Si se agrega una columna nueva a
  `ordenes`, hay que sumarla al `grant select (...)` de `08-terreno.sql` o
  el técnico no la va a poder leer.**
- Por si un técnico intenta escribir un monto, o cliente/origen/campos de
  agenda, en una orden que sí puede editar (la suya): el trigger
  `proteger_campos_tecnico` (antes `proteger_montos_tecnico`, renombrado en
  `09-agenda-simple.sql` porque ya protege más que montos) revierte esos
  valores a lo que estaban, pase lo que pase en la solicitud. Cubre:
  `monto_cotizado`, `monto_final`, `cliente_id`, `origen`, `fecha_agendada`,
  `franja`, `ubicacion_gps`, `tecnico_agendado`, `orden_ruta`. El técnico
  agenda ninguna orden — solo dueño y coordinador editan agenda.

Cuando se agreguen pagos y asistencia, esas tablas van con RLS **restringido
solo al dueño**.

## Navegación en cuatro secciones

Barra fija abajo, siempre visible dentro de la app:

- **Terreno** — OT con `origen = terreno`.
- **Laboratorio** — OT con `origen = laboratorio`.
- **Agenda** — OT con `fecha_agendada` puesta, vista semanal.
- **Gastos** — gastos del mes. Para el dueño trae además las pestañas
  Por persona, Global y Rentabilidad (ver "Gastos y rentabilidad").
  Rentabilidad **no** va en la barra inferior: vive dentro de Gastos.

Una misma OT puede aparecer en Agenda y también en Terreno o Laboratorio a
la vez — no se duplica la tarjeta, es la misma fila de `ordenes` filtrada
de dos formas distintas. Una sola función, `tarjetaOT(o, opts)` en
`index.html`, arma la tarjeta en las tres listas (con `opts.agenda` cambia
qué línea de texto muestra, pero el estilo es siempre el mismo).

Cada rol abre por defecto en una sección (`coordinador` → Agenda, el resto
→ Terreno) pero puede navegar a las otras — no se esconde nada, es
navegación, no permiso.

**Importante:** el esquema de roles no distingue "mecánico de terreno" de
"técnico de laboratorio" — ambos son `rol = 'tecnico'`. Si algún día hace
falta separar sus permisos o su pantalla por defecto de verdad, va a hacer
falta un campo nuevo (por ejemplo `perfiles.area`).

## Gastos y rentabilidad

Ver `11-gastos.sql`. Objetivo de fondo: que el dueño pueda responder si la
empresa es rentable, en qué se va la plata y qué OT dejan margen real.

**El usuario escribe el monto total** (lo que dice la boleta). El neto y el
IVA crédito los calcula un **trigger en la base**, no la pantalla: con
factura, `neto = round(total / 1.19)` y el resto es IVA; sin factura, neto =
total e IVA = 0. Verificado: $119.000 con factura → neto $100.000, IVA
$19.000.

**El mismo trigger fuerza `usuario_id = auth.uid()`** en el insert y lo deja
intacto en el update. Nadie registra un gasto a nombre de otro, ni se lo
traspasa después. Efecto lateral a tener presente: **no se pueden sembrar
gastos desde el SQL Editor** (ahí `auth.uid()` es null); si algún día hay
que importar histórico, se desactiva el trigger a mano para esa carga.

**Aislamiento (RLS real, no filtro de pantalla):** cada usuario ve solo sus
gastos no anulados; el dueño ve todos, incluidos los anulados. Está en la
política `leer_gastos`, no en la consulta del front — un técnico tampoco los
ve pegándole directo a la API.

**No se borran gastos.** No hay política de `delete`: se anulan
(`anulado`, `fecha_anulacion`, `motivo_anulacion`) y quedan fuera de los
totales pero dentro del historial.

**Comprobantes en bucket privado** `gastos-comprobantes` (pueden traer RUT,
proveedor, dirección, patente). Ruta obligatoria
`usuario_id/gasto_id/archivo.jpg`: la primera carpeta es el usuario y de ahí
cuelga el permiso. Se ven con URL firmada temporal, no con link público.
La foto se sube **después** de guardar el gasto: si falla la señal, el gasto
igual quedó registrado y la foto se puede reintentar editándolo.

**Rentabilidad (solo dueño), todo en NETO:**
- Va por función `resumen_rentabilidad(mes)` porque `ordenes.monto_final` y
  `monto_cotizado` tienen el SELECT revocado por columna (08-terreno.sql).
- **Comprometido y facturado nunca se suman.** Comprometido = cotizaciones
  aprobadas todavía no facturadas (una promesa). Facturado = plata cobrada.
  En pantalla van en líneas separadas y con su explicación abajo.
- Margen = facturado − gastos netos − costo fijo. Si no hubo facturación,
  dice "sin facturación registrada" en vez de inventar un porcentaje.
- No incluye sueldos ni asistencia: no están en el sistema todavía.

**Margen por OT** (`rentabilidad_ot`, también solo dueño): el coordinador no
ve los gastos de los demás, así que para él el margen saldría incompleto —
y un margen incompleto engaña más que no mostrarlo. Si la OT no tiene gastos
asociados dice "sin gastos registrados", no `$0`: no es lo mismo.

**Categorías:** campo libre con `datalist`, sin tabla propia. Antes de
guardar se hace trim, se colapsan espacios dobles, y si ya existe una
categoría parecida ignorando tildes y mayúsculas **se reusa esa** — así
"petroleo" escrito después de "Petróleo" no crea una segunda categoría.

## Cotizaciones

Ver `10-cotizaciones-vigente.sql`.

**La vigente es la última guardada que no esté anulada.** No hay campo
`es_vigente` a propósito: se calcula, así no hay dos fuentes de verdad que
se puedan contradecir. `ordenes.monto_cotizado` guarda el **neto** (sin
IVA) de esa cotización vigente — criterio heredado de `04-cotizaciones.sql`,
no se mezcla con el total.

**No se borran cotizaciones, se anulan** (`anulada`, `fecha_anulacion`).
Una anulada queda en el historial y deja de ser vigente. Si se anula la
vigente, la anterior no anulada pasa a vigente sola — lo hace el trigger,
no el front.

Todo el recálculo vive en `recalcular_monto_cotizado(orden_id)`, llamada
por dos triggers: uno sobre `cotizacion_items` y otro sobre `cotizaciones`
(por si se anula, crea o borra una entera). Reemplazó a
`sincronizar_monto_cotizado`, que copiaba el monto de la última cotización
*editada* — con varias por orden eso quedaba mal: tocar una vieja pisaba el
monto de la vigente.

**El formulario siempre crea una cotización nueva.** No se edita una
guardada. Para renegociar se usa "Usar como base": carga los ítems y la
validez de una cotización anterior en el formulario, muestra un aviso
"Basada en COT-000X", y al guardar nace una cotización nueva con su propio
número — la original no se toca. Así queda registro de qué se ofreció
primero y qué se terminó acordando.

Al guardar bien, el formulario se limpia solo (un ítem vacío, validez 15) y
avisa en verde con el número nuevo. Si falla, **no se limpia nada** para no
perder lo escrito.

## Agenda

Es una capa sobre `ordenes` (ver `09-agenda-simple.sql`), no una entidad
aparte — ver "Modelo de datos" arriba. Reemplaza el primer intento
(`09-agenda.sql`, basado en `visitas`), que quedó deprecado.

**Por qué:** llenar una OT y además una visita para el mismo trabajo era
doble trabajo y las dos fichas quedaban desconectadas. Agendar ahora es
literal: crear o editar la OT con `fecha_agendada`.

**Sin dirección/ciudad, sin hora exacta — a propósito:**
- En terreno se trabaja con GPS, no con direcciones escritas.
  `ubicacion_gps` acepta un link de Maps pegado desde WhatsApp,
  coordenadas, o texto de referencia si todavía no hay link. La app decide
  cómo abrirlo: si empieza con `http`, abre el link directo; si no, arma
  una búsqueda de Google Maps con ese texto (`enlaceUbicacion()` en
  `index.html`). Dirección y ciudad **siguen existiendo en la ficha del
  cliente** (`clientes.direccion/ciudad`), para facturación — eso no cambió.
- No hay horario fijo, solo `franja`: mañana / tarde / todo el día. Los
  trayectos son largos y variables; una hora exacta crea un compromiso
  falso con el cliente. El orden real del día lo da `orden_ruta`
  (botones subir/bajar, nunca arrastrar — con guantes, en el celular, no
  sirve).

**Caso laboratorio:** cuando el cliente avisa que manda o trae un módulo
un día determinado, es la misma OT: `origen = laboratorio`,
`fecha_agendada` con la fecha estimada, estado inicial `agendado`. Cuando
llega de verdad, pasa a `recepcionado` (cambio de estado normal, nada
especial). Así la agenda muestra tanto lo que hay que salir a buscar como
lo que va a llegar solo.

**El mismo formulario para todo:** "Nueva OT" (`vNueva` en `index.html`)
sirve para una OT normal, una agendada de terreno y una agendada de
laboratorio. El botón "+ Agendar esta orden" revela los campos de agenda
dentro del mismo formulario (`fecha_agendada`, `franja`, `ubicacion_gps`,
`tecnico_agendado`) — no hay una pantalla separada de "agendar". El botón
"Agendar" de la pestaña Agenda abre ese mismo formulario con la sección ya
desplegada. Para una OT que ya existe, la agenda se edita en línea dentro
del detalle de la OT (sección "Agenda", botón "Editar agenda") — tampoco
hay pantalla intermedia.

**Permisos:** dueño y coordinador agendan y editan agenda (`ordenes` ya
tenía sus políticas de `insert`/`update` para esos roles). El técnico
**ve** sus OT agendadas (filtradas por `tecnico_agendado = auth.uid()`
cuando entra a la pestaña Agenda) pero no tiene manera de tocar
`fecha_agendada`, `franja`, `ubicacion_gps`, `tecnico_agendado` ni
`orden_ruta` — el trigger `proteger_campos_tecnico` los protege a nivel de
base, no solo ocultando botones (ver "Roles y permisos").

**Qué no se construyó a propósito (pedido explícito):** optimización de
rutas o cálculo de distancias, notificaciones/recordatorios,
sincronización con Google Calendar, calendario gráfico mensual, historial
múltiple de reprogramaciones, un módulo nuevo separado de `visitas`.

## Estado actual — qué funciona

- Login con correo y contraseña
- Navegación en cuatro secciones (Terreno / Laboratorio / Agenda / Gastos)
  con barra inferior, todas dentro de esta misma app
- Crear OT: primero se elige tipo de trabajo (módulo o reparación en terreno),
  después cliente, RUT, patente, módulo/sistema según corresponda, síntoma,
  foto, y opcionalmente agendarla (fecha, franja, ubicación GPS, técnico)
  en el mismo formulario
- Cambio de estado, con el flujo correcto según origen + tipo de trabajo
- Subir fotos y capturas de escáner a Supabase Storage
- Informe técnico con el formato de la empresa, imprimible a PDF (oculta el
  valor del servicio si lo abre un técnico)
- Cotización: historial arriba (cada una marcada Vigente / Anterior /
  Anulada, con "Ver formal" y "Usar como base"), formulario de cotización
  nueva abajo con ítems (descripción en dos líneas, cantidad, valor
  unitario, subtotal por ítem) y totales con el Total destacado. Al guardar
  avanza el estado a `cotizado` si corresponde. Solo dueño y coordinador la
  ven — el técnico ni siquiera tiene el botón
- Cotización formal imprimible (mismo tratamiento visual que el informe
  técnico), con número de cotización, tabla de ítems y fecha de validez
  (`validez_dias`, 15 por defecto)
- Agenda: vista semanal (lunes a sábado, con flechas de semana) agrupada
  por día, con pestañas Terreno/Laboratorio arriba; cada fila es la misma
  tarjeta de OT que en el resto de la app; reordenar con botones subir/bajar
  sobre `orden_ruta`; editar la agenda de una OT existente desde su detalle,
  en línea, sin pantalla intermedia
- Nexa cara al cliente: chat, ficha del caso que se llena sola y botón que
  propone la OT. Solo dueño y coordinador. Probada con un caso real

**Detalles de implementación:**

- Cliente, patente y tipo de módulo son campos libres con `datalist` que se
  alimenta de lo ya registrado. No hay listas fijas: el catálogo de módulos se
  arma solo con el uso. Trabajan con muchos tipos distintos.
- El RUT se formatea solo (puntos y guion) y valida el dígito verificador.
- Las fotos se comprimen en el navegador a 1400px / JPEG 0.72 antes de subir.
- El informe se genera en el cliente y se imprime con `window.print()` y una
  hoja de estilos `@media print`.

## Formato del informe técnico (no cambiar sin preguntar)

Encabezado `PAZ SERVICES | INFORME TÉCNICO` → tabla de datos (cliente, RUT,
vehículo, patente, módulo, fecha) → recuadro de resultado técnico → secciones
numeradas: 1. Antecedentes, 2. Trabajos realizados, 3. Resultado final,
4. Valor del servicio (neto + IVA 19% + total), 5. Observaciones → firmas de
Jonatan Daniel Toledo Orellana y recepción conforme del cliente.

Única variación permitida: la línea bajo el encabezado dice "Reparación de
módulos electrónicos" o "Servicio técnico en terreno" según `tipo_trabajo`,
y la fila de la tabla de datos dice "Módulo" o "Sistema" según corresponda.
El resto del formato no se toca sin preguntar.

## Lo que viene, en orden

1. ~~**Cotizaciones** con líneas de detalle~~ — hecho: tablas `cotizaciones` y
   `cotizacion_items`, pantalla en el front.
2. ~~**Agenda de terreno y rutas**~~ — hecho, como capa sobre `ordenes` (ver
   "Agenda" más arriba).
3. ~~**Gastos**~~ — hecho y dentro de esta app, con rentabilidad.
   **Asistencia, sueldos y pagos de colaboradores siguen pendientes** — por
   eso el margen mensual todavía no descuenta mano de obra, y hay que leerlo
   sabiendo eso.
4. **Nexa** — primera etapa hecha: chat dentro de la app, con ficha del caso y
   propuesta de OT. Falta la de WhatsApp y la que ayuda al equipo. Ver abajo.
5. **Códigos GS** — app separada y offline que se alimenta de la vista
   `v_conocimiento`.

## Nexa (el plan grande)

Un agente que conversa y arma las OT solo, para que nadie tenga que llenar
formularios. Es lo que va a resolver el problema de adopción de raíz.

### Corrección de rumbo (14-09-2026) — leer antes de tocar nada de WhatsApp

El plan original era que Nexa leyera **el grupo de WhatsApp del equipo**. Eso
se descartó. El reparto que quedó es:

- **El equipo usa la app.** No WhatsApp. Ahí ya está la Nexa de la etapa 1.
- **WhatsApp es el canal con los clientes**, conversaciones uno a uno.

Esto **borra** la Groups API y todas sus restricciones (máximo 8
participantes, grupo creado por la API, número nuevo obligatorio). Todo eso
aplicaba solo al plan del grupo del equipo; ya no corre. Si alguien lo
reencuentra en un documento viejo, está desactualizado.

Lo que sí aplica ahora (verificado el 14-09-2026):

- Cloud API normal, uno a uno. Requiere Meta Business verificado (2 a 4 días
  hábiles, a veces hasta dos semanas) y revisión del nombre para mostrar.
- **Coexistencia**: desde 2025, y en todos los países desde mayo 2026, un
  mismo número puede seguir en la app de WhatsApp Business *y* estar en la
  Cloud API. Meta lo aprueba número por número según antigüedad y calidad.
  Conviene intentarlo con el número actual antes de sacar uno nuevo: los
  clientes ya lo tienen guardado. Exige abrir la app al menos cada 13 días.
- **Ventana de 24 horas**: si el cliente escribe primero, se puede responder
  libre y gratis por 24 horas, sin plantillas, y cada mensaje del cliente la
  reinicia. Las plantillas aprobadas solo hacen falta para escribir primero
  (por ejemplo "su módulo está listo") — eso queda para después.
- El token permanente va como secreto de Supabase, igual que `OPENAI_API_KEY`.
  Nunca en el `index.html`.
- `nexa_conversaciones.canal` ya existe para esto (`app` / `whatsapp`).

### Cómo se corrige a PAZ: la tabla `paz_aprendizajes` (15-09-2026)

**Antes de tocar el prompt, mirar acá.** El prompt (`nexa_config.prompt`) es el
documento comercial grande: quién es PAZ, precios, condiciones. Se toca poco.
Los **aprendizajes** son correcciones puntuales de criterio, viven en
`paz_aprendizajes`, se prenden y apagan con un booleano, y PAZ los lee **en
cada respuesta**. Una corrección vale desde el mensaje siguiente, sin
desplegar nada y sin republicar la app.

Ese es el punto: que Jonatan pueda corregir a PAZ sin pedirle a nadie que
cambie código. Si aparece una conducta mala, la respuesta correcta casi
siempre es **un aprendizaje nuevo**, no editar el prompt ni la función.

Los siete criterios iniciales salieron de errores observados de verdad, no de
teoría. Están redactados diciendo qué hacer, no qué evitar.

### Lo que PAZ ya sabe antes de preguntar

`contextoDelSistema()` en la Edge Function arma, antes de cada respuesta, un
bloque con lo que la base ya tiene:

- **Cliente por teléfono**: si el número está en `clientes.telefono`, PAZ no
  pregunta el nombre.
- **Patente**: se sacan del texto con una expresión regular (formato chileno
  `BBBB99` y el antiguo `AB1234`), se buscan en `vehiculos`, y si existen PAZ
  **confirma** en vez de preguntar marca, modelo y año.
- **Historial**: las últimas 3 OT de esa patente, marcadas como contexto
  interno — PAZ no se las recita al cliente.

**Si el cliente dice un dato distinto al guardado, no se sobrescribe nada.**
PAZ lo anota sin discutir y lo resuelve una persona. Un dato pisado por un
malentendido es peor que un dato en conflicto.

### Fotos, ubicación y tope de frecuencia

- Las **imágenes** que manda el cliente se bajan de Meta y se guardan en el
  bucket privado `paz-adjuntos`, con registro en `nexa_archivos`. La tabla
  `archivos` no servía: cuelga de una OT, y el caso nace antes de que exista.
- La **ubicación** de WhatsApp queda en `nexa_conversaciones.ubicacion_gps` y
  `ubicacion_texto`. Cuando el caso se convierta en OT, el GPS se copia.
- **Tope de 30 mensajes por hora y por teléfono** (`TOPE_POR_HORA`). Al
  pasarse, se responde con una frase fija **sin llamar a la IA** y se anota en
  `wa_log`. No bloquea al cliente para siempre: es por ventana de una hora.
  Existe porque un reintento masivo de Meta o alguien jugando con el número
  puede costar la cuota de OpenAI en minutos.
- **Duplicados**: `nexa_mensajes.wa_id` tiene índice único. Si Meta reintenta
  el mismo mensaje, el insert falla y no se contesta dos veces.

### Dónde quedó la conexión a WhatsApp (14-09-2026, 21:00)

App de Meta creada (`Paz-Services`), número de prueba `+1 555 152-8643`,
webhook apuntando a `/functions/v1/whatsapp` y **verificado**, campo `messages`
**suscrito**, y las cuatro llaves cargadas como secretos de Supabase
(`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`).

**Probado y funcionando:**
- Salida: el `hello_world` llegó al celular de Jonatan. Token y phone id OK.
- Entrada: el webhook de prueba del panel de Meta llegó completo, con la firma
  verificada, y quedó guardado como conversación de canal `whatsapp`.

**Único bloqueo: la app de Meta está SIN PUBLICAR.** Mientras lo esté, Meta
entrega solo los webhooks disparados desde su propio panel, no los mensajes
reales — ni siquiera los del dueño de la app. Comprobado: cinco mensajes
enviados desde el celular, entregados con doble check, y cero llegaron a la
base. Si alguien retoma esto y ve "todo verde pero no llega nada", es esto.

Para publicar hacía falta la política de privacidad, que ya está en línea en
`privacidad.html` (se publica junto con la app en GitHub Pages). Esa misma URL
sirve para los tres campos que Meta pide; el de eliminación de datos apunta a
`privacidad.html#eliminar`.

**El número real es harina de otro costal.** Meta ofreció "migrar o
desconectar" el +56 9 3374 0440, que es el WhatsApp del taller: eso lo sacaría
del celular y dejaría al taller mudo, sin que los mensajes llegaran a ninguna
parte. **No hacerlo.** El camino correcto es Coexistencia, que se inicia desde
la app de WhatsApp Business, no desde el panel de desarrolladores.

**Decisión pendiente antes de conectar:** si PAZ contesta sola al cliente o
solo propone y una persona manda. Criterio acordado: que conteste sola para
recolectar datos, y que precio, plazo o cualquier compromiso espere a una
persona. Hoy en la app da precios referenciales porque el prompt los tiene y
siempre hay alguien leyendo; en WhatsApp automático ese mismo texto le llega
al cliente sin filtro.

**Reglas de diseño acordadas:**

- Nexa **nunca adivina en silencio**. Si no está segura de a qué OT o cliente
  corresponde algo, pregunta **en el grupo, a quien escribió el mensaje** —
  nunca a Jonatan por privado. Él sabe menos que el coordinador sobre cuál
  camión es.
- Solo escala a Jonatan lo que sea "rojo" según la matriz de decisiones:
  precios fuera de lista, descuentos, garantías, clientes nuevos con monto alto.
- Si nadie responde en 2 horas, la OT queda incompleta en una lista de
  pendientes. Nunca se inventa un dato.
- Se guarda qué dedujo y si la corrigieron, para medir su tasa de error.
- El ingreso manual sigue existiendo siempre, como respaldo.

### Se llama PAZ, no Nexa (14-09-2026)

Jonatan la rebautizó **PAZ**. En pantalla y en el prompt dice PAZ. En el
código, en las tablas y en la Edge Function sigue diciendo `nexa`
(`nexa_config`, `nexa_conversaciones`, `nexa_mensajes`, `/functions/v1/nexa`,
ids `nexaChat`, `btnNexaEnviar`…). **Eso es a propósito:** renombrar tablas y
la función implica migración y cambio de URL, riesgo que no vale la pena por
un nombre interno. Si alguna vez se hace el cambio completo, hay que tocar
las tres tablas, la función desplegada y todos los ids del `index.html` de
una sola vez.

### Etapa 1, ya construida: PAZ cara al cliente, dentro de la app

WhatsApp queda para después (necesita número dedicado y papeleo). La primera
Nexa vive en la app y se usa a mano: alguien copia lo que dijo el cliente y
Nexa responde y arma la ficha.

Piezas:

- `12-nexa.sql` — `nexa_config` (una fila: prompt, modelo, activa),
  `nexa_conversaciones` (con `ficha jsonb` y `orden_id`), `nexa_mensajes`.
  RLS: solo dueño y coordinador. El prompt lo edita solo el dueño.
- `supabase/functions/nexa/index.ts` — Edge Function. Verifica la sesión y el
  rol, lee el prompt con `service_role` y llama a la API de OpenAI.
  Desplegar: `.\.tools\supabase.exe functions deploy nexa --use-api`.
- Pantalla `vNexa` en el `index.html`, botón **Nexa** en el encabezado, visible
  solo para dueño y coordinador.

**Dónde vive cada secreto (no mover esto):**

- La llave de OpenAI es un secreto de Supabase (`OPENAI_API_KEY`). Nunca en el
  `index.html`, que es público.
- El prompt vive en `nexa_config.prompt`, **no en el repo**: tiene precios y
  reglas comerciales y el repo es público. Por eso `12-nexa.sql` lo deja vacío
  y se carga aparte con un `update`.

**Dos pasadas por cada mensaje:** una conversacional (`accion: "responder"`) y
otra que extrae la ficha en JSON (`accion: "ficha"`). Van separadas para no
ensuciar el prompt de conversación con instrucciones de formato.

**PAZ propone, la persona confirma.** El botón "Crear la OT desde este caso"
llena el formulario de Nueva OT y ahí se revisa antes de guardar. PAZ no
inserta órdenes sola. Al guardar, la conversación queda con `orden_id`.

**Cómo termina un caso (regla de negocio de Jonatan):**

- **Módulo que se envía** → PAZ le dicta al cliente los datos de envío y ahí
  termina. Esos datos van en el prompt, no en el código.
- **Visita, revisión o cualquier cosa en terreno** → hay que avisarle al
  coordinador para que agende.

El aviso al coordinador **no es una notificación**: no existen todavía. Es un
bloque **"Casos por agendar"** arriba de todo en la pestaña Agenda, que el
coordinador ve apenas abre la app (su sección por defecto es Agenda). Sale
ahí toda conversación con `ficha->>atencion = 'terreno'` y `orden_id is null`,
y desaparece cuando se crea la OT. Visible solo para dueño y coordinador.
**Nunca hacer que PAZ diga "ya le avisé al coordinador" mientras no exista un
canal real** — una asistente que miente es peor que una que no hace nada.

**La ficha decide el tipo de trabajo**, para no obligar a inventar datos (pasó
en la OT-2026-0009: quedó como laboratorio con un `tipo_modulo` inventado
porque el formulario exigía uno):

- `atencion = envio` → laboratorio + módulo
- `atencion = terreno` con `modulo` → terreno + módulo
- `atencion = terreno` sin `modulo` → terreno + servicio, usando `sistema`
- `atencion = null` → no se toca nada, elige la persona

Por eso la ficha tiene `atencion` y `sistema` además de los datos del cliente.
`modulo` y `sistema` son excluyentes y se cuentan como un solo dato en el
"faltan N".

**Probada de punta a punta el 14-09-2026** por Jonatan, con un caso real
(Actros 4144 2011, patente JYPZ19, GS17, caja que no pasa marchas altas).
Nexa preguntó de a un dato a la vez, no tomó el código de falla como
diagnóstico, y la ficha se llenó sola dejando vacío solo lo que el cliente no
dijo. El modelo `gpt-5.5` responde bien.

## Contexto de negocio que importa

Jonatan es el cuello de botella técnico: el mecánico escanea en terreno y le
manda capturas al teléfono, y él dirige el diagnóstico; si no se resuelve, entra
remotamente a Xentry. Por eso no puede alejarse del celular ningún día hábil, y
por eso no puede armar un segundo equipo.

**El objetivo real del proyecto no es ordenar el taller: es sacarlo del
diagnóstico.** El campo `diagnosticos.requirio_remoto` es el indicador que mide
si eso está pasando. Cada decisión de producto se juzga contra eso.

En paralelo está reorganizando al equipo: definir cargos, formalizar contratos
y delegar decisiones con una matriz verde/amarillo/rojo. Usar el sistema va
escrito en las descripciones de cargo — no es opcional.

## Consultas útiles

```sql
-- órdenes abiertas
select numero_ot, estado, origen, fecha_ingreso from ordenes
 where estado not in ('facturado','entregado','instalado','resuelto_en_terreno','rechazado');

-- base de conocimiento acumulada
select * from v_conocimiento;

-- limpiar datos de prueba (NO toca usuarios)
truncate table archivos, movimientos_estado, visita_ordenes,
               diagnosticos, visitas, ordenes, vehiculos, clientes
restart identity cascade;
```
