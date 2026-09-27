-- 38-lab-rls.sql
-- RLS para el agente de Diagnóstico de Laboratorio (tablas ecu_*, ver 37).
--
-- El esquema del paquete MCM2.1 venía sin políticas de acceso (probado en
-- PostgreSQL puro). En Supabase todo va con RLS. Lo usan Diego (encargado de
-- laboratorio) y Jonatan (dueño) -- por eso el candado es ese, no cualquier
-- coordinador. Osores (coordinación general) no lo usa.
--
-- Los datos de referencia (módulo, componentes, pines, hojas, zonas,
-- circuitos, etapas, ramas, mediciones, síntomas, códigos, canales PV) son
-- SOLO LECTURA para la app: se cargan por CLI (que salta RLS). Lo único que
-- el taller escribe es `ecu_casos` (sus diagnósticos) y, más adelante, el
-- `valor_medido` de `ecu_mediciones` (el levantamiento con placa sana).

create or replace function ve_laboratorio() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from perfiles
    where id = auth.uid()
      and (rol = 'dueno' or (rol = 'coordinador' and area = 'laboratorio'))
  );
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'ecu_modulos','ecu_componentes','ecu_pines','ecu_hojas','ecu_zonas_placa',
    'ecu_circuitos','ecu_etapas','ecu_ramas','ecu_mediciones','ecu_sintomas',
    'ecu_sintoma_circuitos','ecu_sintoma_pasos','ecu_codigos','ecu_canales_pv','ecu_casos'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_leer', t);
    execute format('create policy %I on %I for select using (ve_laboratorio())', t||'_leer', t);
  end loop;
end $$;

-- El taller escribe sus casos.
drop policy if exists ecu_casos_crear on ecu_casos;
create policy ecu_casos_crear on ecu_casos
  for insert with check (ve_laboratorio());
drop policy if exists ecu_casos_editar on ecu_casos;
create policy ecu_casos_editar on ecu_casos
  for update using (ve_laboratorio()) with check (ve_laboratorio());

-- El levantamiento (valor_medido en placa sana) lo llena el taller. La app
-- va a pasar por un RPC acotado; por ahora se abre el update a laboratorio.
drop policy if exists ecu_mediciones_medir on ecu_mediciones;
create policy ecu_mediciones_medir on ecu_mediciones
  for update using (ve_laboratorio()) with check (ve_laboratorio());
