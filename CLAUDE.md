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
13-whatsapp.sql         prepara el canal WhatsApp (telefono, wa_id, interruptor de respuesta)
14-wa-diagnostico.sql   tabla wa_log, para ver qué le llega al webhook y qué se rechaza
15-paz-memoria.sql      paz_aprendizajes, nexa_archivos, bucket paz-adjuntos
16-casos.sql            casos (un caso por vehículo, no por conversación)
17-modo-asistido.sql    paz_respuestas_asistidas, marca humano_asistido en los mensajes
18-trazabilidad.sql     nombre_creador, respuesta_asistida_id (enlace duro mensaje↔auditoría)
19a-rol-agente-enum.sql     agrega 'agente' al enum de roles
19b-rol-agente-rpc.sql       las ocho funciones paz_* que PAZ usa para escribir
19c-rol-agente-lectura.sql   permisos de lectura del rol agente
19d-rol-agente-rpc-extra.sql tres RPC más para los remates de sincronizarCasos
20-modo-aprendizaje.sql      casos.modo, evaluación positivo/negativo, descartar
20b-fix-mi-rol-null.sql      corrige NULL en mi_rol() que se saltaba el guardia de dueño
21-tecnico-crea-ot.sql       el técnico puede crear OT (recepcionar módulos), no solo actualizar las suyas
22-nexa-app-entrenamiento.sql RPC paz_en_entrenamiento(): bloquea crear OT desde el chat interno en modo aprendizaje
23-audio-whatsapp.sql        nexa_archivos admite categoria 'audio_cliente'
24-entregado-en.sql          ordenes.entregado_en: hecho aparte para saber si el módulo salió de verdad
29-rentabilidad-usa-pagado-en.sql  resumen_rentabilidad cuenta el mes por pagado_en, no fecha_cierre
30-asistencia.sql            asistencia, pagos de colaboradores y mano de obra real en rentabilidad
31-cotizacion-suma-todas.sql monto_cotizado suma TODAS las cotizaciones no anuladas, no solo la última
25-cuatro-ejes-estado.sql    ubicacion/reparacion/comercial/pagado_en: reemplazan estado (aditivo)
26-backfill-cuatro-ejes.sql  llena los cuatro ejes en las OT reales que ya existían
27-defaults-cuatro-ejes.sql  defaults de reparacion/comercial, red de seguridad contra null
28-proteger-pago-tecnico.sql pagado_en/comercial/numero_factura protegidos igual que monto_final
29-rentabilidad-usa-pagado-en.sql resumen_rentabilidad cuenta el mes por pagado_en, no fecha_cierre
30-asistencia.sql            asistencia diaria, pagos con comprobante, auditoría, mano de obra en rentabilidad
supabase/functions/nexa/index.ts       Edge Function del chat interno y modo asistido
supabase/functions/whatsapp/index.ts   Edge Function que habla con el cliente por WhatsApp
```

**De la 01 a la 30 están todas aplicadas en la base real** (verificado el
17-09-2026 contra `information_schema` y `pg_proc`). Si alguna vez hay duda, no confiar
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

**Todo lo de arriba (`estado`, `FLUJO`) es el modelo viejo.** Sigue
existiendo en la base y se sigue escribiendo, pero desde el 17-09-2026
**ya no es lo que lee la app** -- ver "Los cuatro ejes" justo abajo.

### Los cuatro ejes reemplazan a `estado` (17-09-2026)

Propuesta de Jonatan, dicha así: *"Estado físico del módulo, estado de
la reparación y estado del pago los mezclas, y ahí se forma el enredo y
se ensucia la app con botones que no son necesarios."* Tenía razón:
`estado` era una sola lista de 16 valores contestando cuatro preguntas
distintas a la vez, y **cada bug real de ese mismo día** (Garantía
apareciendo en una OT recién agendada, la sección Agenda sobrando en un
módulo que nació de una visita, "Pagada" mostrando el flujo completo
hacia atrás, "facturado" escondiendo una OT sin entregar) salió de esa
mezcla.

Ahora son cuatro columnas independientes en `ordenes`
(`25-cuatro-ejes-estado.sql`), cada una contestando una sola pregunta:

- **`ubicacion`** (`con_cliente` → `en_transito` → `en_taller` →
  `entregado`) -- ¿dónde está el objeto? **`null` en terreno+servicio**:
  no hay módulo que mover, no aplica.
- **`reparacion`** (`por_diagnosticar` → `en_diagnostico` →
  `diagnosticado` → `en_reparacion` → `en_pruebas` → `listo`, más
  `irreparable` como salida) -- ¿qué se le ha hecho técnicamente?
- **`comercial`** (`sin_cotizar` → `cotizado` → `aprobado` / `rechazado`)
  -- ¿qué dijo el cliente sobre el precio? La maneja la pantalla
  Cotizar (guardar una cotización avanza a `cotizado`) y el botón
  "Cliente aprobó la cotización" (`aprobado`). Nunca se preguntó
  "¿qué dijo el cliente" mezclado con "¿qué se le hizo" -- son
  preguntas distintas, y `aprobado_cliente`/`fecha_aprobacion` (de
  antes) ya apuntaban en esta dirección, solo que sueltas.
- **`pagado_en`** (timestamp o null) -- ¿cuándo entró la plata? La
  maneja la pantalla Facturar. Reemplaza a `estado = 'facturado'`.

**`estado` se sigue escribiendo, como espejo derivado** (`estadoLegado(o)`
en `index.html`), **solo** para que `resumen_rentabilidad`,
`rentabilidad_ot` (`11-gastos.sql`) y el historial de
`movimientos_estado` (`01-schema.sql`) sigan funcionando sin tocarlos --
no se rehicieron hoy, a propósito, para no agrandar más un cambio ya
grande. **Nada nuevo debería leer `estado` directo**; es compatibilidad,
no la fuente de verdad.

**Qué contesta cada función clave ahora** (todas en `index.html`):

- `estaCerrada(o)` -- ¿se esconde del tablero? `comercial === 'rechazado'`,
  o `pagado_en` puesto **y** (`ubicacion === 'entregado'` o `ubicacion`
  es `null`, es decir terreno+servicio).
- `noSeEdita(o)` -- ¿ya no se puede seguir tocando? `pagado_en` puesto,
  o `comercial === 'rechazado'`. Sigue siendo una pregunta distinta de
  `estaCerrada`: "Pagada · módulo aún en el taller" no está cerrada
  (sigue en el tablero) pero tampoco se edita.
- `etiquetaEstado(o)` / `tonoEstado(o)` -- arman el texto y el color del
  chip combinando los cuatro ejes. Un caso con matiz: `reparacion ===
  'listo'` es ambiguo por sí solo -- para un módulo que sigue en el
  taller es "Listo para entrega" (positivo, nada pendiente de
  nuestro lado); para un servicio (que se resuelve donde mismo, sin
  fase de "listo para retirar") o un módulo ya `entregado`, es
  "falta cobrar" (con el mismo matiz que tenían antes `entregado`/
  `instalado`/`resuelto_en_terreno`).
- `seccionDe(o)` -- sigue igual, por `tipo_trabajo` puro (no tocado hoy).
- `seccionAgendaDe(o)` -- ahora es una línea: la visita sigue activa
  mientras `ubicacion` sea `con_cliente` o `en_transito`; en cuanto
  llega a `en_taller` la visita ya terminó.

**Garantía ya no es un valor de `estado` que se le pisa a la misma
fila** -- era el mismo hueco de siempre (una fila reescrita pierde el
rastro de por dónde había pasado). Ahora `iniciarGarantia()` reingresa
como **una OT nueva**, vinculada a la anterior con `orden_padre_id`
(mismo patrón que "+ Se retiró un módulo en esta visita", con
`garantiaDesdeOrden` como variable global paralela a
`moduloDesdeOrden`), con los cuatro ejes arrancando de cero -- es un
trabajo nuevo de verdad, aunque sea sobre el mismo módulo. Efecto
secundario a propósito: "Garantía" solo se ofrece cuando `estaCerrada(o)`
es verdadero -- no puede haber garantía de algo que nunca se entregó.

**Botones de "Cambiar a" en el detalle**: antes era una sola lista
lineal (`pintarEstados`). Ahora son **dos grupos independientes**
(`grupoSecuencia()`), uno para ubicación (solo si `tipo_trabajo ===
'modulo'`) y otro para reparación -- cada uno con su propio "siguiente
paso" al frente y el resto detrás de "Cambiar manualmente ▾".
"Irreparable" solo aparece una vez que el módulo ya está en el taller
(`ubicacion` en `en_taller`/`entregado`) -- no se puede diagnosticar
algo que sigue con el técnico o con el cliente.

**Backfill de las OT reales que ya existían** (`26-backfill-cuatro-ejes.sql`,
22 filas al momento de migrar, ninguna en un estado de excepción
todavía): mapeo directo desde `estado`/`entregado_en`, con un ajuste
encontrado al mirar los datos de verdad -- `aprobado_cliente` estaba en
`false` en las 3 OT ya facturadas (Naranjo, Jar Spa, y una tercera),
porque el estado se había avanzado con "Cambiar estado manualmente" en
vez de pasar por el botón "Cliente aprobó la cotización". El backfill
no confió en ese booleano: si el trabajo ya había avanzado más allá de
"cotizado" (entró a reparación, pruebas, quedó listo, o se facturó),
eso ya prueba que hubo aprobación, la haya registrado el botón o no.
`pagado_en` de OT ya facturadas antes de esta migración es aproximado
(`fecha_cierre` o `actualizado_en`, lo más cercano que había registrado)
-- de acá en adelante Facturar guarda el momento real.

**Respaldo manual antes de aplicar nada de esto**: como no hay Docker
en este entorno para `supabase db dump` (necesita el `db_url` +
contenedor), el respaldo se hizo con `select json_agg(t) from tabla`
por consulta, guardado en `respaldos/` (`ordenes`, `clientes`,
`vehiculos`, `movimientos_estado`, `cotizaciones`, con fecha en el
nombre). No reemplaza un dump real, pero alcanza para reconstruir a
mano si algo sale mal. El proyecto ya está en Supabase Pro (con
PITR real) desde este mismo día -- ese es el respaldo de fondo.

**`proteger_campos_tecnico` sí se actualizó** (`28-proteger-pago-tecnico.sql`):
`pagado_en`, `comercial` y `numero_factura` quedaron protegidos igual
que `monto_final` -- un técnico no debería poder marcar una OT como
pagada escribiendo directo por API, aunque el front no le ofrezca el
botón. `ubicacion`/`reparacion` se dejaron **sin proteger**, a propósito:
son equivalentes a mover `estado`, que el técnico siempre pudo cambiar
-- es su trabajo del día a día, no un dato financiero.

**Qué no se tocó hoy, a propósito** (para no agrandar más un cambio ya
grande en una sola sesión): `resumen_rentabilidad`, `rentabilidad_ot`
(siguen leyendo `estado`, vía el espejo `estadoLegado`), y el trigger
`registrar_cambio_estado`/`movimientos_estado` (sigue registrando
`estado`, no los cuatro ejes por separado).

## Roles y permisos

`dueno` (Jonatan), `coordinador`, `tecnico`. RLS activo en todas las tablas.
Todos leen todo lo operativo; dueño y coordinador escriben lo operativo; el
técnico actualiza las órdenes asignadas a él, y **puede crear OT nuevas**
(`21-tecnico-crea-ot.sql`, 16-09-2026) — recepcionar un módulo en el
laboratorio es trabajo suyo de todos los días, no una excepción.

**Qué puede y qué no puede el técnico al crear una OT:** inserta cliente,
vehículo y la orden (cliente, patente, tipo de módulo/sistema, síntoma,
foto). **No puede** fijar montos ni campos de agenda ni al crear ni
después — el trigger `proteger_campos_tecnico` los fuerza a `null` en el
INSERT (antes solo actuaba en el UPDATE, comparando contra `OLD`, que no
existe en un INSERT — sin este cambio un técnico habría podido escribir
cualquier monto o agenda en la fila que crea, sin filtro). La OT que crea
queda **asignada a él mismo** automáticamente, para que después la pueda
seguir moviendo de estado con la política de update que ya existía.
Encontrado en vivo: Diego Toledo (técnico) no podía ni guardar el cliente
al intentar ingresar un módulo — RLS lo cortaba en el primer insert.

**Diego Toledo es coordinador, no técnico (17-09-2026).** Es el encargado
de laboratorio: cobra y entrega módulos, necesita las mismas atribuciones
que un coordinador (montos, cotizaciones, facturar). Se le cambió el rol
directo en `perfiles` — no se construyó un permiso intermedio nuevo, se usó
el rol que ya existía y ya encajaba. La idea original de dejarlo cobrar
desde el botón "Entregado" se descartó: quedaba un botón de más: el cobro
va en "Facturar", que es donde siempre vivió `monto_final`.

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

## Navegación en tres pestañas + Herramientas como menú de botones

Barra fija abajo, siempre visible dentro de la app -- desde el
21-09-2026 son **tres** pestañas, no cuatro:

- **Terreno** — OT con `origen = terreno`.
- **Laboratorio** — OT con `origen = laboratorio`.
- **Herramientas** (antes "Agenda") — **ya no muestra ninguna OT**, solo
  una grilla de botones grandes, uno por herramienta (`#herramientasGrid`,
  clase `.herramienta`). Pedido explícito de Jonatan, 21-09-2026: "solo
  las herramientas no las OT". Cada botón se ve u oculta según el rol
  (mismo patrón que ya usaba `btnAsistencia`) -- Luis (técnico) hoy solo
  ve "Gastos"; el resto es dueño/coordinador. Botones de hoy:
  - **Agendar visita** — abre "Nueva OT" con la sección de agenda ya
    desplegada (antes vivía como botón `btnAgendar` en la barra de
    arriba de la Agenda; misma función, movida).
  - **Asistencia personal** — igual que antes (`btnAsistencia`), ahora
    `btnHerAsistencia`.
  - **Pendientes** — "Casos por agendar" + "Módulos por recepcionar",
    que antes estaban SIEMPRE visibles arriba de la Agenda. Ahora viven
    en una pantalla aparte (`vPendientes`) que se abre al tocar el
    botón, con un contador en un badge (`#badgePendientes`) para que no
    se pierdan de vista del todo aunque ya no salten solos a la pantalla.
  - **Gastos** — ya no es una pestaña de la barra inferior, es una
    herramienta más (`btnHerGastos` → `cambiarSeccion("gastos")`, misma
    pantalla de siempre, nada cambió puertas adentro). Para el dueño
    trae además las pestañas Por persona, Global, Rentabilidad y Pagos
    (ver "Gastos y rentabilidad" y "Asistencia, pagos y mano de obra
    real"). Sigue siendo de todos los roles, igual que siempre.

**Lo agendado de la semana sigue viviendo dentro de Terreno y
Laboratorio, no en Herramientas** (cambio hecho antes, la misma sesión,
19-21-09-2026: "en agenda aparecen los mismos datos que ya tenemos en
las OT"). `cargarOrdenes()` arma la MISMA lista de cada pestaña con dos
partes: lo agendado de esta semana agrupado por día arriba (con los
botones Subir/Bajar de `orden_ruta`), y el resto como lista plana
debajo — nada se duplica. El técnico solo ve sus propias visitas en el
grupo de arriba (`tecnico_agendado = auth.uid()`). Una sola función,
`tarjetaOT(o, opts)` en `index.html`, arma la tarjeta en todas las
listas.

Cada rol abre por defecto en una sección (`coordinador` → Herramientas,
el resto → Terreno) pero puede navegar a las otras — no se esconde
nada, es navegación, no permiso.

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
número. Desde el 21-09-2026 "Usar como base" **anula automáticamente** la
cotización base al guardar la nueva (`guardarCotizacion()` en
`index.html`) — es el único caso real donde reemplazar tiene sentido; el
resto de "Historial" se explica abajo.

**Bug real: `monto_cotizado` solo contaba UNA cotización, no todas las que
correspondían (21-09-2026).** `recalcular_monto_cotizado(orden_id)` sumaba
los ítems de la "vigente" (última no anulada) nada más — pensado para
renegociar (reemplazar). Pero el caso real más común es otro: un técnico
crea una **segunda cotización por trabajo adicional** descubierto después
en la misma OT (no reemplaza la primera, se suma). Encontrado en vivo con
`OT-2026-0018` (Pablo Tapia): cotización de $300.000 (visita a terreno +
programación GS) y otra de $150.000 (revisión en Santiago), ambas no
anuladas, ambas trabajo real — pero `monto_cotizado` solo mostraba
$150.000, perdiendo $300.000 de cobro real en silencio.

**Corregido (`31-cotizacion-suma-todas.sql`): ahora se suman TODAS las
cotizaciones no anuladas de la OT**, no solo la última. Recalculado en el
momento para todas las OT existentes (Pablo Tapia quedó en $450.000, sin
tocar ninguna fila a mano). El único caso donde una cotización nueva debe
*reemplazar* en vez de sumar sigue siendo "Usar como base" — por eso ese
flujo ahora anula la base automáticamente (ver arriba); crear una
cotización nueva sin usar "base" siempre suma.

**"Vigente" ya no significa "la única que cuenta".** El historial de
cotizaciones ya no distingue Vigente/Anterior/Anulada — ahora es
Activa/Anulada (todas las Activas suman), con "· más reciente" como dato
de referencia nomás, no como el criterio de cobro.

Al guardar bien, el formulario se limpia solo (un ítem vacío, validez 15) y
avisa en verde con el número nuevo. Si falla, **no se limpia nada** para no
perder lo escrito.

**Bug real: "entregado" sacaba la OT del tablero antes de cobrar
(17-09-2026).** `CERRADOS` (la lista de estados que se filtran del tablero
principal) tenía `entregado` junto con los estados que sí son cierre real.
Pero en el flujo de laboratorio, `entregado` va **antes** de `facturado` —
el módulo salió, pero falta cobrar. Encontrado en producción con dos OT
reales (`OT-2026-0009` "Siria", `OT-2026-0010` "Rio Negro") que
desaparecieron del tablero entregadas y sin pago. Se sacó `entregado` de
`CERRADOS`; ahora sigue visible con la etiqueta "Entregado · falta cobrar"
(tono de espera, no de listo) hasta que se factura de verdad. Las dos OT
afectadas no necesitaron cambiar de estado — ya estaban bien en
`entregado`, solo tenían un `fecha_cierre` puesto de más (se limpió).
**No se agregó un estado "Cerrado" nuevo ni columnas de pago separadas**
(se propuso una lista más grande de cambios — modal al entregar, tabla de
pagos, `pagado`/`medio_pago`/etc. — pero `facturado` ya cumple ese rol de
cierre real para este flujo, y agregar un estado que no encaja en los
otros dos flujos de `FLUJO` era más riesgo del que pedía el bug real).

**Las excepciones (Irreparable/Garantía) también dependen del flujo
(17-09-2026).** Se corrigió el punto anterior (solo mostrar el paso
siguiente) pero se dejó pasar algo que Jonatan ya había dejado explícito
en su especificación original: *"Irreparable"* es un resultado de
diagnóstico de laboratorio, no tiene sentido ofrecerlo en una OT
terreno+servicio (nunca pasa por diagnóstico — o se arregla ahí mismo o
no). Seguía apareciendo igual para las tres porque `EXCEPCIONES` era una
sola lista fija para todos los flujos. Ahora `EXCEPCIONES_POR_FLUJO` la
reparte: `terreno_servicio` no ofrece "Irreparable" (solo "Cotización
rechazada" y "Garantía"); `terreno_modulo` y `laboratorio_modulo` sí lo
ofrecen, porque un módulo —se haya retirado en terreno o llegado directo—
sí pasa por diagnóstico real y puede resultar irreparable.

**Detalle de la OT: solo el paso siguiente, no el flujo completo
(17-09-2026).** `pintarEstados()` mostraba antes todos los estados del
flujo como botones, siempre — mezclaba pasos de laboratorio con los de
terreno según de dónde venía la OT y ensuciaba la pantalla. Ahora muestra
solo el **siguiente** paso del flujo (`flujoDe(o)[idx+1]`) más las
excepciones (irreparable/rechazado/garantía), y el resto queda detrás de
un botón secundario **"Cambiar estado manualmente"** — para poder volver
atrás (de `en_pruebas` a `en_reparacion`, por ejemplo) sin que sea lo
primero que se ve. Si el estado actual es una excepción (no está en el
flujo normal), se muestra la lista completa directo, sin esconder nada.
También se acortó la etiqueta "Cotizado, esperando al cliente" a
"Cotizado". **No se tocaron los nombres de los estados en la base ni el
enum** — esto es solo cómo se presentan los botones, mismo `FLUJO` de
siempre.

**Segunda vuelta del mismo bug: "facturado" también podía esconder la OT
sin entregar (17-09-2026).** El primer arreglo (sacar `entregado` de
`CERRADOS`) no bastaba: `facturado` seguía ahí, y nada impedía saltarse
`entregado` — pasó en vivo dos veces, `OT-2026-0007` (Naranjo) y
`OT-2026-0019` (Jar spa) se facturaron directo desde `listo_entrega` (por
"Cambiar estado manualmente"), cobrando antes de que el cliente retirara.
Como el módulo nunca pasó por "entregado", la OT desapareció con el
módulo todavía físicamente en el taller.

La lección: **esconder una OT no puede depender solo del `estado` actual
cuando ese estado se puede saltar.** Se agregó `ordenes.entregado_en`
(`24-entregado-en.sql`) — un hecho aparte, independiente de si ya se
facturó. `estaCerrada(o)` en `index.html` decide con las dos cosas: los
cierres sin ambigüedad (`instalado`, `resuelto_en_terreno`, `rechazado`)
siempre esconden; `facturado` solo esconde si el flujo no tiene paso de
"entregado" (terreno) o si `entregado_en` ya existe (laboratorio). Si se
factura sin haber entregado, la OT sigue visible como **"Facturado · falta
entregar"** y la pantalla de Facturar avisa de esto antes de confirmar,
en vez de dejarlo pasar en silencio. `cambiarEstado` guarda `entregado_en`
la primera vez que se marca "Entregado", sin importar si eso pasa antes o
después de facturar.

**Revisión completa de los tres flujos (17-09-2026), a pedido explícito
de Jonatan después del tercer incidente el mismo día.** El mismo patrón
("un paso de trabajo físico terminado, puesto a cerrar la OT sin mirar si
ya se cobró") estaba agazapado en **dos estados más**, no solo
"entregado":

- `instalado` (terreno + módulo): se reinstala el módulo en el camión,
  justo antes de "facturado" en ese flujo. Estaba en `CERRADOS` sin
  ningún resguardo — mismo riesgo exacto que tuvo "entregado".
- `resuelto_en_terreno` (los dos flujos de terreno): "se arregló ahí
  mismo, sin retirar nada" — en terreno+servicio va justo antes de
  "facturado"; en terreno+módulo aparece temprano, como una salida
  alternativa (el técnico soluciona en el sitio y el resto de los pasos
  de laboratorio no aplican). En ambos casos, según su propia
  definición ("es trabajo que se factura"), sigue pendiente el cobro.
  También estaba en `CERRADOS` sin resguardo.

Ninguno de los dos había reventado en vivo todavía (no hay ninguna OT
real que haya pasado por ahí), pero el patrón es idéntico al de
"entregado" y era cuestión de tiempo.

**Arreglo, generalizado en vez de repetido tres veces:**
- `PASOS_FISICOS = ["entregado","instalado","resuelto_en_terreno"]` — los
  tres representan lo mismo: trabajo físico terminado, cobro aparte.
- `CERRADOS` quedó en `["rechazado"]` — el único cierre real sin ningún
  cobro pendiente (el cliente dijo que no).
- `estaCerrada(o)`: `rechazado` cierra siempre; `facturado` cierra solo si
  `entregado_en` existe. Ya no importa cuál de los tres pasos físicos fue
  ni en qué flujo — el hecho es el mismo hecho.
- `cambiarEstado`: marcar cualquiera de los tres pasos físicos guarda
  `entregado_en`; si la OT ya estaba `facturado`, **no** retrocede el
  estado (mismo resguardo que ya tenía "entregado", ahora para los tres).
- **Nuevo, para poder cerrar una OT que se facturó de un tirón** (sin
  pasar por ninguno de los tres pasos físicos — perfectamente válido para
  un trabajo rápido): la pantalla de Facturar pregunta *"¿El trabajo ya
  quedó terminado y entregado/instalado?"* cuando `entregado_en` todavía
  no existe. "Sí" (la opción por defecto) cierra la OT ahí mismo; "No, cobré
  antes de terminar" la deja "Facturado · falta entregar" hasta que se
  confirme aparte. Sin esto, cualquier OT facturada de un solo paso
  habría quedado "falta entregar" para siempre, sin forma de cerrarla.

**Tercera vuelta, la misma tarde: "Entregado" pisaba "Facturado" si ya
estaba facturado.** El primer intento de `cambiarEstado` seteaba
`estado: "entregado"` siempre que se apretaba ese botón, sin mirar si la
OT ya estaba más adelante en el flujo. Pasó en vivo con `OT-2026-0019`
(Jar spa): estaba `facturado` (con `numero_factura` y `monto_final` ya
guardados), Jonatan apretó "Entregado" para completar ese dato, y el
estado retrocedió a `entregado` — la OT volvió a mostrarse como "falta
cobrar" aunque ya estaba cobrada. **Nada se perdió** (`monto_final` y
`numero_factura` son columnas aparte, no se tocan al cambiar `estado`),
pero el estado quedó mintiendo. Corregido: si la OT ya está en
`facturado`, marcar "Entregado" solo completa `entregado_en` y **no**
retrocede el `estado` — el más avanzado se queda como está. Único caso
real encontrado (revisado contra `movimientos_estado` completo); se
corrigió a mano sin tocar montos ni factura.

**Facturar: con o sin factura (17-09-2026).** Al entregar un módulo se cobra
ahí mismo, casi siempre en efectivo y sin factura — el monto que se escribe
ya es neto. A veces sí se emite factura, y ahí lo que se cobra incluye IVA.
La pantalla "Facturar" (`vFacturar`) tiene un toggle "¿Cómo entró el pago?":
sin factura guarda el monto tal cual; con factura le descuenta el IVA antes
de guardar (`Math.round(monto/1.19)`, mismo criterio que `gastos.monto_neto`
en `11-gastos.sql`). **`ordenes.monto_final` sigue siendo siempre neto** —
no se agregó ninguna columna nueva a la base, el cálculo se hace en el
front antes de escribir, igual que ya se hacía con un solo camino. La
pantalla de "Informe técnico" (`vCierre`/`cMonto`) sigue pidiendo el monto
directo, sin este toggle — es otra pantalla, con otro propósito (el PDF
para el cliente), y no se tocó.

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

**"Cerradas" — solo dueño (17-09-2026).** Salió de la pregunta obvia
después de tanto tocar `estaCerrada()`: si una OT se esconde del
tablero, ¿cómo se vuelve a encontrar? No había forma — quedaba en la
base pero invisible desde la app. Botón "Cerradas" en Terreno/Laboratorio
(`btnVerCerradas`), visible solo para dueño, abre una pantalla con buscador
libre (cliente, patente o número de OT) sobre las OT `facturado` o
`rechazado` que de verdad están cerradas (mismo `estaCerrada()` de
siempre). No es una tabla nueva ni una política de base aparte: la
pantalla simplemente no existe para nadie más, mismo criterio que
"Enseñarle a PAZ".

**Un módulo retirado en terreno se quedaba atrapado en la pestaña
Terreno para siempre (17-09-2026, corregido dos veces la misma tarde).**
Jonatan lo anticipó antes de que pasara de verdad, revisando el caso de
Germán Morales / módulo VRDU: el tablero separaba Terreno y Laboratorio
solo por `origen`, y un módulo retirado nace con `origen = terreno` — así
que nunca iba a aparecer en la cola del laboratorio, aunque pase ahí casi
toda su vida (diagnóstico, reparación, pruebas). El riesgo real que
describió: si al técnico se le olvida bajar el módulo de la camioneta,
nadie en el laboratorio lo iba a notar, porque ni siquiera aparecía en su
pantalla.

**Primer intento** (`seccionDe` basado en el estado): mientras el módulo
estuviera en tránsito (`agendado`/`en_terreno`/`resuelto_en_terreno`/
`retirado`) se veía en Terreno; desde `recepcionado` pasaba solo a
Laboratorio. Jonatan lo corrigió altiro al ver las dos OT de la misma
visita (servicio + módulo) juntas en Terreno: **"no pueden quedar las 2
en terreno si el módulo es de laboratorio, está mal diseñado"** — la
pestaña la decide QUÉ ES el trabajo, no en qué tránsito está.

**Arreglo final, mucho más simple:** `seccionDe(o)` mira solo
`tipo_trabajo` — módulo siempre Laboratorio, servicio siempre Terreno, sin
importar `origen` ni `estado`. El riesgo de que el técnico se olvide de
entregarlo ya lo cubre **"Módulos por recepcionar"** en la Agenda (ver
abajo) — no hacía falta que el tablero principal hiciera ese mismo
trabajo. `cargarOrdenes()` y `cargarAgendaSemana()` (la pestaña
Terreno/Laboratorio de la Agenda, que tenía el mismo problema) usan
`seccionDe` en vez de comparar `origen` directo.

**`noSeEdita(o)`, no `estaCerrada(o)`: el resto de los botones tenían el
mismo hueco (17-09-2026).** Jonatan mandó tres capturas completas de la
OT de Naranjo y encontró que "Pagada" seguía mostrando "Sin agendar",
"Editar agenda", "Subir foto", "Cliente aprobó la cotización",
"Cotización" e "Informe técnico" — el arreglo anterior solo había
corregido `pintarEstados`, pero **todos los demás** botones de "esto ya
no se edita" seguían mirando `estaCerrada(o)` (que a propósito excluye
"Pagada", para que siga visible en el tablero). Dos preguntas distintas
que se habían mezclado: *"¿se esconde del tablero?"* (`estaCerrada`, no
cambia) vs. *"¿se puede seguir editando?"* (nueva función `noSeEdita(o)`
= `estado === 'facturado' || estado === 'rechazado'`, sin mirar
`entregado_en` para nada). Se cambiaron a `noSeEdita`: `btnRetiroModulo`,
`btnCotizar`, `btnAprobar`, `btnCierre`, `seccionSubirFotoDet`,
`detAgenda`/`puedeEditar`, y el recuadro vacío de fotos. `btnGastoDeOT`
se queda igual (siempre visible, a propósito). De paso, el monto en
"Margen de esta OT" ahora muestra el total con IVA al lado del neto
(`$400.000 + IVA = $476.000`) — Jonatan insistió dos veces con la misma
duda real (¿es un error o es neto?), así que quedó explícito en vez de
depender de que alguien recuerde la convención.

**"Pagada" también necesitaba la lista de botones restringida
(17-09-2026).** El arreglo de "una OT cerrada no invita a seguir
editándola" solo miraba `estaCerrada(o)` — pero "Pagada · módulo aún en
el taller" (facturado, sin `entregado_en`) **no** es `estaCerrada` (sigue
visible en el tablero, a propósito), así que seguía cayendo en la lógica
normal y ofreciendo el flujo completo hacia atrás (recepcionado,
en_diagnostico, etc.) como si nada se hubiera cobrado. Encontrado por
Jonatan mirando la misma OT de Naranjo: *"solo debería salir garantía y
entrega"*. Se agregó un segundo caso especial en `pintarEstados` para
`facturado && !estaCerrada`: mismo aviso restringido que una OT cerrada,
pero ofreciendo además el paso físico pendiente de este flujo
(`PASOS_FISICOS` que aplican — para Naranjo, "Entregado") junto con
"Garantía". Nada de volver atrás en el flujo una vez que ya se cobró.

**"Facturado · falta entregar" pasó a decir "Pagada · módulo aún en el
taller" (17-09-2026).** Jonatan, revisando otra vez la OT de Naranjo
(que él mismo había regresado de "Facturado" a "Listo para entrega"
probando "Cambiar estado manualmente" — se restauró a mano, el monto y
la factura nunca se movieron de la fila): en este taller **"Facturado" ya
significa "plata cobrada"**, no "boleta emitida" — así lo usa
`resumen_rentabilidad()` desde siempre (cuenta el monto apenas el estado
es `facturado`, sin mirar `entregado_en` para nada — se confirmó leyendo
la función real de la base antes de tocar el texto). El monto de una OT
así **ya cuenta en la rentabilidad del mes**, aunque el módulo siga
físicamente en el taller. "Falta entregar" sonaba a que faltaba algo
administrativo; "Pagada" es más directo sobre lo que realmente falta:
que alguien venga a buscar el módulo.

**La causa real de que "cerrar la app 3 veces" no actualizara nada:
GitHub Pages sirve `index.html` con `Cache-Control: max-age=600`
(17-09-2026).** El service worker ya pedía "red primero" (`fetch()` antes
que caché), pero sin decirle explícitamente que ignorara la caché HTTP,
un `fetch()` dentro de esa ventana de 10 minutos se resolvía con la copia
guardada del navegador **sin tocar la red siquiera** — cerrar la app no
limpia esa caché, así que no importaba cuántas veces se cerrara si caía
dentro de esos 10 minutos. Se agregó `{ cache: "no-store" }` al `fetch()`
del service worker (`sw.js`), que fuerza una vuelta real a la red cada
vez, ignorando el `Cache-Control` del servidor. El SW script en sí
(`sw.js`) no tenía este problema — los navegadores ya lo tratan aparte al
revisar actualizaciones — era solo `index.html`.

**"Sin agendar" y "Subir foto" seguían mostrándose en una OT cerrada
(17-09-2026).** Jonatan marcó una captura: el punto anterior solo había
sacado el *botón* de editar agenda, pero la sección "Agenda" seguía
mostrando "Sin agendar" igual (puro ruido en una OT ya facturada que
nunca tuvo visita), y "Subir foto o captura del escáner" seguía
ofreciéndose. Ahora: la sección Agenda entera se esconde si está cerrada
**y** nunca tuvo `fecha_agendada` (si sí tuvo una agenda real, se deja
como registro de solo lectura); "Subir foto" se esconde si está cerrada,
pero las fotos que ya se subieron se quedan visibles. **De paso** quedó
un recuadro blanco vacío cuando una OT cerrada no tenía ni botón de subir
ni fotos que mostrar (`cargarFotos` ahora esconde la tarjeta entera en
ese caso, no solo el botón de subir).

**Se puede registrar un gasto contra una OT cerrada (17-09-2026).**
Pedido de Jonatan, justo después del punto anterior: un costo puede
llegar **después** de facturar (garantía, una factura de repuestos
atrasada) — cerrar la OT no debería cerrar también la posibilidad de
asociarle gastos. `cargarOrdenesParaGasto()` ya no excluye las cerradas
del selector, y el detalle de cualquier OT (abierta o cerrada) tiene un
botón **"+ Registrar gasto de esta OT"** que abre el formulario con esa
orden ya elegida. Distinto de los demás botones que se esconden al
cerrar: **este no cambia nada de la OT**, solo crea un gasto aparte —
por eso no tenía sentido restringirlo.

**Una OT cerrada seguía invitando a editarla como si estuviera abierta
(17-09-2026).** Jonatan: *"fíjate en las OT que fueron cerradas y ve todo
lo que no debería verse"*. El detalle no distinguía cerrada de abierta —
ofrecía "Cambiar estado manualmente" (recepcionado, en_diagnostico, etc.
sobre algo ya facturado), "Cotizar", "Aprobar cotización", "+ Se retiró
un módulo", "Editar agenda" e "Informe técnico" (que además **escribe**
`monto_final` y `observaciones` al generarlo — podía pisar sin querer el
monto ya facturado de verdad). Ahora, si `estaCerrada(o)`:
- `pintarEstados` muestra solo un aviso ("Esta OT ya está cerrada") y,
  si no está ya en garantía, el único botón que deja es **"Garantía
  (reingresa la OT)"** — la única puerta real que tiene sentido dejar
  abierta: un cliente puede volver por un trabajo ya cerrado.
