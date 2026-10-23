-- 52-paz-etiqueta-mensaje.sql
-- ETIQUETAR/CITAR un mensaje de PAZ (decisión de Jonatan, 23-10-2026).
--
-- Cuando el equipo le responde a PAZ CITANDO (reply/etiqueta) uno de sus
-- mensajes —ej: cita el aviso "👋 Estás atendiendo a un cliente (WZ9047)" y
-- escribe "¿qué quiere ese cliente?"— WhatsApp manda la referencia del mensaje
-- citado (su id). Hasta hoy no se leía, así que PAZ no sabía A CUÁL mensaje
-- apuntaba el jefe y tiraba varios "a mano". Para resolverlo, PAZ tiene que
-- poder reconocer sus propios mensajes por ese id: acá se lo guardamos.
--
-- paz_equipo_chat es la memoria de la conversación de PAZ con el equipo (sus
-- avisos y respuestas). Le agregamos el wa_id del mensaje: así, cuando el
-- equipo cita uno, se busca por ese id y se le pasa a PAZ el texto citado para
-- que sepa de qué cliente/tema le hablan.

alter table paz_equipo_chat
  add column if not exists wa_id text;

create index if not exists idx_paz_equipo_chat_wa_id
  on paz_equipo_chat (wa_id) where wa_id is not null;

comment on column paz_equipo_chat.wa_id is
  'id del mensaje en WhatsApp (ver 52): deja reconocer un mensaje de PAZ cuando el equipo lo ETIQUETA/cita, para resolver a qué cliente/tema apunta la orden.';
