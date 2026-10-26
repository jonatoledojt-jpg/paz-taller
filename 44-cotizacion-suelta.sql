-- ============================================================
--  PAZ SERVICES — Cotización suelta (sin OT)
--
--  Pedido de Jonatan (26-10-2026): un botón en Herramientas para
--  COTIZAR sin crear OT, para clientes que solo quieren precio
--  (no han pedido visita ni diagnóstico de módulos). Después, desde
--  la propia cotización, se puede "Generar OT" (el front engancha la
--  cotización a la OT nueva en el mismo paso).
--
--  El cotizado que cuelga de una OT NO se toca -- esto es aditivo.
--
--  Cómo queda:
--  - orden_id pasa a ser NULLABLE (una cotización suelta no tiene OT).
--    El trigger recalcular_monto_cotizado(p_orden_id) ya maneja el
--    caso null (sale temprano), así que no hay que tocarlo.
--  - Se guardan en la propia fila los datos que la cotización formal
--    necesita cuando no hay OT: razón social, RUT, dirección y el
--    sistema a cotizar (camión / módulo). Los valores van NETOS; el
--    IVA se suma solo al total (en el front, igual que siempre).
--
--  OJO -- grants por COLUMNA: `cotizaciones` tiene grants columna por
--  columna para `authenticated` (igual que `ordenes`), así que las
--  columnas nuevas NO se leen/escriben solas: hay que otorgarlas
--  explícito o el front no las podría usar (mismo gotcha de 08-terreno).
--
--  RLS: sin cambios. `leer_cotizaciones` y `esc_cotizaciones` ya
--  exigen mi_rol() in ('dueno','coordinador'); el técnico no ve ni
--  escribe cotizaciones (sueltas o no). La política no filtra por
--  orden_id, así que cubre las sueltas igual.
-- ============================================================

alter table cotizaciones alter column orden_id drop not null;

alter table cotizaciones add column if not exists cliente_nombre    text;
alter table cotizaciones add column if not exists cliente_rut       text;
alter table cotizaciones add column if not exists cliente_direccion text;
alter table cotizaciones add column if not exists sistema_cotizado  text;

grant select (cliente_nombre, cliente_rut, cliente_direccion, sistema_cotizado) on cotizaciones to authenticated;
grant insert (cliente_nombre, cliente_rut, cliente_direccion, sistema_cotizado) on cotizaciones to authenticated;
grant update (cliente_nombre, cliente_rut, cliente_direccion, sistema_cotizado) on cotizaciones to authenticated;
