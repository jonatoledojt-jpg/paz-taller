-- ============================================================
-- PAZ — rol propio y escritura por RPC cerrada
--
-- Hasta ahora, cuando PAZ conversa sola con un cliente por
-- WhatsApp, escribe en la base con la llave maestra del sistema
-- (service_role), que se salta todos los permisos. Funciona, pero
-- si algún día hay un error en el código de esa función, no hay
-- ningún límite de por medio: podría escribir cualquier columna
-- de cualquier tabla.
--
-- Esto le da a PAZ una identidad propia, con rol `agente`, que
-- NO tiene permiso directo para escribir nada. Solo puede llamar
-- a un puñado de funciones (`paz_...`) que:
--   - validan que quien llama es de verdad el agente
--   - escriben SOLO las columnas que se les permite
--   - nunca tocan gastos, cotizaciones, montos, ni cambian el
--     estado de una OT ni la crean
--
-- Esto es refuerzo, no una funcionalidad nueva: nada de lo que
-- ya funciona debería comportarse distinto. Ejecutar después de 18.
-- Es re-ejecutable.
-- ============================================================

-- ------------------------------------------------------------
-- 1. El rol. Va en 19a-rol-agente-enum.sql, aparte: Postgres exige
--    que un valor nuevo de enum se confirme en su propia transacción
--    antes de poder usarse. Correr ese archivo antes que este.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 2. Qué puede LEER el agente directamente (sin pasar por RPC).
--    Clientes, vehículos y órdenes ya son de lectura abierta para
--    cualquier autenticado (`using (true)`), así que no hace falta
--    tocar esas políticas. Lo único nuevo es paz_aprendizajes:
--    PAZ necesita leer los criterios activos para aplicarlos.
-- ------------------------------------------------------------

drop policy if exists leer_paz_aprendizajes on paz_aprendizajes;
create policy leer_paz_aprendizajes on paz_aprendizajes for select to authenticated
  using (mi_rol() in ('dueno','coordinador','agente'));

-- Nunca se agrega 'agente' a gastos, costos_fijos_mensuales,
-- cotizaciones ni cotizacion_items. Eso es a propósito: PAZ no
-- necesita verlos y no debe poder.


-- ------------------------------------------------------------
-- 3. Las RPC. Cada una:
--    - valida que auth.uid() sea el agente (no dueño, no
--      coordinador disfrazado, no nadie más)
--    - recibe parámetros explícitos, nunca un JSON libre que se
--      vuelque directo a una tabla
--    - escribe solo las columnas que declara
--    - set search_path = public (blindaje estándar de
--      security definer, evita que alguien redirija a qué
--      tablas apunta "public.tabla" con un search_path raro)
-- ------------------------------------------------------------

create or replace function paz_verificar_agente()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from perfiles where id = auth.uid() and rol = 'agente'
  ) then
    raise exception 'Esta función es solo para el agente PAZ.';
  end if;
end $$;

comment on function paz_verificar_agente() is
  'Guardia interna: aborta si quien llama no es el agente PAZ. La usan todas las paz_*.';


-- Abre o reutiliza la conversación de un teléfono. Es lo único que
-- puede crear una fila en nexa_conversaciones desde el agente.
create or replace function paz_abrir_conversacion(p_telefono text)
returns bigint
language plpgsql
security definer
set search_path = public
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

  insert into nexa_conversaciones (canal, telefono)
  values ('whatsapp', p_telefono)
  returning id into v_id;
  return v_id;
end $$;

comment on function paz_abrir_conversacion(text) is
  'PAZ: abre o reutiliza la conversación de WhatsApp de un teléfono.';


