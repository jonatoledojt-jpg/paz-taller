-- ============================================================
-- PAZ SERVICES — Agenda simple (reemplaza el enfoque de 09-agenda.sql)
-- La agenda es una CAPA sobre ordenes, no una entidad aparte.
-- Agendar = crear/editar una OT con fecha planificada.
-- Ejecutar después de 01 a 08. El orden respecto a 09-agenda.sql no
-- importa — este archivo no toca visitas ni visita_ordenes para nada,
-- solo agrega columnas a ordenes.
-- Es re-ejecutable: se puede correr dos veces sin romperse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Franja horaria — sin hora exacta, sin duración estimada.
--    Los trayectos son largos y variables; una hora fija crea un
--    compromiso falso con el cliente.
-- ------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_type where typname = 'franja_agenda') then
    create type franja_agenda as enum ('manana', 'tarde', 'todo_el_dia');
  end if;
end $$;


-- ------------------------------------------------------------
-- 2. Columnas de agenda en ordenes.
--    orden_ruta YA EXISTE en visitas (tabla distinta, sin relación).
--    Este es un orden_ruta nuevo, propio de ordenes.
-- ------------------------------------------------------------

alter table ordenes add column if not exists fecha_agendada date;
alter table ordenes add column if not exists franja franja_agenda;
alter table ordenes add column if not exists ubicacion_gps text;
alter table ordenes add column if not exists tecnico_agendado uuid references perfiles;
alter table ordenes add column if not exists orden_ruta int;

create index if not exists ordenes_fecha_agendada_idx on ordenes (fecha_agendada);
create index if not exists ordenes_tecnico_agendado_idx on ordenes (tecnico_agendado, fecha_agendada);


-- ------------------------------------------------------------
-- 3. 08-terreno.sql revocó el select de TODA la tabla ordenes
--    para "authenticated" y volvió a otorgar columna por columna
--    (ver esa migración). Toda columna nueva necesita este mismo
--    grant explícito o nadie —ni dueño ni coordinador— la puede
--    leer desde el front.
-- ------------------------------------------------------------

grant select (fecha_agendada, franja, ubicacion_gps, tecnico_agendado, orden_ruta)
  on ordenes to authenticated;


-- ------------------------------------------------------------
-- 4. El técnico no edita agenda, ni cliente, ni origen — "no
--    depender solo de ocultar botones si hay una restricción de
--    permisos real". RLS filtra filas, no columnas: por eso este
--    trigger (que ya existía protegiendo los montos, ver
--    08-terreno.sql) se reemplaza por una versión que protege
--    también estos campos. Si el técnico logra pasar la política
--    de fila (por ejemplo porque la orden es suya), estos valores
--    igual quedan como estaban, pase lo que pase en la solicitud.
--    Se renombra porque ya protege más que montos.
-- ------------------------------------------------------------

drop trigger if exists trg_proteger_montos_tecnico on ordenes;
drop function if exists proteger_montos_tecnico();

create or replace function proteger_campos_tecnico()
returns trigger
language plpgsql
as $$
begin
  if mi_rol() = 'tecnico' then
    new.monto_cotizado    := old.monto_cotizado;
    new.monto_final       := old.monto_final;
    new.cliente_id        := old.cliente_id;
    new.origen            := old.origen;
    new.fecha_agendada    := old.fecha_agendada;
    new.franja            := old.franja;
    new.ubicacion_gps     := old.ubicacion_gps;
    new.tecnico_agendado  := old.tecnico_agendado;
    new.orden_ruta        := old.orden_ruta;
  end if;
  return new;
end $$;

drop trigger if exists trg_proteger_campos_tecnico on ordenes;
create trigger trg_proteger_campos_tecnico
  before update on ordenes
  for each row execute function proteger_campos_tecnico();


-- ------------------------------------------------------------
-- 5. visitas / visita_ordenes quedan DEPRECADAS, no se tocan ni
--    se borran (podrían servir a futuro para agrupar varias OT
--    en una sola salida a terreno). Sin cambios acá.
-- ------------------------------------------------------------


-- Comprobación
-- select numero_ot, origen, fecha_agendada, franja, ubicacion_gps,
--        tecnico_agendado, orden_ruta
--   from ordenes where fecha_agendada is not null order by fecha_agendada;
