-- ============================================================
-- PAZ SERVICES — Octava parte
-- Trabajos de servicio en terreno (reparación en el camión sin
-- retirar módulo) + protección real de montos y cotizaciones
-- para el rol técnico.
-- Ejecutar después de 01 a 07.
-- ============================================================

-- ------------------------------------------------------------
-- 1. tipo_trabajo: separa QUÉ se hace de DÓNDE ocurre (origen).
--    modulo      -> hay un módulo físico de por medio (retiro o
--                   llegada al laboratorio)
--    servicio    -> reparación directa sobre el camión, sin
--                   retirar nada (línea cortada, aceite en el
--                   sistema neumático, etc.). Siempre es terreno.
-- ------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_type where typname = 'tipo_trabajo_orden') then
    create type tipo_trabajo_orden as enum ('modulo', 'servicio');
  end if;
end $$;

alter table ordenes add column if not exists tipo_trabajo tipo_trabajo_orden not null default 'modulo';

-- Sistema afectado (solo para tipo_trabajo = servicio), campo
-- libre igual que tipo_modulo: se alimenta solo con el uso.
alter table ordenes add column if not exists sistema text;

create index if not exists ordenes_tipo_trabajo_idx on ordenes (tipo_trabajo);

alter table ordenes drop constraint if exists chk_tipo_trabajo_campos;
alter table ordenes add constraint chk_tipo_trabajo_campos
  check (tipo_trabajo = 'modulo' or tipo_modulo is null);


-- ------------------------------------------------------------
-- 2. Cotizaciones: antes cualquier autenticado las podía LEER
--    (solo la escritura estaba restringida). Ahora tampoco las
--    lee el técnico.
-- ------------------------------------------------------------

drop policy if exists leer_cotizaciones on cotizaciones;
create policy leer_cotizaciones on cotizaciones for select to authenticated
  using (mi_rol() in ('dueno','coordinador'));

drop policy if exists leer_cotizacion_items on cotizacion_items;
create policy leer_cotizacion_items on cotizacion_items for select to authenticated
  using (mi_rol() in ('dueno','coordinador'));


-- ------------------------------------------------------------
-- 2b. observaciones (03-informes.sql) nunca se aplicó del todo
--     en la base real — solo la política de movimientos_estado
--     se había corrido por separado. Sin esta columna, guardar
--     el informe técnico fallaba. Se agrega acá para que este
--     archivo deje la base al día.
-- ------------------------------------------------------------

alter table ordenes add column if not exists observaciones text;


-- ------------------------------------------------------------
-- 3. Montos en ordenes (monto_cotizado, monto_final): están en
--    la misma tabla que cliente/patente/estado, que el técnico
--    sí necesita leer — por eso no se puede resolver solo con
--    una política de fila. Se revoca el acceso a esas dos
--    columnas para TODOS y se abre un único camino de lectura:
--    la función de abajo, que decide según el rol de quien
--    pregunta. Así no importa qué columnas pida el cliente ni
--    si alguien cambia la pantalla — la base corta el paso igual.
--
--    OJO — nota para el futuro: Supabase le da SELECT de tabla
--    completa a "authenticated" por defecto en cada tabla nueva,
--    y ese permiso de tabla le gana a un revoke de columna (no
--    se resta). Por eso acá se revoca el SELECT de TODA la tabla
--    y se vuelve a otorgar columna por columna, explícitamente,
--    salvo las dos de montos. Si el día de mañana se agrega una
--    columna nueva a "ordenes", hay que sumarla a este GRANT o
--    el técnico no la va a poder leer.
-- ------------------------------------------------------------

revoke select on ordenes from authenticated;
grant select (
  id, numero_ot, origen, estado, cliente_id, vehiculo_id, tipo_modulo,
  numero_serie, numero_parte, sintoma_cliente, codigos_reportados,
  forma_llegada, numero_guia, recibido_por, kilometraje, aprobado_cliente,
  fecha_aprobacion, numero_factura, orden_padre_id, fecha_ingreso,
  fecha_compromiso, fecha_cierre, asignado_a, notas_internas, creado_por,
  creado_en, actualizado_en, tipo_trabajo, sistema, observaciones
) on ordenes to authenticated;

create or replace function ordenes_montos(p_orden_id bigint)
returns table (monto_cotizado numeric, monto_final numeric)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select
    case when mi_rol() in ('dueno','coordinador') then o.monto_cotizado else null end,
    case when mi_rol() in ('dueno','coordinador') then o.monto_final else null end
  from ordenes o where o.id = p_orden_id
$$;

grant execute on function ordenes_montos(bigint) to authenticated;

-- Por si algún técnico intenta escribir un monto en una orden
-- que sí puede editar (la suya): el trigger deja el valor como
-- estaba, pase lo que pase en la solicitud.
create or replace function proteger_montos_tecnico()
returns trigger
language plpgsql
as $$
begin
  if mi_rol() = 'tecnico' then
    new.monto_cotizado := old.monto_cotizado;
    new.monto_final := old.monto_final;
  end if;
  return new;
end $$;

drop trigger if exists trg_proteger_montos_tecnico on ordenes;
create trigger trg_proteger_montos_tecnico
  before update on ordenes
  for each row execute function proteger_montos_tecnico();


-- Comprobación
-- select numero_ot, tipo_trabajo, sistema, tipo_modulo, origen, estado
--   from ordenes order by id desc limit 10;
