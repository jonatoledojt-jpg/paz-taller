-- ============================================================
-- Separar "estado" en sus cuatro preguntas independientes
-- (17-09-2026, propuesta de Jonatan después de un día entero
-- arreglando el mismo patrón de bug una y otra vez)
--
-- Hoy `estado` es una sola lista de 16 valores que mezcla:
--   1. dónde está el módulo físicamente (ubicación)
--   2. qué se le ha hecho técnicamente (reparación)
--   3. qué dijo el cliente sobre el precio (comercial)
--   4. si entró la plata (pago)
-- Cada bug de hoy (Garantía antes de tiempo, Agenda sobrando,
-- "Pagada" con el flujo completo hacia atrás, "facturado sin
-- entregar") salió de esa misma mezcla.
--
-- Este archivo es ADITIVO A PROPÓSITO: agrega columnas nuevas,
-- no toca `estado` ni nada que ya esté funcionando. El plan es
-- que el front se reescriba para leer las columnas nuevas, y
-- recién ahí -- probado y revisado -- se deja `estado` como
-- historial/respaldo sin que nada dependa de él.
-- ============================================================

create type ubicacion_ot as enum (
  'con_cliente',   -- el módulo sigue en el camión / con el cliente, nadie lo tiene todavía
  'en_transito',   -- el técnico ya lo retiró, viene camino al taller
  'en_taller',     -- está físicamente en el taller
  'entregado'      -- ya volvió al cliente (instalado, resuelto en terreno, o entregado desde el taller)
);

create type reparacion_estado as enum (
  'por_diagnosticar',
  'en_diagnostico',
  'diagnosticado',   -- diagnóstico listo, a la espera de que el cliente responda la cotización
  'en_reparacion',
  'en_pruebas',
  'listo',
  'irreparable'
);

create type comercial_estado as enum (
  'sin_cotizar',
  'cotizado',
  'aprobado',
  'rechazado'
);

alter table ordenes add column if not exists ubicacion   ubicacion_ot;
alter table ordenes add column if not exists reparacion  reparacion_estado;
alter table ordenes add column if not exists comercial   comercial_estado;
alter table ordenes add column if not exists pagado_en   timestamptz;

comment on column ordenes.ubicacion  is 'Dónde está el objeto físicamente. Null en terreno+servicio (no hay módulo que mover).';
comment on column ordenes.reparacion is 'Qué se le ha hecho técnicamente al módulo, sin mirar plata ni ubicación.';
comment on column ordenes.comercial  is 'Qué dijo el cliente sobre el precio. Independiente de si ya se hizo el trabajo.';
comment on column ordenes.pagado_en  is 'Cuándo entró la plata. Null = no pagado. Reemplaza a estado=facturado.';

-- El técnico ya podía leer/escribir estado -- estas columnas nuevas
-- necesitan el mismo grant, o quedan invisibles para él (mismo
-- candado que ordenes.monto_cotizado/monto_final, ver 08-terreno.sql).
grant select (ubicacion, reparacion, comercial, pagado_en) on ordenes to authenticated;
