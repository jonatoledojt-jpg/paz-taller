-- ============================================================
-- El técnico ahora puede crear OT nuevas (recepcionar un módulo
-- en el laboratorio, por ejemplo) — antes solo podía actualizar
-- una orden que ya estuviera asignada a él, y el INSERT en
-- `clientes` fallaba por RLS apenas intentaba guardar (probado en
-- vivo por Diego Toledo, rol técnico, 16-09-2026).
--
-- Decisión: se mantiene todo lo demás igual. El técnico sigue sin
-- ver montos, sin poder editar cotizaciones, sin tocar agenda de
-- una orden ajena — solo se abre la puerta de "crear", no la de
-- "ver o mover dinero". Ejecutar después de 20b-fix-mi-rol-null.sql.
-- Re-ejecutable.
-- ============================================================

-- 1. Insertar cliente y vehículo nuevos, solo eso (nada de
--    update/delete: esc_clientes/esc_vehiculos siguen exigiendo
--    dueño o coordinador para lo demás).
drop policy if exists tecnico_crea_cliente on clientes;
create policy tecnico_crea_cliente on clientes for insert to authenticated
  with check (mi_rol() = 'tecnico');

drop policy if exists tecnico_crea_vehiculo on vehiculos;
create policy tecnico_crea_vehiculo on vehiculos for insert to authenticated
  with check (mi_rol() = 'tecnico');

-- 2. Insertar la OT. La política de update ya existente
--    (tecnico_actualiza_orden) sigue exigiendo asignado_a =
--    auth.uid(), así que sin el punto 3 el técnico crearía una OT
--    y después no podría volver a tocarla.
drop policy if exists tecnico_crea_orden on ordenes;
create policy tecnico_crea_orden on ordenes for insert to authenticated
  with check (mi_rol() = 'tecnico');

-- 3. proteger_campos_tecnico protegía estos campos comparando
--    contra OLD, que no existe en un INSERT — sin este cambio, un
--    INSERT de técnico habría pasado montos y agenda sin filtro
--    ninguno. Ahora distingue INSERT de UPDATE:
--    - INSERT: puede fijar cliente y origen (así funciona crear la
--      OT), pero montos y agenda nacen en null — eso lo agenda
--      dueño o coordinador después. Y queda asignada a quien la
--      creó, para que la pueda seguir moviendo de estado.
--    - UPDATE: sin cambios, sigue revirtiendo todo a lo que estaba.
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

drop trigger if exists trg_proteger_campos_tecnico on ordenes;
create trigger trg_proteger_campos_tecnico
  before insert or update on ordenes
  for each row execute function proteger_campos_tecnico();


-- Comprobación (con una sesión de técnico real):
-- insert into clientes (nombre, rut) values ('Prueba', '11.111.111-1');
-- insert into ordenes (cliente_id, origen, tipo_trabajo, ...) values (...);
-- select asignado_a, monto_cotizado, fecha_agendada from ordenes where numero_ot = '...';
--   -> asignado_a = el técnico que la creó, el resto en null.
