-- ============================================================
-- PAZ — modo asistido y alertas en vivo
--
-- Dos cosas:
--   1. Que dueño/coordinador puedan dictarle a PAZ qué decirle al
--      cliente, en vez de escribirle ellos mismos por WhatsApp.
--   2. Que la app avise cuando un caso necesita una decisión
--      humana, sin tener que estar refrescando la pantalla.
--
-- Ejecutar después de 16. Es re-ejecutable.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Historial de respuestas asistidas.
--    Queda todo: la instrucción interna, quién la escribió, el
--    mensaje que PAZ redactó, y si al final se mandó o no.
-- ------------------------------------------------------------

create table if not exists paz_respuestas_asistidas (
  id                bigint generated always as identity primary key,
  caso_id           bigint not null references casos on delete cascade,
  conversacion_id   bigint not null references nexa_conversaciones on delete cascade,
  instruccion_interna text not null,
  mensaje_generado  text not null,
  mensaje_enviado   text,
  enviado           boolean not null default false,
  wa_message_id     text,
  error              text,
  creado_por        uuid references perfiles,
  rol_creador       text,
  creado_en         timestamptz not null default now(),
  enviado_en        timestamptz
);

create index if not exists paz_resp_asist_caso_idx on paz_respuestas_asistidas (caso_id);

alter table paz_respuestas_asistidas enable row level security;

drop policy if exists leer_paz_resp_asist on paz_respuestas_asistidas;
create policy leer_paz_resp_asist on paz_respuestas_asistidas for select to authenticated
  using (mi_rol() in ('dueno','coordinador'));

-- Solo la Edge Function escribe acá (con service_role, que se salta RLS).
-- No hay política de insert/update para authenticated a propósito: el
-- historial no se toca desde la app, solo se lee.


-- ------------------------------------------------------------
-- 2. Marcar en la conversación qué mensajes los mandó una persona
--    a través de PAZ, para diferenciarlos de los que PAZ mandó sola.
-- ------------------------------------------------------------

alter table nexa_mensajes add column if not exists humano_asistido boolean not null default false;
alter table nexa_mensajes add column if not exists escrito_por     uuid references perfiles;


-- ------------------------------------------------------------
-- 3. Tiempo real: que la app avise sola cuando un caso pasa a
--    "requiere respuesta humana", sin que nadie tenga que
--    refrescar. replica identity full para que el evento de
--    UPDATE traiga el valor anterior y la app pueda distinguir
--    "ya estaba en true" de "recién pasó a true".
-- ------------------------------------------------------------

alter table casos replica identity full;

do $$ begin
  alter publication supabase_realtime add table casos;
exception when duplicate_object then null; end $$;


-- Comprobación
-- select numero_caso, requiere_respuesta_humana, motivo_alerta from casos where requiere_respuesta_humana;
-- select caso_id, instruccion_interna, enviado, creado_en from paz_respuestas_asistidas order by creado_en desc;
