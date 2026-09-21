-- ============================================================
-- PAZ SERVICES — Asistencia, pagos y mano de obra real
-- Ejecutar después de 01 a 29. Re-ejecutable.
--
-- Por qué existe: los colaboradores se pagan por días trabajados,
-- de memoria y por transferencia, sin registro. La rentabilidad
-- muestra un margen inflado porque la mano de obra -- el costo más
-- grande de la empresa -- no está en el sistema.
--
-- La mano de obra es un costo VARIABLE: un mes con menos días
-- trabajados cuesta menos. No se estima, se calcula de la asistencia.
--
-- DÍA HÁBIL = lunes a viernes. Sábado y domingo son día
-- extraordinario: se pagan EXACTAMENTE igual, sin recargo; la única
-- diferencia es que no se esperan (no entran en el aviso de días sin
-- marcar).
--
-- ORDEN DEL ARCHIVO, a propósito:
--   tablas -> siembra -> triggers -> permisos -> funciones nuevas ->
--   funciones que ya usa producción (al final)
-- Las dos funciones que producción ya llama hoy (resumen_rentabilidad,
-- rentabilidad_ot) se sueltan y recrean AL FINAL: si algo falla antes,
-- nunca llegan a soltarse y la app sigue funcionando.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Tipos. `area_gasto` y `medio_pago_gasto` (11-gastos.sql) ya
--    existen y dicen lo mismo: se reutilizan.
-- ------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_type where typname = 'modalidad_pago_colab') then
    create type modalidad_pago_colab as enum ('por_dia', 'semanal_fijo');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'estado_asistencia') then
    create type estado_asistencia as enum (
      'presente', 'media_jornada',
      'ausente_con_aviso', 'ausente_sin_aviso',
      'feriado',
      'sin_carga'          -- la empresa no requirió trabajo ese día
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'estado_pago_colab') then
    create type estado_pago_colab as enum ('borrador', 'emitido', 'pagado', 'anulado');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'accion_auditoria') then
    create type accion_auditoria as enum ('insert', 'update', 'delete', 'anular');
  end if;
end $$;


-- ------------------------------------------------------------
-- 2. Colaboradores
-- ------------------------------------------------------------

create table if not exists colaboradores (
  id              bigint generated always as identity primary key,
  nombre          text not null,
  rut             text,
  cargo           text,
  area_default    area_gasto not null default 'terreno',
  modalidad_pago  modalidad_pago_colab not null default 'por_dia',
  valor_dia       numeric(12,0),
  valor_semana    numeric(12,0),
  usuario_id      uuid references perfiles(id) on delete set null,
  activo          boolean not null default true,
  creado_en       timestamptz not null default now()
);

create index if not exists colaboradores_activo_idx  on colaboradores (activo);
create index if not exists colaboradores_usuario_idx on colaboradores (usuario_id);

-- Sin esto la siembra duplicaría gente al re-ejecutar, y dos
-- "Luis Gonzales" harían impagable el cálculo por colaborador.
create unique index if not exists colaboradores_nombre_uniq on colaboradores (lower(btrim(nombre)));
-- Una cuenta de la app = un colaborador. Dos fichas colgando del mismo
-- perfil serían la misma persona pagada dos veces.
create unique index if not exists colaboradores_usuario_uniq on colaboradores (usuario_id) where usuario_id is not null;

-- Cada modalidad exige su propio valor, y mayor a cero: un colaborador
-- "por día" sin valor_dia registraría días en $0 sin que nadie lo note.
alter table colaboradores drop constraint if exists chk_colab_valor_segun_modalidad;
alter table colaboradores add constraint chk_colab_valor_segun_modalidad check (
  (modalidad_pago = 'por_dia'      and valor_dia    is not null and valor_dia    > 0) or
  (modalidad_pago = 'semanal_fijo' and valor_semana is not null and valor_semana > 0)
);


-- ------------------------------------------------------------
-- 3. Siembra — ANTES de crear los triggers de auditoría.
--    Así no hay que apagar ningún trigger (si la carga fallaba a
--    la mitad, la auditoría quedaba apagada en silencio para
--    siempre), y de paso queda claro que esto es carga inicial y
--    no la acción de un usuario.
--    Datos dichos por Jonatan el 20-09-2026.
-- ------------------------------------------------------------

insert into colaboradores (nombre, cargo, area_default, modalidad_pago, valor_dia, usuario_id)
select v.nombre, v.cargo, v.area::area_gasto, 'por_dia'::modalidad_pago_colab, v.valor,
       (select p.id from perfiles p where p.nombre = v.nombre limit 1)
  from (values
    ('Luis Gonzales',   'Mecánico de terreno',      'terreno',      50000),
    ('Jonatan Osores',  'Coordinador',              'coordinacion', 50000),
    ('Diego Toledo',    'Encargado de laboratorio', 'laboratorio',  40000)
  ) as v(nombre, cargo, area, valor)
on conflict do nothing;


-- ------------------------------------------------------------
-- 4. Asistencia
--
--    valor_referencia: la tarifa del colaborador CONGELADA el día
--    que se registró. Sin esto, corregir un día viejo lo repactaba
--    a la tarifa de hoy -- reescribiendo meses ya pagados.
--
--    factor_manual: separa "el factor sale de la tabla" de "el
--    dueño lo ajustó a mano". Sin esta bandera no había forma de
--    distinguir un factor mandado por el cliente de uno por
--    defecto, y corregir un día marcado quedaba trabado.
-- ------------------------------------------------------------

