-- ============================================================
-- Defaults de seguridad para los cuatro ejes (17-09-2026).
-- El front ya los escribe siempre al crear una OT, pero varias
-- consultas filtran con .neq("comercial","rechazado") -- en SQL,
-- NULL <> 'rechazado' da NULL, no verdadero, así que una fila con
-- comercial null quedaría afuera de las listas por accidente. Los
-- defaults son la red de seguridad para cualquier insert que no
-- pase por el front (SQL Editor, un futuro RPC, etc.).
-- ============================================================

alter table ordenes alter column reparacion set default 'por_diagnosticar';
alter table ordenes alter column comercial  set default 'sin_cotizar';
