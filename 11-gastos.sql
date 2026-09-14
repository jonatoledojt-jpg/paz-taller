-- ============================================================
-- PAZ SERVICES — Gastos y rentabilidad
-- Reemplaza la app externa de Gastos (localStorage, sin nube).
-- Ejecutar después de 01 a 10.
-- Es re-ejecutable: se puede correr dos veces sin romperse.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tipos
-- ------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_type where typname = 'area_gasto') then
    create type area_gasto as enum ('terreno', 'laboratorio', 'coordinacion', 'administracion');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'medio_pago_gasto') then
    create type medio_pago_gasto as enum ('efectivo', 'transferencia', 'tarjeta', 'credito_proveedor');
  end if;
end $$;


-- ------------------------------------------------------------
-- 2. Gastos
--    El usuario escribe monto_total (lo que dice la boleta).
--    neto e IVA los calcula la base, no la pantalla.
-- ------------------------------------------------------------

create table if not exists gastos (
  id                bigint generated always as identity primary key,
  usuario_id        uuid references perfiles(id),
  fecha             date not null default current_date,
  monto_total       numeric(12,0) not null,
  monto_neto        numeric(12,0) not null default 0,
  iva_credito       numeric(12,0) not null default 0,
  tiene_factura     boolean not null default false,
  categoria         text not null,
  area              area_gasto not null,
  descripcion       text,
  medio_pago        medio_pago_gasto not null,
  orden_id          bigint references ordenes(id) on delete set null,
  ruta_comprobante  text,
  anulado           boolean not null default false,
  fecha_anulacion   timestamptz,
  motivo_anulacion  text,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);

create index if not exists gastos_usuario_fecha_idx on gastos (usuario_id, fecha desc);
create index if not exists gastos_orden_idx         on gastos (orden_id);
create index if not exists gastos_fecha_idx         on gastos (fecha);
create index if not exists gastos_area_idx          on gastos (area);
create index if not exists gastos_categoria_idx     on gastos (categoria);
create index if not exists gastos_activos_idx       on gastos (fecha desc) where not anulado;


-- Dueño del gasto y cálculo de IVA: en la base, no en el front.
-- Nadie registra un gasto a nombre de otro, ni cambiándolo después.
create or replace function tg_gastos_usuario_y_montos()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.usuario_id := auth.uid();
  else
    new.usuario_id := old.usuario_id;
  end if;

  if new.tiene_factura then
    new.monto_neto  := round(new.monto_total / 1.19);
    new.iva_credito := new.monto_total - new.monto_neto;
  else
    new.monto_neto  := new.monto_total;
    new.iva_credito := 0;
  end if;

  new.actualizado_en := now();
  return new;
end $$;

drop trigger if exists trg_gastos_usuario_y_montos on gastos;
create trigger trg_gastos_usuario_y_montos
  before insert or update on gastos
  for each row execute function tg_gastos_usuario_y_montos();


-- ------------------------------------------------------------
-- 3. Costos fijos mensuales (arriendo, cuentas, etc.)
--    Solo del dueño. Un registro por mes; mes = día 1.
-- ------------------------------------------------------------