create table if not exists asistencia (
  id               bigint generated always as identity primary key,
  colaborador_id   bigint not null references colaboradores(id) on delete restrict,
  fecha            date not null,
  estado           estado_asistencia not null,
  factor_jornada   numeric(4,2) not null,
  factor_manual    boolean not null default false,
  valor_referencia numeric(12,0) not null default 0,
  valor_aplicado   numeric(12,0) not null default 0,
  orden_id         bigint references ordenes(id) on delete set null,
  pago_id          bigint,
  observacion      text,
  registrado_por   uuid references perfiles(id),
  registrado_en    timestamptz not null default now(),
  revisado         boolean not null default false,
  revisado_por     uuid references perfiles(id),
  revisado_en      timestamptz
);

-- Por si la tabla ya existía de una corrida anterior del archivo viejo.
alter table asistencia add column if not exists factor_manual    boolean not null default false;
alter table asistencia add column if not exists valor_referencia numeric(12,0) not null default 0;
alter table asistencia alter column factor_jornada drop default;

create unique index if not exists asistencia_colab_fecha_uniq on asistencia (colaborador_id, fecha);
create index if not exists asistencia_fecha_idx    on asistencia (fecha);
create index if not exists asistencia_pago_idx     on asistencia (pago_id);
create index if not exists asistencia_orden_idx    on asistencia (orden_id);
create index if not exists asistencia_sin_revisar_idx on asistencia (fecha) where not revisado;

-- Una ausencia (o feriado, o sin carga) NUNCA vale más que 0 jornada.
alter table asistencia drop constraint if exists chk_asistencia_factor_por_estado;
alter table asistencia add constraint chk_asistencia_factor_por_estado check (
  (estado in ('presente', 'media_jornada') and factor_jornada > 0)
  or
  (estado in ('ausente_con_aviso', 'ausente_sin_aviso', 'feriado', 'sin_carga') and factor_jornada = 0)
);

alter table asistencia drop constraint if exists chk_asistencia_factor_rango;
alter table asistencia add constraint chk_asistencia_factor_rango
  check (factor_jornada >= 0 and factor_jornada <= 2);

alter table asistencia drop constraint if exists chk_asistencia_valores_no_negativos;
alter table asistencia add constraint chk_asistencia_valores_no_negativos
  check (valor_aplicado >= 0 and valor_referencia >= 0);

-- Un ajuste manual de factor sin explicación no sirve de nada.
alter table asistencia drop constraint if exists chk_asistencia_manual_con_observacion;
alter table asistencia add constraint chk_asistencia_manual_con_observacion
  check (not factor_manual or coalesce(btrim(observacion), '') <> '');


-- ------------------------------------------------------------
-- 5. Pagos a colaboradores
--
--    El comprobante de la app (COMP-2026-0001) identifica QUÉ se
--    pagó: el período y el detalle de días. El comprobante del
--    BANCO (numero_transferencia) prueba que la plata se movió --
--    lo emite un tercero, trae identificador único y no lo puede
--    adulterar ninguna de las dos partes. Son cosas distintas y se
--    guardan por separado (criterio de Jonatan, 21-09-2026).
-- ------------------------------------------------------------

create table if not exists pagos_colaboradores (
  id                      bigint generated always as identity primary key,
  colaborador_id          bigint not null references colaboradores(id) on delete restrict,
  periodo_desde           date not null,
  periodo_hasta           date not null,
  dias_trabajados         numeric(6,2) not null default 0,
  monto_devengado         numeric(12,0) not null default 0,
  bonos                   numeric(12,0) not null default 0,
  descuentos              numeric(12,0) not null default 0,
  monto_total             numeric(12,0) not null default 0,
  estado                  estado_pago_colab not null default 'borrador',
  comprobante_numero      text unique,
  comprobante_generado_en timestamptz,
  medio_pago              medio_pago_gasto,
  numero_transferencia    text,
  banco                   text,
  pagado_en               timestamptz,
  comprobante_firmado     boolean not null default false,
  ruta_comprobante        text,
  motivo_anulacion        text,
  anulado_por             uuid references perfiles(id),
  anulado_en              timestamptz,
  notas                   text,
  nota_bonos              text,
  nota_descuentos         text,
  registrado_por          uuid references perfiles(id),
  creado_en               timestamptz not null default now(),
  actualizado_en          timestamptz not null default now()
);

alter table pagos_colaboradores add column if not exists numero_transferencia text;
alter table pagos_colaboradores add column if not exists banco text;

create index if not exists pagos_colab_colaborador_idx on pagos_colaboradores (colaborador_id, periodo_desde desc);
create index if not exists pagos_colab_estado_idx      on pagos_colaboradores (estado);

alter table pagos_colaboradores drop constraint if exists chk_pago_periodo;
alter table pagos_colaboradores add constraint chk_pago_periodo
  check (periodo_hasta >= periodo_desde);

alter table pagos_colaboradores drop constraint if exists chk_pago_bonos_descuentos;
alter table pagos_colaboradores add constraint chk_pago_bonos_descuentos
  check (bonos >= 0 and descuentos >= 0);

-- Si mueve plata, tiene que decir por qué.
alter table pagos_colaboradores drop constraint if exists chk_pago_notas_obligatorias;
alter table pagos_colaboradores add constraint chk_pago_notas_obligatorias check (
  (bonos = 0      or coalesce(btrim(nota_bonos), '')      <> '') and
  (descuentos = 0 or coalesce(btrim(nota_descuentos), '') <> '')
);

