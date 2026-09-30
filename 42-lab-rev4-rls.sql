-- 42-lab-rev4-rls.sql
-- RLS de las tablas nuevas del paquete rev4 (equivalencias, reglas de banco,
-- realimentación) + columna circuitos en componentes (para "en qué circuitos
-- aparece" en el buscador de componentes).

-- Cross-referencia componente -> circuitos donde aparece (viene en el paquete).
alter table ecu_componentes add column if not exists circuitos text[] not null default '{}';

alter table ecu_equivalencias enable row level security;
drop policy if exists ecu_equiv_leer on ecu_equivalencias;
create policy ecu_equiv_leer on ecu_equivalencias for select using (ve_laboratorio());

alter table ecu_reglas_banco enable row level security;
drop policy if exists ecu_reglas_leer on ecu_reglas_banco;
create policy ecu_reglas_leer on ecu_reglas_banco for select using (ve_laboratorio());

-- Realimentación del taller: laboratorio lee y crea; el dueño resuelve (marca
-- confirmado/descartado/corregido).
alter table ecu_feedback enable row level security;
drop policy if exists ecu_feedback_leer on ecu_feedback;
create policy ecu_feedback_leer on ecu_feedback for select using (ve_laboratorio());
drop policy if exists ecu_feedback_crear on ecu_feedback;
create policy ecu_feedback_crear on ecu_feedback for insert with check (ve_laboratorio());
drop policy if exists ecu_feedback_resolver on ecu_feedback;
create policy ecu_feedback_resolver on ecu_feedback for update
  using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');
