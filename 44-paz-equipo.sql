-- 44-paz-equipo.sql — PAZ le habla al equipo por WhatsApp (20-10-2026)
--
-- Jonatan diseñó que PAZ avise al equipo por WhatsApp (en vez de push):
-- cuando necesita asistencia de un humano, le manda un mensaje al que le
-- toca (módulos->Diego, precio/factura/personal->jefe, agenda->Osores).
-- Para poder escribirles "primero" sin pagar plantillas de Meta, los tres
-- trabajan con la ventana de 24h: PAZ los saluda cada mañana y mantiene la
-- ventana viva; ellos responden para renovarla. Ver CLAUDE.md.
--
-- Esta tabla registra a los miembros del equipo que PAZ reconoce (NO son
-- clientes) y a quién le toca cada tipo de alerta. Los números personales
-- son sensibles: RLS solo dueño (y el rol agente, que los necesita para
-- reconocerlos y rutear).

create table if not exists paz_equipo (
  id            bigint generated always as identity primary key,
  telefono      text not null unique,          -- formato wa: 569XXXXXXXX
  nombre        text not null,
  area          text not null,                 -- 'dueno' | 'laboratorio' | 'coordinacion'
  saludo        text not null,                 -- saludo matutino personalizado
  activo        boolean not null default true,
  -- control de la ventana de 24h (lo escribe la Edge Function):
  ultimo_inbound_en  timestamptz,              -- último mensaje de ESTA persona a PAZ (renueva ventana)
  ultimo_saludo_en   timestamptz,              -- último saludo matutino que PAZ le mandó
  ultimo_nudge_en    timestamptz,              -- último recordatorio "responde para mantener la ventana"
  creado_en     timestamptz not null default now()
);

comment on table paz_equipo is
  'Miembros del equipo que PAZ reconoce por WhatsApp (no clientes) y ruteo de alertas. 44-paz-equipo.sql';

-- qué alertas recibe cada área (ruteo). Derivable del area, se documenta acá:
--   dueno        -> precio, factura, personal, y catch-all de lo que no calce
--   laboratorio  -> módulos / recepción / banco
--   coordinacion -> agenda / visitas a terreno

alter table paz_equipo enable row level security;

drop policy if exists leer_paz_equipo on paz_equipo;
create policy leer_paz_equipo on paz_equipo for select
  using (mi_rol() in ('dueno','agente'));

drop policy if exists escribir_paz_equipo on paz_equipo;
create policy escribir_paz_equipo on paz_equipo for all
  using (mi_rol() = 'dueno')
  with check (mi_rol() = 'dueno');

-- Dedup del reenvío de alertas al equipo: PAZ avisa una vez por cada
-- motivo nuevo (no repite el mismo aviso). Mismo criterio que la alerta
-- in-app: se levanta por motivo, no en cada mensaje. La función paz-equipo
-- avisa cuando notificado_motivo es distinto del motivo_alerta actual.
alter table casos add column if not exists notificado_equipo_en timestamptz;
alter table casos add column if not exists notificado_motivo     text;

-- Cadena de escalada (quién tiene el caso ahora y desde cuándo). Si no lo
-- toma en su plazo, pasa al siguiente: módulo Diego(5m)->Osores(15m)->jefe;
-- visita Osores(5m)->jefe; factura jefe(5m)->Osores. Ver paz-equipo.
alter table casos add column if not exists escala_area text;
alter table casos add column if not exists escala_en   timestamptz;

-- Si el nombre de columna ya existía en una corrida previa, estos alter no
-- hacen nada (if not exists). Lo mismo con ultimo_nudge_en de paz_equipo,
-- cubierto por el create table de arriba salvo que la tabla ya existiera:
alter table paz_equipo add column if not exists ultimo_nudge_en timestamptz;

-- Semilla: los tres del equipo (Jonatan=dueno, Diego=laboratorio,
-- Osores=coordinacion) se cargan APARTE con un insert directo, NO en este
-- archivo -- el repo es público y los números personales son sensibles
-- (mismo criterio que nexa_config.prompt, que tampoco va al repo).
-- Estructura del insert (los números reales se aplican fuera del repo):
--   insert into paz_equipo (telefono, nombre, area, saludo) values
--     ('569........', 'Nombre', 'dueno|laboratorio|coordinacion', 'saludo')
--   on conflict (telefono) do update set
--     nombre=excluded.nombre, area=excluded.area,
--     saludo=excluded.saludo, activo=true;