alter table pagos_colaboradores drop constraint if exists chk_pago_motivo_anulacion;
alter table pagos_colaboradores add constraint chk_pago_motivo_anulacion
  check (estado <> 'anulado' or coalesce(btrim(motivo_anulacion), '') <> '');

-- Red por si alguien escribe directo en la base: el número siempre con
-- el formato del correlativo, y nunca pagado sin comprobante emitido.
alter table pagos_colaboradores drop constraint if exists chk_pago_comprobante_formato;
alter table pagos_colaboradores add constraint chk_pago_comprobante_formato
  check (comprobante_numero is null or comprobante_numero ~ '^COMP-[0-9]{4}-[0-9]{4,}$');
alter table pagos_colaboradores drop constraint if exists chk_pago_pagado_con_comprobante;
alter table pagos_colaboradores add constraint chk_pago_pagado_con_comprobante
  check (estado <> 'pagado' or comprobante_numero is not null);

-- OJO, decisión tomada con datos reales (Jonatan, 21-09-2026): el banco
-- de la empresa NO entrega número de transferencia en el comprobante.
-- Otro banco que usa sí, pero no se puede exigir algo que el banco no
-- da. Así que `numero_transferencia` queda OPCIONAL, y el respaldo real
-- es la imagen del comprobante.
--
-- Y NO se valida con una constraint a propósito: obligar a tener la
-- imagen para poder marcar "pagado" invertiría el orden real (primero
-- se paga, después se sube la foto) y una subida fallida haría perder
-- el registro del pago. Mismo criterio que ya se tomó con los
-- comprobantes de gastos en 11-gastos.sql. La app avisa de los pagos
-- sin respaldo, la base no los bloquea.

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'asistencia_pago_id_fkey') then
    alter table asistencia add constraint asistencia_pago_id_fkey
      foreign key (pago_id) references pagos_colaboradores(id) on delete restrict;
  end if;
end $$;


-- ------------------------------------------------------------
-- 6. Auditoría — append only, ni el dueño la edita
-- ------------------------------------------------------------

create table if not exists auditoria_mano_obra (
  id               bigint generated always as identity primary key,
  tabla_afectada   text not null,
  registro_id      bigint not null,
  accion           accion_auditoria not null,
  valores_antes    jsonb,
  valores_despues  jsonb,
  usuario_id       uuid not null references perfiles(id),
  fecha            timestamptz not null default now(),
  motivo           text
);

create index if not exists auditoria_mo_tabla_idx on auditoria_mano_obra (tabla_afectada, registro_id);
create index if not exists auditoria_mo_fecha_idx on auditoria_mano_obra (fecha desc);


-- ------------------------------------------------------------
-- 7. Guardia común: nada se escribe sin sesión
-- ------------------------------------------------------------

create or replace function exigir_sesion()
returns uuid
language plpgsql stable
as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'Esta operación necesita una sesión iniciada';
  end if;
  return v;
end $$;

create or replace function factor_por_estado(p_estado estado_asistencia)
returns numeric
language sql immutable
as $$
  select case p_estado
           when 'presente'      then 1::numeric
           when 'media_jornada' then 0.5::numeric
           else 0::numeric
         end
$$;


-- ------------------------------------------------------------
-- 8. Asistencia: cálculo, congelado del valor, y bloqueos
-- ------------------------------------------------------------

create or replace function tg_asistencia_calcula()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := exigir_sesion();
  v_colab    colaboradores%rowtype;
  v_es_dueno boolean := coalesce(mi_rol()::text, '') = 'dueno';
begin
  select * into v_colab from colaboradores where id = new.colaborador_id;
  if not found then
    raise exception 'Colaborador % no existe', new.colaborador_id;
  end if;

  -- ---- factor ----
  -- Por defecto SIEMPRE sale de la tabla, sin importar lo que mande
  -- el cliente. Solo un ajuste declarado explícitamente (factor_manual)
  -- puede ser distinto, y solo lo hace el dueño. Así corregir el estado
  -- de un día nunca queda trabado.
  if coalesce(new.factor_manual, false) then
    if new.estado not in ('presente', 'media_jornada') then
      -- Una ausencia no admite ajuste: se fuerza a 0 y se apaga la bandera.
      new.factor_manual  := false;
      new.factor_jornada := 0;
    elsif tg_op = 'INSERT'
          or not coalesce(old.factor_manual, false)
          or new.factor_jornada is distinct from old.factor_jornada then
      -- Ajuste manual NUEVO o MODIFICADO en esta operación: solo dueño.
      -- Si el ajuste ya existía y no se tocó, se conserva tal cual --
      -- así el coordinador puede marcar revisado, poner orden_id o
      -- corregir la observación de un día ajustado sin que le salte un
      -- error de permisos que no tiene nada que ver con lo que pidió.
      if not v_es_dueno then
        raise exception 'Solo el dueño puede ajustar el factor de jornada a mano';
      end if;
    end if;
  else
    new.factor_jornada := factor_por_estado(new.estado);
  end if;

  -- ---- valor congelado ----
  -- La tarifa se copia UNA vez, al registrar el día, y se guarda en
  -- valor_referencia. Si mañana sube el valor_dia, este día mantiene
  -- el suyo. Corregir el estado recalcula solo el factor, siempre
  -- sobre la tarifa original.
  if tg_op = 'INSERT' then
    if v_colab.modalidad_pago = 'semanal_fijo' then
      new.valor_referencia := round(coalesce(v_colab.valor_semana, 0) / 5.0);
    else
      new.valor_referencia := coalesce(v_colab.valor_dia, 0);
    end if;
    new.registrado_por := v_uid;
    new.registrado_en  := now();
  else
    new.valor_referencia := old.valor_referencia;   -- nunca se repacta
    new.registrado_por   := old.registrado_por;
    new.registrado_en    := old.registrado_en;
  end if;

  if v_colab.modalidad_pago = 'semanal_fijo' then
    -- El sueldo semanal cubre los días hábiles pase lo que pase: una
    -- ausencia NO descuenta sola (si corresponde descontar, se hace a
    -- mano en el pago). Sábado y domingo se pagan igual que un día de
    -- semana, pero solo si de verdad se trabajaron.
    if extract(isodow from new.fecha) <= 5 then
      new.valor_aplicado := new.valor_referencia;
    else
      new.valor_aplicado := round(new.valor_referencia * new.factor_jornada);
    end if;
  else
    new.valor_aplicado := round(new.valor_referencia * new.factor_jornada);
  end if;

  -- ---- revisado ----
  if new.revisado and (tg_op = 'INSERT' or not coalesce(old.revisado, false)) then
    new.revisado_por := v_uid;
    new.revisado_en  := now();
  elsif not new.revisado then
    new.revisado_por := null;
    new.revisado_en  := null;
  end if;

  return new;
