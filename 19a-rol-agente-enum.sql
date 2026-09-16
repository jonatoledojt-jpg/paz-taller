-- Postgres exige que un valor nuevo de enum se confirme en su propia
-- transacción antes de poder usarse — por eso va en un archivo aparte,
-- que se corre antes de 19b-rol-agente-rpc.sql.
do $$ begin
  alter type rol_usuario add value if not exists 'agente';
exception when duplicate_object then null; end $$;
