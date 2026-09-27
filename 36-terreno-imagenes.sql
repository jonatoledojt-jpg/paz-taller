-- 36-terreno-imagenes.sql
-- "Ojos" para el agente de Diagnóstico de Terreno (27-09-2026).
--
-- Pedido de Jonatan: que el agente pueda VER imágenes de la pantalla del
-- escáner -- los códigos de falla y, si hay, datos en vivo. La IA lee la
-- imagen LITERAL (códigos y valores tal cual se ven), no diagnostica ni
-- inventa; ese texto se suma a la transcripción del caso.
--
-- Las imágenes se guardan en un bucket privado propio (aparte de las de las
-- OT), con la ruta obligatoria `<usuario_id>/archivo.jpg` -- misma idea que
-- gastos-comprobantes. Solo el dueño, solo su carpeta.

-- Rutas de las imágenes guardadas (en el bucket terreno-adjuntos).
alter table terreno_diagnosticos
  add column if not exists imagenes text[] not null default '{}';

-- Bucket privado.
insert into storage.buckets (id, name, public)
values ('terreno-adjuntos', 'terreno-adjuntos', false)
on conflict (id) do nothing;

-- RLS de Storage: dueño, y solo su propia carpeta (primer segmento = su uid).
drop policy if exists terreno_adj_leer on storage.objects;
create policy terreno_adj_leer on storage.objects for select
  using (bucket_id = 'terreno-adjuntos' and mi_rol() = 'dueno'
         and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists terreno_adj_crear on storage.objects;
create policy terreno_adj_crear on storage.objects for insert
  with check (bucket_id = 'terreno-adjuntos' and mi_rol() = 'dueno'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists terreno_adj_borrar on storage.objects;
create policy terreno_adj_borrar on storage.objects for delete
  using (bucket_id = 'terreno-adjuntos' and mi_rol() = 'dueno'
         and (storage.foldername(name))[1] = auth.uid()::text);