end $$;

drop trigger if exists trg_asistencia_calcula on asistencia;
create trigger trg_asistencia_calcula
  before insert or update on asistencia
  for each row execute function tg_asistencia_calcula();


-- Un día que ya está en un comprobante emitido o pagado no se toca.
-- Para corregirlo: anular el pago (eso libera los días), corregir, y
-- emitir un pago nuevo con número nuevo.
--
-- Mira old.pago_id y NO new.pago_id a propósito: si mirara el nuevo,
-- el trigger que amarra los días al emitir un pago se bloquearía a sí
-- mismo. Y quién amarra un día lo decide solo la base (ver abajo), no
-- el cliente.
create or replace function tg_asistencia_bloqueo_pago()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_estado_pago estado_pago_colab;
begin
  if old.pago_id is not null then
    select p.estado into v_estado_pago from pagos_colaboradores p where p.id = old.pago_id;
    if v_estado_pago in ('emitido', 'pagado') then
      raise exception 'Ese día está en el pago % (%). Anula el pago para poder corregirlo.',
        old.pago_id, v_estado_pago;
    end if;
  end if;

  -- El cliente nunca decide a qué pago pertenece un día: lo hace el
  -- trigger del pago. Sin esto, cualquiera podía meter días a un pago
  -- ya cerrado, o sacarlos de uno abierto.
  if tg_op = 'UPDATE' and new.pago_id is distinct from old.pago_id
     and current_setting('paz.amarrando_dias', true) is distinct from 'si' then
    raise exception 'El pago de un día lo asigna la app al emitir el pago, no se escribe a mano';
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists trg_asistencia_bloqueo_pago on asistencia;
create trigger trg_asistencia_bloqueo_pago
  before update or delete on asistencia
  for each row execute function tg_asistencia_bloqueo_pago();


-- ------------------------------------------------------------
-- 9. Pagos: total calculado en la base, correlativo, transiciones
-- ------------------------------------------------------------

create or replace function tg_pagos_colab_calcula()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid          uuid := exigir_sesion();
  v_devengado    numeric;
  v_dias         numeric;
  v_sin_revisar  text;
  v_sin_marcar   text;
  v_anio         text;
  v_siguiente    int;
  v_congelado    boolean := false;
