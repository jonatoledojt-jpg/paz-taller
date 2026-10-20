-- 46-paz-equipo-fixes.sql — arreglos de la auditoría del 20-10-2026
--
-- Dos cosas que la auditoría adversarial encontró en los avisos al equipo:
--
-- 1) AVISOS DUPLICADOS. La alerta inmediata (la dispara `whatsapp` apenas se
--    levanta un caso) y el cron de rondas pueden caer en la misma ventana de
--    ~1-2s, leer el caso como "no avisado" los dos, y mandarle al equipo el
--    MISMO aviso dos veces. El arreglo es un "claim" atómico: la condición
--    `notificado_motivo is distinct from p_motivo` va DENTRO del UPDATE, así
--    solo UNO de los dos procesos gana el derecho a avisar. El que gana manda
--    el WhatsApp; si el envío falla, suelta el claim para reintentar.
--    Lo mismo para el salto de escalada (por si dos ticks del cron se solapan).
--
-- 2) PRIMER MENSAJE PERDIDO. Cuando Meta junta 2+ mensajes de un número NUEVO
--    en el primer webhook, dos `paz_abrir_conversacion` corren en paralelo,
--    ambos no encuentran conversación, ambos insertan → uno choca con el
--    unique y, como el error se relanzaba, ese mensaje se perdía. Ahora el
--    choque se captura y se reusa la conversación que ganó.

-- --- 1) claim atómico de alertas ------------------------------------------

-- Gana el aviso solo si nadie más ya avisó este mismo motivo. Devuelve el id
-- del caso si ESTE proceso ganó el derecho, o nada si otro se adelantó.
-- escala_area queda con el área que DE VERDAD recibe el aviso (p_area), no la
-- ruteada — así la cadena de escalada sabe quién lo tiene.
create or replace function paz_claim_alerta(p_id bigint, p_motivo text, p_area text)
returns bigint language sql as $$
  update casos
     set notificado_equipo_en = now(), notificado_motivo = p_motivo,
         escala_area = p_area, escala_en = now()
   where id = p_id and notificado_motivo is distinct from p_motivo
  returning id;
$$;

-- Suelta el claim si el WhatsApp no salió, para reintentar al próximo tick.
create or replace function paz_unclaim_alerta(p_id bigint)
returns void language sql as $$
  update casos
     set notificado_equipo_en = null, notificado_motivo = null,
         escala_area = null, escala_en = null
   where id = p_id;
$$;

-- Avanza la escalada al siguiente de la cadena, solo si el caso sigue donde
-- estaba (p_desde). Si dos ticks se solapan, el segundo ve que ya cambió y no
-- reescala. Devuelve el id si ESTE proceso hizo el salto.
create or replace function paz_claim_escala(p_id bigint, p_desde text, p_next text)
returns bigint language sql as $$
  update casos
     set escala_area = p_next, escala_en = now()
   where id = p_id and escala_area = p_desde
  returning id;
$$;

-- Revierte el salto si el WhatsApp de escalada no salió.
create or replace function paz_unclaim_escala(p_id bigint, p_desde text, p_desde_en timestamptz)
returns void language sql as $$
  update casos set escala_area = p_desde, escala_en = p_desde_en where id = p_id;
$$;

-- Estas cuatro las llama la función paz-equipo con el cliente service_role
-- (admin), que se salta RLS. Un llamador anónimo quedaría sujeto al RLS de
-- `casos` (no puede escribir), así que no hace falta que sean security definer.

-- --- 2) abrir conversación a prueba de choques ----------------------------

create or replace function paz_abrir_conversacion(p_telefono text)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_id bigint;
begin
  perform paz_verificar_agente();
  if p_telefono is null or length(trim(p_telefono)) = 0 then
    raise exception 'Falta el teléfono.';
  end if;

  select id into v_id from nexa_conversaciones
   where canal = 'whatsapp' and telefono = p_telefono and cerrada = false
   limit 1;
  if v_id is not null then return v_id; end if;

  -- Si otro webhook en paralelo la crea primero, el insert choca con el unique;
  -- en vez de relanzar (y perder el mensaje), reusamos la que ganó.
  begin
    insert into nexa_conversaciones (canal, telefono)
    values ('whatsapp', p_telefono)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from nexa_conversaciones
     where canal = 'whatsapp' and telefono = p_telefono and cerrada = false
     limit 1;
  end;
  return v_id;
end $$;
