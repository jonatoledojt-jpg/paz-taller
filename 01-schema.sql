-- ============================================================
-- PAZ SERVICES LTDA. — Esquema base
-- Supabase / PostgreSQL
-- Fase 1: clientes, vehículos, órdenes, visitas, diagnósticos
-- ============================================================

-- ------------------------------------------------------------
-- TIPOS
-- ------------------------------------------------------------

create type rol_usuario as enum ('dueno', 'coordinador', 'tecnico');

create type origen_orden as enum ('terreno', 'laboratorio');

create type estado_orden as enum (
  'agendado',
  'en_terreno',
  'resuelto_en_terreno',
  'retirado',
  'recepcionado',
  'en_diagnostico',
  'cotizado',
  'en_reparacion',
  'en_pruebas',
  'listo_entrega',
  'instalado',
  'entregado',
  'facturado',
  'irreparable',
  'rechazado',
  'garantia'
);

create type tipo_visita as enum ('diagnostico', 'retiro', 'instalacion', 'mixta');

create type estado_visita as enum ('agendada', 'confirmada', 'en_ruta', 'realizada', 'reprogramada', 'cancelada');

create type forma_llegada as enum ('cliente_trae', 'encomienda', 'transportista', 'retiro_terreno');


-- ------------------------------------------------------------
-- PERFILES  (extiende auth.users de Supabase)
-- ------------------------------------------------------------

create table perfiles (
  id          uuid primary key references auth.users on delete cascade,
  nombre      text not null,
  rol         rol_usuario not null default 'tecnico',
  telefono    text,
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);

-- Función auxiliar para las políticas RLS
create or replace function mi_rol()
returns rol_usuario
language sql stable security definer
set search_path = public
as $$ select rol from perfiles where id = auth.uid() $$;


-- ------------------------------------------------------------
-- CLIENTES
-- ------------------------------------------------------------

create table clientes (
  id              bigint generated always as identity primary key,
  nombre          text not null,
  rut             text,
  tipo            text,                    -- flota, particular, taller
  contacto        text,
  telefono        text,
  email           text,
  direccion       text,
  ciudad          text,
  notas           text,
  activo          boolean not null default true,
  creado_en       timestamptz not null default now()
);

create index on clientes (nombre);
create index on clientes (rut);


-- ------------------------------------------------------------
-- VEHÍCULOS
-- ------------------------------------------------------------

create table vehiculos (
  id              bigint generated always as identity primary key,
  cliente_id      bigint references clientes on delete set null,
  patente         text not null,
  marca           text default 'Mercedes Benz',
  modelo          text,
  anio            int,
  vin             text,
  motor           text,
  notas           text,
  creado_en       timestamptz not null default now()
);

create unique index on vehiculos (upper(patente));
create index on vehiculos (cliente_id);


-- ------------------------------------------------------------
-- ÓRDENES DE TRABAJO
-- Cada fila es UN TRABAJO, no un módulo físico.
-- Un mismo módulo (numero_serie) puede tener varias órdenes.
-- ------------------------------------------------------------

create table ordenes (
  id                  bigint generated always as identity primary key,
  numero_ot           text unique,          -- se genera por trigger: OT-2026-0001
  origen              origen_orden not null,
  estado              estado_orden not null default 'recepcionado',

  cliente_id          bigint references clientes on delete restrict,
  vehiculo_id         bigint references vehiculos on delete set null,

  -- Identificación del módulo
  tipo_modulo         text,                 -- MR, ADM, GS, FR, PSM...
  numero_serie        text,
  numero_parte        text,

  -- Falla reportada
  sintoma_cliente     text,
  codigos_reportados  text,

  -- Solo laboratorio
  forma_llegada       forma_llegada,
  numero_guia         text,
  recibido_por        uuid references perfiles,

  -- Solo terreno
  kilometraje         int,

  -- Comercial
  monto_cotizado      numeric(12,0),
  monto_final         numeric(12,0),
  aprobado_cliente    boolean default false,
  fecha_aprobacion    timestamptz,
  numero_factura      text,

  -- Garantía
  orden_padre_id      bigint references ordenes on delete set null,

  -- Fechas
  fecha_ingreso       timestamptz not null default now(),
  fecha_compromiso    date,
  fecha_cierre        timestamptz,

  asignado_a          uuid references perfiles,
  notas_internas      text,

  creado_por          uuid references perfiles,
  creado_en           timestamptz not null default now(),
  actualizado_en      timestamptz not null default now()
);

