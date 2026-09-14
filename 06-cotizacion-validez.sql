-- ============================================================
-- PAZ SERVICES — Sexta parte
-- Días de validez de la cotización, para el documento formal.
-- Ejecutar después de 04-cotizaciones.sql (y 05, si ya la corriste).
-- Es seguro correrlo aunque la columna ya exista.
-- ============================================================

alter table cotizaciones
  add column if not exists validez_dias int not null default 15;

-- Comprobación
-- select id, orden_id, validez_dias, creado_en from cotizaciones;
