-- ============================================================
-- PAZ — casos estructurados
--
-- El problema que resuelve, observado el 15-09-2026: un cliente
-- reportó un Actros 4144 y después dijo "tengo otro camión con
-- falla". Como había una sola ficha por conversación, el segundo
-- camión pisó al primero y el caso original se perdió.
--
-- Desde acá: la CONVERSACIÓN es el hilo con un teléfono, y
-- adentro puede haber VARIOS CASOS, uno por camión o problema.
--
-- Ejecutar después de 15. Es re-ejecutable y no borra nada:
-- migra las fichas que ya existen a su primer caso.
-- ============================================================

-- ------------------------------------------------------------
-- 1. La tabla
-- ------------------------------------------------------------

do $$ begin
  create type estado_caso as enum (
    'recopilando_datos', 'listo_para_revision', 'convertido_a_ot',
    'archivado', 'cerrado_sin_ot'
  );
exception when duplicate_object then null; end $$;

create table if not exists casos (
  id                        bigint generated always as identity primary key,
  numero_caso               text unique,
  conversacion_id           bigint not null references nexa_conversaciones on delete cascade,

  -- Posición dentro de la conversación. Es la llave con la que se
  -- sincroniza: la IA relee el hilo completo y devuelve los casos en
  -- el orden en que aparecieron, que es estable.
  orden_en_conversacion     int not null default 1,

  estado_caso               estado_caso not null default 'recopilando_datos',

  cliente_id                bigint references clientes on delete set null,
  vehiculo_id               bigint references vehiculos on delete set null,
  orden_id                  bigint references ordenes   on delete set null,

  telefono_whatsapp         text,
  cliente_nombre            text,
  patente                   text,
  vehiculo_marca            text,
  vehiculo_modelo           text,
  vehiculo_anio             text,

  ubicacion_texto           text,
  ubicacion_gps             text,

  atencion                  text check (atencion in ('terreno','envio')),
  falla_reportada           text,
  codigos_reportados        text,
  sistema                   text,
  modulo                    text,
  se_desplaza               boolean,
  trabajos_previos          text,
  resumen_tecnico           text,

  -- Lo que falta y lo que no calza. Van en jsonb porque cambian
  -- seguido y no vale la pena migrar la tabla cada vez.
  faltantes                 jsonb not null default '[]'::jsonb,
  conflictos                jsonb not null default '[]'::jsonb,

  tiene_fotos               boolean not null default false,

  -- Alertas: cuando PAZ no puede seguir sola.
  requiere_respuesta_humana boolean not null default false,
  motivo_alerta             text,
  alerta_creada_en          timestamptz,
  atendida_por              uuid references perfiles,
  atendida_en               timestamptz,

  archivado                 boolean not null default false,
  creado_en                 timestamptz not null default now(),
  actualizado_en            timestamptz not null default now(),

  constraint casos_pos_unica unique (conversacion_id, orden_en_conversacion)
);

create index if not exists casos_conv_idx     on casos (conversacion_id, orden_en_conversacion);
create index if not exists casos_patente_idx  on casos (patente) where patente is not null;
create index if not exists casos_abiertos_idx on casos (actualizado_en desc) where not archivado;
create index if not exists casos_alerta_idx   on casos (alerta_creada_en desc) where requiere_respuesta_humana;


-- ------------------------------------------------------------
-- 2. Correlativo CASO-2026-0001, reinicia cada año.
--    Mismo criterio que las OT: un número que se puede decir por
--    teléfono sin deletrear.
-- ------------------------------------------------------------

create or replace function tg_numero_caso()
returns trigger language plpgsql as $$
declare
  anio text := to_char(now(), 'YYYY');
  siguiente int;
begin
  if new.numero_caso is not null then return new; end if;
  select coalesce(max(substring(numero_caso from 11)::int), 0) + 1
    into siguiente
    from casos
   where numero_caso like 'CASO-' || anio || '-%';
  new.numero_caso := 'CASO-' || anio || '-' || lpad(siguiente::text, 4, '0');
  return new;
end $$;

drop trigger if exists trg_numero_caso on casos;
create trigger trg_numero_caso before insert on casos
  for each row execute function tg_numero_caso();


create or replace function tg_casos_tocar()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  -- Cuando alguien atiende la alerta, queda constancia de quién.
  if old.requiere_respuesta_humana and not new.requiere_respuesta_humana
     and new.atendida_en is null then
    new.atendida_en := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_casos_tocar on casos;
create trigger trg_casos_tocar before update on casos
  for each row execute function tg_casos_tocar();


-- ------------------------------------------------------------
-- 3. Los archivos ahora pueden colgar del caso, no solo de la
--    conversación: si el cliente manda la foto del segundo camión,
--    tiene que quedar en el caso del segundo camión.
-- ------------------------------------------------------------

