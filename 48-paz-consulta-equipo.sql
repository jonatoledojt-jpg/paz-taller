-- 48-paz-consulta-equipo.sql — cuando PAZ dice "lo consulto con el equipo",
-- el equipo recibe de VERDAD la pregunta (20-10-2026)
--
-- El bug: PAZ (cara al cliente) dice "lo consulto con el equipo y te confirmo",
-- pero eso era solo texto para el cliente — nada disparaba la pregunta al
-- equipo. Y como la alerta del caso solo se levanta cuando CAMBIA el motivo,
-- una pregunta NUEVA dentro de un caso ya avisado (ej: el cliente ya pidió el
-- presupuesto, y después pregunta "¿la reparación es allá o hay que llevar el
-- módulo?") se quedaba sin avisar: el motivo seguía siendo "espera presupuesto"
-- y el sistema creía que ya estaba avisado. Resultado: PAZ prometía consultar y
-- no le preguntaba a nadie.
--
-- Esta RPC la llama la función whatsapp cuando detecta que PAZ se comprometió a
-- consultar al equipo: re-arma el caso con la pregunta real del cliente como
-- motivo y lo deja listo para que procesarAlertas lo mande YA. Si el sistema
-- está en vivo, de paso lo promueve a producción (si no, no podría avisar).

create or replace function paz_consulta_equipo(p_conversacion_id bigint, p_motivo text)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id bigint; v_live boolean;
begin
  perform paz_verificar_agente();   -- solo el agente PAZ
  v_live := coalesce((select modo_casos_defecto from nexa_config limit 1), 'aprendizaje') = 'produccion';

  -- el caso activo de esta conversación (el que se está conversando)
  select id into v_id from casos
   where conversacion_id = p_conversacion_id and archivado = false
   order by actualizado_en desc limit 1;
  if v_id is null then return null; end if;

  update casos
     set requiere_respuesta_humana = true,
         motivo_alerta = left(coalesce(p_motivo, 'El cliente hizo una consulta que PAZ no puede responder.'), 300),
         notificado_motivo = null, notificado_equipo_en = null,
         escala_area = null, escala_en = null,
         modo = case when v_live then 'produccion' else modo end
   where id = v_id;
  return v_id;
end $$;