begin
  if tg_op = 'INSERT' then
    new.registrado_por := v_uid;
    if new.estado not in ('borrador', 'emitido') then
      raise exception 'Un pago nace en borrador (o se emite), no en %', new.estado;
    end if;
  else
    new.registrado_por := old.registrado_por;
    new.creado_en      := old.creado_en;

    if old.estado = 'anulado' then
      raise exception 'Un pago anulado no se modifica.';
    end if;
    if old.estado = 'pagado' and new.estado <> 'anulado' then
      raise exception 'Un pago ya pagado no se edita. Anúlalo con motivo y emite uno nuevo.';
    end if;
    -- Emitido solo avanza a pagado o anulado: volver a borrador dejaría
    -- el mismo número de comprobante respaldando otro monto.
    if old.estado = 'emitido' and new.estado not in ('emitido', 'pagado', 'anulado') then
      raise exception 'Un pago emitido no vuelve a borrador. Anúlalo y emite uno nuevo.';
    end if;
    -- Una vez emitido, el monto queda congelado: el papel ya salió.
    v_congelado := old.estado in ('emitido', 'pagado');
    -- El correlativo nunca se toca a mano.
    new.comprobante_numero      := old.comprobante_numero;
    new.comprobante_generado_en := old.comprobante_generado_en;
  end if;

  if tg_op = 'INSERT' then
    new.comprobante_numero      := null;   -- lo asigna solo esta función, al emitir
    new.comprobante_generado_en := null;
  end if;

  if not v_congelado then
    -- Devengado y días SIEMPRE salen de la asistencia, nunca del cliente.
    select coalesce(sum(a.valor_aplicado), 0), coalesce(sum(a.factor_jornada), 0)
      into v_devengado, v_dias
      from asistencia a
     where a.colaborador_id = new.colaborador_id
       and a.fecha between new.periodo_desde and new.periodo_hasta
       and (a.pago_id is null or a.pago_id = new.id);

    new.monto_devengado := v_devengado;
    new.dias_trabajados := v_dias;
    new.monto_total     := v_devengado + coalesce(new.bonos, 0) - coalesce(new.descuentos, 0);
  else
    new.monto_devengado := old.monto_devengado;
    new.dias_trabajados := old.dias_trabajados;
    new.bonos           := old.bonos;
    new.descuentos      := old.descuentos;
    new.monto_total     := old.monto_total;
    new.periodo_desde   := old.periodo_desde;
    new.periodo_hasta   := old.periodo_hasta;
    new.colaborador_id  := old.colaborador_id;
  end if;

  new.actualizado_en := now();

  -- ---- emitir ----
  if new.estado = 'emitido' and (tg_op = 'INSERT' or old.estado <> 'emitido') then
    select string_agg(to_char(a.fecha, 'DD-MM'), ', ' order by a.fecha)
      into v_sin_revisar
      from asistencia a
     where a.colaborador_id = new.colaborador_id
       and a.fecha between new.periodo_desde and new.periodo_hasta
       and not a.revisado;
    if v_sin_revisar is not null then
      raise exception 'Faltan días por revisar antes de emitir: %', v_sin_revisar;
    end if;

    -- Un día hábil sin marcar pasaría invisible y el comprobante saldría
    -- corto, sin que nadie se entere.
    select string_agg(to_char(d.dia, 'DD-MM'), ', ' order by d.dia)
      into v_sin_marcar
      from generate_series(new.periodo_desde, new.periodo_hasta, interval '1 day') as d(dia)
     where extract(isodow from d.dia) <= 5
       and not exists (
         select 1 from asistencia a
          where a.colaborador_id = new.colaborador_id and a.fecha = d.dia::date);
    if v_sin_marcar is not null then
      raise exception 'Hay días hábiles sin marcar en el período: %', v_sin_marcar;
    end if;

    -- Correlativo por año. El candado evita que dos emisiones a la vez
    -- saquen el mismo número; se suelta solo al terminar la transacción.
    perform pg_advisory_xact_lock(hashtext('comprobante_pago_colaborador'));
    v_anio := to_char(now(), 'YYYY');
    select coalesce(max(substring(p.comprobante_numero from 11)::int), 0) + 1
      into v_siguiente
      from pagos_colaboradores p
     where p.comprobante_numero ~ ('^COMP-' || v_anio || '-[0-9]{4}$');
    new.comprobante_numero      := 'COMP-' || v_anio || '-' || lpad(v_siguiente::text, 4, '0');
    new.comprobante_generado_en := now();
  end if;

  -- ---- pagar ----
  if new.estado = 'pagado' and (tg_op = 'INSERT' or old.estado <> 'pagado') then
    if new.comprobante_numero is null then
      raise exception 'Un pago no puede quedar pagado sin comprobante emitido';
    end if;
    new.pagado_en := coalesce(new.pagado_en, now());
  end if;

  -- ---- anular ----
  if new.estado = 'anulado' and tg_op = 'UPDATE' and old.estado <> 'anulado' then
    new.anulado_por := v_uid;
    new.anulado_en  := now();
  end if;

  return new;
end $$;

drop trigger if exists trg_pagos_colab_calcula on pagos_colaboradores;
create trigger trg_pagos_colab_calcula
  before insert or update on pagos_colaboradores
  for each row execute function tg_pagos_colab_calcula();


-- Después de guardar: amarrar o soltar los días. Es el ÚNICO lugar que
-- escribe asistencia.pago_id (ver el bloqueo de más arriba).
create or replace function tg_pagos_colab_amarra_dias()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('paz.amarrando_dias', 'si', true);

  if new.estado = 'anulado' then
    update asistencia a set pago_id = null where a.pago_id = new.id;
  elsif tg_op = 'INSERT' or old.estado = 'borrador' then
    -- Solo mientras el pago todavía puede cambiar. Una vez emitido, el
    -- papel ya salió con su lista de días: un día registrado después
    -- (atrasado, olvidado) NO se le cuelga -- queda libre y lo toma el
    -- siguiente pago del período. Sin este guardia, subir la foto del
    -- comprobante firmado bastaba para tragarse un día nuevo y dejarlo
    -- contado como pagado sin estar en ningún comprobante.

    -- Primero soltar los que quedaron fuera del período (si se movió),
    -- para que no queden amarrados a un pago que ya no los cubre.
    update asistencia a set pago_id = null
     where a.pago_id = new.id
       and (a.colaborador_id <> new.colaborador_id
            or a.fecha not between new.periodo_desde and new.periodo_hasta);

    -- Y amarrar los libres del período. Un día no puede estar en dos pagos.
    update asistencia a set pago_id = new.id
     where a.colaborador_id = new.colaborador_id
       and a.fecha between new.periodo_desde and new.periodo_hasta
       and a.pago_id is null;
  end if;

  perform set_config('paz.amarrando_dias', 'no', true);
  return null;
end $$;

drop trigger if exists trg_pagos_colab_amarra_dias on pagos_colaboradores;
create trigger trg_pagos_colab_amarra_dias
  after insert or update on pagos_colaboradores
  for each row execute function tg_pagos_colab_amarra_dias();


create or replace function tg_no_borrar()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Este registro no se borra. Si corresponde, anúlalo con motivo.';
end $$;

drop trigger if exists trg_pagos_colab_no_borrar on pagos_colaboradores;
create trigger trg_pagos_colab_no_borrar
  before delete on pagos_colaboradores
  for each row execute function tg_no_borrar();

drop trigger if exists trg_auditoria_mo_no_borrar on auditoria_mano_obra;
create trigger trg_auditoria_mo_no_borrar
  before delete or update on auditoria_mano_obra
  for each row execute function tg_no_borrar();


