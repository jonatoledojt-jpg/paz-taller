-- Informe técnico redactado con IA desde el historial de la OT (25-09-2026).
-- La IA solo ORDENA y REDACTA lo que ya existe; no diagnostica ni agrega
-- hechos (ver Edge Function supabase/functions/informe y la sección
-- "INFORME AUTOMÁTICO" en CLAUDE.md).
--
-- Esta tabla es el RASTRO DE AUDITORÍA: qué texto generó la IA, con qué
-- historial (hash, para no regenerar si no cambió), quién lo aprobó y
-- cuándo -- así se puede comparar el texto de la IA contra el texto final
-- que editó la persona. El texto final editable sigue viviendo en
-- `diagnosticos` (que es lo que lee el informe imprimible); acá se guarda
-- una copia congelada al momento de aprobar, para poder auditar cambios.

create table if not exists informes_ia (
  id            bigint generated always as identity primary key,
  orden_id      bigint not null references ordenes on delete cascade,
  fuente_hash   text not null,          -- hash del historial que se le mandó a la IA
  borrador_ia   jsonb not null,         -- {trabajos_realizados, causa_falla, advertencias_internas}
  generado_por  uuid references perfiles,
  generado_en   timestamptz not null default now(),
  texto_final   jsonb,                  -- snapshot al aprobar: lo que quedó en el informe
  aprobado_por  uuid references perfiles,
  aprobado_en   timestamptz
);

create index if not exists informes_ia_orden_idx  on informes_ia (orden_id, generado_en desc);
create index if not exists informes_ia_autor_idx  on informes_ia (generado_por, generado_en desc);

alter table informes_ia enable row level security;

-- Solo dueño y coordinador. El técnico no redacta informes con IA (y cada
-- llamada cuesta). Sin política de delete a propósito: es auditoría, no se
-- borra. `generado_por = auth.uid()` en el insert impide anotar a nombre de
-- otro. El texto_final/aprobado_* se completan por update al guardar.
drop policy if exists leer_informes_ia on informes_ia;
create policy leer_informes_ia on informes_ia for select to authenticated
  using (mi_rol() in ('dueno', 'coordinador'));

drop policy if exists crear_informes_ia on informes_ia;
create policy crear_informes_ia on informes_ia for insert to authenticated
  with check (mi_rol() in ('dueno', 'coordinador') and generado_por = auth.uid());

drop policy if exists editar_informes_ia on informes_ia;
create policy editar_informes_ia on informes_ia for update to authenticated
  using (mi_rol() in ('dueno', 'coordinador'))
  with check (mi_rol() in ('dueno', 'coordinador'));
