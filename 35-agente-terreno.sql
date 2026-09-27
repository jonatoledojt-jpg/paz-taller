-- 35-agente-terreno.sql
-- Agente de Diagnóstico de Terreno (STANDALONE).
--
-- Pedido de Jonatan (27-09-2026): un botón limpio en Herramientas,
-- "Diagnóstico de terreno", que es la ÚNICA entrada. NO se mezcla con las
-- OT ni con el informe: guarda en SU PROPIA tabla, aparte. El objetivo de
-- fondo es capturar el criterio de diagnóstico de Jonatan (hoy el cuello de
-- botella) para, más adelante, asistir al técnico en terreno sin llamarlo
-- cada vez -- justo lo que mide `diagnosticos.requirio_remoto`.
--
-- Fase 1 (hoy): SOLO el dueño. Habla por voz, la IA transcribe (Whisper),
-- ordena la ficha y le pregunta lo que falta. Cada diagnóstico real queda
-- documentado. Fase 2 (después): el técnico le pregunta y el agente responde
-- desde estos casos. Por eso hoy la RLS es dueño puro -- se abrirá cuando
-- toque, no antes (fallar cerrado).
--
-- La TRANSCRIPCIÓN es la fuente de verdad (las palabras reales del técnico);
-- la ficha estructurada es cómo la IA la ordena -- mismo criterio que PAZ
-- (mensajes = verdad, ficha = organización). La IA no inventa: ordena lo que
-- se dijo y pregunta lo que falta.

create table if not exists terreno_diagnosticos (
  id              bigint generated always as identity primary key,
  creado_por      uuid not null default auth.uid() references perfiles(id),
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now(),

  -- Ficha estructurada (la arma la IA desde la transcripción; editable).
  vehiculo        text,
  patente         text,
  codigo          text,          -- código de falla del escáner
  sintoma         text,          -- qué reportó / qué hacía el camión
  reviso          text,          -- qué se revisó / midió
  hallazgo        text,          -- qué se encontró
  causa           text,          -- causa determinada
  solucion        text,          -- qué lo solucionó
  requirio_remoto boolean,       -- ¿hubo que entrar por Xentry / remoto?
  resumen         text,          -- una línea para leer de un vistazo

  -- La fuente de verdad: las palabras del técnico (transcripción acumulada).
  transcripcion   text
);

alter table terreno_diagnosticos enable row level security;

-- Toca actualizado_en en cada update.
create or replace function tg_terreno_actualizado()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

drop trigger if exists tg_terreno_actualizado on terreno_diagnosticos;
create trigger tg_terreno_actualizado
  before update on terreno_diagnosticos
  for each row execute function tg_terreno_actualizado();

-- RLS: solo el dueño, y solo sus propias filas. mi_rol() en RLS falla
-- CERRADO ante NULL (una condición NULL esconde la fila), así que es seguro
-- sin coalesce -- distinto de un IF de PL/pgSQL (ver 20b-fix-mi-rol-null).
drop policy if exists td_leer on terreno_diagnosticos;
create policy td_leer on terreno_diagnosticos
  for select using (mi_rol() = 'dueno' and creado_por = auth.uid());

drop policy if exists td_crear on terreno_diagnosticos;
create policy td_crear on terreno_diagnosticos
  for insert with check (mi_rol() = 'dueno' and creado_por = auth.uid());

drop policy if exists td_editar on terreno_diagnosticos;
create policy td_editar on terreno_diagnosticos
  for update using (mi_rol() = 'dueno' and creado_por = auth.uid())
           with check (mi_rol() = 'dueno' and creado_por = auth.uid());

-- Es data de entrenamiento: el dueño puede borrar lo que es basura de prueba.
drop policy if exists td_borrar on terreno_diagnosticos;
create policy td_borrar on terreno_diagnosticos
  for delete using (mi_rol() = 'dueno' and creado_por = auth.uid());

create index if not exists ix_terreno_diag_creador
  on terreno_diagnosticos (creado_por, creado_en desc);
