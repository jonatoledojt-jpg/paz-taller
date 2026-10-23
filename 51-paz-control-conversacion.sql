-- 51-paz-control-conversacion.sql
-- EL PUENTE ENTRE LOS DOS HEMISFERIOS DE PAZ (decisión de Jonatan, 23-10-2026).
--
-- PAZ es una sola, con dos hemisferios: el que habla con el CLIENTE
-- (supabase/functions/whatsapp) y el que te asiste a TI y al equipo
-- (supabase/functions/paz-asistente). Ya compartían la "libreta" (la base:
-- casos, mensajes, memoria), pero NO compartían tu VOLUNTAD: si le decías al
-- hemisferio-equipo "yo llevo a este cliente, no le hables", el hemisferio-
-- cliente no se enteraba y seguía respondiendo. No es que fueran dos PAZ
-- distintas; es que les faltaba un nervio que conectara los dos lados.
--
-- Esto es ese nervio: una señal por conversación que el hemisferio-equipo
-- escribe y el hemisferio-cliente lee antes de responder. Cuando está
-- silenciada, el lado cliente NO contesta solo (el equipo la lleva), pero
-- SIGUE OBSERVANDO: guarda los mensajes y arma los casos. Un hemisferio en
-- reposo no queda ciego — solo deja de hablar.

alter table nexa_conversaciones
  add column if not exists paz_silenciada boolean not null default false,
  add column if not exists silenciada_por text,
  add column if not exists silenciada_en timestamptz,
  add column if not exists silenciada_motivo text;

comment on column nexa_conversaciones.paz_silenciada is
  'Puente de hemisferios (ver 51): si true, el lado cliente de PAZ NO responde solo en esta conversación — el equipo la lleva. Igual guarda mensajes y arma casos (sigue observando). Lo enciende/apaga el lado equipo (paz-asistente) cuando el dueño/equipo dice "yo llevo a este cliente" / "retomá".';
