-- ============================================================
-- PAZ SERVICES — Novena parte
-- Agenda de terreno: esquema + permisos.
-- Ejecutar después de 01 a 08 (en particular necesita mi_rol()
-- de 01-schema.sql y las tablas visitas/visita_ordenes de 01).
-- Es re-ejecutable: se puede correr dos veces sin romperse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nuevo tipo de visita: servicio en terreno (sin retirar
--    módulo). ADD VALUE IF NOT EXISTS es nativo desde PG12 y no
--    falla si 'servicio' ya existe.
-- ------------------------------------------------------------

alter type tipo_visita add value if not exists 'servicio';


-- ------------------------------------------------------------
-- 2. Columnas nuevas en visitas.
--    fecha_original: se llena UNA sola vez, en la primera
--    reprogramación (ver el UPDATE de reprogramar_visita más
--    abajo) — no se pisa en reprogramaciones siguientes.
-- ------------------------------------------------------------

alter table visitas add column if not exists motivo_reprogramacion text;
alter table visitas add column if not exists fecha_original date;
alter table visitas add column if not exists duracion_estimada_min int;

create index if not exists visitas_tecnico_fecha_idx on visitas (tecnico_id, fecha_programada);


-- ------------------------------------------------------------
-- 3. RLS no filtra columnas, solo filas — por eso el técnico no
--    tiene UPDATE directo sobre visitas en absoluto (ninguna
--    política se lo permite). Su único camino de escritura es
--    esta función, que toca nada más que estado/km/observaciones
--    y solo en la visita que tiene asignada.
-- ------------------------------------------------------------

create or replace function actualizar_visita_tecnico(
  p_visita_id bigint,
  p_estado estado_visita default null,
  p_km_inicio int default null,
  p_km_termino int default null,
  p_observaciones text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tecnico_id uuid;
begin
  select tecnico_id into v_tecnico_id from visitas where id = p_visita_id;

  if v_tecnico_id is null then
    raise exception 'Visita % no existe', p_visita_id;
  end if;

  if v_tecnico_id is distinct from auth.uid() then
    raise exception 'Esta visita no está asignada a ti';
  end if;

  if p_estado is not null and p_estado not in ('en_ruta', 'realizada') then
    raise exception 'No puedes cambiar la visita a ese estado';
  end if;

  update visitas set
    estado        = coalesce(p_estado, estado),
    km_inicio     = coalesce(p_km_inicio, km_inicio),
    km_termino    = coalesce(p_km_termino, km_termino),
    observaciones = coalesce(p_observaciones, observaciones)
  where id = p_visita_id;
end $$;

grant execute on function actualizar_visita_tecnico(bigint, estado_visita, int, int, text) to authenticated;


-- ------------------------------------------------------------
-- 4. Reprogramar y cancelar: dueño/coordinador solamente.
--    Funciones en vez de UPDATE directo desde el front para
--    que la regla de fecha_original (solo se llena una vez)
--    viva en un solo lugar, no repetida en el JS.
-- ------------------------------------------------------------

create or replace function reprogramar_visita(
  p_visita_id bigint,
  p_fecha_nueva date,
  p_motivo text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if mi_rol() not in ('dueno', 'coordinador') then
    raise exception 'Solo dueño o coordinador pueden reprogramar';
  end if;

  update visitas set
    fecha_original = coalesce(fecha_original, fecha_programada),
    fecha_programada = p_fecha_nueva,
    motivo_reprogramacion = p_motivo,
    estado = 'reprogramada'
  where id = p_visita_id;
end $$;

grant execute on function reprogramar_visita(bigint, date, text) to authenticated;

create or replace function cancelar_visita(
  p_visita_id bigint,
  p_motivo text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if mi_rol() not in ('dueno', 'coordinador') then
    raise exception 'Solo dueño o coordinador pueden cancelar';
  end if;

  update visitas set
    estado = 'cancelada',
    motivo_reprogramacion = p_motivo
  where id = p_visita_id;
end $$;

grant execute on function cancelar_visita(bigint, text) to authenticated;


-- ------------------------------------------------------------
-- 5. Políticas de visitas: se reemplaza esc_visitas (de
--    01-schema.sql) por dos políticas separadas, sin DELETE.
--    Nadie borra visitas desde la app, ni el dueño — cancelar
--    es un estado, no un delete. Al no existir política de
--    DELETE, RLS lo bloquea para todos los roles.
-- ------------------------------------------------------------

drop policy if exists esc_visitas on visitas;

create policy crear_visitas on visitas for insert to authenticated
  with check (mi_rol() in ('dueno','coordinador'));

create policy editar_visitas on visitas for update to authenticated
  using (mi_rol() in ('dueno','coordinador'))
  with check (mi_rol() in ('dueno','coordinador'));


-- ------------------------------------------------------------
-- 6. Dos huecos que este módulo deja al descubierto y hay que
--    cerrar para que funcione "crear OT desde la visita":
--
--    a) visita_ordenes solo tenía esc_visita_ordenes (dueño/
--       coordinador). El técnico necesita poder asociar una OT
--       nueva a SU visita.
--
--    b) ordenes solo tenía esc_ordenes (dueño/coordinador) para
--       insert. El técnico no podía crear ninguna OT nueva —
--       esto ya era así antes de este archivo, no es nuevo, pero
--       recién ahora hay una pantalla (crear OT desde la visita)
--       que lo necesita para funcionar.
-- ------------------------------------------------------------

drop policy if exists tecnico_crea_visita_orden on visita_ordenes;
create policy tecnico_crea_visita_orden on visita_ordenes for insert to authenticated
  with check (exists (
    select 1 from visitas v where v.id = visita_id and v.tecnico_id = auth.uid()
  ));

drop policy if exists tecnico_crea_orden on ordenes;
create policy tecnico_crea_orden on ordenes for insert to authenticated
  with check (mi_rol() = 'tecnico');


-- Comprobación
-- select id, tipo, estado, fecha_programada, fecha_original, tecnico_id
--   from visitas order by fecha_programada desc limit 10;
-- select routine_name from information_schema.routines
--   where routine_name in ('actualizar_visita_tecnico','reprogramar_visita','cancelar_visita');
