-- Bug real: OT-2026-0018 (Pablo Tapia) tenía 2 cotizaciones no anuladas por
-- trabajos distintos ($300.000 + $150.000) pero monto_cotizado solo contaba
-- $150.000 -- recalcular_monto_cotizado sumaba los ítems de una sola
-- cotización (la "vigente": la última no anulada), pensado para renegociar
-- (reemplazar), no para el caso real y más común de una segunda cotización
-- por trabajo adicional descubierto después en la misma OT.
--
-- Confirmado con Jonatan: de ahora en adelante TODAS las cotizaciones no
-- anuladas de una OT se suman a monto_cotizado. Para renegociar (reemplazar
-- una cotización por otra) se sigue usando "Usar como base" -- ahora anula
-- automáticamente la base al guardar la nueva (ver guardarCotizacion() en
-- index.html), que es el único caso real donde no se quiere sumar.
create or replace function public.recalcular_monto_cotizado(p_orden_id bigint)
 returns void
 language plpgsql
as $function$
declare
  v_existe boolean;
  v_neto   numeric;
begin
  if p_orden_id is null then return; end if;

  select exists(
    select 1 from cotizaciones where orden_id = p_orden_id and not anulada
  ) into v_existe;

  if not v_existe then
    update ordenes set monto_cotizado = null where id = p_orden_id;
    return;
  end if;

  select coalesce(sum(ci.cantidad * ci.valor_unitario), 0) into v_neto
    from cotizacion_items ci
    join cotizaciones c on c.id = ci.cotizacion_id
   where c.orden_id = p_orden_id and not c.anulada;

  update ordenes set monto_cotizado = v_neto where id = p_orden_id;
end $function$;

-- Recalcula ahora mismo todas las OT abiertas (o con cotización) para que
-- Pablo Tapia y cualquier otro caso igual queden corregidos sin tocar cada
-- fila a mano -- el trigger ya haría esto solo, pero recién en el próximo
-- insert/update/anulación de cada OT.
do $$
declare
  r record;
begin
  for r in select distinct orden_id from cotizaciones loop
    perform recalcular_monto_cotizado(r.orden_id);
  end loop;
end $$;
