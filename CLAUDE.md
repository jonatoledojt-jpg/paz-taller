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
  Postgres + Auth + Storage. Plan gratis.
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
```

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
- Una `cotizacion` por orden (no se versiona; para re-cotizar se editan los
  mismos ítems). `ordenes.monto_cotizado` se mantiene sincronizado por trigger
  desde `cotizacion_items`, no lo escribe el front.

**Dos orígenes de módulo:**

- `terreno` — se agenda visita, se escanea en sitio, se retira si no se
  resuelve, y después hay una segunda visita para instalar.
- `laboratorio` — el cliente lo trae o lo manda por encomienda.

Estados (enum `estado_orden`): agendado, en_terreno, resuelto_en_terreno,
retirado, recepcionado, en_diagnostico, cotizado, en_reparacion, en_pruebas,
listo_entrega, instalado, entregado, facturado, irreparable, rechazado, garantia.

El estado `resuelto_en_terreno` importa: es trabajo que se factura sin que
exista módulo. Si se pierde, la facturación no cuadra.

## Roles y permisos

`dueno` (Jonatan), `coordinador`, `tecnico`. RLS activo en todas las tablas.
Todos leen todo; dueño y coordinador escriben lo operativo; el técnico solo
actualiza las órdenes asignadas a él.

Cuando se agreguen pagos y asistencia, esas tablas van con RLS **restringido
solo al dueño**.

## Estado actual — qué funciona

- Login con correo y contraseña
- Tablero de OT abiertas con días en taller
- Crear OT: cliente, RUT, patente, tipo de módulo, síntoma, foto
- Cambio de estado con sugerencia del paso siguiente según el flujo
- Subir fotos y capturas de escáner a Supabase Storage
- Informe técnico con el formato de la empresa, imprimible a PDF
- Cotización con líneas de ítems (descripción, cantidad, valor unitario),
  IVA calculado al vuelo; al guardar avanza el estado a `cotizado` si
  corresponde
- Cotización formal imprimible (mismo tratamiento visual que el informe
  técnico), con número de cotización, tabla de ítems y fecha de validez
  (`validez_dias`, 15 por defecto)

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

## Lo que viene, en orden

1. ~~**Cotizaciones** con líneas de detalle~~ — hecho: tablas `cotizaciones` y
   `cotizacion_items`, pantalla en el front. Falta ejecutar `04-cotizaciones.sql`
   en Supabase.
2. **Agenda de terreno y rutas** — la tabla `visitas` existe pero no tiene
   pantalla.
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
