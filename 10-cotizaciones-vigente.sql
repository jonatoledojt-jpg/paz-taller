-- ============================================================
-- PAZ SERVICES — Cotización vigente
-- Una OT puede tener varias cotizaciones. Manda la última
-- guardada que no esté anulada: esa es la "vigente", y es la
-- que alimenta ordenes.monto_cotizado.
-- Ejecutar después de 04-cotizaciones.sql (y del resto, el
-- orden respecto a 07/08/09 no importa).
-- Es re-ejecutable: se puede correr dos veces sin romperse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Anular en vez de borrar.
--    No se borra historial: una cotización anulada queda, deja
--    de ser vigente y se muestra como tal.
--    No se usa un campo "es_vigente" a propósito: la vigente se
--    calcula (última no anulada) y así no hay dos fuentes de
--    verdad que se puedan contradecir.
-- ------------------------------------------------------------

alter table cotizaciones add column if not exists anulada boolean not null default false;
alter table cotizaciones add column if not exists fecha_anulacion timestamptz;

create index if not exists cotizaciones_vigente_idx
  on cotizaciones (orden_id, creado_en desc) where not anulada;


-- ------------------------------------------------------------
-- 2. Una sola función decide el monto de la orden.
--    ordenes.monto_cotizado guarda el NETO (sin IVA) — es el
--    criterio que ya traía el proyecto desde 04-cotizaciones.sql
--    y no se cambia acá.
--    Si no queda ninguna cotización válida, vuelve a null.
-- ------------------------------------------------------------

create or replace function recalcular_monto_cotizado(p_orden_id bigint)
returns void
language plpgsql
as $$
declare
  v_cotizacion_id bigint;
  v_neto          numeric;
begin
  if p_orden_id is null then return; end if;

  select id into v_cotizacion_id
    from cotizaciones
   where orden_id = p_orden_id and not anulada
   order by creado_en desc, id desc
   limit 1;

  if v_cotizacion_id is null then
    update ordenes set monto_cotizado = null where id = p_orden_id;
    return;
  end if;

  select coalesce(sum(cantidad * valor_unitario), 0) into v_neto
    from cotizacion_items where cotizacion_id = v_cotizacion_id;

  update ordenes set monto_cotizado = v_neto where id = p_orden_id;
end $$;


-- ------------------------------------------------------------
-- 3. Reemplaza a sincronizar_monto_cotizado (04-cotizaciones.sql),
--    que copiaba el monto de la ÚLTIMA cotización editada — con
--    varias cotizaciones por orden eso quedaba mal: editar una
--    vieja pisaba el monto de la vigente.
-- ------------------------------------------------------------

drop trigger if exists trg_sincronizar_monto_cotizado on cotizacion_items;
drop function if exists sincronizar_monto_cotizado();

create or replace function tg_items_monto_cotizado()
returns trigger
language plpgsql
as $$
declare
  v_orden_id bigint;
begin
  select orden_id into v_orden_id
    from cotizaciones where id = coalesce(new.cotizacion_id, old.cotizacion_id);
  perform recalcular_monto_cotizado(v_orden_id);
  return coalesce(new, old);
end $$;

drop trigger if exists trg_items_monto_cotizado on cotizacion_items;
create trigger trg_items_monto_cotizado
  after insert or update or delete on cotizacion_items
  for each row execute function tg_items_monto_cotizado();

-- Y cuando se anula, se crea o se borra una cotización entera.
create or replace function tg_cotizacion_monto_cotizado()
returns trigger
language plpgsql
as $$
begin
  perform recalcular_monto_cotizado(coalesce(new.orden_id, old.orden_id));
  return coalesce(new, old);
end $$;

drop trigger if exists trg_cotizacion_monto_cotizado on cotizaciones;
create trigger trg_cotizacion_monto_cotizado
  after insert or update or delete on cotizaciones
  for each row execute function tg_cotizacion_monto_cotizado();


-- ------------------------------------------------------------
-- 4. Poner al día lo que ya existe, con el criterio nuevo.
-- ------------------------------------------------------------

do $$
declare r record;
begin
  for r in select distinct orden_id from cotizaciones loop
    perform recalcular_monto_cotizado(r.orden_id);
  end loop;
end $$;


-- Comprobación
-- select o.numero_ot, o.monto_cotizado,
--        c.id as cotizacion_vigente, c.creado_en
--   from ordenes o
--   left join lateral (
--     select id, creado_en from cotizaciones
--      where orden_id = o.id and not anulada
--      order by creado_en desc, id desc limit 1
--   ) c on true
--  where o.monto_cotizado is not null or c.id is not null;