-- Guarda un mensaje. wa_id es único: si Meta reintenta el mismo
-- mensaje, el ON CONFLICT lo ignora y devuelve null — el llamador
-- ya sabe que significa "ya se procesó, no hagas nada más".
create or replace function paz_guardar_mensaje(
  p_conversacion_id bigint, p_rol text, p_contenido text,
  p_wa_id text default null, p_humano_asistido boolean default false
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  perform paz_verificar_agente();
  if p_rol not in ('user','assistant') then
    raise exception 'Rol de mensaje inválido: %', p_rol;
  end if;
  if not exists (select 1 from nexa_conversaciones where id = p_conversacion_id) then
    raise exception 'La conversación % no existe.', p_conversacion_id;
  end if;

  insert into nexa_mensajes (conversacion_id, rol, contenido, wa_id, humano_asistido)
  values (p_conversacion_id, p_rol, p_contenido, p_wa_id, p_humano_asistido)
  on conflict (wa_id) where wa_id is not null do nothing
  returning id into v_id;
  return v_id;
end $$;

comment on function paz_guardar_mensaje(bigint, text, text, text, boolean) is
  'PAZ: guarda un mensaje de la conversación. Ignora reintentos duplicados de Meta (wa_id repetido).';


create or replace function paz_actualizar_ubicacion(
  p_conversacion_id bigint, p_gps text, p_texto text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform paz_verificar_agente();
  update nexa_conversaciones
     set ubicacion_gps = p_gps, ubicacion_texto = p_texto
   where id = p_conversacion_id;
end $$;

comment on function paz_actualizar_ubicacion(bigint, text, text) is
  'PAZ: guarda la ubicación que compartió el cliente por WhatsApp.';


create or replace function paz_adjuntar_archivo(
  p_conversacion_id bigint, p_caso_id bigint, p_ruta text,
  p_categoria text, p_mime text, p_wa_media_id text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  perform paz_verificar_agente();
  insert into nexa_archivos (conversacion_id, caso_id, ruta, categoria, mime, wa_media_id)
  values (p_conversacion_id, p_caso_id, p_ruta, coalesce(p_categoria,'foto_cliente'), p_mime, p_wa_media_id)
  on conflict (wa_media_id) where wa_media_id is not null do nothing
  returning id into v_id;

  if p_caso_id is not null then
    update casos set tiene_fotos = true where id = p_caso_id;
  else
    update nexa_conversaciones set tiene_fotos = true where id = p_conversacion_id;
  end if;
  return v_id;
end $$;

comment on function paz_adjuntar_archivo(bigint, bigint, text, text, text, text) is
  'PAZ: asocia un archivo ya subido al bucket con un caso o, si aún no hay caso, con la conversación.';


-- La pieza más grande: crea o actualiza UN caso dentro de una
-- conversación. Mantiene, tal cual estaban en el código, las dos
-- reglas que costaron errores reales de encontrar:
--   - la alerta se levanta sola, pero no se baja sola
--   - un caso con OT no vuelve a alertar por el MISMO motivo, pero
--     sí por uno distinto (pasó de verdad: alguien pidió cancelar
--     una visita ya agendada y la alerta no saltaba)
-- Nunca toca orden_id, estado_caso más allá de recopilando -> listo,
-- archivado, atendida_por ni atendida_en: crear una OT, cerrar o
-- archivar un caso sigue siendo solo de una persona.
create or replace function paz_sincronizar_caso(
  p_conversacion_id bigint, p_orden_en_conversacion int, p_telefono text,
  p_cliente_nombre text, p_patente text, p_vehiculo_modelo text, p_vehiculo_anio text,
  p_ubicacion_texto text, p_atencion text, p_modulo text, p_sistema text,
  p_codigos_reportados text, p_falla_reportada text, p_se_desplaza boolean,
  p_trabajos_previos text, p_resumen_tecnico text,
  p_faltantes jsonb, p_conflictos jsonb,
  p_requiere_humano boolean, p_motivo_alerta text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_previo record;
  v_ya_convertido boolean;
  v_motivo_distinto boolean;
begin
  perform paz_verificar_agente();
  if p_atencion is not null and p_atencion not in ('terreno','envio') then
    raise exception 'atencion inválida: %', p_atencion;
  end if;

  select id, orden_id, estado_caso, requiere_respuesta_humana, motivo_alerta
    into v_previo
    from casos
   where conversacion_id = p_conversacion_id and orden_en_conversacion = p_orden_en_conversacion;

  v_ya_convertido := v_previo.orden_id is not null;
  v_motivo_distinto := p_motivo_alerta is not null and trim(p_motivo_alerta) <> ''
                        and trim(p_motivo_alerta) is distinct from trim(coalesce(v_previo.motivo_alerta,''));

  if v_previo.id is null then
    insert into casos (
      conversacion_id, orden_en_conversacion, telefono_whatsapp,
      cliente_nombre, patente, vehiculo_modelo, vehiculo_anio,
      ubicacion_texto, atencion, modulo, sistema, codigos_reportados,
      falla_reportada, se_desplaza, trabajos_previos, resumen_tecnico,
      faltantes, conflictos
    ) values (
      p_conversacion_id, p_orden_en_conversacion, p_telefono,
      p_cliente_nombre, p_patente, p_vehiculo_modelo, p_vehiculo_anio,
      p_ubicacion_texto, p_atencion, p_modulo, p_sistema, p_codigos_reportados,
      p_falla_reportada, p_se_desplaza, p_trabajos_previos, p_resumen_tecnico,
      coalesce(p_faltantes,'[]'::jsonb), coalesce(p_conflictos,'[]'::jsonb)
    ) returning id into v_id;

    if p_requiere_humano then
      update casos set requiere_respuesta_humana = true,
             motivo_alerta = coalesce(nullif(trim(p_motivo_alerta),''), 'El cliente espera una respuesta del equipo.'),
             alerta_creada_en = now()
       where id = v_id;
    end if;
    return v_id;
  end if;

  v_id := v_previo.id;

  update casos set
    telefono_whatsapp = p_telefono,
    cliente_nombre    = p_cliente_nombre,
    patente           = p_patente,
    vehiculo_modelo   = p_vehiculo_modelo,
    vehiculo_anio     = p_vehiculo_anio,
    ubicacion_texto   = p_ubicacion_texto,
    atencion          = p_atencion,
    modulo            = p_modulo,
    sistema           = p_sistema,
    codigos_reportados= p_codigos_reportados,
    falla_reportada   = p_falla_reportada,
    se_desplaza       = p_se_desplaza,
    trabajos_previos  = p_trabajos_previos,
    resumen_tecnico   = p_resumen_tecnico,
    faltantes         = coalesce(p_faltantes, faltantes),
    conflictos        = coalesce(p_conflictos, conflictos)
  where id = v_id;

  if p_requiere_humano and not v_previo.requiere_respuesta_humana
     and (not v_ya_convertido or v_motivo_distinto) then
    update casos set requiere_respuesta_humana = true,
           motivo_alerta = coalesce(nullif(trim(p_motivo_alerta),''), 'El cliente espera una respuesta del equipo.'),
           alerta_creada_en = now()
     where id = v_id;
  end if;

  if v_previo.estado_caso = 'recopilando_datos' and not v_ya_convertido
     and p_falla_reportada is not null and (p_patente is not null or p_vehiculo_modelo is not null)
     and p_ubicacion_texto is not null then
    update casos set estado_caso = 'listo_para_revision' where id = v_id;
  end if;

  return v_id;
end $$;

comment on function paz_sincronizar_caso(
  bigint, int, text, text, text, text, text, text, text, text, text,
  text, text, boolean, text, text, jsonb, jsonb, boolean, text
) is
  'PAZ: crea o actualiza UN caso dentro de una conversación. Nunca toca orden_id, archivado ni atendida_*: crear OT, cerrar o archivar un caso sigue siendo solo de una persona.';


-- ------------------------------------------------------------
-- 4. Permisos de ejecución. Por defecto Postgres da EXECUTE a
--    PUBLIC en funciones nuevas — eso se cierra acá, y se abre
--    solo a authenticated (la guardia paz_verificar_agente()
--    de cada función igual exige ser el agente puntualmente).
-- ------------------------------------------------------------

revoke execute on function paz_verificar_agente()      from public;
revoke execute on function paz_abrir_conversacion(text) from public;
revoke execute on function paz_guardar_mensaje(bigint, text, text, text, boolean) from public;
revoke execute on function paz_actualizar_ubicacion(bigint, text, text) from public;
revoke execute on function paz_adjuntar_archivo(bigint, bigint, text, text, text, text) from public;
revoke execute on function paz_sincronizar_caso(
  bigint, int, text, text, text, text, text, text, text, text, text,
  text, text, boolean, text, text, jsonb, jsonb, boolean, text
) from public;

grant execute on function paz_abrir_conversacion(text) to authenticated;
grant execute on function paz_guardar_mensaje(bigint, text, text, text, boolean) to authenticated;
grant execute on function paz_actualizar_ubicacion(bigint, text, text) to authenticated;
grant execute on function paz_adjuntar_archivo(bigint, bigint, text, text, text, text) to authenticated;
grant execute on function paz_sincronizar_caso(
  bigint, int, text, text, text, text, text, text, text, text, text,
  text, text, boolean, text, text, jsonb, jsonb, boolean, text
) to authenticated;
-- paz_verificar_agente no se otorga a nadie directo: solo la llaman
-- las otras paz_* internamente.


-- Comprobación
-- select proname from pg_proc where proname like 'paz_%' order by proname;
-- select rolname, has_function_privilege('authenticated', 'paz_guardar_mensaje(bigint,text,text,text,boolean)', 'execute');