create index on ordenes (estado);
create index on ordenes (cliente_id);
create index on ordenes (numero_serie);
create index on ordenes (fecha_ingreso desc);
create index on ordenes (asignado_a);


-- Correlativo de OT por año
create or replace function generar_numero_ot()
returns trigger
language plpgsql
as $$
declare
  siguiente int;
  anio text := to_char(now(), 'YYYY');
begin
  if new.numero_ot is null then
    select coalesce(max(substring(numero_ot from 9)::int), 0) + 1
      into siguiente
      from ordenes
     where numero_ot like 'OT-' || anio || '-%';
    new.numero_ot := 'OT-' || anio || '-' || lpad(siguiente::text, 4, '0');
  end if;
  return new;
end $$;

create trigger trg_numero_ot
  before insert on ordenes
  for each row execute function generar_numero_ot();


-- ------------------------------------------------------------
-- HISTORIAL DE ESTADOS  (auditoría automática)
-- ------------------------------------------------------------

create table movimientos_estado (
  id            bigint generated always as identity primary key,
  orden_id      bigint not null references ordenes on delete cascade,
  estado_previo estado_orden,
  estado_nuevo  estado_orden not null,
  usuario_id    uuid references perfiles,
  comentario    text,
  ocurrido_en   timestamptz not null default now()
);

create index on movimientos_estado (orden_id, ocurrido_en desc);

create or replace function registrar_cambio_estado()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.estado is distinct from old.estado then
    insert into movimientos_estado (orden_id, estado_previo, estado_nuevo, usuario_id)
    values (new.id, old.estado, new.estado, auth.uid());
    new.actualizado_en := now();
  end if;
  return new;
end $$;

create trigger trg_cambio_estado
  before update on ordenes
  for each row execute function registrar_cambio_estado();


-- ------------------------------------------------------------
-- VISITAS A TERRENO
-- Una visita puede tocar varias órdenes (cliente de flota).
-- ------------------------------------------------------------

create table visitas (
  id                bigint generated always as identity primary key,
  cliente_id        bigint references clientes on delete restrict,
  tipo              tipo_visita not null default 'diagnostico',
  estado            estado_visita not null default 'agendada',

  fecha_programada  date not null,
  hora_programada   time,
  direccion         text,
  ciudad            text,
  contacto_sitio    text,
  telefono_sitio    text,

  tecnico_id        uuid references perfiles,
  orden_ruta        int,                   -- posición en la ruta del día

  km_inicio         int,
  km_termino        int,

  observaciones     text,
  creado_por        uuid references perfiles,
  creado_en         timestamptz not null default now()
);

create index on visitas (fecha_programada, orden_ruta);
create index on visitas (tecnico_id);
create index on visitas (estado);


-- Relación visita <-> orden
create table visita_ordenes (
  visita_id   bigint not null references visitas on delete cascade,
  orden_id    bigint not null references ordenes on delete cascade,
  accion      text not null,               -- diagnostico, retiro, instalacion
  primary key (visita_id, orden_id, accion)
);


-- ------------------------------------------------------------
-- DIAGNÓSTICOS  ← el activo de la empresa
-- Cada intento de diagnóstico, con lo que se probó y el resultado.
-- Esto alimenta la app de códigos GS.
-- ------------------------------------------------------------

create table diagnosticos (
  id                bigint generated always as identity primary key,
  orden_id          bigint not null references ordenes on delete cascade,

  tipo_modulo       text,
  sintoma           text not null,
  codigos_falla     text[],                -- {'2001-002','4F35-004'}

  pruebas_realizadas text,
  causa_raiz        text,
  solucion          text,
  componente        text,                  -- transistor, condensador, pista...

  resuelto          boolean default false,
  requirio_remoto   boolean default false, -- ¿tuvo que entrar el dueño a Xentry?
  tiempo_minutos    int,

  tecnico_id        uuid references perfiles,
  creado_en         timestamptz not null default now()
);

create index on diagnosticos (orden_id);
create index on diagnosticos (tipo_modulo);
create index on diagnosticos using gin (codigos_falla);


-- ------------------------------------------------------------
-- ARCHIVOS  (fotos de recepción, capturas de escáner, informes)
-- Los binarios van a Supabase Storage; acá va la referencia.
-- ------------------------------------------------------------