- Cotizar, Aprobar, "+ Se retiró un módulo" e "Informe técnico" se
  esconden.
- "Editar agenda" también se esconde (reprogramar algo que ya terminó no
  tiene sentido); la info de agenda que ya tenía sigue visible, solo de
  lectura.

**Cuatro ajustes más finos, misma sesión (17-09-2026), a pedido de
Jonatan de revisar con más precisión antes de tocar código:**

- **La Agenda necesita su propio criterio, distinto al del tablero.**
  `seccionDe` (tablero) contesta "de quién es el trabajo" — correcto que
  sea por `tipo_trabajo`. Pero la Agenda contesta "¿a dónde hay que ir?",
  y un módulo agendado para retiro que todavía no se retira **es una
  visita real** (alguien maneja hasta allá), aunque el trabajo en sí
  termine siendo de laboratorio. Se agregó `seccionAgendaDe(o)`, que usa
  el estado (¿la visita ya pasó o no?) en vez del tipo de trabajo, solo
  para la pestaña Terreno/Laboratorio dentro de la Agenda. **Ojo:** por
  esto mismo, "+ Agendar esta orden" al elegir "Llegó al laboratorio" **sí
  es correcto y no se tocó** — es la fecha estimada en que el cliente
  avisa que manda o trae el módulo (ver "Caso laboratorio" más abajo), no
  una visita.
