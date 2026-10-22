-- 50-paz-memoria-cliente.sql
-- La MEMORIA VIVA de PAZ por cliente, anclada al TELÉFONO.
--
-- Por qué existe (decisión de Jonatan, 22-10-2026): "la memoria a los humanos
-- nos da la comprensión; sin memoria no puedo comprender el contexto de nada".
-- Hasta hoy PAZ re-leía la conversación COMPLETA en cada mensaje para entender
-- el contexto -- caro, lento, y a los 5 meses o si el chat se borra, se perdía.
-- Una ficha de 15 campos era una FOTO, no memoria: botaba la textura (que el
-- cliente ya lo trajo dos veces, que quedó molesto, que el camión es del
-- hermano). Esto le da memoria de verdad: un relato que PAZ escribe con sus
-- palabras, crece en cada interacción, y VIVE EN NUESTRA BASE -- no en el
-- WhatsApp del cliente. Sobrevive a los 5 meses y al borrado del chat.
--
-- Llave = teléfono (la identidad del cliente, el índice para recuperar la
-- memoria). Durable e independiente del ciclo de vida de la conversación: si
-- una conversación se cierra y se abre otra para el mismo número, la memoria
-- (por teléfono) sigue ahí.
--
-- El transcript crudo sigue en nexa_mensajes como ARCHIVO para consultar un
-- detalle exacto; el día a día corre sobre esta memoria consolidada.

create table if not exists paz_memoria (
  telefono            text primary key,
  memoria             text not null default '',
  cliente_nombre      text,
  -- marcador del último mensaje de nexa_mensajes ya "digerido" en la memoria:
  -- en cada consolidación se leen SOLO los mensajes posteriores a este id y se
  -- actualiza. Así no se re-lee toda la conversación cada vez (memoria incremental).
  ultimo_mensaje_id   bigint,
  creada_en           timestamptz not null default now(),
  actualizada_en      timestamptz not null default now()
);

comment on table paz_memoria is
  'Memoria viva de PAZ por cliente (llave: teléfono). Relato consolidado que da comprensión del contexto, durable e independiente del chat. Ver 50-paz-memoria-cliente.sql.';

alter table paz_memoria enable row level security;

-- Lectura: dueño, coordinador y el propio agente PAZ (necesita leer su memoria
-- para armar el contexto de cada respuesta). El técnico NO.
drop policy if exists leer_paz_memoria on paz_memoria;
create policy leer_paz_memoria on paz_memoria
  for select using (mi_rol() in ('dueno','coordinador','agente'));

-- Corrección manual: solo el dueño puede editar/corregir lo que PAZ recuerda
-- (para enderezar la memoria si se desvía). PAZ no escribe directo: lo hace por
-- la RPC de abajo. Sin política de insert/delete abierta a nadie más.
drop policy if exists corregir_paz_memoria on paz_memoria;
create policy corregir_paz_memoria on paz_memoria
  for update using (mi_rol() = 'dueno') with check (mi_rol() = 'dueno');

-- PAZ actualiza su memoria SOLO por acá (security definer, guardado por el
-- mismo verificador de agente que el resto de las RPC paz_*). Recibe parámetros
-- explícitos, nunca un JSON libre volcado a la tabla. El marcador avanza nomás
-- (greatest) para no retroceder si llegan pasadas fuera de orden.
create or replace function paz_actualizar_memoria(
  p_telefono text,
  p_memoria text,
  p_ultimo_mensaje_id bigint default null,
  p_cliente_nombre text default null
) returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform paz_verificar_agente();
  if p_telefono is null or length(trim(p_telefono)) = 0 then
    raise exception 'Falta el teléfono.';
  end if;
  if p_memoria is null then
    raise exception 'Falta la memoria.';
  end if;

  insert into paz_memoria (telefono, memoria, cliente_nombre, ultimo_mensaje_id, actualizada_en)
  values (p_telefono, p_memoria, p_cliente_nombre, p_ultimo_mensaje_id, now())
  on conflict (telefono) do update
    set memoria = excluded.memoria,
        cliente_nombre = coalesce(excluded.cliente_nombre, paz_memoria.cliente_nombre),
        ultimo_mensaje_id = greatest(coalesce(excluded.ultimo_mensaje_id, 0), coalesce(paz_memoria.ultimo_mensaje_id, 0)),
        actualizada_en = now();
end $$;

revoke all on function paz_actualizar_memoria(text, text, bigint, text) from public, anon;
grant execute on function paz_actualizar_memoria(text, text, bigint, text) to authenticated;
