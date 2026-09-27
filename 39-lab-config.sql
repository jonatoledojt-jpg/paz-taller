-- 39-lab-config.sql
-- Config del agente de Diagnóstico de Laboratorio.
-- El prompt (know-how de diagnóstico) NO va en el repo público: se carga
-- aparte con un update, igual que nexa_config.prompt. La tabla queda con RLS
-- y SIN políticas: solo el service_role (la Edge Function) la lee.

create table if not exists ecu_config (
  id     int primary key default 1,
  prompt text,
  modelo text,
  constraint ecu_config_una_fila check (id = 1)
);

alter table ecu_config enable row level security;

insert into ecu_config (id, prompt, modelo) values (1, null, null)
on conflict (id) do nothing;