- **El atajo "+ Se retiró un módulo" nace en "Retirado", no en
  "Agendado", y no ofrece agendar.** La visita ya está pasando cuando se
  usa ese botón — agendarla de nuevo no tiene sentido, y "Agendado" habría
  sugerido que todavía falta ir a buscarlo.
- **Ese mismo botón desaparece una vez que el módulo ya avanzó** (pasó
  `recepcionado` en el laboratorio) — mostrarlo ahí sugeriría que la
  visita sigue activa cuando ya terminó hace días.
- **"Tomar foto de recepción" ahora dice solo "Tomar foto" en un
  servicio** — nada se "recibe" al reparar algo directo en el camión, esa
  frase es lenguaje de módulo.

**"Módulos por recepcionar" en la Agenda (17-09-2026).** Pedido directo
de Jonatan: cuando un módulo retirado en terreno pasa a ser
responsabilidad del laboratorio, alguien tiene que acordarse de pedirlo
— si no, se pierde en el camino sin que nadie lo note. Mismo problema
que "Casos por agendar" ya resolvía para PAZ (no hay notificaciones de
verdad todavía), así que se usó el mismo patrón: un bloque en la Agenda
—donde el coordinador abre la app por defecto— que lista los módulos en
estado `retirado` (el técnico ya los tiene, en tránsito) hasta que
alguien los marca `Recepcionado`. Tocar uno abre su detalle directo. No
es una notificación push real, es la misma clase de aviso honesto que ya
se usa en el resto de la app: visible cada vez que se abre, no una
promesa de algo que no existe.