create table if not exists costos_fijos_mensuales (
  id              bigint generated always as identity primary key,
  mes             date not null unique,
  monto           numeric(12,0) not null default 0,
  notas           text,
  creado_por      uuid references perfiles(id),
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 4. RLS — cada uno ve lo suyo; el dueño ve todo.
--    No hay política de DELETE en gastos: no se borra historial
--    financiero desde la app, se anula.
-- ------------------------------------------------------------

alter table gastos                  enable row level security;
alter table costos_fijos_mensuales  enable row level security;

drop policy if exists leer_gastos on gastos;
create policy leer_gastos on gastos for select to authenticated
  using (mi_rol() = 'dueno' or (usuario_id = auth.uid() and not anulado));

drop policy if exists crear_gastos on gastos;
create policy crear_gastos on gastos for insert to authenticated
  with check (usuario_id = auth.uid());

-- El USING deja editar solo los no anulados (propios); el WITH CHECK
-- permite que el resultado quede anulado — si no, anular fallaría.
drop policy if exists editar_gastos on gastos;
create policy editar_gastos on gastos for update to authenticated
  using (mi_rol() = 'dueno' or (usuario_id = auth.uid() and not anulado))
  with check (mi_rol() = 'dueno' or usuario_id = auth.uid());

drop policy if exists esc_costos_fijos on costos_fijos_mensuales;
create policy esc_costos_fijos on costos_fijos_mensuales for all to authenticated
  using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');


-- ------------------------------------------------------------
-- 5. Comprobantes: bucket PRIVADO.
--    Pueden traer RUT, proveedor, dirección, patente.
--    Ruta obligatoria: usuario_id/gasto_id/archivo.jpg
--    La primera carpeta es el usuario, y de ahí cuelga el permiso.
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('gastos-comprobantes', 'gastos-comprobantes', false)
on conflict (id) do nothing;

drop policy if exists "gastos subir comprobante" on storage.objects;
create policy "gastos subir comprobante" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'gastos-comprobantes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "gastos ver comprobante" on storage.objects;
create policy "gastos ver comprobante" on storage.objects for select to authenticated
  using (
    bucket_id = 'gastos-comprobantes'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.mi_rol() = 'dueno')
  );

-- Sin política de delete: los comprobantes no se borran desde la app.


-- ------------------------------------------------------------
-- 6. Rentabilidad — solo dueño.
--    Va por función porque ordenes.monto_final y monto_cotizado
--    tienen el SELECT revocado a nivel de columna (08-terreno.sql):
--    nadie los lee directo de la tabla.
--    Todo en NETO, que es el criterio del proyecto.
--
--    "Comprometido" y "facturado" se devuelven por separado y
--    NUNCA se suman: una cotización aprobada es una promesa, no
--    plata cobrada.
-- ------------------------------------------------------------

create or replace function resumen_rentabilidad(p_mes date)
returns table (
  comprometido  numeric,
  facturado     numeric,
  gastos_netos  numeric,
  costo_fijo    numeric,
  margen        numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ini date := date_trunc('month', p_mes)::date;
  v_fin date := (date_trunc('month', p_mes) + interval '1 month' - interval '1 day')::date;
begin
  if mi_rol() <> 'dueno' then
    raise exception 'Solo el dueño puede ver la rentabilidad';
  end if;

  -- Pipeline completo, sin filtro de mes: es lo aprobado y no cobrado.
  select coalesce(sum(o.monto_cotizado), 0) into comprometido
    from ordenes o
   where o.aprobado_cliente
     and o.estado not in ('facturado', 'rechazado');

  select coalesce(sum(o.monto_final), 0) into facturado
    from ordenes o
   where o.estado = 'facturado'
     and o.fecha_cierre::date between v_ini and v_fin;

  select coalesce(sum(g.monto_neto), 0) into gastos_netos
    from gastos g
   where not g.anulado and g.fecha between v_ini and v_fin;

  select coalesce(sum(c.monto), 0) into costo_fijo
    from costos_fijos_mensuales c where c.mes = v_ini;

  margen := facturado - gastos_netos - costo_fijo;
  return next;
end $$;

grant execute on function resumen_rentabilidad(date) to authenticated;


-- Margen de una OT. También solo dueño: el coordinador no ve los
-- gastos de los demás, así que para él el margen saldría incompleto
-- y eso es peor que no mostrarlo.
create or replace function rentabilidad_ot(p_orden_id bigint)
returns table (
  ingreso       numeric,
  tipo_ingreso  text,
  monto_gastos  numeric,
  hay_gastos    boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_estado    estado_orden;
  v_aprobado  boolean;
  v_final     numeric;
  v_cotizado  numeric;
begin
  if mi_rol() <> 'dueno' then
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

  return next;
end $$;

grant execute on function rentabilidad_ot(bigint) to authenticated;


-- Comprobación
-- select * from resumen_rentabilidad(current_date);
-- select usuario_id, count(*), sum(monto_neto) from gastos where not anulado group by 1;