-- ------------------------------------------------------------
-- 10. Auditoría automática (incluye DELETE)
-- ------------------------------------------------------------

create or replace function tg_auditar_mano_obra()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := exigir_sesion();
  v_accion accion_auditoria;
  v_motivo text;
  v_id     bigint;
begin
  -- OJO: "elsif tg_table_name = 'pagos_colaboradores' and new.estado =
  -- 'anulado' ..." (versión anterior) rompía CUALQUIER update en
  -- asistencia o colaboradores con "invalid input value for enum
  -- estado_asistencia: anulado". Postgres necesita tipar los DOS lados
  -- del AND aunque el primero sea falso -- el corto-circuito es del
  -- VALOR en tiempo de ejecución, no evita el chequeo de TIPO en tiempo
  -- de parseo -- y 'anulado' no existe en estado_asistencia (solo en
  -- estado_pago_colab). Iba a reventar cada vez que alguien corrigiera
  -- un día ya marcado (bug real, encontrado por Jonatan, 21-09-2026:
  -- "se aprieta por error y no hay como arreglarlo"). Con el IF
  -- anidado, la comparación con 'anulado' solo se compila/ejecuta
  -- cuando la tabla es de verdad pagos_colaboradores.
  if tg_op = 'INSERT' then
    v_accion := 'insert';  v_id := new.id;
  elsif tg_op = 'DELETE' then
    v_accion := 'delete';  v_id := old.id;
  else
    v_accion := 'update';  v_id := new.id;
    if tg_table_name = 'pagos_colaboradores' then
      if new.estado = 'anulado' and old.estado <> 'anulado' then
        v_accion := 'anular';
        v_motivo := new.motivo_anulacion;
      end if;
    end if;
  end if;

  if tg_table_name = 'asistencia' and tg_op <> 'DELETE' then
    v_motivo := coalesce(v_motivo, new.observacion);
  end if;

  insert into auditoria_mano_obra
    (tabla_afectada, registro_id, accion, valores_antes, valores_despues, usuario_id, motivo)
  values (
    tg_table_name, v_id, v_accion,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    v_uid, v_motivo
  );

  return null;
end $$;

drop trigger if exists trg_auditar_colaboradores on colaboradores;
create trigger trg_auditar_colaboradores
  after insert or update or delete on colaboradores
  for each row execute function tg_auditar_mano_obra();

drop trigger if exists trg_auditar_asistencia on asistencia;
create trigger trg_auditar_asistencia
  after insert or update or delete on asistencia
  for each row execute function tg_auditar_mano_obra();

drop trigger if exists trg_auditar_pagos_colab on pagos_colaboradores;
create trigger trg_auditar_pagos_colab
  after insert or update on pagos_colaboradores
  for each row execute function tg_auditar_mano_obra();


-- ------------------------------------------------------------
-- 11. RLS + candado de columnas
--
--     Dueño y coordinador son AMBOS el rol de Postgres
--     "authenticated": los grants de columna no los distinguen. Por
--     eso la plata se revoca para TODOS -- lectura Y escritura -- y
--     se abre un único camino por función que mira mi_rol(), igual
--     que se hizo con ordenes.monto_final en 08-terreno.sql.
-- ------------------------------------------------------------

alter table colaboradores       enable row level security;
alter table asistencia          enable row level security;
alter table pagos_colaboradores enable row level security;
alter table auditoria_mano_obra enable row level security;

-- colaboradores: el coordinador necesita la lista para marcar.
revoke all on colaboradores from authenticated;
grant select (id, nombre, rut, cargo, area_default, modalidad_pago, usuario_id, activo, creado_en)
  on colaboradores to authenticated;
grant insert, update, delete on colaboradores to authenticated;  -- la RLS de abajo lo limita al dueño

drop policy if exists leer_colaboradores on colaboradores;
create policy leer_colaboradores on colaboradores for select to authenticated
  using (mi_rol() in ('dueno', 'coordinador'));

drop policy if exists esc_colaboradores on colaboradores;
create policy esc_colaboradores on colaboradores for all to authenticated
  using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');

-- asistencia: el coordinador marca y ve los días, pero NI LEE NI
-- ESCRIBE factor, valores ni pago_id. Escritura columna por columna:
-- revocar solo el SELECT dejaba el hueco de poder mandarlos igual.
revoke all on asistencia from authenticated;
grant select (id, colaborador_id, fecha, estado, orden_id, pago_id, observacion,
              registrado_por, registrado_en, revisado, revisado_por, revisado_en)
  on asistencia to authenticated;
grant insert (colaborador_id, fecha, estado, orden_id, observacion, revisado)
  on asistencia to authenticated;
grant update (fecha, estado, orden_id, observacion, revisado)
  on asistencia to authenticated;
grant delete on asistencia to authenticated;

drop policy if exists leer_asistencia on asistencia;
create policy leer_asistencia on asistencia for select to authenticated
  using (mi_rol() in ('dueno', 'coordinador'));

drop policy if exists crear_asistencia on asistencia;
create policy crear_asistencia on asistencia for insert to authenticated
  with check (mi_rol() in ('dueno', 'coordinador'));

drop policy if exists editar_asistencia on asistencia;
create policy editar_asistencia on asistencia for update to authenticated
  using (mi_rol() in ('dueno', 'coordinador'))
  with check (mi_rol() in ('dueno', 'coordinador'));

drop policy if exists borrar_asistencia on asistencia;
create policy borrar_asistencia on asistencia for delete to authenticated
  using (mi_rol() = 'dueno');

