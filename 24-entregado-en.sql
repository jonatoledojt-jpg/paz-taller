-- ============================================================
-- Segunda vuelta del mismo problema del 17-09-2026: "facturado" está en
-- CERRADOS (esconde la OT del tablero) sin mirar si el módulo salió de
-- verdad del taller. Pasó en vivo dos veces: OT-2026-0007 (Naranjo) y
-- OT-2026-0019 (Logística y transportes Jar spa) se facturaron saltándose
-- "entregado" -- cobrar antes de que el cliente retire es válido (pasa
-- seguido), pero el módulo seguía físicamente en el taller y la OT
-- desapareció igual.
--
-- La corrección anterior (sacar "entregado" de CERRADOS) no alcanza: el
-- problema no es el orden en que pasan las cosas, es que "esconder la OT"
-- no puede depender solo del estado actual cuando el estado se puede
-- saltar. Hace falta un hecho aparte: ¿salió el módulo? -- independiente
-- de si ya se cobró o no.
-- ============================================================

alter table ordenes add column if not exists entregado_en timestamptz;

-- 08-terreno.sql revocó el select de toda la tabla ordenes para
-- "authenticated" y otorga columna por columna -- cualquier columna nueva
-- necesita este mismo grant explícito o nadie la puede leer desde el front.
grant select (entregado_en) on ordenes to authenticated;

-- Se llenan las que ya pasaron por "entregado" de verdad, según el
-- historial real (movimientos_estado). Las que se saltaron ese paso
-- (Naranjo, Jar spa) quedan en null a propósito: es la verdad, el módulo
-- nunca salió por ese camino.
update ordenes o set entregado_en = (
  select min(m.ocurrido_en) from movimientos_estado m
   where m.orden_id = o.id and m.estado_nuevo = 'entregado'
)
where o.entregado_en is null
  and exists (
    select 1 from movimientos_estado m
     where m.orden_id = o.id and m.estado_nuevo = 'entregado'
  );

-- Comprobación:
-- select numero_ot, estado, entregado_en from ordenes
--  where origen = 'laboratorio' and tipo_trabajo = 'modulo'
--    and estado in ('entregado','facturado');
