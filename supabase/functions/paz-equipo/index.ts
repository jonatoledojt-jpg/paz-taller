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
// El aviso va DIRECTO al que corresponde, según lo que el cliente necesita:
//   VISITA / coordinación (día, ir a verlo, agendar, sábado) -> Osores
//   MÓDULO / reparación (estado, listo, banco)               -> Diego
//   FACTURA / plata (factura, precio, pago, transferencia)   -> el jefe
// Se mira primero la visita (una visita a terreno que de paso menciona el
// precio igual es de Osores), luego el módulo, luego la plata.
function rutear(c: any): string {
  const m = (c.motivo_alerta || "").toLowerCase();
  const esVisita = /visit|ir a ver|pasan a|a terreno|qu[eé] d[ií]a|cu[aá]ndo (van|vienen|pueden ir|pasan|ir[aá]n)|agend|coordin.*(visit|d[ií]a|hora)|disponib|s[aá]bado|domingo|fin de semana|turno|ruta/.test(m);
  const esModulo = !!c.modulo || /m[oó]dulo|reparaci|est[aá] listo|lo tienen listo|banco|placa|recep/.test(m);
  const esPlata = /factura|boleta|pago|transfer|precio|valor|cuesta|cu[aá]nto cuesta|cobr|dinero|plata/.test(m);
  if (esVisita) return "coordinacion";
  if (esModulo) return "laboratorio";
  if (esPlata) return "dueno";
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

  // 3: alertas de casos de producción que necesitan a un humano.
  const alertAcciones = await procesarAlertas(miembros);
  acciones.push(...alertAcciones);

  // 4: si Diego u Osores no atendieron un aviso en un rato, se lo escala al jefe.
  const escAcciones = await escalarSinAtender(miembros);
  acciones.push(...escAcciones);

  return { ok: true, hora_chile: horaCL, fecha_chile: hoyCL, miembros: miembros.length, acciones };
}

// Escalada: cuando PAZ avisó a Diego u Osores de un caso y pasó un rato
// (~45 min) sin que nadie lo tomara —ni contactó al cliente del teléfono ni le
// respondió a PAZ— le avisa al JEFE para que intervenga y vea por qué no
// responden. La velocidad de respuesta es la que hace ganar, así que la
// cadena pasa rápido al siguiente. Por tema:
//   Módulo:  Diego (5 min) → Osores (15 min) → jefe
//   Visita:  Osores (5 min) → jefe
//   Factura: jefe  (5 min) → Osores
// "Tomarlo" = contactó al cliente desde el teléfono, o le respondió a PAZ.
function cadenaDe(area: string): { area: string; min: number }[] {
  if (area === "laboratorio") return [{ area: "laboratorio", min: 5 }, { area: "coordinacion", min: 15 }, { area: "dueno", min: 0 }];
  if (area === "coordinacion") return [{ area: "coordinacion", min: 5 }, { area: "dueno", min: 0 }];
  return [{ area: "dueno", min: 5 }, { area: "coordinacion", min: 0 }];
}