-- pagos y auditoría: solo dueño. Acá alcanza con RLS de fila porque no
-- hay nada que el coordinador deba ver.
revoke all on pagos_colaboradores from authenticated;
grant select, insert, update on pagos_colaboradores to authenticated;

drop policy if exists solo_dueno_pagos_colab on pagos_colaboradores;
create policy solo_dueno_pagos_colab on pagos_colaboradores for all to authenticated
  using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');

revoke all on auditoria_mano_obra from authenticated;
grant select on auditoria_mano_obra to authenticated;

drop policy if exists leer_auditoria_mo on auditoria_mano_obra;
create policy leer_auditoria_mo on auditoria_mano_obra for select to authenticated
  using (mi_rol() = 'dueno');
-- Sin política de insert/update/delete: las filas entran solo por los
-- triggers security definer, que corren como dueño de la función.


-- ------------------------------------------------------------
-- 12. Único camino de lectura de los montos: solo el dueño
-- ------------------------------------------------------------

create or replace function colaboradores_valores()
returns table (id bigint, valor_dia numeric, valor_semana numeric)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ver los valores de los colaboradores';
  end if;
  return query select c.id, c.valor_dia, c.valor_semana from colaboradores c;
end $$;

grant execute on function colaboradores_valores() to authenticated;

-- Los valores día por día. Sin esto, factor y valor no los podía leer
-- NADIE (ni el dueño), porque están revocados a nivel de columna.
create or replace function asistencia_valores(p_desde date, p_hasta date)
returns table (id bigint, colaborador_id bigint, fecha date,
               factor_jornada numeric, factor_manual boolean,
               valor_referencia numeric, valor_aplicado numeric)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ver los montos de asistencia';
  end if;
  return query
    select a.id, a.colaborador_id, a.fecha, a.factor_jornada, a.factor_manual,
           a.valor_referencia, a.valor_aplicado
      from asistencia a
     where a.fecha between p_desde and p_hasta
     order by a.fecha, a.colaborador_id;
end $$;

grant execute on function asistencia_valores(date, date) to authenticated;

