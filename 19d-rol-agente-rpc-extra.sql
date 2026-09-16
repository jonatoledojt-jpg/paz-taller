-- ============================================================
-- PAZ — tres RPC más, para los remates que hace sincronizarCasos
-- después de recorrer los casos: vincular fotos que llegaron antes
-- de que el caso existiera, copiar la ubicación de la conversación,
-- y guardar el resumen de compatibilidad en nexa_conversaciones.
--
-- Ejecutar después de 19c-rol-agente-lectura.sql. Re-ejecutable.
-- ============================================================

create or replace function paz_finalizar_sincronizacion(
  p_conversacion_id bigint, p_caso_id bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform paz_verificar_agente();
  if p_caso_id is null then return; end if;

  -- Fotos que llegaron antes de que el caso existiera quedan sueltas
  -- (caso_id null): se vinculan al caso que se está conversando ahora.
  update nexa_archivos set caso_id = p_caso_id
   where conversacion_id = p_conversacion_id and caso_id is null;

  if exists (select 1 from nexa_archivos where caso_id = p_caso_id) then
    update casos set tiene_fotos = true where id = p_caso_id;
  end if;

  update casos set ubicacion_gps = c.ubicacion_gps
    from nexa_conversaciones c
   where casos.id = p_caso_id and c.id = p_conversacion_id
     and c.ubicacion_gps is not null and casos.ubicacion_gps is null;
end $$;

comment on function paz_finalizar_sincronizacion(bigint, bigint) is
  'PAZ: después de sincronizar los casos de una conversación, vincula fotos sueltas y copia la ubicación al caso activo.';


create or replace function paz_actualizar_ficha_conversacion(
  p_conversacion_id bigint, p_ficha jsonb, p_titulo text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform paz_verificar_agente();
  update nexa_conversaciones set ficha = coalesce(p_ficha, '{}'::jsonb), titulo = p_titulo
   where id = p_conversacion_id;
end $$;

comment on function paz_actualizar_ficha_conversacion(bigint, jsonb, text) is
  'PAZ: guarda el resumen de compatibilidad para la pantalla de ficha única (antes de que existieran los casos).';


revoke execute on function paz_finalizar_sincronizacion(bigint, bigint) from public;
revoke execute on function paz_actualizar_ficha_conversacion(bigint, jsonb, text) from public;
grant execute on function paz_finalizar_sincronizacion(bigint, bigint) to authenticated;
grant execute on function paz_actualizar_ficha_conversacion(bigint, jsonb, text) to authenticated;
