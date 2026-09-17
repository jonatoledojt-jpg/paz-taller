-- ============================================================
-- resumen_rentabilidad contaba "facturado del mes" filtrando por
-- fecha_cierre::date -- válido mientras fecha_cierre se escribía sola,
-- en el mismo instante que pagado_en. Desde el rediseño de carriles
-- (17-09-2026), cerrar es un paso explícito y posterior ("Cerrar OT"),
-- así que fecha_cierre ya no representa "cuándo entró la plata": puede
-- quedar null por días, o pasar a otro mes que el del cobro real.
--
-- Encontrado en vivo: al limpiar un fecha_cierre viejo en la OT de
-- Naranjo (dato suelto de antes del rediseño, no reflejaba una entrega
-- real), el monto desapareció de la rentabilidad del mes -- aunque el
-- dinero sí había entrado. La fecha correcta para esto siempre fue
-- pagado_en, que existe desde 25-cuatro-ejes-estado.sql y es
-- exactamente "cuándo entró la plata".
-- ============================================================

create or replace function resumen_rentabilidad(p_mes date)
returns table(comprometido numeric, facturado numeric, gastos_netos numeric, costo_fijo numeric, margen numeric)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
     and o.pagado_en::date between v_ini and v_fin;

  select coalesce(sum(g.monto_neto), 0) into gastos_netos
    from gastos g
   where not g.anulado and g.fecha between v_ini and v_fin;

  select coalesce(sum(c.monto), 0) into costo_fijo
    from costos_fijos_mensuales c where c.mes = v_ini;

  margen := facturado - gastos_netos - costo_fijo;
  return next;
end $function$;