alter table nexa_archivos add column if not exists caso_id bigint references casos on delete cascade;
create index if not exists nexa_archivos_caso_idx on nexa_archivos (caso_id);


-- ------------------------------------------------------------
-- 4. Migrar lo que ya existe. Cada conversación con ficha se
--    convierte en su primer caso. No se pierde nada.
-- ------------------------------------------------------------

insert into casos (
  conversacion_id, orden_en_conversacion, telefono_whatsapp,
  cliente_nombre, patente, vehiculo_modelo, vehiculo_anio,
  ubicacion_texto, ubicacion_gps, atencion, falla_reportada,
  codigos_reportados, sistema, modulo, tiene_fotos, orden_id, creado_en
)
select
  c.id, 1, c.telefono,
  nullif(c.ficha->>'cliente',''),
  upper(nullif(c.ficha->>'patente','')),
  nullif(c.ficha->>'vehiculo',''),
  nullif(c.ficha->>'anio',''),
  coalesce(nullif(c.ficha->>'ubicacion',''), c.ubicacion_texto),
  c.ubicacion_gps,
  nullif(c.ficha->>'atencion',''),
  nullif(c.ficha->>'sintoma',''),
  nullif(c.ficha->>'codigo',''),
  nullif(c.ficha->>'sistema',''),
  nullif(c.ficha->>'modulo',''),
  c.tiene_fotos, c.orden_id, c.creado_en
from nexa_conversaciones c
where c.ficha is not null
  and c.ficha <> '{}'::jsonb
  and not exists (select 1 from casos k where k.conversacion_id = c.id);


-- ------------------------------------------------------------
-- 5. RLS. Mismo criterio que el resto de PAZ: dueño y coordinador.
--    El técnico no entra — son casos comerciales, con precios y
--    decisiones de agenda de por medio.
-- ------------------------------------------------------------

alter table casos enable row level security;

drop policy if exists leer_casos on casos;
create policy leer_casos on casos for select to authenticated
  using (mi_rol() in ('dueno','coordinador'));

drop policy if exists esc_casos on casos;
create policy esc_casos on casos for all to authenticated
  using (mi_rol() in ('dueno','coordinador'))
  with check (mi_rol() in ('dueno','coordinador'));


-- ------------------------------------------------------------
-- 6. Instrucciones de la ficha: ahora devuelve VARIOS casos.
--    Acá estaba el error de fondo: se pedía un solo objeto, así
--    que el segundo camión sobrescribía al primero.
-- ------------------------------------------------------------

update nexa_config set prompt_ficha =
'Lee la conversación completa y devuelve SOLO un objeto JSON, sin texto alrededor, con esta forma exacta:
{"casos":[{"cliente":null,"telefono":null,"vehiculo":null,"anio":null,"patente":null,"ubicacion":null,"atencion":null,"modulo":null,"sistema":null,"codigo":null,"sintoma":null,"se_desplaza":null,"trabajos_previos":null,"resumen":null,"faltantes":[],"conflictos":[],"requiere_humano":false,"motivo_alerta":null}]}

UN CASO POR VEHÍCULO O PROBLEMA DISTINTO.
Si el cliente habla de dos camiones, devuelve dos casos, en el mismo orden en que aparecieron en la conversación. No mezcles los datos de uno con los del otro. El orden importa: no los reordenes entre una lectura y otra.

Usa null en lo que el cliente todavía no haya dicho. No inventes ni deduzcas datos que no estén en la conversación.
"patente" en mayúsculas y sin puntos ni guiones.
"atencion" es "terreno" si hay que ir donde está el vehículo (visita, revisión, reparación en sitio, retiro del módulo), o "envio" si el cliente va a mandar o traer el módulo al taller. Si todavía no se puede saber, null.
"sistema" es el sistema afectado cuando no hay un módulo identificado: eléctrico, arranque, caja de cambios, neumático, motor, frenos.
"se_desplaza" es true si el camión se mueve, false si quedó detenido, null si no se sabe.
"resumen" es una línea de máximo 140 caracteres que le sirva a un técnico para entender el caso de un vistazo.
"faltantes" es una lista con los nombres de los datos que todavía faltan, en palabras simples: ["patente","ubicación"].
"conflictos" es una lista de textos donde el cliente dijo algo distinto a lo que el sistema ya tenía registrado. Ejemplo: ["El sistema tiene el año 2011, el cliente dice 2018"]. Si no hay, lista vacía.

"requiere_humano" es true SOLO si el cliente necesita una decisión que PAZ no puede tomar: disponibilidad concreta de agenda, precio final cerrado, agendar una visita, un reclamo por demora, o preguntar si ya van en camino. También si hay conflictos sin resolver. En ese caso "motivo_alerta" dice en una línea qué está esperando el cliente. Si no, false y null.'
where id = 1;


-- Comprobación
-- select numero_caso, estado_caso, patente, falla_reportada, requiere_respuesta_humana
--   from casos order by creado_en desc;
