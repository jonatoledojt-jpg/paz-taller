-- Auditoría 26-09-2026. Cierra tres huecos de RLS y agrega el conteo de uso
-- de IA para el tope del Redactor.

-- ── #3: diagnosticos y archivos tenían FOR ALL using(true) ──
-- Cualquier autenticado (técnico, o la sesión del rol agente PAZ) podía
-- UPDATE/DELETE filas AJENAS -- vaciar/adulterar la base de conocimiento
-- (diagnosticos alimenta v_conocimiento) o los registros de fotos de
-- cualquier OT. Se separa: leer todos, INSERT abierto (el técnico registra
-- su diagnóstico / sube fotos), pero UPDATE/DELETE acotado.

-- diagnosticos
drop policy if exists esc_diagnosticos on diagnosticos;
drop policy if exists leer_diagnosticos on diagnosticos;
drop policy if exists crear_diagnosticos on diagnosticos;
drop policy if exists editar_diagnosticos on diagnosticos;
drop policy if exists borrar_diagnosticos on diagnosticos;

create policy leer_diagnosticos on diagnosticos for select to authenticated
  using (true);
create policy crear_diagnosticos on diagnosticos for insert to authenticated
  with check (true);
-- Editar: dueño/coordinador siempre; el técnico solo el diagnóstico de una
-- OT asignada a él (así el "Informe técnico" del técnico sigue funcionando).
create policy editar_diagnosticos on diagnosticos for update to authenticated
  using (
    mi_rol() in ('dueno','coordinador')
    or exists (select 1 from ordenes o where o.id = diagnosticos.orden_id and o.asignado_a = auth.uid())
  )
  with check (
    mi_rol() in ('dueno','coordinador')
    or exists (select 1 from ordenes o where o.id = diagnosticos.orden_id and o.asignado_a = auth.uid())
  );
-- Borrar: solo el dueño (es "el activo de la empresa").
create policy borrar_diagnosticos on diagnosticos for delete to authenticated
  using (mi_rol() = 'dueno');

-- archivos
drop policy if exists esc_archivos on archivos;
drop policy if exists leer_archivos on archivos;
drop policy if exists crear_archivos on archivos;
drop policy if exists editar_archivos on archivos;
drop policy if exists borrar_archivos on archivos;

create policy leer_archivos on archivos for select to authenticated
  using (true);
create policy crear_archivos on archivos for insert to authenticated
  with check (true);
-- Editar/borrar: dueño/coordinador, o quien subió el archivo.
create policy editar_archivos on archivos for update to authenticated
  using (mi_rol() in ('dueno','coordinador') or subido_por = auth.uid())
  with check (mi_rol() in ('dueno','coordinador') or subido_por = auth.uid());
create policy borrar_archivos on archivos for delete to authenticated
  using (mi_rol() in ('dueno','coordinador') or subido_por = auth.uid());

-- ── #9: movimientos_estado tenía insert with check(true) ──
-- Se podía forjar historial atribuido a otra persona. Ahora el insert exige
-- usuario_id = auth.uid(). El trigger registrar_cambio_estado ya inserta con
-- auth.uid() (01-schema.sql), así que los cambios de estado legítimos siguen.
drop policy if exists escribir_movimientos on movimientos_estado;
create policy escribir_movimientos on movimientos_estado for insert to authenticated
  with check (usuario_id = auth.uid());

-- ── #7: tope por hora del Redactor IA no cubría analizar/mejorar ──
-- El contador miraba informes_ia, que solo escribe "redactar". Ahora cada
-- llamada a la IA (analizar/redactar/mejorar) deja una fila acá y el tope se
-- cuenta de esta tabla. Solo dueño/coordinador (los únicos que usan el
-- Redactor); se escribe desde la Edge Function con la sesión del usuario.
create table if not exists ia_uso (
  id          bigint generated always as identity primary key,
  usuario_id  uuid references perfiles,
  accion      text,
  creado_en   timestamptz not null default now()
);
create index if not exists ia_uso_autor_idx on ia_uso (usuario_id, creado_en desc);
alter table ia_uso enable row level security;

drop policy if exists leer_ia_uso on ia_uso;
create policy leer_ia_uso on ia_uso for select to authenticated
  using (mi_rol() in ('dueno','coordinador'));
drop policy if exists crear_ia_uso on ia_uso;
create policy crear_ia_uso on ia_uso for insert to authenticated
  with check (usuario_id = auth.uid() and mi_rol() in ('dueno','coordinador'));
