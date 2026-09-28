-- 40-lab-conversaciones.sql
-- Guardar las conversaciones del agente de Diagnóstico de Laboratorio.
--
-- Pedido de Jonatan (28-09-2026): que no vivan solo en el teléfono. Se
-- persisten en la base para poder revisarlas y para que sean material de
-- aprendizaje del taller. Es conocimiento compartido del laboratorio:
-- dueño y encargado de laboratorio ven todas; cada uno edita/borra las suyas.

create table if not exists ecu_conversaciones (
  id             uuid primary key default gen_random_uuid(),
  autor          uuid not null default auth.uid() references perfiles(id),
  titulo         text,
  mensajes       jsonb not null default '[]',
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table ecu_conversaciones enable row level security;

-- Reusa el trigger genérico de 35-agente-terreno (setea actualizado_en).
drop trigger if exists tg_ecu_conv_actualizado on ecu_conversaciones;
create trigger tg_ecu_conv_actualizado
  before update on ecu_conversaciones
  for each row execute function tg_terreno_actualizado();

drop policy if exists ecu_conv_leer on ecu_conversaciones;
create policy ecu_conv_leer on ecu_conversaciones
  for select using (ve_laboratorio());
drop policy if exists ecu_conv_crear on ecu_conversaciones;
create policy ecu_conv_crear on ecu_conversaciones
  for insert with check (ve_laboratorio() and autor = auth.uid());
drop policy if exists ecu_conv_editar on ecu_conversaciones;
create policy ecu_conv_editar on ecu_conversaciones
  for update using (ve_laboratorio() and autor = auth.uid())
           with check (ve_laboratorio() and autor = auth.uid());
drop policy if exists ecu_conv_borrar on ecu_conversaciones;
create policy ecu_conv_borrar on ecu_conversaciones
  for delete using (ve_laboratorio() and autor = auth.uid());

create index if not exists ix_ecu_conv_autor on ecu_conversaciones (autor, actualizado_en desc);
