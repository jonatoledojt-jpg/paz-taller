-- 49-caso-telefono.sql — el teléfono como identidad del caso (21-10-2026)
--
-- Idea de Jonatan: el nombre del cliente es ambiguo ("Pablo", "Pablo Tapia",
-- "cliente viña" pueden ser la misma persona). El TELÉFONO es el identificador
-- de oro. El teléfono vive en la conversación de WhatsApp; acá lo copiamos
-- también al caso para que sea explícito y PAZ sepa, por el número, que varios
-- nombres son la misma persona.

alter table casos add column if not exists telefono text;

-- Backfill: copiar el teléfono de la conversación a cada caso que no lo tenga.
update casos c
   set telefono = con.telefono
  from nexa_conversaciones con
 where con.id = c.conversacion_id
   and con.telefono is not null
   and (c.telefono is null or c.telefono = '');

-- Trigger: todo caso nuevo (o que cambie de conversación) hereda solo el
-- teléfono de su conversación. Así nunca más hay que acordarse de ponerlo.
create or replace function caso_set_telefono()
returns trigger language plpgsql as $$
begin
  if new.conversacion_id is not null then
    select telefono into new.telefono
      from nexa_conversaciones where id = new.conversacion_id;
  end if;
  return new;
end $$;

drop trigger if exists tg_caso_telefono on casos;
create trigger tg_caso_telefono
  before insert or update of conversacion_id on casos
  for each row execute function caso_set_telefono();