**"+ Se retiró un módulo en esta visita" (17-09-2026).** Salió de un caso
real: una visita a terreno donde se repara algo directo en el camión
(servicio) Y aparte se retira un módulo para el laboratorio — dos
trabajos, dos OT (`tipo_trabajo` es uno u otro por fila, no se mezclan).
Jonatan había creado solo la del servicio; la del módulo nunca se guardó
porque había que ir a "Nueva OT" desde cero y re-buscar el mismo cliente
y la misma patente. Ahora, en el detalle de cualquier OT de `origen =
terreno`, el botón **"+ Se retiró un módulo en esta visita"** abre "Nueva
OT" con cliente y patente ya cargados, tipo módulo y origen terreno ya
elegidos — solo falta el tipo de módulo y la falla.

**`orden_padre_id` ya existía en el esquema (`01-schema.sql`) sin usarse
nunca** — es justo para esto: la OT nueva queda con `orden_padre_id`
apuntando a la OT desde la que se creó. El detalle de cada una ahora
muestra el vínculo en las dos direcciones: la hija dice "Nace de la
visita: OT-XXXX", y la que originó otras muestra "Otros trabajos de esta
visita: OT-YYYY" — ambos con link directo. No se creó tabla ni columna
nueva, solo se usó lo que ya estaba.

## Estado actual — qué funciona

- Login con correo y contraseña
- Navegación en tres pestañas (Terreno / Laboratorio / Herramientas) con
  barra inferior; Herramientas es un menú de botones (Agendar visita,
  Asistencia, Pendientes, Gastos), no una lista de OT
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

### Casos: una conversación, varios camiones (15-09-2026)

**La conversación es el hilo con un teléfono. El caso es un camión.** Adentro
de una conversación puede haber varios casos.

Esto nació de un error real: un cliente reportó un Actros 4144 y después dijo
"tengo otro camión con falla". Como había una sola ficha por conversación, el
segundo camión **pisó al primero** y el caso original se perdió. En un taller
de flotas eso pasa todos los días.

Cómo se sincroniza (`sincronizarCasos()` en la Edge Function): la IA relee el
hilo completo y devuelve `{"casos":[...]}` **en el orden en que aparecieron**.
Ese orden es la llave (`orden_en_conversacion`), porque es lo único estable:
la patente puede llegar tarde o no llegar nunca.

**Reglas que no hay que romper:**

- **La alerta la levanta PAZ, la baja una persona.** Si alguien ya atendió un
  caso, que la IA cambie de opinión en la lectura siguiente no debe hacerla
  reaparecer. Por eso `requiere_respuesta_humana` solo se pone en true si
  estaba en false.
- **Los conflictos no se resuelven solos.** Si el cliente dice un año distinto
  al registrado, va a `conflictos` y lo mira una persona. Nunca se sobrescribe.
- **PAZ no crea OT.** El botón del detalle llena el formulario de siempre; al
  guardar, el caso queda con `orden_id` y `estado_caso = convertido_a_ot`.
- Los adjuntos cuelgan del caso (`nexa_archivos.caso_id`), no solo de la
  conversación: la foto del segundo camión va al caso del segundo camión.
- Se **archiva**, no se borra.

**Falta:** las conversaciones que nacen dentro de la app todavía no generan
casos — se listan aparte en la bandeja para que no queden invisibles.

### Modo asistido y alertas en vivo (15-09-2026)

