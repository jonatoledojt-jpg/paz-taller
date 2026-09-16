-- ============================================================
-- PAZ — modo aprendizaje
--
-- Un mes de entrenamiento antes de soltar a PAZ con clientes de
-- verdad. Los casos que se generan ahora quedan marcados como
-- `aprendizaje`: no crean OT, no agendan visita real, y el modo
-- asistido no manda WhatsApp de verdad desde un caso así.
--
-- El dueño conversa con PAZ por el número de prueba de WhatsApp
-- (ya probado, aislado de clientes reales porque solo hablan los
-- teléfonos autorizados) y evalúa cada caso: Positivo, Negativo o
-- Descartar. Lo que aprueba se vuelve un aprendizaje permanente en
-- paz_aprendizajes — la misma tabla de siempre, no una nueva.
--
-- Ejecutar después de 19d. Re-ejecutable.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Modo del caso. Se fija al nacer, nunca cambia solo: si algún
--    día hay que pasar un caso de entrenamiento a producción, lo
--    hace una persona a mano, no un proceso automático.
-- ------------------------------------------------------------

alter table casos add column if not exists modo text not null default 'aprendizaje'
  check (modo in ('aprendizaje','produccion'));

alter table casos add column if not exists evaluacion_aprendizaje text
  check (evaluacion_aprendizaje in ('positivo','negativo'));

alter table casos add column if not exists descartado    boolean not null default false;
alter table casos add column if not exists descartado_en timestamptz;
alter table casos add column if not exists descartado_por uuid references perfiles;

create index if not exists casos_modo_idx on casos (modo, archivado, descartado);

-- Interruptor global: en qué modo nace un caso NUEVO. Por defecto,
-- aprendizaje — el mes de entrenamiento que pidió Jonatan. El día
-- que se suelte a producción, se cambia acá, sin tocar código.
alter table nexa_config add column if not exists modo_casos_defecto text not null default 'aprendizaje'
  check (modo_casos_defecto in ('aprendizaje','produccion'));


-- ------------------------------------------------------------
-- 2. paz_aprendizajes ya tenía justo los tipos que pedía el plan
--    (criterio, ejemplo, respuesta_aprobada, correccion). Solo
--    falta el vínculo al caso que originó el aprendizaje, y un
--    lugar para guardar el intercambio completo, no solo la regla
--    destilada.
-- ------------------------------------------------------------

alter table paz_aprendizajes add column if not exists caso_id_origen bigint references casos on delete set null;
alter table paz_aprendizajes add column if not exists transcripcion text;

create index if not exists paz_aprendizajes_caso_idx on paz_aprendizajes (caso_id_origen);


-- ------------------------------------------------------------
-- 3. paz_sincronizar_caso: los casos NUEVOS nacen en el modo que
--    diga nexa_config.modo_casos_defecto. Un caso ya existente
--    nunca cambia de modo por esta función — eso queda para una
--    acción explícita de una persona, si algún día hace falta.
-- ------------------------------------------------------------

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
  v_modo text;
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
    select modo_casos_defecto into v_modo from nexa_config where id = 1;

    insert into casos (
      conversacion_id, orden_en_conversacion, telefono_whatsapp,
      cliente_nombre, patente, vehiculo_modelo, vehiculo_anio,
      ubicacion_texto, atencion, modulo, sistema, codigos_reportados,
      falla_reportada, se_desplaza, trabajos_previos, resumen_tecnico,
      faltantes, conflictos, modo
    ) values (
      p_conversacion_id, p_orden_en_conversacion, p_telefono,
      p_cliente_nombre, p_patente, p_vehiculo_modelo, p_vehiculo_anio,
      p_ubicacion_texto, p_atencion, p_modulo, p_sistema, p_codigos_reportados,
      p_falla_reportada, p_se_desplaza, p_trabajos_previos, p_resumen_tecnico,
      coalesce(p_faltantes,'[]'::jsonb), coalesce(p_conflictos,'[]'::jsonb),
      coalesce(v_modo, 'aprendizaje')
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


-- ------------------------------------------------------------
-- 4. Descartar un caso de prueba sin valor: no es borrado físico.
--    Sale de la vista, no alimenta aprendizajes, no es contexto
--    para PAZ, pero se puede auditar después si hace falta.
--    Solo dueño, igual que gestionar aprendizajes.
-- ------------------------------------------------------------

create or replace function paz_descartar_caso(p_caso_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if mi_rol() <> 'dueno' then
    raise exception 'Solo el dueño puede descartar un caso de entrenamiento.';
  end if;
  update casos set descartado = true, descartado_en = now(), descartado_por = auth.uid()
   where id = p_caso_id;
end $$;

comment on function paz_descartar_caso(bigint) is
  'Dueño: marca un caso de aprendizaje como descartado (sin valor). No es borrado físico.';

revoke execute on function paz_descartar_caso(bigint) from public;
grant execute on function paz_descartar_caso(bigint) to authenticated;


-- Comprobación
-- select modo, count(*) from casos group by modo;
-- select modo_casos_defecto from nexa_config where id=1;
