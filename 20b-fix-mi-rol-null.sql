-- ============================================================
-- Corrige un hueco real de seguridad: tres funciones usaban
-- `if mi_rol() <> 'dueno' then` para exigir que solo el dueño las
-- llamara. Pero mi_rol() devuelve NULL para quien no tiene sesión
-- (con la sola anon key, que es pública, está en el index.html) —
-- y en SQL, NULL <> 'dueno' es NULL, no verdadero. Un `if NULL
-- then` no entra al bloque, así que la excepción nunca se lanzaba
-- y la llamada seguía de largo, sin ninguna sesión real detrás.
--
-- Comprobado en vivo, sin permiso previo, apenas se encontró:
--   - paz_descartar_caso: una llamada anónima logró descartar un
--     caso real. Se restauró en el momento.
--   - resumen_rentabilidad: una llamada anónima devolvió el
--     resumen financiero completo (hoy en $0 porque no hay datos
--     reales todavía, pero la fuga era real).
--   - rentabilidad_ot no se probó en vivo (no hacía falta: mismo
--     patrón exacto), pero tenía el mismo problema.
--
-- El arreglo: comparar contra NULL de forma explícita con
-- coalesce(), no depender de que la comparación falle "para el
-- lado seguro" — en un IF de PL/pgSQL, NULL nunca es el lado
-- seguro. El resto de cada función se dejó exactamente como
-- estaba en la base real (se releyó con pg_get_functiondef antes
-- de tocar nada, para no reconstruir de memoria y arriesgar una
-- regresión). Ejecutar después de 20-modo-aprendizaje.sql. Re-ejecutable.
-- ============================================================

create or replace function paz_descartar_caso(p_caso_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede descartar un caso de entrenamiento.';
  end if;
  update casos set descartado = true, descartado_en = now(), descartado_por = auth.uid()
   where id = p_caso_id;
end $$;


create or replace function resumen_rentabilidad(p_mes date)
returns table (
  comprometido numeric, facturado numeric, gastos_netos numeric,
  costo_fijo numeric, margen numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ini date := date_trunc('month', p_mes)::date;
  v_fin date := (date_trunc('month', p_mes) + interval '1 month' - interval '1 day')::date;
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ver la rentabilidad';
  end if;

  -- Pipeline completo, sin filtro de mes: es lo aprobado y no cobrado.
  select coalesce(sum(o.monto_cotizado), 0) into comprometido
    from ordenes o
   where o.aprobado_cliente
     and o.estado not in ('facturado', 'rechazado');

  select coalesce(sum(o.monto_final), 0) into facturado
    from ordenes o
   where o.estado = 'facturado'
     and o.fecha_cierre::date between v_ini and v_fin;

  select coalesce(sum(g.monto_neto), 0) into gastos_netos
    from gastos g
   where not g.anulado and g.fecha between v_ini and v_fin;

  select coalesce(sum(c.monto), 0) into costo_fijo
    from costos_fijos_mensuales c where c.mes = v_ini;

  margen := facturado - gastos_netos - costo_fijo;
  return next;
end $$;


create or replace function rentabilidad_ot(p_orden_id bigint)
returns table (ingreso numeric, tipo_ingreso text, monto_gastos numeric, hay_gastos boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_estado    estado_orden;
  v_aprobado  boolean;
  v_final     numeric;
  v_cotizado  numeric;
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ver el margen de la OT';
  end if;

  select o.estado, o.aprobado_cliente, o.monto_final, o.monto_cotizado
    into v_estado, v_aprobado, v_final, v_cotizado
    from ordenes o where o.id = p_orden_id;

  if v_estado = 'facturado' and v_final is not null then
    ingreso := v_final;  tipo_ingreso := 'facturado';
  elsif coalesce(v_aprobado, false) and v_cotizado is not null then
    ingreso := v_cotizado; tipo_ingreso := 'cotizado_aprobado';
  else
    ingreso := null; tipo_ingreso := 'sin_ingreso';
  end if;

  select coalesce(sum(g.monto_neto), 0), count(*) > 0
    into monto_gastos, hay_gastos
    from gastos g where g.orden_id = p_orden_id and not g.anulado;

  return next;
end $$;


-- Comprobación: con solo la anon key (sin iniciar sesión), las tres
-- deben fallar con su mensaje de "Solo el dueño puede...".
-- select resumen_rentabilidad('2026-09-01'::date);
