-- ============================================================
-- La pantalla de chat interno de PAZ (Atender un caso nuevo, canal
-- "app") es de antes de que existiera el modelo de casos y el modo
-- aprendizaje: su "Crear la OT desde este caso" llena el formulario
-- de Nueva OT directo desde la ficha de la conversación, sin ningún
-- filtro de modo. Mientras el taller siga en modo aprendizaje
-- (nexa_config.modo_casos_defecto), una conversación de prueba en esa
-- pantalla podía terminar en una OT real, mezclada con las de verdad.
--
-- La tabla `casos` ya resuelve esto para WhatsApp; acá se necesita el
-- mismo criterio pero nexa_config tiene el prompt comercial completo
-- (precios, condiciones) y su RLS es "solo dueño" — el coordinador
-- también usa esta pantalla y no puede leer esa tabla. Esta función
-- expone solo el booleano que hace falta, sin abrir el resto.
-- ============================================================

create or replace function paz_en_entrenamiento()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select modo_casos_defecto = 'aprendizaje' from nexa_config limit 1),
    true
  );
$$;

revoke execute on function paz_en_entrenamiento() from public;
grant execute on function paz_en_entrenamiento() to authenticated;

-- Comprobación: select paz_en_entrenamiento();  -> true mientras dure el
-- mes de entrenamiento (nexa_config.modo_casos_defecto = 'aprendizaje').
