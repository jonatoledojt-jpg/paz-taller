-- ============================================================
-- PAZ SERVICES — Séptima parte
-- Permitir más de una cotización por orden (se guardan todas,
-- no se sobrescriben). La más reciente es la que se edita; las
-- anteriores quedan de solo lectura para verlas/imprimirlas.
-- Ejecutar después de 04-cotizaciones.sql.
-- Es seguro correrlo aunque ya lo hayas hecho.
-- ============================================================

alter table cotizaciones drop constraint if exists cotizaciones_orden_id_key;

create index if not exists cotizaciones_orden_id_idx on cotizaciones (orden_id, creado_en desc);

-- El trigger sincronizar_monto_cotizado (04-cotizaciones.sql) no cambia:
-- solo se editan los ítems de la cotización más reciente, así que
-- ordenes.monto_cotizado siempre queda igual al último precio ofrecido.

-- Comprobación
-- select id, orden_id, creado_en from cotizaciones order by orden_id, creado_en desc;
