-- ============================================================
-- Backfill de los cuatro ejes nuevos (25-cuatro-ejes-estado.sql)
-- contra las OT reales que ya existían. Solo llena filas donde
-- ubicacion todavía es null -- correr de nuevo no pisa nada que
-- ya se haya migrado ni nada que ya se haya escrito por el front
-- nuevo.
--
-- Aproximado a propósito en un solo punto: `pagado_en` para OT
-- que ya estaban `facturado` antes de que existiera esta columna
-- usa `coalesce(fecha_cierre, actualizado_en)` como la fecha más
-- cercana que hay -- no es el momento exacto del cobro, es lo
-- mejor que queda registrado. De acá en adelante, la pantalla de
-- Facturar va a escribir el momento real.
--
-- `comercial`: si el estado ya avanzó más allá de "cotizado"
-- (entró a reparación, pruebas, quedó listo, o se facturó), eso
-- ya prueba que el cliente aprobó -- no se usó el booleano
-- `aprobado_cliente` porque en las OT reales de hoy quedó en
-- false: el estado se avanzó con "Cambiar estado manualmente" en
-- vez de pasar por el botón "Cliente aprobó la cotización".
-- ============================================================

update ordenes set
  ubicacion = case
    when tipo_trabajo = 'servicio' then null
    when estado in ('agendado','en_terreno') then 'con_cliente'
    when estado = 'retirado' then 'en_transito'
    when estado in ('recepcionado','en_diagnostico','cotizado','en_reparacion','en_pruebas','listo_entrega') then 'en_taller'
    when estado in ('instalado','resuelto_en_terreno','entregado') then 'entregado'
    when estado = 'facturado' then (case when entregado_en is not null then 'entregado' else 'en_taller' end)
    when estado = 'irreparable' then 'en_taller'
    when estado = 'rechazado' then 'en_taller'
    when estado = 'garantia' then 'entregado'
  end::ubicacion_ot,
  reparacion = case
    when estado in ('agendado','en_terreno','retirado','recepcionado') then 'por_diagnosticar'
    when estado = 'en_diagnostico' then 'en_diagnostico'
    when estado = 'cotizado' then 'diagnosticado'
    when estado = 'en_reparacion' then 'en_reparacion'
    when estado = 'en_pruebas' then 'en_pruebas'
    when estado in ('listo_entrega','instalado','entregado','resuelto_en_terreno','facturado','garantia') then 'listo'
    when estado = 'irreparable' then 'irreparable'
    when estado = 'rechazado' then 'diagnosticado'
  end::reparacion_estado,
  comercial = case
    when estado in ('agendado','en_terreno','retirado','recepcionado','en_diagnostico') then 'sin_cotizar'
    when estado = 'cotizado' then 'cotizado'
    when estado in ('en_reparacion','en_pruebas','listo_entrega','instalado','entregado','resuelto_en_terreno','facturado','garantia') then 'aprobado'
    when estado = 'rechazado' then 'rechazado'
    when estado = 'irreparable' then 'sin_cotizar'
  end::comercial_estado,
  pagado_en = case when estado = 'facturado' then coalesce(fecha_cierre, actualizado_en) end
where ubicacion is null and reparacion is null and comercial is null;
