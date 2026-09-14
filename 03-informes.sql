-- ============================================================
-- PAZ SERVICES — Tercera parte
-- Cierre de OT e informe técnico
-- Ejecutar después de 01 y 02
-- ============================================================

-- Observaciones que van al informe del cliente
-- (distintas de notas_internas, que el cliente no ve)
alter table ordenes add column if not exists observaciones text;

-- Permiso que faltaba: el trigger de historial necesita poder escribir
create policy escribir_movimientos
  on movimientos_estado for insert to authenticated
  with check (true);

-- Comprobación
-- select numero_ot, monto_final, observaciones from ordenes;
