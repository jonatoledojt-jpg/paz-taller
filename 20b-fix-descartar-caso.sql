-- ============================================================
-- Corrige un hueco real en paz_descartar_caso: usaba
-- `mi_rol() <> 'dueno'` para rechazar a cualquiera que no fuera el
-- dueño. Pero mi_rol() devuelve NULL para quien no tiene sesión
-- (la anon key sola, sin iniciar sesión) o cuyo id no está en
-- perfiles — y en SQL, NULL <> 'dueno' es NULL, no verdadero. Un
-- `if NULL then` no entra, así que la excepción nunca se lanzaba
-- y la llamada seguía de largo.
--
-- Comprobado en vivo: una llamada anónima, con solo la anon key
-- (pública, está en el index.html), logró descartar un caso real.
-- Se corrigió y se restauró el caso afectado en el mismo momento.
--
-- Ejecutar después de 20-modo-aprendizaje.sql. Re-ejecutable.
-- ============================================================

create or replace function paz_descartar_caso(p_caso_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(mi_rol()::text, '') <> 'dueno' then
    raise exception 'Solo el dueño puede descartar un caso de entrenamiento.';
  end if;
  update casos set descartado = true, descartado_en = now(), descartado_por = auth.uid()
   where id = p_caso_id;
end $$;

-- Comprobación: con la anon key sola, esto debe fallar con
-- "Solo el dueño puede descartar un caso de entrenamiento."
-- select paz_descartar_caso(1);
