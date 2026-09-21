-- Diego (laboratorio) y Jonatan Osores (coordinación) son los dos
-- "coordinador" -- el rol solo no alcanza para distinguirlos. Se necesita
-- para el aviso de "Pendientes" (21-09-2026): Diego solo debe ver módulos
-- por recepcionar (su área), Jonny solo casos por agendar de PAZ (la suya).
-- El dueño ve las dos áreas igual, sin filtro.
--
-- Reusa area_gasto (ya existe en 11-gastos.sql: terreno/laboratorio/
-- coordinacion/administracion) en vez de crear un enum nuevo -- mismo
-- criterio de "usar lo que ya estaba" que orden_padre_id.
alter table perfiles add column if not exists area area_gasto;

update perfiles set area = 'laboratorio'  where nombre = 'Diego Toledo';
update perfiles set area = 'coordinacion' where nombre = 'Jonatan Osores';
