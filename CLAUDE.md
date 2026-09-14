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
- **PWA:** `manifest.webmanifest` + `sw.js`, se instala en el celular.

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
04-cotizaciones.sql     tablas cotizaciones y cotizacion_items (falta ejecutar)
05-fix-rls.sql          endurece mi_rol() y agrega mi_sesion() de diagnóstico
06-cotizacion-validez.sql  columna validez_dias en cotizaciones (falta ejecutar)
07-cotizacion-multiple.sql  permite varias cotizaciones por orden (falta ejecutar)
08-terreno.sql          tipo_trabajo/sistema, montos y cotizaciones ocultos al técnico
09-agenda.sql           agenda de terreno: esquema + RPC + permisos (falta ejecutar)
```

`08-terreno.sql` también agregó `ordenes.observaciones`, que en teoría venía de
`03-informes.sql` pero nunca se había aplicado en la base real (solo la
política de `movimientos_estado` de ese archivo se corrió aparte). Sin esa
columna, guardar el informe técnico fallaba. Ya está al día.

Los `.sql` son historial de migraciones. No se suben a GitHub Pages pero
conviene mantenerlos versionados.

## Modelo de datos

Tablas: `perfiles`, `clientes`, `vehiculos`, `ordenes`, `movimientos_estado`,
`visitas`, `visita_ordenes`, `diagnosticos`, `archivos`, `cotizaciones`,
`cotizacion_items`.

**Decisiones de diseño que hay que respetar:**

- La tabla se llama `ordenes`, no `modulos`. **Cada fila es un trabajo**, no un
  objeto físico. Un mismo módulo puede tener varias órdenes a lo largo del tiempo.
- `visitas` y `ordenes` están separadas. Una visita a terreno puede retirar
  varios módulos de un mismo cliente de flota, o resolver el problema en sitio
  sin retirar nada. Se unen por `visita_ordenes`.
- Correlativo `OT-2026-0001` generado por trigger, reinicia cada año.
- Todo cambio de estado se registra solo en `movimientos_estado` (trigger).
- `numero_serie` existe en el esquema pero **no se usa**: identifican los
  módulos con sellos de seguridad.
- Una orden puede tener **varias** `cotizacion` (para cuando el cliente pide
  una segunda opción para el mismo módulo). Todas quedan guardadas, se puede
  editar o eliminar cualquiera desde la app. `ordenes.monto_cotizado` se
  mantiene sincronizado por trigger desde `cotizacion_items` con la que se
  haya editado/guardado más recientemente — no lo escribe el front.

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
- Por si un técnico intenta escribir un monto en una orden que sí puede
  editar (la suya): el trigger `proteger_montos_tecnico` revierte el valor,
  pase lo que pase en la solicitud.

Cuando se agreguen pagos y asistencia, esas tablas van con RLS **restringido
solo al dueño**.

## Navegación en tres secciones

Barra fija abajo, siempre visible dentro de la app (no se esconde nada, es
navegación, no permiso):

- **Terreno** — servicios en terreno (todo `tipo_trabajo = servicio`) y la
  parte de terreno de un retiro de módulo (agendado, en_terreno,
  resuelto_en_terreno, retirado, instalado). Foco del mecánico.
- **Módulos** — todo lo demás con `tipo_trabajo = modulo`: desde que se
  recepciona (venga de terreno o de laboratorio) hasta que se entrega.
  Foco del técnico de laboratorio.
- **Agenda** — vista semanal de `visitas` (lunes a sábado), crear/editar,
  ruta del día. Foco del coordinador.

Cada rol abre por defecto en una sección (`coordinador` → Agenda, el resto →
Terreno) pero puede navegar a las otras — el mecánico que retira un módulo
necesita ver en qué va en Módulos. La función `seccionDe(orden)` en
`index.html` decide en cuál aparece cada orden.

**Caso especial:** cuando un `tecnico` abre la pestaña Terreno, no ve la
lista de OT — ve "Mis visitas de hoy" (sus `visitas` del día, ordenadas por
`orden_ruta`). Es su pantalla de inicio real. Dueño y coordinador siguen
viendo la lista de OT de terreno en esa misma pestaña.

## Agenda de terreno

Construida completa sobre `visitas` y `visita_ordenes` (existían desde
01-schema.sql sin pantalla). Ver `09-agenda.sql`.

**Modelo:**
- `tipo_visita` ahora incluye `servicio` (antes: diagnostico, retiro,
  instalacion, mixta), para visitas de reparación en terreno sin módulo.
- `visitas.fecha_original`: se llena **una sola vez**, en la primera
  reprogramación — no se pisa en reprogramaciones siguientes. No hay
  historial completo de reprogramaciones, a propósito (fuera de alcance).
- `visitas.duracion_estimada_min`, `visitas.motivo_reprogramacion`: nuevas.
- **Nadie borra visitas, ni el dueño.** No hay política de `delete` en la
  tabla — cancelar (`estado = 'cancelada'`) es la única salida, y queda en
  el historial. No hay botón de eliminar en ninguna pantalla tampoco.

**Permisos — por qué hay tres funciones en vez de políticas RLS solas:**
RLS filtra filas, no columnas. Para que el técnico pueda cambiar el estado
de SU visita sin poder tocar el cliente, la fecha o el técnico asignado,
no bastaba con una política — hicieron falta funciones `security definer`
que escriben solo lo que corresponde:

- `actualizar_visita_tecnico(p_visita_id, p_estado, p_km_inicio,
  p_km_termino, p_observaciones)` — el técnico **no tiene `update` directo
  sobre `visitas` en absoluto** (no existe ninguna política que se lo
  permita). Este RPC es su único camino de escritura: verifica que
  `auth.uid()` sea el `tecnico_id` de esa visita, solo toca esos cuatro
  campos, y solo acepta `p_estado` en `en_ruta` o `realizada` — cualquier
  otro valor lo rechaza.
- `reprogramar_visita(p_visita_id, p_fecha_nueva, p_motivo)` y
  `cancelar_visita(p_visita_id, p_motivo)` — dueño/coordinador. Son
  funciones (no un `update` libre desde el front) para que la regla de
  "`fecha_original` se llena una sola vez" viva en un solo lugar en la
  base, no repetida en el JS.

**Dos huecos que `09-agenda.sql` tuvo que cerrar para que "crear OT desde
la visita" funcionara** (ver el archivo para el detalle):
- `visita_ordenes` solo aceptaba `insert` de dueño/coordinador; se agregó
  una política para que el técnico pueda ligar una OT nueva a su propia
  visita.
- `ordenes` solo aceptaba `insert` de dueño/coordinador — el técnico **no
  podía crear ninguna OT nueva**, ni siquiera antes de este módulo. No es
  un bug de la agenda, es algo que ya estaba así y que recién se hizo
  visible porque ahora hay una pantalla que lo necesita.

**Relación visita ↔ OT:** una visita puede tener 0, 1 o varias OT
(`visita_ordenes`, con `accion`: diagnostico/retiro/instalacion/servicio).
Desde la visita se crea una OT nueva (cliente precargado) o se ve la lista
de las ya ligadas; desde la OT se ve a qué visitas está ligada. Al marcar
una visita como `realizada`, si tiene OT asociadas, la app **ofrece**
actualizar el estado de esas OT — nunca lo hace sola.

**Qué no se construyó a propósito (pedido explícito):** optimización de
rutas o distancias, notificaciones/recordatorios, sincronización con
Google Calendar, vista de mes/calendario gráfico, historial múltiple de
reprogramaciones. La ruta del día se reordena con botones subir/bajar, no
arrastrando (con guantes, en el celular, no sirve).

## Estado actual — qué funciona

- Login con correo y contraseña
- Navegación en tres secciones (Terreno / Módulos / Agenda) con barra inferior
- Crear OT: primero se elige tipo de trabajo (módulo o reparación en terreno),
  después cliente, RUT, patente, módulo/sistema según corresponda, síntoma, foto
- Cambio de estado, con el flujo correcto según origen + tipo de trabajo
- Subir fotos y capturas de escáner a Supabase Storage
- Informe técnico con el formato de la empresa, imprimible a PDF (oculta el
  valor del servicio si lo abre un técnico)
- Cotización con líneas de ítems (descripción, cantidad, valor unitario),
  IVA calculado al vuelo; al guardar avanza el estado a `cotizado` si
  corresponde. Se pueden guardar varias por orden, editar o eliminar
  cualquiera. Solo dueño y coordinador la ven — el técnico ni siquiera tiene
  el botón
- Cotización formal imprimible (mismo tratamiento visual que el informe
  técnico), con número de cotización, tabla de ítems y fecha de validez
  (`validez_dias`, 15 por defecto)
- Agenda de terreno: vista semanal con contadores y aviso de visitas sin
  técnico, crear/editar visita (precarga dirección/ciudad del cliente),
  ruta del día reordenable, crear OT desde una visita, reprogramar/cancelar,
  y la pantalla del técnico ("Mis visitas de hoy") con su RPC de escritura
  acotada a estado/km/observaciones

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
   `cotizacion_items`, pantalla en el front. Falta ejecutar `04-cotizaciones.sql`
   en Supabase.
2. ~~**Agenda de terreno y rutas**~~ — hecho: vista semanal, crear/editar
   visita, ruta del día, vinculación con OT. Falta ejecutar `09-agenda.sql`
   en Supabase.
3. **Gastos, asistencia y pagos** de colaboradores, visibles solo para el dueño.
4. **Nexa** — agente de IA que lee el grupo de WhatsApp del equipo y crea las
   OT solo. Ver más abajo.
5. **Códigos GS** — app separada y offline que se alimenta de la vista
   `v_conocimiento`.

## Nexa (el plan grande)

Un agente que lee el grupo de WhatsApp del equipo y registra las OT
automáticamente, para que nadie tenga que llenar formularios. Es lo que va a
resolver el problema de adopción de raíz.

Restricciones técnicas ya verificadas: la Groups API de WhatsApp existe desde
2026, máximo 8 participantes, requiere Official Business Account en Cloud API
y **un número nuevo dedicado**. El grupo lo tiene que crear la API; no se puede
conectar uno existente. No admite botones ni listas interactivas, solo texto y
media.

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
