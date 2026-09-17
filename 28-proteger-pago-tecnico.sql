-- ============================================================
-- El técnico tampoco debería poder marcar una OT como pagada
-- (17-09-2026). Encontrado documentando los cuatro ejes nuevos:
-- proteger_campos_tecnico ya protegía monto_cotizado/monto_final
-- de un UPDATE de técnico (revertía a OLD), pero pagado_en, comercial
-- y numero_factura -- el mismo tipo de hecho financiero/comercial --
-- no estaban en esa lista. Un técnico con una OT asignada podía, en
-- teoría, escribir pagado_en directo vía API y hacer que la OT se
-- viera pagada sin haber pasado por Facturar (que sí protege
-- monto_final). ubicacion y reparacion se dejan fuera a propósito:
-- son equivalentes a mover `estado`, que el técnico siempre pudo
-- cambiar -- es su trabajo del día a día.
-- ============================================================

create or replace function proteger_campos_tecnico()
returns trigger
language plpgsql
as $$
begin
  if mi_rol() = 'tecnico' then
    if TG_OP = 'UPDATE' then
      new.monto_cotizado    := old.monto_cotizado;
      new.monto_final       := old.monto_final;
      new.cliente_id        := old.cliente_id;
      new.origen            := old.origen;
      new.fecha_agendada    := old.fecha_agendada;
      new.franja            := old.franja;
      new.ubicacion_gps     := old.ubicacion_gps;
      new.tecnico_agendado  := old.tecnico_agendado;
      new.orden_ruta        := old.orden_ruta;
      new.pagado_en         := old.pagado_en;
      new.comercial         := old.comercial;
      new.numero_factura    := old.numero_factura;
    elsif TG_OP = 'INSERT' then
      new.monto_cotizado    := null;
      new.monto_final       := null;
      new.fecha_agendada    := null;
      new.franja            := null;
      new.ubicacion_gps     := null;
      new.tecnico_agendado  := null;
      new.orden_ruta        := null;
      new.asignado_a        := auth.uid();
    end if;
  end if;
  return new;
end $$;