async function escalarSinAtender(miembros: any[]): Promise<string[]> {
  const ahora = Date.now();
  const abierta = (m: any) => m.ultimo_inbound_en && (ahora - Date.parse(m.ultimo_inbound_en)) < VENTANA_MS;
  const acciones: string[] = [];

  const { data: casos } = await admin.from("casos")
    .select("id,numero_caso,cliente_nombre,patente,vehiculo_modelo,modulo,sistema,atencion,falla_reportada,ubicacion_texto,ubicacion_gps,motivo_alerta,conversacion_id,escala_area,escala_en")
    .eq("modo", "produccion").eq("archivado", false).eq("requiere_respuesta_humana", true)
    .not("escala_area", "is", null).not("escala_en", "is", null);

  for (const c of casos ?? []) {
    const cadena = cadenaDe(rutear(c));
    const idx = cadena.findIndex((p) => p.area === c.escala_area);
    if (idx < 0 || idx + 1 >= cadena.length || !cadena[idx].min) continue; // último de la cadena
    const desde = c.escala_en;
    if (ahora - Date.parse(desde) < cadena[idx].min * 60000) continue; // aún dentro del plazo

    // ¿el que lo tiene ya lo tomó? (contactó al cliente del teléfono, o le respondió a PAZ)
    const { data: echo } = await admin.from("nexa_mensajes").select("id")
      .eq("conversacion_id", c.conversacion_id).eq("rol", "assistant").eq("humano_asistido", true)
      .ilike("contenido", "%el equipo desde%").gte("creado_en", desde).limit(1).maybeSingle();
    const actual = miembros.find((m) => m.area === c.escala_area);
    let respondio = null;
    if (actual) {
      const r = await admin.from("paz_equipo_chat").select("id")
        .eq("telefono", actual.telefono).eq("rol", "user").gte("creado_en", desde).limit(1).maybeSingle();
      respondio = r.data;
    }
    if (echo || respondio) continue; // está en ello, no escalar

    const siguiente = cadena[idx + 1];
    const destino = miembros.find((m) => m.area === siguiente.area);
    if (!destino || !abierta(destino)) continue; // sin ventana: se reintenta al próximo tick
    const nombre = destino.area === "dueno" ? "jefe" : (String(destino.nombre || "").split(" ")[0] || destino.nombre);
    const quienAntes = actual ? (actual.area === "dueno" ? "el jefe" : (String(actual.nombre).split(" ")[0] || actual.nombre)) : c.escala_area;
    const veh = [c.vehiculo_modelo, c.patente].filter(Boolean).join(" ");
    const falla = c.falla_reportada || c.sistema || c.modulo || "";
    const ubic = c.ubicacion_texto || (c.ubicacion_gps ? "compartió ubicación por WhatsApp" : "");
    const txt = [
      `⚠️ ${nombre}, ${quienAntes} no alcanzó a tomar esto y el cliente espera. Tómalo tú:`,
      `• Cliente: ${c.cliente_nombre || "sin nombre"}${veh ? ` — ${veh}` : ""}`,
      falla ? `• Qué pasa: ${falla}` : "",
      ubic ? `• Dónde: ${ubic}` : "",
      `• Lo que necesita: ${c.motivo_alerta}`,
      `(${c.numero_caso} — detalle en la app.)`,
    ].filter(Boolean).join("\n");
    if (await enviarWA(destino.telefono, txt)) {
      await admin.from("casos").update({ escala_area: siguiente.area, escala_en: new Date().toISOString() }).eq("id", c.id);
      const refCliente = c.patente || c.cliente_nombre || c.numero_caso;
      await admin.from("paz_equipo_chat").insert({
        telefono: destino.telefono, rol: "assistant",
        contenido: `${txt}\n[si me respondes "dile al cliente ..." es sobre este caso: ${c.cliente_nombre || "cliente"} ${c.patente ? `patente ${c.patente}` : ""} (${c.numero_caso}); para escribirle usa destino "${refCliente}".]`,
      }).then(() => {}, () => {});
      await admin.from("wa_log").insert({
        metodo: "PAZ-ESCALA", firma_ok: true,
        nota: `conv ${c.conversacion_id}: ${quienAntes}→${nombre} (${cadena[idx].min}min sin tomar)`.slice(0, 500), cuerpo: "",
      }).then(() => {}, () => {});
      acciones.push(`escala ${c.numero_caso}: ${c.escala_area}→${siguiente.area}`);
    }
  }
  return acciones;
}

// Avisos al equipo: casos de producción que necesitan a un humano. PAZ le da
// la ORDEN completa por WhatsApp (cliente, vehículo, qué pasa, dónde, qué
// necesita) para que actúe sin abrir la app. Se llama en el tick (cada 15 min)
// Y al instante desde la función whatsapp cuando se levanta una alerta nueva.
async function procesarAlertas(miembros: any[]): Promise<string[]> {
  const ahora = Date.now();
  const abierta = (m: any) => m.ultimo_inbound_en && (ahora - Date.parse(m.ultimo_inbound_en)) < VENTANA_MS;
  const acciones: string[] = [];

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
    const nombre = destino.area === "dueno" ? "jefe" : (String(destino.nombre || "").split(" ")[0] || destino.nombre);
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
      const ahoraISO = new Date().toISOString();
      await admin.from("casos")
        .update({
          notificado_equipo_en: ahoraISO, notificado_motivo: c.motivo_alerta,
          escala_area: area, escala_en: ahoraISO,   // arranca la cadena de escalada acá
        })
        .eq("id", c.id);
      const refCliente = c.patente || c.cliente_nombre || c.numero_caso;
      await admin.from("paz_equipo_chat").insert({
        telefono: destino.telefono, rol: "assistant",
        contenido: `${txt}\n[si me respondes "dile al cliente ..." es sobre este caso: ${c.cliente_nombre || "cliente"} ${c.patente ? `patente ${c.patente}` : ""} (${c.numero_caso}); para escribirle usa destino "${refCliente}".]`,
      }).then(() => {}, () => {});
      acciones.push(`alerta ${c.numero_caso}→${destino.nombre}`);
    }
  }
  return acciones;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-paz-key") !== Deno.env.get("PAZ_EQUIPO_KEY")) {
    return new Response("no autorizado", { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  // ?a=alertas: solo reenvía las alertas pendientes, al instante (lo llama la
  // función whatsapp apenas se levanta una alerta, sin esperar el cron). NO
  // hace saludos ni recordatorios.
  if (params.get("a") === "alertas" || params.get("a") === "rondas") {
    // "alertas": solo reenvía alertas pendientes (lo llama whatsapp al instante).
    // "rondas": alertas + escalada (lo llama un cron frecuente, cada 1-2 min),
    // para que la cadena Diego/Osores/jefe avance rápido — la velocidad gana.
    try {
      const { data: equipo } = await admin.from("paz_equipo")
        .select("id,telefono,nombre,area,ultimo_inbound_en").eq("activo", true);
      const miembros = equipo ?? [];
      const acciones = await procesarAlertas(miembros);
      if (params.get("a") === "rondas") acciones.push(...(await escalarSinAtender(miembros)));
      return Response.json({ ok: true, acciones });
    } catch (e) {
      console.error("paz-equipo alertas/rondas error:", e);
      return Response.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }
  // ?dry=1 calcula sin enviar nada (para probar sin molestar al equipo).
  const dry = params.get("dry") === "1";
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
