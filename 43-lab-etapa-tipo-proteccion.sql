-- 43: el paquete rev4 agrega el tipo de etapa 'proteccion' (rueda libre,
-- snubbers, TVS...). Se amplía el check de ecu_etapas.tipo.
alter table ecu_etapas drop constraint if exists ecu_etapas_tipo_check;
alter table ecu_etapas add constraint ecu_etapas_tipo_check
  check (tipo in ('entrada','logica','potencia','proteccion','salida','diag'));
