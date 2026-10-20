-- 45-paz-equipo-chat.sql — memoria del asistente del equipo (20-10-2026)
--
-- paz-asistente (la PAZ que responde consultas del equipo por WhatsApp)
-- necesita acordarse del hilo: sin esto, cuando el jefe decía "sí, revísalo"
-- PAZ ya no sabía a qué se refería (cada mensaje lo trataba de cero).
-- Acá se guarda la conversación del equipo, aparte de las de clientes
-- (nexa_mensajes) para no mezclar. La función lee el hilo reciente y escribe
-- cada par pregunta/respuesta.

create table if not exists paz_equipo_chat (
  id         bigint generated always as identity primary key,
  telefono   text not null,                 -- número del miembro (paz_equipo.telefono)
  rol        text not null check (rol in ('user','assistant')),
  contenido  text not null,
  creado_en  timestamptz not null default now()
);

create index if not exists ix_paz_equipo_chat_tel on paz_equipo_chat(telefono, creado_en);

alter table paz_equipo_chat enable row level security;

-- Lectura: dueño (auditar) y el rol agente. La escritura la hace solo la
-- Edge Function con service_role (que se salta RLS); no hay política de
-- insert para nadie más a propósito.
drop policy if exists leer_paz_equipo_chat on paz_equipo_chat;
create policy leer_paz_equipo_chat on paz_equipo_chat for select
  using (mi_rol() in ('dueno','agente'));
