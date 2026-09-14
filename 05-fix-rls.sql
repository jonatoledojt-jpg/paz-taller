-- ============================================================
-- PAZ SERVICES — Quinta parte
-- Endurecer mi_rol() + reafirmar TODAS las políticas de escritura
-- + función de diagnóstico para ver la sesión real del navegador.
-- Ejecutar después de 01, 02, 03 y 04.
-- Es idempotente: se puede correr más de una vez sin problema.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Reafirmar mi_rol(): security definer, search_path fijo
--    (incluyendo pg_temp, por buena práctica) y permiso
--    explícito de ejecución. Si ya estaba bien, esto no cambia
--    nada; si algo quedó mal tras una edición manual, lo repara.
-- ------------------------------------------------------------

create or replace function mi_rol()
returns rol_usuario
language sql stable security definer
set search_path = public, pg_temp
as $$ select rol from perfiles where id = auth.uid() $$;

grant execute on function mi_rol() to authenticated, anon;


-- ------------------------------------------------------------
-- 2. Función de diagnóstico.
--
--    OJO: en el SQL Editor de Supabase esto es inútil, porque ahí
--    corres como "postgres" y auth.uid() siempre da null (no hay
--    sesión de usuario). Hay que llamarla DESDE LA APP, logueado
--    como Jonatan, en la consola del navegador:
--
--        await db.rpc('mi_sesion')
--
--    Eso te dice, con la sesión real, si el uid existe en
--    perfiles y qué rol le está leyendo mi_rol().
-- ------------------------------------------------------------

create or replace function mi_sesion()
returns table (uid uuid, rol_jwt text, existe_perfil boolean, mi_rol rol_usuario)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid(), auth.role(),
         exists(select 1 from perfiles where id = auth.uid()),
         mi_rol()
$$;

grant execute on function mi_sesion() to authenticated;


-- ------------------------------------------------------------
-- 3. Reafirmar TODAS las políticas de escritura, tabla por
--    tabla (drop + create, para que este archivo sea la fuente
--    de verdad y se pueda re-ejecutar sin miedo a "ya existe").
--    Incluye la de movimientos_estado que ya habías agregado en
--    03-informes.sql, para que este archivo quede autosuficiente.
-- ------------------------------------------------------------

drop policy if exists esc_clientes on clientes;
create policy esc_clientes on clientes for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

drop policy if exists esc_vehiculos on vehiculos;
create policy esc_vehiculos on vehiculos for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

drop policy if exists esc_visitas on visitas;
create policy esc_visitas on visitas for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

drop policy if exists esc_ordenes on ordenes;
create policy esc_ordenes on ordenes for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

drop policy if exists tecnico_actualiza_orden on ordenes;
create policy tecnico_actualiza_orden on ordenes for update to authenticated
  using (asignado_a = auth.uid()) with check (asignado_a = auth.uid());

drop policy if exists esc_diagnosticos on diagnosticos;
create policy esc_diagnosticos on diagnosticos for all to authenticated
  using (true) with check (true);

drop policy if exists esc_archivos on archivos;
create policy esc_archivos on archivos for all to authenticated
  using (true) with check (true);

drop policy if exists esc_visita_ordenes on visita_ordenes;
create policy esc_visita_ordenes on visita_ordenes for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

drop policy if exists esc_perfiles on perfiles;
create policy esc_perfiles on perfiles for all to authenticated
  using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');

drop policy if exists escribir_movimientos on movimientos_estado;
create policy escribir_movimientos on movimientos_estado for insert to authenticated
  with check (true);

drop policy if exists esc_cotizaciones on cotizaciones;
create policy esc_cotizaciones on cotizaciones for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

drop policy if exists esc_cotizacion_items on cotizacion_items;
create policy esc_cotizacion_items on cotizacion_items for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));


-- ------------------------------------------------------------
-- 4. Verificación rápida (correr como postgres en el SQL
--    Editor — ahí SÍ ve todas las filas, sin RLS de por medio).
-- ------------------------------------------------------------

-- ¿Qué rol tiene realmente cada perfil?
-- select id, nombre, rol from perfiles;

-- ¿El id de Jonatan en auth.users es el mismo que en perfiles?
-- select id, email from auth.users where email = 'jonatoledo.jt@gmail.com';

-- Si el id no calza o el rol no es 'dueno', corrige así
-- (reemplaza el id por el que salió en la consulta de arriba):
-- update perfiles set rol = 'dueno' where id = 'PEGA-AQUI-EL-UUID';
