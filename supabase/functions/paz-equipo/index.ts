// PAZ le habla al equipo por WhatsApp (20-10-2026).
//
// Esta función NO atiende clientes (eso es `whatsapp`). Corre por cron
// (pg_cron la llama cada ~15 min) y hace tres cosas con el equipo —
// Jonatan (dueño), Diego (laboratorio), Osores (coordinación), en la tabla
// paz_equipo (ver 44-paz-equipo.sql):
//
//   1. SALUDO MATUTINO (~8 AM hora Chile): le manda a cada uno su saludo.
//   2. CUIDA-VENTANA: si saludó y la persona no respondió en ~1.5h, le
//      manda UN recordatorio para que conteste y no se cierre la ventana
//      de 24h de WhatsApp (sin esa ventana, PAZ no les puede escribir).
//   3. ALERTAS: cuando un caso de producción necesita a un humano, le
//      reenvía el aviso al que le toca (módulos->Diego, precio/factura/
//      personal->Jonatan, agenda->Osores; Jonatan es el comodín).
//
// Por qué así y no plantillas de Meta: la ventana de 24h se mantiene sola
// con el saludo diario + la respuesta de cada uno. Evita el medio de pago
// en Meta. Costo: si alguien no responde en >24h, su ventana se cierra y
// PAZ no lo alcanza hasta que él escriba. Es la decisión de Jonatan.
//
// Seguridad: solo la llama el cron, con la cabecera x-paz-key == secreto
// PAZ_EQUIPO_KEY. No es cliente-facing, no lleva --no-verify-jwt especial.
//
// Desplegar:  supabase functions deploy paz-equipo --use-api
// Secretos:   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, PAZ_EQUIPO_KEY
//             (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY los inyecta el runtime)

import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const GRAPH = "https://graph.facebook.com/v21.0";
const VENTANA_MS = 24 * 3600 * 1000;
const NUDGE_TRAS_MS = 90 * 60 * 1000; // 1.5 h sin responder el saludo -> recordatorio

