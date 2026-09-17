-- ============================================================
-- PAZ ahora transcribe los audios que manda el cliente por WhatsApp
-- (whatsapp/index.ts, transcribirAudio) en vez de ignorarlos -- en un
-- taller de terreno, un cliente describiendo la falla por audio es
-- tan común como escribir, y antes PAZ seguía la conversación a
-- ciegas con solo "[el cliente envió audio, revísalo en WhatsApp]".
--
-- El audio igual se guarda como adjunto (mismo camino que una foto),
-- para poder escucharlo si la transcripción falla o queda dudosa.
-- nexa_archivos.categoria tenía un check que no incluía audio; sin
-- este cambio, guardar el adjunto habría fallado silenciosamente
-- (el error solo queda en el log, no interrumpe la conversación).
-- ============================================================

alter table nexa_archivos drop constraint if exists nexa_archivos_categoria_check;
alter table nexa_archivos add constraint nexa_archivos_categoria_check
  check (categoria in ('foto_cliente','captura_cliente','ubicacion','otro','audio_cliente'));

-- Comprobación:
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'nexa_archivos'::regclass and contype = 'c';
