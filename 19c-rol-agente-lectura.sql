-- ============================================================
-- PAZ — permisos de LECTURA para el rol agente
--
-- Las escrituras de PAZ van solo por las RPC de 19b-rol-agente-rpc.sql.
-- Pero para armar el contexto de cada respuesta (qué ya se dijo,
-- qué casos hay, quién confirmó qué) necesita LEER sus propias
-- tablas de trabajo. Sin esto tendría que seguir usando la llave
-- maestra para leer, que era justo lo que se quería evitar.
--
-- Nunca se agrega 'agente' a gastos, costos_fijos_mensuales,
-- cotizaciones ni cotizacion_items — eso sigue vedado, tal como
-- pedía el plan original.
--
-- Ejecutar después de 19b-rol-agente-rpc.sql. Re-ejecutable.
-- ============================================================

drop policy if exists leer_nexa_conv on nexa_conversaciones;
create policy leer_nexa_conv on nexa_conversaciones for select to authenticated
  using (mi_rol() in ('dueno','coordinador','agente'));

drop policy if exists leer_nexa_msj on nexa_mensajes;
create policy leer_nexa_msj on nexa_mensajes for select to authenticated
  using (mi_rol() in ('dueno','coordinador','agente'));

drop policy if exists leer_nexa_archivos on nexa_archivos;
create policy leer_nexa_archivos on nexa_archivos for select to authenticated
  using (mi_rol() in ('dueno','coordinador','agente'));

drop policy if exists leer_casos on casos;
create policy leer_casos on casos for select to authenticated
  using (mi_rol() in ('dueno','coordinador','agente'));

-- Para la etiqueta "confirmado por ..." en el historial que arma PAZ:
-- necesita leer quién escribió una respuesta asistida, nunca escribir ahí.
drop policy if exists leer_paz_resp_asist on paz_respuestas_asistidas;
create policy leer_paz_resp_asist on paz_respuestas_asistidas for select to authenticated
  using (mi_rol() in ('dueno','coordinador','agente'));

-- Comprobación
-- select tablename, policyname, qual from pg_policies
--  where schemaname='public' and qual ilike '%agente%' order by tablename;
