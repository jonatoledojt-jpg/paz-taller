-- MCM2.1 — esquema para la app de Paz Services (Supabase / PostgreSQL)
-- Revisión 2: cubre circuitos, etapas, ramas, mediciones, componentes,
-- pinout, hojas, zonas de placa, síntomas, códigos y casos.

create extension if not exists pgcrypto;

create table if not exists ecu_modulos (
  id            text primary key,
  nombre        text not null,
  variante      text,
  parte_final   text,
  parte_semi    text,
  parte_pcb     text,
  procesador    text,
  fpga          text,
  fuente        text,
  nota_variante text
);

create table if not exists ecu_componentes (
  modulo_id      text not null references ecu_modulos(id) on delete cascade,
  designador     text not null,
  nombre         text,
  parte          text,
  familia        text,
  encapsulado    text,
  valor          text,
  descripcion    text,
  hoja           int,
  hojas_posibles int[],
  primary key (modulo_id, designador)
);
create index if not exists ecu_componentes_busqueda_idx on ecu_componentes
  using gin (to_tsvector('spanish', coalesce(nombre,'') || ' ' || coalesce(descripcion,'')));

create table if not exists ecu_pines (
  modulo_id     text not null references ecu_modulos(id) on delete cascade,
  pin           int not null,
  descripcion   text,
  descripcion_original text,
  grupo         text,
  sistema       text,
  en_uso        boolean default true,
  primary key (modulo_id, pin)
);

create table if not exists ecu_hojas (
  modulo_id     text not null references ecu_modulos(id) on delete cascade,
  n             int not null,
  titulo        text,
  tipo          text,
  rango_designadores text,
  bloques       text[],
  primary key (modulo_id, n)
);

create table if not exists ecu_zonas_placa (
  modulo_id     text not null references ecu_modulos(id) on delete cascade,
  n             int not null,
  titulo        text,
  hoja          int,
  nota          text,
  caja_x        numeric, caja_y numeric, caja_w numeric, caja_h numeric,
  primary key (modulo_id, n)
);

create table if not exists ecu_circuitos (
  id            text primary key,
  modulo_id     text not null references ecu_modulos(id) on delete cascade,
  titulo        text not null,
  subtitulo     text,
  hoja          int,
  funcion       text,
  alimentacion  text,
  cobertura     text,
  svg           text,
  svg_w         int,
  svg_h         int,
  nota          text,
  origen        text,
  -- lo que el texto menciona pero el dibujo no muestra: la app no debe
  -- ofrecer abrir la ficha de algo que no se ve en el SVG
  no_dibujados_componentes text[],
  no_dibujados_puntos      text[],
  dibujados_en_el_svg      text[],
  -- componentes que el circuito nombra y que NO figuran en el listado de fábrica
  sin_ficha_en_el_listado  text[],
  verificacion             jsonb
);

create table if not exists ecu_etapas (
  circuito_id   text not null references ecu_circuitos(id) on delete cascade,
  n             int not null,
  nombre        text not null,
  tipo          text check (tipo in ('entrada','logica','potencia','salida','diag')),
  senal_entra   text,
  senal_sale    text,
  componentes   text[],
  puntos_prueba text[],
  descripcion   text,
  que_revisar   text,
  primary key (circuito_id, n)
);

create table if not exists ecu_ramas (
  circuito_id   text not null references ecu_circuitos(id) on delete cascade,
  nombre        text not null,
  nodo          text,
  componentes   text[],
  puntos_prueba text[],
  detalle       text,
  primary key (circuito_id, nombre)
);

create table if not exists ecu_mediciones (
  circuito_id    text not null references ecu_circuitos(id) on delete cascade,
  punto          text not null,
  que_es         text,
  valor_esperado text,
  base           text check (base in ('componente','esquema','nombre_senal','supuesto','topologia')),
  nota           text,
  valor_medido   text,          -- lo que el taller midió en una placa sana
  medido_por     text,
  medido_en      timestamptz,
  primary key (circuito_id, punto)
);

create table if not exists ecu_sintomas (
  id            text primary key,
  modulo_id     text references ecu_modulos(id),
  titulo        text not null,
  detalle       text,
  severidad     text,
  hojas         int[],
  zonas_placa   int[],
  componentes   text[],
  nota          text
);

create table if not exists ecu_sintoma_circuitos (
  sintoma_id    text not null references ecu_sintomas(id) on delete cascade,
  circuito_id   text not null references ecu_circuitos(id) on delete cascade,
  primary key (sintoma_id, circuito_id)
);

create table if not exists ecu_sintoma_pasos (
  sintoma_id    text not null references ecu_sintomas(id) on delete cascade,
  n             int not null,
  titulo        text,
  detalle       text,
  primary key (sintoma_id, n)
);

create table if not exists ecu_codigos (
  codigo             text primary key,
  texto              text not null,
  circuito_id        text references ecu_circuitos(id),
  componente_externo text,
  tipo_falla         text
);

create table if not exists ecu_casos (
  id                  uuid primary key default gen_random_uuid(),
  modulo_id           text references ecu_modulos(id),
  circuito_id         text references ecu_circuitos(id),
  codigo              text references ecu_codigos(codigo),
  texto_scanner       text,
  condiciones         text,
  hipotesis           text,   -- lo que se sospecha, sin confirmar
  hallazgo_confirmado text,   -- solo lo comprobado con la placa en el banco
  accion              text,
  resultado           text check (resultado in ('resuelto','no resuelto','en proceso')),
  autor               text,
  creado_en           timestamptz default now()
);
create index if not exists ecu_casos_codigo_idx on ecu_casos (codigo);


-- Canales de válvulas proporcionales de la hoja 11.
-- Los 18 canales de los rieles PV_B1 y PV_B2, con su cadena completa.
-- Sirve para que la app arme la ficha de cualquier canal sin dibujarlos todos:
-- la topología es la misma, solo cambian los designadores y el pin de salida.
create table if not exists ecu_canales_pv (
  canal            text primary key,           -- PWM1 … PWM18
  riel             text not null,              -- PV_B1 o PV_B2
  circuito_id      text references ecu_circuitos(id),
  pre_driver       text not null,              -- I5020 / I5021 / I5022
  pin_in           int,
  pin_drn          int,
  pin_gat          int,
  buffer           text,                       -- null en los canales sin buffer
  buffer_canal     text,
  r_puerta         text,
  mosfet           text,
  diodo            text,
  r_sensado        text,
  c_salida         text not null,
  pin_x0120        int,
  poblado          boolean not null default true,
  tp_puerta        text,
  tp_entrada_mosfet text,
  tp_drenaje       text,
  tp_salida        text,
  tp_entrada_buffer text
);
create index if not exists ecu_canales_pv_riel_idx on ecu_canales_pv (riel);
create index if not exists ecu_canales_pv_pin_idx  on ecu_canales_pv (pin_x0120);
