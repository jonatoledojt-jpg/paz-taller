-- ============================================================
-- PAZ SERVICES — Nexa (agente de IA)
-- Primera etapa: Nexa cara al cliente, conectada a la base.
-- Ejecutar después de 01 a 11.
-- Es re-ejecutable: se puede correr dos veces sin romperse.
--
-- OJO: este archivo NO contiene el prompt de Nexa. El prompt vive
-- en la tabla nexa_config y se carga aparte, porque tiene precios
-- y reglas comerciales y el repo de la app es público.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Configuración de Nexa: una sola fila.
--    El prompt es un documento del negocio, no código: se edita
--    acá sin republicar la app.
-- ------------------------------------------------------------

create table if not exists nexa_config (
  id              int primary key default 1,
  prompt          text not null default '',
  modelo          text not null default 'gpt-5.5',
  activa          boolean not null default true,
  actualizado_en  timestamptz not null default now(),
  constraint nexa_config_una_fila check (id = 1)
);

insert into nexa_config (id, prompt) values (1, '')
on conflict (id) do nothing;


-- ------------------------------------------------------------
-- 2. Conversaciones y mensajes.
--    ficha: lo que Nexa fue entendiendo del caso (cliente,
--    patente, síntoma...). Es jsonb para no tener que migrar la
--    tabla cada vez que cambie qué datos pide.
--    orden_id queda null hasta que alguien confirma crear la OT:
--    Nexa propone, la persona decide.
-- ------------------------------------------------------------

create table if not exists nexa_conversaciones (
  id              bigint generated always as identity primary key,
  canal           text not null default 'app',
  cliente_id      bigint references clientes on delete set null,
  orden_id        bigint references ordenes on delete set null,
  titulo          text,
  ficha           jsonb not null default '{}'::jsonb,
  cerrada         boolean not null default false,
  creado_por      uuid references perfiles,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

create table if not exists nexa_mensajes (
  id               bigint generated always as identity primary key,
  conversacion_id  bigint not null references nexa_conversaciones on delete cascade,
  rol              text not null check (rol in ('user', 'assistant')),
  contenido        text not null,
  creado_en        timestamptz not null default now()
);

create index if not exists nexa_mensajes_conv_idx on nexa_mensajes (conversacion_id, creado_en);
create index if not exists nexa_conv_fecha_idx    on nexa_conversaciones (creado_en desc);
create index if not exists nexa_conv_orden_idx    on nexa_conversaciones (orden_id);


create or replace function tg_nexa_tocar_conversacion()
returns trigger
language plpgsql
as $$
begin
  update nexa_conversaciones
     set actualizado_en = now()
   where id = coalesce(new.conversacion_id, old.conversacion_id);
  return coalesce(new, old);
end $$;

drop trigger if exists trg_nexa_tocar_conversacion on nexa_mensajes;
create trigger trg_nexa_tocar_conversacion
  after insert on nexa_mensajes
  for each row execute function tg_nexa_tocar_conversacion();


-- ------------------------------------------------------------
-- 3. RLS — Nexa atiende clientes, así que es cosa de dueño y
--    coordinador. El técnico no entra acá: son conversaciones
--    comerciales, con precios de por medio.
--    El prompt lo lee solo el dueño (tiene la lista de precios);
--    la Edge Function lo lee con service_role, que se salta RLS.
-- ------------------------------------------------------------

alter table nexa_config          enable row level security;
alter table nexa_conversaciones  enable row level security;
alter table nexa_mensajes        enable row level security;

drop policy if exists esc_nexa_config on nexa_config;
create policy esc_nexa_config on nexa_config for all to authenticated
  using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');

drop policy if exists leer_nexa_conv on nexa_conversaciones;
create policy leer_nexa_conv on nexa_conversaciones for select to authenticated
  using (mi_rol() in ('dueno', 'coordinador'));

drop policy if exists esc_nexa_conv on nexa_conversaciones;
create policy esc_nexa_conv on nexa_conversaciones for all to authenticated
  using (mi_rol() in ('dueno', 'coordinador'))
  with check (mi_rol() in ('dueno', 'coordinador'));

drop policy if exists leer_nexa_msj on nexa_mensajes;
create policy leer_nexa_msj on nexa_mensajes for select to authenticated
  using (mi_rol() in ('dueno', 'coordinador'));

drop policy if exists esc_nexa_msj on nexa_mensajes;
create policy esc_nexa_msj on nexa_mensajes for all to authenticated
  using (mi_rol() in ('dueno', 'coordinador'))
  with check (mi_rol() in ('dueno', 'coordinador'));


-- Comprobación
-- select id, length(prompt) as largo_prompt, modelo, activa from nexa_config;
-- select c.id, c.titulo, c.orden_id, count(m.id) as mensajes
--   from nexa_conversaciones c left join nexa_mensajes m on m.conversacion_id = c.id
--  group by c.id order by c.creado_en desc;
