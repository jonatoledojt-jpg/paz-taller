-- ============================================================
-- PAZ SERVICES — Cuarta parte
-- Cotizaciones con líneas de detalle
-- Ejecutar después de 01, 02 y 03
-- ============================================================

-- Una cotización por orden. Para re-cotizar se editan los ítems
-- de la misma cotización (no se versiona).
create table cotizaciones (
  id              bigint generated always as identity primary key,
  orden_id        bigint not null unique references ordenes on delete cascade,
  notas           text,
  creado_por      uuid references perfiles,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

create table cotizacion_items (
  id              bigint generated always as identity primary key,
  cotizacion_id   bigint not null references cotizaciones on delete cascade,
  descripcion     text not null,
  cantidad        numeric(10,2) not null default 1,
  valor_unitario  numeric(12,0) not null default 0,
  orden_item      int not null default 0,
  creado_en       timestamptz not null default now()
);

create index on cotizacion_items (cotizacion_id);


-- ------------------------------------------------------------
-- Mantener ordenes.monto_cotizado = suma de los ítems
-- (mismo criterio que el trigger de numero_ot: la BD es la
-- fuente de verdad, no el front)
-- ------------------------------------------------------------

create or replace function sincronizar_monto_cotizado()
returns trigger
language plpgsql
as $$
declare
  v_cotizacion_id bigint := coalesce(new.cotizacion_id, old.cotizacion_id);
  v_orden_id      bigint;
  v_neto          numeric;
begin
  select orden_id into v_orden_id from cotizaciones where id = v_cotizacion_id;
  select coalesce(sum(cantidad * valor_unitario), 0) into v_neto
    from cotizacion_items where cotizacion_id = v_cotizacion_id;
  update ordenes set monto_cotizado = v_neto where id = v_orden_id;
  return coalesce(new, old);
end $$;

create trigger trg_sincronizar_monto_cotizado
  after insert or update or delete on cotizacion_items
  for each row execute function sincronizar_monto_cotizado();

create or replace function tocar_cotizacion()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en := now();
  return new;
end $$;

create trigger trg_tocar_cotizacion
  before update on cotizaciones
  for each row execute function tocar_cotizacion();


-- ------------------------------------------------------------
-- SEGURIDAD (RLS) — mismo criterio que el resto de lo comercial:
-- todos leen, solo dueño y coordinador escriben.
-- ------------------------------------------------------------

alter table cotizaciones     enable row level security;
alter table cotizacion_items enable row level security;

create policy leer_cotizaciones on cotizaciones for select to authenticated using (true);
create policy leer_cotizacion_items on cotizacion_items for select to authenticated using (true);

create policy esc_cotizaciones on cotizaciones for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

create policy esc_cotizacion_items on cotizacion_items for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));


-- Comprobación
-- select o.numero_ot, o.monto_cotizado, c.id as cotizacion_id
--   from ordenes o join cotizaciones c on c.orden_id = o.id;
