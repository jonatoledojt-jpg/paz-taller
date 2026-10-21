-- 47-paz-auto-promover.sql — un caso viejo vuelve a producción solo (20-10-2026)
--
-- El bug: cuando PAZ estaba en modo escucha/entrenamiento, los casos nacían en
-- modo='aprendizaje', y ese modo se CONGELA al nacer (nunca cambia solo). Al
-- soltar a PAZ a producción, solo los casos NUEVOS nacen en producción; los de
-- clientes que ya habían escrito antes quedan pegados en aprendizaje. Resultado:
-- si ese cliente vuelve a escribir hoy, su caso es invisible para el aviso al
-- equipo (procesarAlertas solo mira 'produccion') y la promesa "lo consulto con
-- el equipo" queda en el aire.
--
-- El arreglo correcto (NO pasar todos a producción a lo bruto, eso llenó la app
-- de pendientes viejos): promover el caso a producción SOLO cuando el cliente
-- vuelve a escribir, y SOLO si el sistema ya está en vivo. Así la lista de
-- pendientes muestra únicamente clientes que están hablando de verdad.
--
-- La llama la función whatsapp con la sesión del agente, apenas llega un mensaje
-- del cliente. Si el sistema sigue en entrenamiento (modo_casos_defecto distinto
-- de 'produccion'), no hace nada: respeta el modo entrenamiento.

create or replace function paz_promover_conversacion(p_conversacion_id bigint)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare n integer;
begin
  perform paz_verificar_agente();   -- solo el agente PAZ
  if coalesce((select modo_casos_defecto from nexa_config limit 1), 'aprendizaje') <> 'produccion' then
    return 0;   -- el sistema NO está en vivo: no promover (modo entrenamiento)
  end if;
  update casos set modo = 'produccion'
   where conversacion_id = p_conversacion_id and modo = 'aprendizaje';
  get diagnostics n = row_count;
  return n;
end $$;
