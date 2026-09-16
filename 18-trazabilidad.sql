-- ============================================================
-- PAZ — trazabilidad dura del modo asistido
--
-- Lo que pedía Jonatan: que quede quién dio la instrucción, y que
-- PAZ no pueda decir "confirmado por el equipo" si esa instrucción
-- no existe de verdad.
--
-- Antes, el vínculo entre "este mensaje lo mandó una persona" y
-- "acá está la instrucción que lo originó" era solo una convención
-- del código: dos inserts separados en la misma función, sin nada
-- que los atara. Esto lo vuelve estructural: nexa_mensajes.
-- respuesta_asistida_id es una llave foránea real hacia el
-- registro de auditoría. Sin esa fila, la etiqueta no puede existir.
--
-- Ejecutar después de 17. Es re-ejecutable.
-- ============================================================

alter table paz_respuestas_asistidas add column if not exists nombre_creador text;

alter table nexa_mensajes
  add column if not exists respuesta_asistida_id bigint references paz_respuestas_asistidas on delete set null;

create index if not exists nexa_mensajes_resp_asist_idx on nexa_mensajes (respuesta_asistida_id);

-- Comprobación
-- select m.contenido, m.humano_asistido, m.respuesta_asistida_id,
--        r.nombre_creador, r.rol_creador, r.instruccion_interna, r.creado_en
--   from nexa_mensajes m join paz_respuestas_asistidas r on r.id = m.respuesta_asistida_id
--  order by m.creado_en desc;
