-- ============================================================
-- PAZ Services — PAZ por WhatsApp
-- Conecta las conversaciones de WhatsApp a las mismas tablas
-- que ya usa la pantalla de PAZ dentro de la app.
-- Ejecutar después de 12-nexa.sql. Es re-ejecutable.
--
-- Recordatorio: las tablas se llaman nexa_* por historia.
-- La asistente se llama PAZ. Ver CLAUDE.md.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De qué teléfono viene la conversación.
--    En la app no hace falta (la abre una persona), pero por
--    WhatsApp es lo único que identifica al cliente antes de
--    que diga su nombre.
-- ------------------------------------------------------------

alter table nexa_conversaciones add column if not exists telefono text;

-- Una sola conversación abierta por teléfono. Si el cliente vuelve
-- a escribir después de que se cerró el caso, se abre uno nuevo.
create unique index if not exists nexa_conv_wa_abierta_idx
  on nexa_conversaciones (telefono)
  where canal = 'whatsapp' and cerrada = false;


-- ------------------------------------------------------------
-- 2. Identificador del mensaje en WhatsApp.
--    Meta reintenta el mismo mensaje si no le respondemos rápido.
--    Sin esto, un reintento se guardaría dos veces y PAZ
--    contestaría dos veces al cliente.
-- ------------------------------------------------------------

alter table nexa_mensajes add column if not exists wa_id text;

create unique index if not exists nexa_mensajes_wa_id_idx
  on nexa_mensajes (wa_id) where wa_id is not null;


-- ------------------------------------------------------------
-- 3. Interruptor: ¿PAZ contesta sola por WhatsApp?
--    Arranca APAGADO a propósito. Mientras esté apagado, los
--    mensajes del cliente se guardan y aparecen en la app, pero
--    PAZ no responde nada. Así se puede leer qué habría dicho
--    antes de soltarla con clientes de verdad.
-- ------------------------------------------------------------

alter table nexa_config
  add column if not exists responde_whatsapp boolean not null default false;


-- ------------------------------------------------------------
-- 4. Permisos de lectura para la app.
--    Las políticas de 12-nexa.sql ya cubren estas tablas
--    (dueño y coordinador). Las columnas nuevas no cambian eso.
-- ------------------------------------------------------------

-- Comprobación
-- select id, modelo, activa, responde_whatsapp, length(prompt) from nexa_config;
-- select id, canal, telefono, titulo, orden_id, cerrada
--   from nexa_conversaciones order by creado_en desc limit 10;