**Quién decide qué se le dice al cliente sigue siendo una persona.** PAZ
recolecta datos sola, pero agenda, precio final, condiciones y compromisos
los redacta a pedido: dueño o coordinador escriben una **instrucción
interna** en el detalle del caso ("Dile que el jueves en la mañana tenemos
disponibilidad"), PAZ la convierte en un mensaje breve y claro para el
cliente, y recién con **Enviar por WhatsApp** sale — nunca antes de que
alguien lo revise en la vista previa.

Tres acciones nuevas en la Edge Function `nexa` (`redactar_respuesta`,
`enviar_respuesta`, `marcar_atendido`), protegidas igual que el resto: exigen
sesión de dueño o coordinador. El técnico nunca llega ni a la pantalla —
`btnNexa` sigue oculto para él, no hace falta un cerrojo aparte.

**La ventana de 24 horas de WhatsApp se respeta de verdad, no se ignora.**
Si el cliente escribió hace menos de 24 horas, el texto libre es gratis; si
no, WhatsApp solo deja plantillas aprobadas (no construidas todavía —
necesitan medio de pago cargado en Meta, cosa que se saltó a propósito
porque no hacía falta hasta ahora). La función comprueba la ventana antes de
intentar el envío y explica el motivo si está cerrada, en vez de dejar que
WhatsApp lo rechace en silencio. La app también la muestra en el detalle del
caso ("quedan 17 h 42 min…"), calculada del lado del cliente para no gastar
una llamada a la función solo por mirar el reloj.

**Todo queda en `paz_respuestas_asistidas`**: la instrucción interna, quién
la escribió y con qué rol, el mensaje que salió, si se envió, y el error si
falló. Un envío fallido **no borra el texto**: la persona lo ve en pantalla y
puede reintentar sin volver a escribirlo. Los mensajes que salen por este
camino quedan marcados en `nexa_mensajes` (`humano_asistido`, `escrito_por`)
para distinguirlos de lo que PAZ contesta sola — eso importa el día que se
quiera medir qué tanto está resolviendo sin ayuda.

**Nunca crea OT.** Enviar un mensaje asistido apaga la alerta del caso, nada
más. La OT sigue naciendo solo del botón "Crear la OT desde este caso", con
revisión humana.

**Alertas, por qué existen:** cuando el cliente pregunta algo que PAZ no
puede decidir sola (disponibilidad, precio final, agendar, un reclamo por
demora, si ya van en camino), lo declara ella misma en la misma pasada que
arma la ficha del caso — sin llamada extra, sin costo adicional. El caso
queda `requiere_respuesta_humana = true` con un `motivo_alerta` en una línea.

**Cómo se entera la app, sin refrescar:** Realtime de Supabase sobre la
tabla `casos` (con `replica identity full`, para que el evento de UPDATE
traiga también el valor anterior). La app compara viejo contra nuevo —
**solo avisa cuando pasa de false a true**, nunca en cada mensaje que llega
después mientras el caso ya estaba esperando. Sin esa comparación, cada
mensaje del cliente habría hecho sonar el timbre de nuevo.

El aviso es un timbre corto por Web Audio (sin archivo que cargar) más
vibración si el celular la soporta, y un número en el botón PAZ del
encabezado. **Esto solo funciona con la app abierta.** Push de verdad —que
llegue con la pantalla apagada— es la segunda etapa, deliberadamente no
construida todavía: complejidad real (Service Worker con push subscription,
servidor de notificaciones) que no vale la pena antes de que el número real
de WhatsApp esté conectado.

### Dos errores reales encontrados en la primera prueba larga (15/16-09-2026)

Jonatan probó una conversación larga simulando varios camiones del mismo
teléfono, y aparecieron dos fallas de verdad — quedan acá porque el mismo
patrón puede repetirse si se toca esta parte sin leerlo primero.

**1. PAZ se desdecía a sí misma frente al cliente.** El dueño confirmó por
modo asistido una hora y un precio ("el jueves a las 10:00, $150.000"). Diez
segundos después, respondiendo sola, PAZ le dijo al cliente que no podía
confirmar esa hora y le agregó IVA que nadie había mencionado. La causa: al
armar el historial para la IA, un mensaje escrito por una persona y uno
escrito por PAZ se veían exactamente igual — ningún dato distinguía cuál
pesaba más. **Arreglado:** `procesarMensaje` ahora marca los mensajes con
`humano_asistido = true` con una etiqueta dentro del propio texto
(`[CONFIRMADO POR EL EQUIPO — no lo desdigas]`) antes de mandarlos a la IA, y
`REGLAS_WHATSAPP` tiene una sección explícita: lo que el equipo ya confirmó
no se pone en duda ni se le agregan condiciones nuevas — pero tampoco se
convierte en "queda agendado", que sigue siendo solo de una persona.

**2. PAZ separaba un caso en dos.** Un cliente mandó un módulo GS por
Chilexpress, sacado de la patente PP1865 — un solo caso, y la tabla `casos`
ya lo tenía bien unido: `"Módulo GS de PP1865… enviado a taller."` Pero al
responder en vivo, PAZ vuelve a reconstruir el panorama desde el texto crudo
del chat en cada turno, sin mirar esa tabla — y terminó preguntándole al
cliente *"¿es el camión PP1865 o el módulo GS enviado?"*, como si fueran dos
cosas para elegir. **Arreglado:** `contextoDelSistema` ahora consulta
`casos` por `conversacion_id` y le pasa a la IA la lista ya resuelta, con la
instrucción explícita de no volver a separar lo que el sistema ya unió. Esto
importa sobre todo cuando un mismo teléfono tiene varios casos abiertos a la
vez (una flota, por ejemplo) — mientras más casos mezclados en una
conversación, más fácil que PAZ pierda el hilo sin este contexto.

**Ninguno de los dos llegó a un cliente real** — la prueba fue con el propio
Jonatan haciendo de cliente, en el número de prueba. Vale la pena repetir
una conversación larga con varios casos antes de conectar el número real,
para confirmar que estos dos arreglos sostienen bajo uso de verdad.

### Trazabilidad dura, reglas comerciales y la agenda (16-09-2026)

Jonatan revisó esos dos errores a fondo y encontró tres cosas más, todas
reales:

**1. La trazabilidad era una convención, no una estructura.** Antes, que un
mensaje llevara la etiqueta "confirmado por el equipo" dependía de que dos
inserts separados en el mismo código se hicieran bien — nada lo ataba de
verdad. Ahora `nexa_mensajes.respuesta_asistida_id` es una llave foránea real
hacia `paz_respuestas_asistidas`. La etiqueta que ve la IA sale de un **join**,
no de un booleano suelto: estructuralmente no puede existir sin un registro
de auditoría real detrás, con `nombre_creador`, `rol_creador` y `creado_en`.
Se agregó `nombre_creador` porque antes solo quedaba el rol, no quién
específicamente.

**2. El modo asistido se saltaba reglas comerciales obligatorias.** El dueño
dio la instrucción "el jueves a las 10, valor 150mil", y PAZ mandó
"$150.000" sin IVA — porque yo mismo le había puesto una regla demasiado
literal ("no agregues nada que la instrucción no haya dicho"), que pisaba la
convención de todo el sistema: **todo monto es neto**. Corregido:
`redactar_respuesta` ahora tiene reglas comerciales que valen aunque la
instrucción no las mencione — monto sin decir "IVA incluido"/"total" se
comunica con "+ IVA"; fuera de la Región del Maule no se cierra un valor si
la instrucción no lo autorizó explícitamente. Y de paso: **esa acción no leía
`paz_aprendizajes`** — los criterios solo aplicaban a la conversación en
vivo, no al modo asistido. Ya se corrigió; los dos caminos por los que PAZ le
habla a un cliente comparten las mismas reglas.

**3. Confirmado con el cliente, invisible para el equipo.** Si el modo
asistido confirma una hora, esa fecha vivía solo en el texto del chat —
nunca llegaba a `ordenes.fecha_agendada`, así que no aparecía en la Agenda
del coordinador. Se agregó un toggle opcional en "Responder como PAZ": si la
respuesta fija una fecha y el caso **ya tiene una OT vinculada**, al enviar
se actualiza `fecha_agendada`/`franja` de esa OT en el mismo paso. Si el caso
**no tiene OT todavía**, se avisa explícito ("la fecha no va a aparecer en la
Agenda hasta que la crees") en vez de perder el dato en silencio. Esto
**nunca crea una OT** — solo actualiza una que una persona ya vinculó al
caso con el botón de siempre.

**Nueva sección en el detalle del caso: "Quién confirmó qué"** — el
historial completo de `paz_respuestas_asistidas` para ese caso: instrucción,
mensaje enviado, quién y cuándo, visible directamente en la app sin tener
que consultar la base.

### Dos errores más, misma tarde (16-09-2026): cancelar sin tocar nada, y responder dos veces

**4. PAZ confirmaba una cancelación que no existía en ningún lado.** El
cliente pidió cancelar una visita ya agendada ("es muy caro, cancela"), y
PAZ le contestó "queda dado de baja" — pero nadie le construyó a PAZ la
posibilidad de cancelar nada, así que la OT (`OT-2026-0004`) se quedó
`agendado` para la fecha original. Es el mismo error de siempre, al revés:
antes prometía una agenda que no existía; acá prometió una baja que tampoco
existía. **Arreglado en `REGLAS_WHATSAPP`:** cancelar es tan serio como
agendar — PAZ nunca dice "queda cancelada" ni "la dimos de baja"; dice que
lo pasa al equipo. Y en `prompt_ficha`: pedir cancelar o reprogramar algo ya
agendado ahora entra en la lista de motivos que levantan
`requiere_respuesta_humana`.

Esto chocaba con el arreglo del punto 1 de la sección anterior (`yaConvertido`
bloqueaba toda alerta nueva una vez que el caso ya tenía OT). Se afinó: la
alerta se bloquea solo si el **motivo es el mismo que ya se avisó antes**
(`motivo_alerta` sin cambios); si el motivo es distinto —como pedir
cancelar algo que antes solo se estaba agendando—, sí avisa, tenga OT o no.

**5. PAZ respondía dos veces al mismo mensaje.** El cliente mandó dos
mensajes seguidos con tres segundos de diferencia ("Cuáles son las que te
envié" y luego "?"). Meta los entregó como dos avisos separados, y como
`procesarMensaje` corre uno por aviso sin saber del otro, generó **dos
respuestas casi idénticas, 195 milisegundos aparte** — como si dos personas
del equipo contestaran el mismo mensaje sin mirarse. **Arreglado con una
pausa de 2,5 segundos** antes de generar la respuesta: si en ese lapso llega
un mensaje más nuevo del mismo cliente, este se retira y deja que el más
nuevo conteste por los dos (que sí va a leer todo el historial, incluido el
mensaje que se retiró). Le agrega ~2,5 s de latencia a cada respuesta, que
es apenas perceptible por WhatsApp.

Los cinco errores de esta tarde salieron de la misma prueba larga con varios
camiones mezclados. Ninguno llegó a un cliente real. Vale la pena repetir
una conversación así de larga, con cancelaciones y ráfagas de mensajes
incluidas, antes de conectar el número de verdad.

### Rol `agente`: PAZ ya no escribe con la llave maestra (16-09-2026)

Hasta acá, cuando PAZ conversaba sola con un cliente, todo lo que escribía en
la base pasaba por `service_role` — la llave que se salta cualquier permiso.
Funcionaba, pero sin ningún límite de por medio: un error de código ahí
podría, en teoría, tocar cualquier columna de cualquier tabla. Esto cierra
esa puerta.

**Cómo queda armado:**

- **Un usuario de Supabase propio para PAZ**, con `perfiles.rol = 'agente'`
  (`paz.agente@sistema.pazservices.local`). Sus credenciales están en
  `PAZ_AGENT_EMAIL` / `PAZ_AGENT_PASSWORD`, secretos de Supabase — igual que
  `OPENAI_API_KEY` o `WHATSAPP_TOKEN`.
- **`supabase/functions/whatsapp/index.ts` inicia sesión como ese usuario**
  una vez por cada aviso de Meta (`iniciarSesionPaz()`), y usa esa sesión
  (no `service_role`) para todo lo que antes hacía con `admin`.
- **Nunca escribe directo en las tablas.** Todo pasa por ocho funciones
  `security definer` en la base (`19a-rol-agente-enum.sql`, `19b`, `19c`, `19d`):
  `paz_abrir_conversacion`, `paz_guardar_mensaje`, `paz_actualizar_ubicacion`,
  `paz_adjuntar_archivo`, `paz_sincronizar_caso`, `paz_finalizar_sincronizacion`,
  `paz_actualizar_ficha_conversacion`, y la guardia interna
  `paz_verificar_agente()` que todas llaman primero. Cada una valida que
  quien llama es de verdad el agente, recibe parámetros explícitos (nunca un
  JSON libre volcado directo a una tabla), y escribe solo las columnas que
  declara.
- **`paz_sincronizar_caso` nunca toca `orden_id`, `estado_caso` más allá de
  recopilando→listo, `archivado`, `atendida_por` ni `atendida_en`.** Crear
  una OT, cerrar o archivar un caso sigue siendo solo de una persona — eso
  se probó explícitamente antes de dar esto por bueno (ver más abajo).
- **Las dos reglas que costaron errores reales de encontrar** (la alerta se
  levanta sola pero no se baja sola; un caso con OT no vuelve a alertar por
  el mismo motivo pero sí por uno distinto) viven ahora **dentro de la RPC**,
  no en el código de la función — un solo lugar, protegido, en vez de lógica
  repartida en TypeScript.
- **Lectura**: se agregó `'agente'` a las políticas de `select` de
  `paz_aprendizajes`, `nexa_conversaciones`, `nexa_mensajes`, `nexa_archivos`,
  `casos` y `paz_respuestas_asistidas` (`19c-rol-agente-lectura.sql`) —
  necesita leer su propio trabajo para armar el contexto de cada respuesta.
  **`clientes`, `vehiculos` y `ordenes` ya eran de lectura abierta** para
  cualquier autenticado, así que no hizo falta tocarlas; `agente` hereda el
  mismo límite de columnas de `ordenes` que ya tenía todo el mundo (sin
  montos). **Nunca se agregó `'agente'` a `gastos`, `costos_fijos_mensuales`,
  `cotizaciones` ni `cotizacion_items`** — eso sigue completamente vedado.
- **Tres cosas se quedaron en la llave maestra, a propósito:** escribir en
  `wa_log` (registro interno, sin política de escritura para nadie más),
  subir el archivo binario al bucket `paz-adjuntos` (Storage no tiene
  política de subida para `agente` todavía — solo el registro en la base del
  archivo va por RPC), y leer `nexa_config` (tiene precios y reglas
  comerciales; no se abrió esa tabla a un rol más). Si algún día se quiere
  cerrar también esas tres, hay que sumar política de Storage y una lectura
  acotada de `nexa_config` sin exponer el prompt completo.

**Cómo se creó el usuario:** con una función temporal (`bootstrap-agente`),
protegida por un secreto de un solo uso, que llamó `admin.auth.admin.createUser(...)`
y luego se borró — mismo patrón que la puerta de mantenimiento de WhatsApp
que también se sacó una vez cumplida su función. **Ojo con esto si se repite
algún día:** Supabase tiene un trigger que crea automáticamente una fila en
`perfiles` apenas nace un usuario nuevo, con `rol = 'tecnico'` por defecto —
el `insert` explícito a `perfiles` que hace el bootstrap choca con eso
(`duplicate key value violates unique constraint perfiles_pkey`). La
solución es un `update`, no un segundo `insert`.

**Probado antes de conectarlo**, sin depender de que Jonatan mandara nada:
con la sesión real de PAZ (no `service_role`), se llamó cada RPC por
separado — abrir conversación, guardar un mensaje, deduplicar por `wa_id`,
sincronizar un caso, simular que ya tenía OT y confirmar que no se repite la
alerta con el mismo motivo pero sí con uno distinto, y que nunca tocó
`orden_id`/`estado_caso`/`archivado`. También se confirmó que un usuario
sin sesión de agente (anon puro) recibe `"Esta función es solo para el
agente PAZ."` al intentar llamar cualquiera de las RPC. Todos los datos de
prueba se borraron después.

**Lo que queda pendiente, a propósito:** el `nexa/index.ts` que atiende la
app (chat interno, modo asistido, enseñar a PAZ) sigue usando `service_role`
para sus escrituras — pero ahí quien actúa siempre es una persona ya
autenticada como dueño o coordinador (su propia sesión ya pasó por RLS antes
de llegar a la función); el riesgo que este cambio cierra es específicamente
el de PAZ actuando **sola**, sin nadie en el medio, que es lo que pasa en
`whatsapp/index.ts`.

### Fuga de seguridad real encontrada y corregida (16-09-2026): `mi_rol() <> 'dueno'`

Probando `paz_descartar_caso` recién creada, una llamada **sin ninguna
sesión** — solo con la anon key, que es pública y está en el `index.html` —
logró descartar un caso real. La causa: `mi_rol()` devuelve `NULL` cuando no
hay sesión, y en SQL `NULL <> 'dueno'` es `NULL`, no verdadero. Un
`if NULL then` de PL/pgSQL **no entra al bloque** — la excepción nunca se
lanzaba, y la llamada seguía de largo como si el guardia no existiera.

Se buscó el mismo patrón en todo el proyecto y apareció **dos veces más, en
`11-gastos.sql`, de antes de esta sesión** — `resumen_rentabilidad` y
`rentabilidad_ot`. Se probó en vivo: una llamada anónima devolvió el
resumen financiero completo (hoy en $0 porque no hay datos reales
todavía, pero la fuga era real y llevaba tiempo expuesta).

**Corregido en `20b-fix-mi-rol-null.sql`** cambiando `mi_rol() <> 'dueno'`
por `coalesce(mi_rol()::text, '') <> 'dueno'` en las tres funciones — así
`NULL` se trata como cadena vacía, que sí es distinta de `'dueno'`, y el
guardia funciona de verdad. El resto de cada función se releyó con
`pg_get_functiondef` directo desde la base antes de tocarla, para no
reconstruir de memoria y arriesgar una regresión.

**La lección que vale la pena anotar para cualquier función nueva:** las
políticas RLS con `using (mi_rol() in (...))` son seguras solas —
Postgres trata una condición `NULL` en RLS como "esta fila no se ve", falla
**cerrado**. Pero un `IF` de PL/pgSQL con una comparación que puede dar
`NULL` falla **abierto** — no lanza la excepción, sigue de largo. Si algún
día se escribe una función `security definer` nueva con un guardia manual,
usar `paz_verificar_agente()` como modelo (usa `not exists(...)`, que es
seguro ante `NULL` por construcción) o envolver la comparación en
`coalesce(...)`, nunca comparar `mi_rol()` pelado con `<>` o `=`.

**Qué faltó a propósito**, siguiendo el mismo criterio de no sobre-construir:
plantillas para fuera de la ventana de 24 horas, push notifications reales, y
un job programado para avisar cuando un caso lleva mucho tiempo sin que nadie
lo mire (hoy la alerta nace de la conversación, no del tiempo transcurrido).

**Bug real encontrado y corregido (15-09-2026):** un caso con OT ya creada
seguía apareciendo como "te espera" cada vez que llegaba un mensaje nuevo del
mismo cliente, porque `sincronizarCasos` no sabía que ya había pasado por una
persona. Se agregó `yaConvertido` (si el caso tiene `orden_id`, no se toca ni
la alerta ni el estado desde la sincronización — de ahí en adelante esos
campos son responsabilidad de la app, no de la IA).

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

Los criterios iniciales salieron de errores observados de verdad, no de
teoría. Están redactados diciendo qué hacer, no qué evitar.

**Se editan desde la app**, en PAZ → *Enseñarle a PAZ*, visible solo para el
dueño. Ahí se pega una conversación real de WhatsApp o una corrección escrita,
y PAZ destila los criterios (`accion: "aprender"` en la Edge Function) y los
**propone**: el dueño los revisa, edita y guarda. Mismo criterio que con las
OT — nada entra al sistema sin que una persona lo mire.

Los criterios se pueden **apagar** (siguen a la vista, dejan de aplicar) o
borrar. Apagar es casi siempre lo correcto: deja el rastro de lo que se probó.

**Criterios vs. estilo (16-09-2026) — no son lo mismo.** Jonatan subió una
conversación real de venta (negociando un INS de Actros MP3) y "Sacar
criterios" propuso guardar el precio negociado ($600.000 + IVA, garantía 3
meses) y el descuento acordado ($100.000 por el tablero antiguo) como si
fueran reglas fijas — eso habría hecho que PAZ le cotizara exactamente eso
a cualquier cliente futuro, aunque fuera un trato puntual con ese cliente.
Y lo que Jonatan de verdad quería no era eso: quería que PAZ aprenda a
**hablar** de las conversaciones reales, para que un cliente no note que
está hablando con una IA — no que aprenda valores de piezas ni condiciones
comerciales.

`accion: "aprender"` ahora separa dos cosas explícitamente:

- **Criterios** (`tipo = 'criterio'`): reglas de proceso que valen para
  cualquier cliente futuro. La instrucción le prohíbe explícitamente sacar
  precios, descuentos o condiciones comerciales puntuales de una
  conversación — eso se acordó con ese cliente, no es una lista de precios.
  Los precios de verdad siguen viviendo solo en `nexa_config.prompt`,
  cargados a mano y revisados.
- **Estilo** (`tipo = 'ejemplo'`, tipo nuevo en uso — ya existía en el
  enum y en el filtro de "Enseñarle a PAZ" pero nada lo generaba): frases
  o patrones citados casi tal cual de la conversación real — saludos,
  remates, muletillas, nivel de formalidad — no una descripción del
  estilo ("sé cercano"), sino el ejemplo en sí.

Ambos se leen aparte al armar el prompt (`bloqueAprendizajes()`, en
`nexa/index.ts` y `whatsapp/index.ts`): los criterios van bajo "CRITERIOS
DEL TALLER" (mandan), el estilo va bajo "CÓMO HABLA EL EQUIPO DE VERDAD"
(para imitar el tono, no como instrucción literal). Mezclarlos en una sola
lista de "reglas" desperdiciaba los de estilo — el objetivo de esos es que
PAZ hable parecido a una persona, no que siga una instrucción más.

**Pendiente, a propósito:** `respuesta_aprobada` (lo que se guarda al
marcar un caso de entrenamiento como Positivo) queda fuera de "estilo" por
ahora — su `contenido` hoy es solo un puntero al caso de origen ("Ejemplo
aprobado por el dueño: ..."), no texto de estilo real. El transcript
completo sí vive en `paz_aprendizajes.transcripcion`, pero usarlo para
estilo es una mejora aparte, no construida todavía.

**Solo el dueño, de verdad:** la política `esc_paz_aprendizajes` exige
`mi_rol() = 'dueno'`, y la acción `aprender` de la función vuelve a comprobar
el rol. No es que se le esconda el botón al coordinador.

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

### Fotos, audio y tope de frecuencia

- Las **imágenes** que manda el cliente se bajan de Meta y se guardan en el
  bucket privado `paz-adjuntos`, con registro en `nexa_archivos`. La tabla
  `archivos` no servía: cuelga de una OT, y el caso nace antes de que exista.
- Los **audios** (16-09-2026) se transcriben con Whisper (`whisper-1`,
  mismo `OPENAI_API_KEY`) antes de entrar a la conversación como
  `[audio transcrito] ...` — sin esto PAZ seguía a ciegas cuando el cliente
  describía la falla hablando en vez de escribiendo, algo común en terreno.
  El audio igual se guarda como adjunto (mismo camino que una foto,
  `categoria = 'audio_cliente'`) para poder escucharlo si la transcripción
  falla o queda dudosa — no reemplaza el original, lo complementa. Si
  Whisper falla, el mensaje queda como
  "[el cliente envió un audio y no se pudo transcribir — revísalo en
  WhatsApp]" en vez de cortar la conversación.
  **Pendiente, a propósito:** esto solo cubre la conversación en vivo por
  WhatsApp. Un `.txt`/`.zip` exportado para "Enseñarle a PAZ" que tenga
  audios los muestra como "‎audio omitted" (así los omite WhatsApp al
  exportar) — esos mensajes se pierden igual al entrenar desde un archivo
  viejo, a menos que se pida explícitamente resolver también ese caso.
- La **ubicación** de WhatsApp queda en `nexa_conversaciones.ubicacion_gps` y
  `ubicacion_texto`. Cuando el caso se convierta en OT, el GPS se copia.
- **Tope de 30 mensajes por hora y por teléfono** (`TOPE_POR_HORA`). Al
  pasarse, se responde con una frase fija **sin llamar a la IA** y se anota en
  `wa_log`. No bloquea al cliente para siempre: es por ventana de una hora.
  Existe porque un reintento masivo de Meta o alguien jugando con el número
  puede costar la cuota de OpenAI en minutos.
- **Duplicados**: `nexa_mensajes.wa_id` tiene índice único. Si Meta reintenta
  el mismo mensaje, el insert falla y no se contesta dos veces.
- **Debounce en dos pasadas (16-09-2026), no una sola.** Encontrado probando
  audio real: un audio y una ubicación mandados casi juntos generaron dos
  respuestas — el audio tarda en bajarse de Meta y transcribirse antes de
  insertarse, así que su mensaje quedó con hora de inserción más tardía que
  la ubicación, que se insertó 4.2s después de todas formas: fuera de la
  ventana de una sola pasada de 2.5s. Ahora `procesarMensaje` chequea dos
  veces (2.5s + 2.5s) antes de contestar; agrega ~2.5s más de latencia a
  cada respuesta, pero cierra el hueco sin volverlo instantáneo.

### La conexión a WhatsApp quedó funcionando (15-09-2026)

Cliente escribe por WhatsApp → entra al sistema → PAZ contesta. Probado de
punta a punta con el número de prueba `+1 555 152-8643`.

**Las tres trampas que costaron una tarde entera. Si algo se cae, mirar acá
primero, en este orden:**

1. **La app de Meta tiene que estar en modo activo (publicada).** Sin publicar,
   Meta entrega solo los webhooks disparados desde su propio panel, ni siquiera
   los mensajes del dueño de la app. Todo se ve verde y no llega nada.
2. **Hay DOS suscripciones distintas.** El campo `messages` marcado en el panel
   es una. La otra es que la cuenta de WhatsApp Business quede suscrita a la
   app (`POST /{waba-id}/subscribed_apps`), y el panel no la hace sola. Mismo
   síntoma: avisos generados que no llegan a ninguna parte.
3. **El token.** Los temporales del asistente duran horas y al vencer producen
   el peor error posible: los mensajes **entran** (eso va por la firma, no por
   el token) pero las respuestas **no salen**, y en la base todo se ve perfecto.
   Ya está puesto un **token permanente de usuario del sistema**, que no vence.
   Si alguna vez hay que rehacerlo: `business.facebook.com` → Configuración del
   negocio → Usuarios → Usuarios del sistema → asignarle la app y la cuenta de
   WhatsApp → Generar token con `whatsapp_business_messaging` y
   `whatsapp_business_management`, vencimiento **Nunca**.

**Para diagnosticar**: `wa_log` guarda los golpes rechazados y los envíos que
fallan. Un envío que se pierde en silencio es el error más caro de todos,
porque la conversación queda perfecta en la base y el cliente no recibe nada.

**Falta el número real.** Hoy es el de prueba, que solo habla con 5 teléfonos
autorizados. Ningún cliente puede alcanzar a PAZ todavía.

### Cómo se conectó (14-09-2026, 21:00)

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

## Modo aprendizaje (16-09-2026)

Un mes de entrenamiento antes de soltar a PAZ con clientes de verdad. El
dueño conversa con ella —por el número de prueba de WhatsApp, ya aislado de
clientes reales porque solo hablan los teléfonos autorizados— y evalúa cada
caso. Lo que aprueba se vuelve un aprendizaje permanente en la misma tabla
de siempre, `paz_aprendizajes`; no se creó una tabla nueva.

**`casos.modo`** (`aprendizaje` / `produccion`) se fija al nacer el caso,
según `nexa_config.modo_casos_defecto` (hoy: `aprendizaje`). **Nunca cambia
solo** — si algún día hay que pasar un caso de entrenamiento a producción,
lo hace una persona a mano. Los 4 casos que existían antes de este cambio
quedaron en `aprendizaje` por el valor por defecto de la columna.

**Un caso de aprendizaje no puede tocar nada real:**
- No crea OT: el botón "Crear la OT desde este caso" se oculta y se
  reemplaza por un aviso.
- No agenda visita real: sin OT no hay `fecha_agendada` que tocar.
- No manda WhatsApp real: `enviar_respuesta` en `nexa/index.ts` lo bloquea
  del lado del servidor si `caso.modo === 'aprendizaje'` — no es solo un
  botón escondido en pantalla.
- El widget viejo "Casos por agendar" de la pestaña Agenda (que lee
  `nexa_conversaciones.ficha`, la capa de compatibilidad de antes de que
  existieran los casos) se corrigió para excluir conversaciones que no
  tengan al menos un caso `produccion` — sin eso, un caso de entrenamiento
  podía aparecer ahí como si fuera un cliente real esperando agenda.

**Bandeja con pestañas Producción / Entrenamiento**, visible la segunda
solo para el dueño. El badge del encabezado y el contador de "Te esperan"
cuentan **solo casos de producción** — una alerta de una conversación de
prueba no es una urgencia real y mezclarla le quitaría sentido al aviso.

**Tres acciones por caso de entrenamiento** (dueño únicamente, la política
de `casos` ya lo permitía escribir; `paz_descartar_caso` lo exige explícito):

- **Positivo**: pide un título corto, guarda el intercambio completo (no
  solo la última respuesta) en `paz_aprendizajes` como `respuesta_aprobada`,
  vinculado al caso vía `caso_id_origen`. Es un ejemplo de buen criterio,
  no una frase para que PAZ repita literal.
- **Negativo**: pide la regla correctiva, la guarda como `correccion` con
  la transcripción del error. No se borra nunca — queda para comparar si
  PAZ vuelve a fallar parecido.
- **Descartar** (`paz_descartar_caso`): para pruebas sin valor. No es
  borrado físico — sale de toda vista, deja de ser contexto para PAZ, pero
  se puede auditar después.

**Reintentar este caso**: después de guardar una corrección, se puede volver
a generar la respuesta al mismo mensaje del cliente, con la regla ya activa
(los aprendizajes se leen frescos en cada llamada, así que no hace falta
nada especial para que la tome en cuenta). Muestra mensaje del cliente,
respuesta original y respuesta nueva, lado a lado — para ver si sirvió sin
esperar a que el caso se repita solo. No reemplaza la conversación real; es
una comparación, no se guarda como mensaje.

**"Enseñarle a PAZ" ahora tiene filtro por tipo** (criterio / ejemplo /
aprobado / corrección) y buscador por palabra, y cada entrada que viene de
un caso evaluado trae un enlace "Ver caso" a su origen.

**Qué falta a propósito:** el orden explícito "primero correcciones, luego
criterios, luego aprobados" que describía el plan no se implementó como tal
— hoy todos los aprendizajes activos se leen juntos, sin distinguir tipo al
armar el bloque para la IA. Es una mejora posible, no crítica: el efecto
práctico (la IA los ve todos) es el mismo.

**El chat interno también quedó cubierto (16-09-2026).** La pantalla
"Atender un caso nuevo" (canal `app`) es de antes del modelo de casos: su
ficha y su "Crear la OT desde este caso" no pasan por `casos.modo` en
absoluto, así que una conversación de prueba ahí sí podía terminar
llenando el formulario de una OT real. Como `nexa_config` tiene el prompt
comercial completo y su RLS es "solo dueño" (el coordinador también usa
esta pantalla y no puede leer esa tabla), se agregó
`paz_en_entrenamiento()` — una función que solo expone el booleano que
hace falta, sin abrir el resto. Mientras esté en `true`, el botón de crear
OT se esconde y además se bloquea si igual se llega a apretar. Por defecto
el front asume `true` (falla cerrado) hasta que la función confirme lo
contrario.

### Rediseño visual de los cuatro carriles + cierre explícito (17-09-2026)

Después de un día armando y probando los cuatro ejes, Jonatan pidió
puntualmente: *"mejorar interfaz de estados de OT sin cambiar el
modelo de datos"* -- los botones grandes por eje ya eran correctos por
debajo, pero seguían siendo confusos de leer. Esto es una capa
**visual y de usabilidad** sobre `ubicacion`/`reparacion`/`comercial`/
`pagado_en` -- ninguna columna nueva, ningún estado nuevo.

**Un solo cambio real de comportamiento: cerrar dejó de ser automático.**
Antes, `estaCerrada(o)` se derivaba sola de `pagado_en` + `ubicacion`
(pagado y entregado = cerrada, sin que nadie lo confirmara). Ahora
`estaCerrada(o)` es `comercial === 'rechazado' || !!o.fecha_cierre` --
`fecha_cierre` (columna que ya existía desde `01-schema.sql`, antes se
escribía sola) pasa a ser la fuente de verdad, y **solo se escribe con
un clic explícito**: `cerrarOT()` o `cerrarSinCobro()`. Una OT pagada Y
entregada se queda "Abierta · lista para cerrar" hasta que alguien
aprieta "Cerrar OT" -- ya no desaparece sola del tablero. `rechazado`
sigue cerrando solo, ahí de verdad no queda ninguna decisión pendiente.

**Los cuatro carriles, como filas compactas** (`dato`, igual que
Cliente/Patente en los datos de arriba), no como botones:
- **Físico** (antes "Ubicación" -- Jonatan: *"no se entiende, hay que
  explicarlo"*): `ETIQUETA_UBICACION` — Aún no llega / En tránsito /
  Recibido / Entregado. Solo para módulos.
- **Reparación**: por diagnosticar → en diagnóstico → diagnosticado →
  en reparación → en pruebas → listo (+ irreparable).
- **Económico** (`economicoEstado(o)`, nuevo): Sin monto / Cotizado /
  Falta cobrar / Pagado / Sin cobro (si se cerró con `cerrarSinCobro`).
- **Cierre**: Abierta / Cerrada, directo de `estaCerrada(o)`.

**Estado general** (`etiquetaEstado(o)`/`tonoEstado(o)`, reutilizan los
nombres de siempre): una frase arriba de los carriles que resume sin
reemplazarlos -- "Abierta · en diagnóstico", "Abierta · falta cobrar",
"Abierta · pagada, falta entregar" (el matiz de Naranjo: pagado pero
sin entregar tiene que decirlo, no perderse detrás de un genérico
"lista para entregar"), "Abierta · lista para cerrar", "Cerrada".

**Una sola acción principal** (`accionesPrincipales(o)`), no una lista
de botones: se destaca en negro (clase `.actual`, ya existía en el
CSS), una segunda acción (como Irreparable) queda plana al lado.
Prioridad: si la reparación ya terminó (listo/irreparable) → falta
entregar → falta cobrar → falta cerrar, en ese orden; si sigue en
proceso → el paso siguiente de reparación (+ Irreparable si aplica
según `puedeSerIrreparable`); si el módulo ni siquiera llegó al taller
→ el paso siguiente de **ubicación**, no de reparación (no se puede
diagnosticar algo que sigue con el técnico o el cliente).

**Opciones secundarias**, todas detrás de enlaces de texto, nunca
botones grandes: *Agregar observación* (usa `ordenes.notas_internas`,
columna que ya existía y no se usaba -- se le va agregando texto con
fecha y quién, no se pisa), *Ver historial* (lee `movimientos_estado`
directo, sin tabla nueva), *Cambiar estados manualmente* (los cuatro
ejes editables en un solo panel, uno debajo del otro -- ya no un
"Cambiar manualmente" repetido por carril), *Cerrar sin cobro* (solo
cuando de verdad falta cobrar), *Garantía* (solo cuando ya está
cerrada). **Cambiar estados manualmente y Cerrar sin cobro son solo de
dueño/coordinador** -- mismo criterio de permisos que ya regía el
cambio manual antes de este rediseño, no se abrió nada nuevo al técnico.

**Cerrar sin cobro**: pide motivo obligatorio (`prompt`), lo anota en
`notas_internas` con fecha y quién, y cierra con `fecha_cierre`. No hay
un valor "sin_cobro" en el enum de `comercial` -- no hacía falta un
estado nuevo, el rastro de *por qué* se cerró sin cobrar vive en la
nota, no en el carril. `economicoEstado()` igual lo refleja ("Sin
cobro") mirando `estaCerrada(o) && !pagado_en`.

**Tablero**: la tarjeta ahora muestra el estado general (la frase, no
el nombre técnico de un solo eje) y un contador **"N OT por cobrar"**
arriba de la lista (`faltaCobrar(o)`: reparación terminada + entregada
+ sin pagar). Las OT por cobrar se destacan con un borde rojo a la
izquierda de la tarjeta (`.ot.falta-cobrar`) -- sin repetir el chip,
que ya lo dice en rojo. **Nunca se esconden** por estar pendientes de
cobro: solo salen del tablero cuando `estaCerrada(o)` es de verdad
cierto (cerrada o rechazada).

**Qué no se tocó**: `resumen_rentabilidad`/`rentabilidad_ot` (siguen
leyendo `estado`, vía `estadoLegado`, sin cambios); ningún flujo de
terreno ni de laboratorio; los permisos existentes; Cotización, Agenda,
Fotos siguen siendo secciones aparte, no se mezclaron con los estados.

## Asistencia, pagos y mano de obra real (21-09-2026)

Ver `30-asistencia.sql`. Antes se pagaba de memoria y por transferencia,
sin registro; la rentabilidad mostraba un margen inflado porque la mano de
obra —el costo más grande— no estaba en el sistema. Ahora es un **costo
variable calculado desde la asistencia real**, no una estimación.

**Equipo cargado**: Luis Gonzales (terreno, $50.000/día), Jonatan Osores
(coordinación, $50.000/día), Diego Toledo (laboratorio, $40.000/día). Los
tres `por_dia`, enlazados a su cuenta por nombre. La modalidad
`semanal_fijo` existe en la base pero hoy no la usa nadie.

**Día hábil = lunes a viernes.** Sábado y domingo se pagan **igual**, sin
recargo — solo que no se esperan: no entran en el aviso de "días sin
marcar" ni en el prorrateo del semanal fijo (que va sobre 5 días).

**Decisiones que costaron bugs reales en la revisión previa (no revertir):**

- **El valor del día se congela al registrar** en `asistencia.valor_referencia`.
  Corregir el estado de un día recalcula solo el factor, siempre sobre esa
  tarifa original. Si sube `valor_dia`, los días viejos no se tocan. La
  primera versión recalculaba con la tarifa de HOY en cada update — y el
  simple hecho de amarrar los días a un pago los repactaba a todos.
- **El factor sale de la tabla, siempre**, salvo `factor_manual = true`,
  que solo pone el dueño vía RPC `ajustar_factor_jornada()` con observación
  obligatoria. Sin esa bandera era imposible corregir un día marcado: el
  factor viejo se arrastraba y disparaba el guardia de permisos.
- **`sin_carga` no es ausencia** en ningún conteo. Es decisión de la
  empresa, no del colaborador. `resumen_periodo_colaborador` lo devuelve
  aparte.
- **Un pago emitido queda congelado**: monto, días, período, bonos y
  descuentos. Y **deja de tragarse días nuevos**: un día registrado después
  queda libre y lo toma el siguiente pago. `emitido` solo avanza a `pagado`
  o `anulado`; nunca vuelve a `borrador` (el mismo COMP-XXXX respaldaría
  otro monto).
- **`asistencia.pago_id` lo escribe solo la base** (trigger del pago, con
  el setting `paz.amarrando_dias`). El cliente no puede colgar días a un
  pago ni soltarlos. Al mover el período de un borrador, primero se
  sueltan los que quedaron fuera y después se amarran los libres.
- **El correlativo `COMP-2026-0001`** lo asigna solo el trigger al emitir,
  con `pg_advisory_xact_lock` contra emisiones simultáneas, y nunca se
  reutiliza. El cliente no puede mandarlo; hay constraint de formato.
- **Emitir exige** que todos los días del período estén revisados **y**
  que no haya días hábiles sin marcar — los dos errores dicen cuáles.

**Permisos, lo más crítico.** Dueño y coordinador son ambos el rol de
Postgres `authenticated`: los grants de columna no los distinguen. Por eso
la plata se revoca para **todos**, lectura **y escritura** (`revoke all` +
`grant` columna por columna), y se abre por RPC que valida `mi_rol()`:
`colaboradores_valores()`, `asistencia_valores()`, `resumen_periodo_colaborador()`,
`resumen_mano_obra()`. El coordinador ve días y estados, marca asistencia
(hasta 7 días atrás), y **no puede leer ni escribir** `valor_dia`,
`valor_semana`, `factor_jornada`, `factor_manual`, `valor_referencia`,
`valor_aplicado`, `pago_id`, ni nada de `pagos_colaboradores` ni
`auditoria_mano_obra`. La primera versión revocó solo el SELECT y dejó la
escritura abierta.

**Auditoría** (`auditoria_mano_obra`): insert, update, delete y anular de
las tres tablas, con `usuario_id` de `auth.uid()` nunca nulo. Sin política
de insert/update/delete para nadie: entra solo por triggers `security
definer`, y un trigger `tg_no_borrar` la protege incluso del dueño.

**Toda escritura exige sesión** (`exigir_sesion()` en cada trigger). La
siembra de colaboradores va **antes** de crear los triggers de auditoría,
a propósito: corre por CLI sin sesión y no debe dejar rastro como acción
de usuario. (La primera versión apagaba el trigger alrededor de la
siembra: si fallaba a la mitad, quedaba apagado para siempre.)

**Comprobante de pago — dos documentos distintos** (criterio de Jonatan):
el de la **app** (COMP-XXXX, imprimible con `.hoja`) dice **qué** se pagó:
período, días, total. El del **banco** (pantallazo en el bucket privado
`comprobantes-pagos`) prueba **que** se pagó. `numero_transferencia` es
**opcional**: el banco de la empresa no lo entrega. Y **no se exige la
foto para marcar pagado** — invertiría el orden real (primero se paga,
después se sube) y una subida fallida perdería el registro del pago; la
lista de Pagos destaca los que quedaron sin respaldo, la base no bloquea.
Mismo criterio que los comprobantes de gastos.

**Rentabilidad**: `resumen_rentabilidad` devuelve `mano_obra`
(devengado del mes, pagado o no), `mano_obra_pagada` y
`mano_obra_pendiente`; el margen la resta. El campo manual pasó a ser
"Otros costos fijos (sin mano de obra)". `rentabilidad_ot` suma la mano
de obra de los días con `orden_id` a esa OT (`costo_total`, `hay_costos`)
— antes una OT con tres días de mecánico y sin repuestos mostraba "100%
de margen". Ambas cambiaron de firma, por eso van con `drop function` y
**al final del archivo**: si algo falla antes, producción sigue con las
de siempre.

**Pantallas**: botón **Asistencia** en la barra de la Agenda (dueño y
coordinador) → `vAsistencia`, un toque por persona. Pestaña **Pagos** en
Gastos (solo dueño) → lista; `vPago` para armar, emitir, marcar pagado,
subir pantallazo, anular; `vComprobante` imprimible.

**No construido, a propósito**: AFP/salud/liquidaciones, hora de entrada
y salida, Previred/SII. Viáticos y alimentación van en gastos.

**Pendiente**: las pruebas de punta a punta del punto 12 de la
especificación con sesión real (dueño y coordinador). La migración se
probó ejecutando dos veces en transacción revertida contra la base real, y
pasó revisión adversarial de 6 lentes (22 hallazgos, todos corregidos
antes de aplicar).

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
