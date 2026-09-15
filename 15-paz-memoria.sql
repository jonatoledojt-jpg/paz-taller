-- ============================================================
-- PAZ — aprendizajes, archivos y ubicación de los casos
--
-- Primera parte del plan de "PAZ conectada a la base":
--   · que el dueño pueda corregir criterios sin tocar código
--   · que las fotos y ubicaciones que manda el cliente no se pierdan
--   · que se puedan archivar conversaciones sin borrarlas
--
-- Ejecutar después de 14. Es re-ejecutable.
--
-- Recordatorio: las tablas se llaman nexa_* por historia. La
-- asistente se llama PAZ. Ver CLAUDE.md.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Aprendizajes: cómo se corrige a PAZ sin reescribir el prompt.
--
--    El prompt es el documento grande de la empresa y se toca
--    poco. Los aprendizajes son correcciones puntuales que el
--    dueño puede prender y apagar desde la app. PAZ los lee
--    antes de cada respuesta.
-- ------------------------------------------------------------

create table if not exists paz_aprendizajes (
  id         bigint generated always as identity primary key,
  tipo       text not null default 'criterio'
             check (tipo in ('criterio','ejemplo','respuesta_aprobada','correccion')),
  titulo     text not null,
  contenido  text not null,
  activo     boolean not null default true,
  creado_por uuid references perfiles,
  creado_en  timestamptz not null default now()
);

create index if not exists paz_aprendizajes_activos_idx
  on paz_aprendizajes (id) where activo;

-- Criterios de arranque. Salen de errores reales observados, no
-- de teoría: por eso cada uno dice qué hacer, no qué evitar.
insert into paz_aprendizajes (tipo, titulo, contenido)
select * from (values
  ('criterio', 'Un código de falla es antecedente, no diagnóstico',
   'Un código leído por el escáner (por ejemplo GS17) es un antecedente del sistema afectado, nunca un diagnóstico definitivo. Dilo así: "lo tomamos como antecedente, pero hay que revisarlo".'),
  ('criterio', 'Si el camión se desplaza, precisar hasta dónde',
   'Cuando el cliente dice que el camión todavía se mueve, preguntar hasta qué marcha llega o bajo qué condición falla. "Se mueve" solo no sirve para preparar la visita.'),
  ('criterio', 'Si mandó ubicación, no pedir dirección escrita',
   'Si el cliente compartió su ubicación por WhatsApp, ya tenemos dónde está. No pedirle la dirección ni la comuna otra vez.'),
  ('criterio', 'No volver a pedir lo que ya tenemos',
   'El teléfono de WhatsApp desde el que escribe ya es su contacto. No preguntarlo. Solo preguntar por otro contacto si el cliente dice que hay que coordinar con otra persona.'),
  ('criterio', 'Caso listo no es visita agendada',
   'Cuando el caso queda completo, decir que queda listo para revisión del equipo y que se le confirmará por este mismo WhatsApp. Nunca dar por agendada una visita ni prometer un horario.'),
  ('criterio', 'Si el dato no calza con lo guardado, no discutir',
   'Si el cliente dice un dato distinto al que tenemos registrado (por ejemplo otro año del vehículo), anotar lo que dice sin contradecirlo y sin corregir la ficha. Lo resuelve una persona después.'),
  ('criterio', 'Fuera de la Región del Maule no hay precio cerrado',
   'Si el vehículo está fuera de la Región del Maule, no dar un valor cerrado por la visita. Decir que el valor se confirma según la distancia.')
) as nuevos(tipo, titulo, contenido)
where not exists (select 1 from paz_aprendizajes);


-- ------------------------------------------------------------
-- 2. Archivos que manda el cliente por WhatsApp.
--
--    La tabla `archivos` cuelga de una OT, y acá todavía no hay
--    OT: el caso nace antes. Por eso van aparte, y cuando el
--    caso se convierta en OT se podrán mostrar desde la orden.
-- ------------------------------------------------------------

create table if not exists nexa_archivos (
  id               bigint generated always as identity primary key,
  conversacion_id  bigint not null references nexa_conversaciones on delete cascade,
  ruta             text not null,
  categoria        text not null default 'foto_cliente'
                   check (categoria in ('foto_cliente','captura_cliente','ubicacion','otro')),
  mime             text,
  wa_media_id      text,
  creado_en        timestamptz not null default now()
);

create index if not exists nexa_archivos_conv_idx on nexa_archivos (conversacion_id);
create unique index if not exists nexa_archivos_media_idx
  on nexa_archivos (wa_media_id) where wa_media_id is not null;


-- ------------------------------------------------------------
-- 3. Ubicación y archivado de la conversación.
-- ------------------------------------------------------------

alter table nexa_conversaciones add column if not exists ubicacion_gps   text;
alter table nexa_conversaciones add column if not exists ubicacion_texto text;
alter table nexa_conversaciones add column if not exists archivado       boolean not null default false;
alter table nexa_conversaciones add column if not exists tiene_fotos     boolean not null default false;

create index if not exists nexa_conv_activas_idx
  on nexa_conversaciones (actualizado_en desc) where not archivado;


-- ------------------------------------------------------------
-- 4. RLS. Mismo criterio que el resto de PAZ: dueño y
--    coordinador. El técnico no entra: son conversaciones
--    comerciales. La Edge Function usa service_role y se las
--    salta, que es donde vive la lógica controlada.
-- ------------------------------------------------------------

alter table paz_aprendizajes enable row level security;
alter table nexa_archivos    enable row level security;

-- Los aprendizajes los lee el coordinador (para entender por qué
-- PAZ contestó algo) pero los edita solo el dueño: son criterio
-- comercial, igual que el prompt.
drop policy if exists leer_paz_aprendizajes on paz_aprendizajes;
create policy leer_paz_aprendizajes on paz_aprendizajes for select to authenticated
  using (mi_rol() in ('dueno','coordinador'));

drop policy if exists esc_paz_aprendizajes on paz_aprendizajes;
create policy esc_paz_aprendizajes on paz_aprendizajes for all to authenticated
  using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');

drop policy if exists leer_nexa_archivos on nexa_archivos;
create policy leer_nexa_archivos on nexa_archivos for select to authenticated
  using (mi_rol() in ('dueno','coordinador'));

drop policy if exists esc_nexa_archivos on nexa_archivos;
create policy esc_nexa_archivos on nexa_archivos for all to authenticated
  using (mi_rol() in ('dueno','coordinador'))
  with check (mi_rol() in ('dueno','coordinador'));


-- ------------------------------------------------------------
-- 5. Bucket privado para lo que manda el cliente.
--    Privado: puede traer patentes, documentos y la ubicación
--    de un camión cargado.
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('paz-adjuntos', 'paz-adjuntos', false)
on conflict (id) do nothing;

drop policy if exists leer_paz_adjuntos on storage.objects;
create policy leer_paz_adjuntos on storage.objects for select to authenticated
  using (bucket_id = 'paz-adjuntos' and mi_rol() in ('dueno','coordinador'));


-- Comprobación
-- select id, tipo, titulo, activo from paz_aprendizajes order by id;
-- select id, canal, telefono, archivado, tiene_fotos, ubicacion_texto
--   from nexa_conversaciones order by creado_en desc limit 10;
