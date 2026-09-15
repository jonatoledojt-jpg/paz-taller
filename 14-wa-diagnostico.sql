-- ============================================================
-- Testigo temporal en la puerta del webhook de WhatsApp.
-- Registra TODO lo que llega, incluso lo que se rechaza, para
-- poder distinguir "Meta no nos llama" de "nos llama y algo
-- falla de nuestro lado".
--
-- ESTO ES TEMPORAL. Borrar la tabla y sacar el registro de la
-- Edge Function cuando la conexión quede andando.
-- ============================================================

create table if not exists wa_log (
  id         bigint generated always as identity primary key,
  metodo     text,
  firma_ok   boolean,
  nota       text,
  cuerpo     text,
  creado_en  timestamptz not null default now()
);

create index if not exists wa_log_fecha_idx on wa_log (creado_en desc);

alter table wa_log enable row level security;

-- Solo el dueño. Trae texto de conversaciones de clientes.
drop policy if exists leer_wa_log on wa_log;
create policy leer_wa_log on wa_log for select to authenticated
  using (mi_rol() = 'dueno');

-- select creado_en, metodo, firma_ok, nota, left(cuerpo, 300)
--   from wa_log order by creado_en desc limit 20;