-- Ajustar el factor a mano (ej. 1.5 por jornada extendida). Es el único
-- camino: las columnas factor_* están revocadas para todos.
create or replace function ajustar_factor_jornada(
  p_asistencia_id bigint, p_factor numeric, p_observacion text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform exigir_sesion();
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ajustar el factor de jornada';
  end if;
  if coalesce(btrim(p_observacion), '') = '' then
    raise exception 'Un factor ajustado a mano necesita una observación que lo explique';
  end if;
  update asistencia
     set factor_manual = true, factor_jornada = p_factor, observacion = p_observacion
   where id = p_asistencia_id;
end $$;

grant execute on function ajustar_factor_jornada(bigint, numeric, text) to authenticated;


-- Resumen de un colaborador en un período: lo que se necesita para armar
-- un pago. `sin_carga` se cuenta APARTE y nunca como ausencia: es
-- decisión de la empresa, no del colaborador.
create or replace function resumen_periodo_colaborador(
  p_colaborador_id bigint, p_desde date, p_hasta date)
returns table (
  dias_trabajados     numeric,
  medias_jornadas     int,
  ausencias_con_aviso int,
  ausencias_sin_aviso int,
  feriados            int,
  dias_sin_carga      int,
  dias_sin_revisar    int,
  dias_habiles_sin_marcar int,
  monto_devengado     numeric
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ver los montos de mano de obra';
  end if;

  select
    coalesce(sum(a.factor_jornada), 0),
    count(*) filter (where a.estado = 'media_jornada'),
    count(*) filter (where a.estado = 'ausente_con_aviso'),
    count(*) filter (where a.estado = 'ausente_sin_aviso'),
    count(*) filter (where a.estado = 'feriado'),
    count(*) filter (where a.estado = 'sin_carga'),
    count(*) filter (where not a.revisado),
    coalesce(sum(a.valor_aplicado), 0)
  into dias_trabajados, medias_jornadas, ausencias_con_aviso, ausencias_sin_aviso,
       feriados, dias_sin_carga, dias_sin_revisar, monto_devengado
  from asistencia a
  where a.colaborador_id = p_colaborador_id
    and a.fecha between p_desde and p_hasta;

  select count(*)
    into dias_habiles_sin_marcar
    from generate_series(p_desde, p_hasta, interval '1 day') as d(dia)
   where extract(isodow from d.dia) <= 5
     and not exists (select 1 from asistencia a
                      where a.colaborador_id = p_colaborador_id and a.fecha = d.dia::date);

  return next;
end $$;

grant execute on function resumen_periodo_colaborador(bigint, date, date) to authenticated;


-- Mano de obra del mes para la rentabilidad. Devengado = lo que se ganó
-- ese mes según asistencia, esté pagado o no.
create or replace function resumen_mano_obra(p_mes date)
returns table (devengado numeric, pagado numeric, pendiente numeric, por_area jsonb)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_ini date := date_trunc('month', p_mes)::date;
  v_fin date := (date_trunc('month', p_mes) + interval '1 month' - interval '1 day')::date;
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ver la mano de obra';
  end if;

  select coalesce(sum(a.valor_aplicado), 0) into devengado
    from asistencia a where a.fecha between v_ini and v_fin;

  select coalesce(sum(a.valor_aplicado), 0) into pagado
    from asistencia a join pagos_colaboradores p on p.id = a.pago_id
   where a.fecha between v_ini and v_fin and p.estado = 'pagado';

  pendiente := devengado - pagado;

  select coalesce(jsonb_object_agg(t.area, t.monto), '{}'::jsonb) into por_area
    from (select c.area_default::text as area, coalesce(sum(a.valor_aplicado), 0) as monto
            from asistencia a join colaboradores c on c.id = a.colaborador_id
           where a.fecha between v_ini and v_fin
           group by c.area_default) t;

  return next;
end $$;

grant execute on function resumen_mano_obra(date) to authenticated;


-- ------------------------------------------------------------
-- 13. Comprobantes: bucket privado. Acá va el pantallazo de la
--     transferencia del banco (o el papel firmado, si se pagó en
--     efectivo). Solo el dueño sube y mira.
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('comprobantes-pagos', 'comprobantes-pagos', false)
on conflict (id) do nothing;

drop policy if exists "pagos subir comprobante" on storage.objects;
create policy "pagos subir comprobante" on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes-pagos' and public.mi_rol() = 'dueno');

drop policy if exists "pagos ver comprobante" on storage.objects;
create policy "pagos ver comprobante" on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes-pagos' and public.mi_rol() = 'dueno');


-- ============================================================
-- 14. AL FINAL: las dos funciones que producción ya usa hoy.
--     Van últimas a propósito -- si algo del archivo falla antes,
--     nunca se sueltan y la app sigue andando con las de siempre.
--     Cambian de forma (suman mano de obra), y Postgres no deja
--     cambiar el tipo de retorno con "create or replace".
-- ============================================================

drop function if exists resumen_rentabilidad(date);
create function resumen_rentabilidad(p_mes date)
returns table (
  comprometido        numeric,
  facturado           numeric,
  gastos_netos        numeric,
  mano_obra           numeric,
  mano_obra_pagada    numeric,
  mano_obra_pendiente numeric,
  costo_fijo          numeric,
  margen              numeric
)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ini date := date_trunc('month', p_mes)::date;
  v_fin date := (date_trunc('month', p_mes) + interval '1 month' - interval '1 day')::date;
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ver la rentabilidad';
  end if;

  select coalesce(sum(o.monto_cotizado), 0) into comprometido
    from ordenes o
   where o.aprobado_cliente and o.estado not in ('facturado', 'rechazado');

  -- Por pagado_en, no por fecha_cierre: cerrar es un paso aparte desde
  -- el rediseño de carriles (ver 29-rentabilidad-usa-pagado-en.sql).
  select coalesce(sum(o.monto_final), 0) into facturado
    from ordenes o
   where o.estado = 'facturado' and o.pagado_en::date between v_ini and v_fin;

  select coalesce(sum(g.monto_neto), 0) into gastos_netos
    from gastos g where not g.anulado and g.fecha between v_ini and v_fin;

  select coalesce(sum(a.valor_aplicado), 0) into mano_obra
    from asistencia a where a.fecha between v_ini and v_fin;

  select coalesce(sum(a.valor_aplicado), 0) into mano_obra_pagada
    from asistencia a join pagos_colaboradores p on p.id = a.pago_id
   where a.fecha between v_ini and v_fin and p.estado = 'pagado';

  mano_obra_pendiente := mano_obra - mano_obra_pagada;

  -- costo_fijo son OTROS costos fijos: luz, internet, seguros,
  -- camioneta, contador, software. La mano de obra ya no va acá.
  select coalesce(sum(c.monto), 0) into costo_fijo
    from costos_fijos_mensuales c where c.mes = v_ini;

  margen := facturado - gastos_netos - mano_obra - costo_fijo;
  return next;
end $$;

grant execute on function resumen_rentabilidad(date) to authenticated;


drop function if exists rentabilidad_ot(bigint);
create function rentabilidad_ot(p_orden_id bigint)
returns table (
  ingreso       numeric,
  tipo_ingreso  text,
  monto_gastos  numeric,
  hay_gastos    boolean,
  mano_obra     numeric,
  costo_total   numeric,
  hay_costos    boolean
)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_estado    estado_orden;
  v_aprobado  boolean;
  v_final     numeric;
  v_cotizado  numeric;
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede ver el margen de la OT';
  end if;

  select o.estado, o.aprobado_cliente, o.monto_final, o.monto_cotizado
    into v_estado, v_aprobado, v_final, v_cotizado
    from ordenes o where o.id = p_orden_id;

  if v_estado = 'facturado' and v_final is not null then
    ingreso := v_final;  tipo_ingreso := 'facturado';
  elsif coalesce(v_aprobado, false) and v_cotizado is not null then
    ingreso := v_cotizado; tipo_ingreso := 'cotizado_aprobado';
  else
    ingreso := null; tipo_ingreso := 'sin_ingreso';
  end if;

  select coalesce(sum(g.monto_neto), 0), count(*) > 0
    into monto_gastos, hay_gastos
    from gastos g where g.orden_id = p_orden_id and not g.anulado;

  -- Días atribuidos a esta OT: su mano de obra es costo de esta OT.
  select coalesce(sum(a.valor_aplicado), 0) into mano_obra
    from asistencia a where a.orden_id = p_orden_id;

  costo_total := coalesce(monto_gastos, 0) + coalesce(mano_obra, 0);
  hay_costos  := coalesce(hay_gastos, false) or coalesce(mano_obra, 0) > 0;

  return next;
end $$;

grant execute on function rentabilidad_ot(bigint) to authenticated;


-- Comprobación
-- select nombre, cargo, area_default, usuario_id is not null as enlazado from colaboradores order by id;
-- select * from resumen_mano_obra(current_date);
-- select * from resumen_rentabilidad(current_date);
