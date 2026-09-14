-- ============================================================
-- PAZ SERVICES — Segunda parte del setup
-- Ejecutar DESPUÉS de schema-paz-services.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Crear perfil automáticamente al crear un usuario
--    (sin esto, un usuario nuevo no puede escribir nada)
-- ------------------------------------------------------------

create or replace function crear_perfil_nuevo_usuario()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.perfiles (id, nombre, rol)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'rol')::rol_usuario, 'tecnico')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists trg_perfil_nuevo on auth.users;
create trigger trg_perfil_nuevo
  after insert on auth.users
  for each row execute function crear_perfil_nuevo_usuario();


-- ------------------------------------------------------------
-- 2. Bucket de archivos (fotos de recepción y capturas)
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('archivos', 'archivos', true)
on conflict (id) do nothing;

create policy "subir archivos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'archivos');

create policy "ver archivos"
  on storage.objects for select to public
  using (bucket_id = 'archivos');

create policy "borrar archivos dueno"
  on storage.objects for delete to authenticated
  using (bucket_id = 'archivos' and mi_rol() = 'dueno');


-- ------------------------------------------------------------
-- 3. Convertirte a ti en dueño
--    Reemplaza el correo por el tuyo y ejecuta DESPUÉS
--    de haber creado tu usuario en Authentication.
-- ------------------------------------------------------------

-- update perfiles set rol = 'dueno', nombre = 'Jonatan Toledo'
--  where id = (select id from auth.users where email = 'TU_CORREO@ejemplo.cl');


-- ------------------------------------------------------------
-- 4. Comprobación rápida
-- ------------------------------------------------------------

-- select id, nombre, rol from perfiles;
-- select numero_ot, estado, origen from ordenes order by id desc limit 10;