async function enviarWA(para: string, texto: string) {
  const r = await fetch(`${GRAPH}/${Deno.env.get("WHATSAPP_PHONE_ID")}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("WHATSAPP_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: para, type: "text", text: { body: texto },
    }),
  });
  const cuerpo = await r.text();
  if (!r.ok) {
    console.error("paz-equipo: fallo envío a", para, r.status, cuerpo);
    await admin.from("wa_log").insert({
      metodo: "EQUIPO-ENVIO", firma_ok: false,
      nota: `fallo envío equipo a ${para} (${r.status})`, cuerpo: cuerpo.slice(0, 2000),
    }).then(() => {}, () => {});
  }
  return r.ok;
}

// Hora local de Chile sin depender de la zona del servidor (que es UTC).
function chile(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Santiago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  let hora = Number(g("hour"));
  if (hora === 24) hora = 0;
  return { fecha: `${g("year")}-${g("month")}-${g("day")}`, hora };
}

// A quién le toca una alerta. Prioridad: plata/factura/personal es del
// jefe aunque sea de un módulo; luego módulo/laboratorio; luego agenda.
function rutear(c: any): string {
  const m = (c.motivo_alerta || "").toLowerCase();
  // Coordinar una visita/día (agenda) es de Osores, AUNQUE se mencione el
  // precio: un pre-compra en terreno que hay que agendar el sábado va a
  // coordinación, no al dueño por nombrar "valor".
  const esCoordinacion = /agend|visit|coordin|cu[aá]ndo|qu[eé] d[ií]a|s[aá]bado|domingo|fin de semana|disponib|pasar|ir a|hora para|turno|ruta/.test(m)
    || (c.atencion === "terreno" && /d[ií]a|hora|cu[aá]ndo|fecha/.test(m));
  if (esCoordinacion) return "coordinacion";
  // Plata pura (sin coordinación de visita) la ve el jefe.
  if (/factura|boleta|pago|transfer|precio|valor|cuesta|cuá?nto|cobr|dinero|plata/.test(m)) return "dueno";
  // Módulo / banco -> laboratorio.
  if (c.modulo || /m[oó]dulo|recep|banco|reparad|repar|placa/.test(m)) return "laboratorio";
  // Cualquier otra cosa de terreno -> coordinación.
  if (c.atencion === "terreno") return "coordinacion";
  return "dueno";
}

async function tick() {
  const ahora = Date.now();
  const hoyCL = chile().fecha;
  const horaCL = chile().hora;
  const acciones: string[] = [];

  const { data: equipo } = await admin.from("paz_equipo")
    .select("id,telefono,nombre,area,saludo,activo,ultimo_inbound_en,ultimo_saludo_en,ultimo_nudge_en")
    .eq("activo", true);
  const miembros = equipo ?? [];

  const abierta = (m: any) =>
    m.ultimo_inbound_en && (ahora - Date.parse(m.ultimo_inbound_en)) < VENTANA_MS;

  // 1 y 2: saludo matutino / recordatorio.
  for (const m of miembros) {
    const saludoFechaCL = m.ultimo_saludo_en ? chile(new Date(m.ultimo_saludo_en)).fecha : null;
    const saludadoHoy = saludoFechaCL === hoyCL;

    if (horaCL >= 8 && !saludadoHoy) {
      // Toca saludar. Solo se puede si la ventana está abierta.
      if (abierta(m)) {
        if (await enviarWA(m.telefono, m.saludo)) {
          await admin.from("paz_equipo")
            .update({ ultimo_saludo_en: new Date().toISOString() }).eq("id", m.id);
          acciones.push(`saludo→${m.nombre}`);
        }
      } else {
        acciones.push(`saludo-omitido(ventana-cerrada)→${m.nombre}`);
      }
    } else if (saludadoHoy && abierta(m)) {
      // Ya se saludó hoy: ¿respondió? Si no, y pasó el rato, un recordatorio.
      const saludoMs = Date.parse(m.ultimo_saludo_en);
      const inboundMs = m.ultimo_inbound_en ? Date.parse(m.ultimo_inbound_en) : 0;
      const nudgeMs = m.ultimo_nudge_en ? Date.parse(m.ultimo_nudge_en) : 0;
      const respondioAlSaludo = inboundMs > saludoMs;
      const yaLoNudgee = nudgeMs > saludoMs;
      if (!respondioAlSaludo && !yaLoNudgee && (ahora - saludoMs) > NUDGE_TRAS_MS) {
        const txt = "Recuerda responder este chat 🙏 así mantenemos abierto nuestro canal del día y te puedo avisar cuando te necesite.";
        if (await enviarWA(m.telefono, txt)) {
          await admin.from("paz_equipo")
            .update({ ultimo_nudge_en: new Date().toISOString() }).eq("id", m.id);
          acciones.push(`recordatorio→${m.nombre}`);
        }
      }
    }
  }

  // 3: alertas de casos de producción que necesitan a un humano. PAZ le da la
  // ORDEN completa ahí en el WhatsApp (cliente, vehículo, qué pasa, dónde, qué
  // necesita), para que el responsable pueda actuar sin ni abrir la app.
  const { data: casos } = await admin.from("casos")
    .select("id,numero_caso,cliente_nombre,patente,vehiculo_modelo,modulo,sistema,atencion,falla_reportada,ubicacion_texto,ubicacion_gps,resumen_tecnico,motivo_alerta,notificado_motivo")
    .eq("modo", "produccion").eq("archivado", false).eq("requiere_respuesta_humana", true);

  for (const c of casos ?? []) {
    if (!c.motivo_alerta) continue;
    if (c.notificado_motivo === c.motivo_alerta) continue; // ya avisado por este motivo
    const area = rutear(c);
    const destino = miembros.find((m) => m.area === area)
      ?? miembros.find((m) => m.area === "dueno");
    if (!destino) continue;
    if (!abierta(destino)) continue; // sin ventana no se puede avisar; se reintenta al próximo tick cuando abra
    const nombre = String(destino.nombre || "").split(" ")[0] || destino.nombre;
    const veh = [c.vehiculo_modelo, c.patente].filter(Boolean).join(" ");
    const falla = c.falla_reportada || c.sistema || c.modulo || "";
    const ubic = c.ubicacion_texto || (c.ubicacion_gps ? "compartió ubicación por WhatsApp" : "");
    const txt = [
      `👋 ${nombre}, te paso este cliente para que lo tomes:`,
      `• Cliente: ${c.cliente_nombre || "sin nombre"}${veh ? ` — ${veh}` : ""}`,
      falla ? `• Qué pasa: ${falla}` : "",
      ubic ? `• Dónde: ${ubic}` : "",
      `• Lo que necesita: ${c.motivo_alerta}`,
      `(${c.numero_caso} — el detalle completo está en la app si lo necesitas.)`,
    ].filter(Boolean).join("\n");
    if (await enviarWA(destino.telefono, txt)) {
      await admin.from("casos")
        .update({ notificado_equipo_en: new Date().toISOString(), notificado_motivo: c.motivo_alerta })
        .eq("id", c.id);
      // Se guarda en la memoria del chat de PAZ con esa persona, para que
      // cuando responda "dile al cliente que..." PAZ sepa de qué cliente/caso
      // habla. Se agrega una referencia resoluble (cliente/patente/caso).
      const refCliente = c.patente || c.cliente_nombre || c.numero_caso;
      await admin.from("paz_equipo_chat").insert({
        telefono: destino.telefono, rol: "assistant",
        contenido: `${txt}\n[si me respondes "dile al cliente ..." es sobre este caso: ${c.cliente_nombre || "cliente"} ${c.patente ? `patente ${c.patente}` : ""} (${c.numero_caso}); para escribirle usa destino "${refCliente}".]`,
      }).then(() => {}, () => {});
      acciones.push(`alerta ${c.numero_caso}→${destino.nombre}`);
    }
  }

  return { ok: true, hora_chile: horaCL, fecha_chile: hoyCL, miembros: miembros.length, acciones };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-paz-key") !== Deno.env.get("PAZ_EQUIPO_KEY")) {
    return new Response("no autorizado", { status: 401 });
  }
  // ?dry=1 calcula sin enviar nada (para probar sin molestar al equipo).
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  if (dry) {
    const ahora = Date.now();
    const { data: equipo } = await admin.from("paz_equipo")
      .select("nombre,area,telefono,ultimo_inbound_en,ultimo_saludo_en").eq("activo", true);
    const { data: casos } = await admin.from("casos")
      .select("numero_caso,cliente_nombre,modulo,atencion,motivo_alerta,notificado_motivo")
      .eq("modo", "produccion").eq("archivado", false).eq("requiere_respuesta_humana", true);
    const estado = (equipo ?? []).map((m: any) => ({
      nombre: m.nombre, area: m.area,
      ventana_abierta: !!(m.ultimo_inbound_en && (ahora - Date.parse(m.ultimo_inbound_en)) < VENTANA_MS),
      ultimo_inbound_en: m.ultimo_inbound_en,
    }));
    const alertas = (casos ?? [])
      .filter((c: any) => c.motivo_alerta && c.notificado_motivo !== c.motivo_alerta)
      .map((c: any) => ({ caso: c.numero_caso, ruta: rutear(c), motivo: c.motivo_alerta }));
    return Response.json({ dry: true, hora_chile: chile().hora, equipo: estado, alertas_pendientes: alertas });
  }
  try {
    return Response.json(await tick());
  } catch (e) {
    console.error("paz-equipo tick error:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