create table archivos (
  id            bigint generated always as identity primary key,
  orden_id      bigint references ordenes on delete cascade,
  visita_id     bigint references visitas on delete cascade,
  diagnostico_id bigint references diagnosticos on delete cascade,
  categoria     text not null,             -- recepcion, captura_scanner, reparacion, entrega, informe
  ruta_storage  text not null,
  descripcion   text,
  subido_por    uuid references perfiles,
  creado_en     timestamptz not null default now()
);

create index on archivos (orden_id);


-- ------------------------------------------------------------
-- VISTAS ÚTILES
-- ------------------------------------------------------------

-- Tablero del taller: todo lo que no está cerrado
create view v_tablero as
select
  o.id,
  o.numero_ot,
  o.origen,
  o.estado,
  c.nombre        as cliente,
  v.patente,
  o.tipo_modulo,
  o.numero_serie,
  o.sintoma_cliente,
  o.fecha_ingreso,
  o.fecha_compromiso,
  p.nombre        as asignado,
  extract(day from now() - o.fecha_ingreso)::int as dias_en_taller
from ordenes o
left join clientes c on c.id = o.cliente_id
left join vehiculos v on v.id = o.vehiculo_id
left join perfiles p on p.id = o.asignado_a
where o.estado not in ('facturado', 'entregado', 'instalado', 'resuelto_en_terreno', 'rechazado');


-- Historial de un módulo físico por número de serie
create view v_historial_modulo as
select
  o.numero_serie,
  o.numero_ot,
  o.fecha_ingreso,
  o.estado,
  c.nombre as cliente,
  d.sintoma,
  d.causa_raiz,
  d.solucion
from ordenes o
left join clientes c on c.id = o.cliente_id
left join diagnosticos d on d.orden_id = o.id
where o.numero_serie is not null
order by o.numero_serie, o.fecha_ingreso desc;


-- Base de conocimiento: fallas resueltas, para la app de códigos GS
create view v_conocimiento as
select
  d.tipo_modulo,
  d.codigos_falla,
  d.sintoma,
  d.causa_raiz,
  d.solucion,
  d.componente,
  count(*) over (partition by d.tipo_modulo, d.causa_raiz) as veces_vista,
  d.creado_en
from diagnosticos d
where d.resuelto = true
  and d.causa_raiz is not null;


-- ------------------------------------------------------------
-- SEGURIDAD (RLS)
-- ------------------------------------------------------------

alter table perfiles            enable row level security;
alter table clientes            enable row level security;
alter table vehiculos           enable row level security;
alter table ordenes             enable row level security;
alter table movimientos_estado  enable row level security;
alter table visitas             enable row level security;
alter table visita_ordenes      enable row level security;
alter table diagnosticos        enable row level security;
alter table archivos            enable row level security;

-- Todo usuario autenticado lee
create policy leer_perfiles       on perfiles           for select to authenticated using (true);
create policy leer_clientes       on clientes           for select to authenticated using (true);
create policy leer_vehiculos      on vehiculos          for select to authenticated using (true);
create policy leer_ordenes        on ordenes            for select to authenticated using (true);
create policy leer_movimientos    on movimientos_estado for select to authenticated using (true);
create policy leer_visitas        on visitas            for select to authenticated using (true);
create policy leer_visita_ordenes on visita_ordenes     for select to authenticated using (true);
create policy leer_diagnosticos   on diagnosticos       for select to authenticated using (true);
create policy leer_archivos       on archivos           for select to authenticated using (true);

-- Dueño y coordinador escriben en lo operativo
create policy esc_clientes  on clientes  for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

create policy esc_vehiculos on vehiculos for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

create policy esc_visitas   on visitas   for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

create policy esc_ordenes   on ordenes   for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

-- El técnico puede avanzar el estado de las órdenes asignadas a él
create policy tecnico_actualiza_orden on ordenes for update to authenticated
  using (asignado_a = auth.uid()) with check (asignado_a = auth.uid());

-- Cualquiera registra diagnósticos y sube archivos
create policy esc_diagnosticos on diagnosticos for all to authenticated
  using (true) with check (true);

create policy esc_archivos on archivos for all to authenticated
  using (true) with check (true);

create policy esc_visita_ordenes on visita_ordenes for all to authenticated
  using (mi_rol() in ('dueno','coordinador')) with check (mi_rol() in ('dueno','coordinador'));

-- Solo el dueño edita perfiles (roles)
create policy esc_perfiles on perfiles for all to authenticated
  using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');


-- ------------------------------------------------------------
-- LISTO.
-- Los precios especiales, la asistencia y los pagos van en una
-- segunda migración, con RLS restringido solo al dueño.
-- ------------------------------------------------------------
