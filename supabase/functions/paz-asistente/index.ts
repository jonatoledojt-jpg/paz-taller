// PAZ asistente del equipo (20-10-2026).
//
// Cuando un miembro del equipo (paz_equipo) le pregunta algo a PAZ por
// WhatsApp, esta función responde consultando la MISMA base que ve la app:
// estado de OT, pendientes, agenda, historial de una patente. La plata
// (montos, facturado del mes) SOLO se le dice al JEFE (area='dueno') —
// Diego y Osores no tienen siquiera la herramienta.
//
// La llama la función `whatsapp` cuando reconoce un mensaje del equipo
// (le pasa {telefono, texto} + la cabecera x-paz-key). No es cliente-facing.
//
// Razonamiento: Claude (claude-sonnet-5-5) con tool-calling. Las consultas
// a la base las ejecuta esta función con service_role (así puede leer la
// plata para el jefe), pero las herramientas de plata solo existen si quien
// pregunta es el jefe, y el ejecutor lo revuelve a comprobar (doble llave).
//
// Desplegar:  supabase functions deploy paz-asistente --use-api
// Secretos:   ANTHROPIC_API_KEY, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, PAZ_EQUIPO_KEY

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPA_URL, SERVICE);
const GRAPH = "https://graph.facebook.com/v21.0";
const MODELO = "claude-sonnet-5-5";

async function enviarWA(para: string, texto: string) {
  const r = await fetch(`${GRAPH}/${Deno.env.get("WHATSAPP_PHONE_ID")}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("WHATSAPP_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to: para, type: "text", text: { body: texto } }),
  });
  if (!r.ok) console.error("paz-asistente: fallo envío", r.status, (await r.text()).slice(0, 300));
  return r.ok;
}

const limpiar = (s: string) => String(s ?? "").replace(/[(),]/g, " ").trim();

function herramientas(esJefe: boolean) {
  const base = [
    { name: "buscar_ot", description: "Busca órdenes de trabajo (OT) y clientes por número de OT, nombre de cliente, patente o TELÉFONO del cliente. Sirve para '¿ves a este cliente?' o '¿de quién es este número?': devuelve los clientes que calzan (aunque no tengan OT) y, si hay, sus OT con estado, ubicación física, si está cobrada, patente y vehículo.", input_schema: { type: "object", properties: { consulta: { type: "string", description: "número de OT, nombre de cliente, patente o teléfono" } }, required: ["consulta"], additionalProperties: false } },
    { name: "ver_conversacion_cliente", description: "Muestra los últimos mensajes de la conversación de WhatsApp con un cliente: lo que el cliente escribió y lo que YA se le respondió o envió (por PAZ o por el equipo). Úsalo ANTES de escribirle para no repetir, y cuando te pregunten qué se le dijo al cliente. Por OT, cliente, patente o teléfono.", input_schema: { type: "object", properties: { destino: { type: "string", description: "OT, cliente, patente o teléfono del cliente" } }, required: ["destino"], additionalProperties: false } },
    { name: "pendientes", description: "Lo que está esperando acción ahora: casos de WhatsApp que necesitan respuesta humana, y módulos por recepcionar.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "agenda", description: "Qué hay agendado (visitas a terreno o llegadas de módulo). Por defecto los próximos 7 días.", input_schema: { type: "object", properties: { dias: { type: "integer", description: "días hacia adelante, por defecto 7" } }, additionalProperties: false } },
    { name: "historial_patente", description: "Las últimas OT de una patente.", input_schema: { type: "object", properties: { patente: { type: "string" } }, required: ["patente"], additionalProperties: false } },
    { name: "escribir_al_cliente", description: "Le envías TÚ (PAZ) un WhatsApp a un CLIENTE de parte del taller, cuando el equipo te lo pide (ej: 'mándale al cliente de la OT X los datos de pago con factura'). Sirve para que el equipo NO tenga que entrar al chat del cliente: la única voz hacia el cliente eres tú. Para los datos de pago usa los DATOS DE PAGO DEL TALLER del system, y recuerda: el equipo decide con/sin factura, tú no. Solo funciona si el cliente escribió al taller en las últimas 24h.", input_schema: { type: "object", properties: { destino: { type: "string", description: "OT, cliente, patente o número de teléfono del cliente" }, mensaje: { type: "string", description: "el mensaje que le envías al cliente, redactado por ti, claro y cordial" }, forzar: { type: "boolean", description: "SOLO true si el equipo confirmó explícitamente que quiere mandarle OTRO mensaje al cliente aunque ya le hayas escrito hace poco" } }, required: ["destino", "mensaje"], additionalProperties: false } },
    { name: "generar_informe", description: "Redacta el borrador del informe técnico de una OT a partir del DETALLE del trabajo que te cuenta el usuario (qué se revisó, cambió, solucionó) y lo deja guardado en la app para revisar. Si no te han dado el detalle del trabajo, NO lo llames: pídeselo primero. Nunca inventes lo que se hizo.", input_schema: { type: "object", properties: { ot: { type: "string", description: "número de OT, patente o cliente" }, detalle: { type: "string", description: "lo que se hizo en el trabajo, dictado por el técnico (real, no inventado)" } }, required: ["ot", "detalle"], additionalProperties: false } },
    { name: "avisar_a_area", description: "Le escribes TÚ (PAZ) un WhatsApp al responsable de un área del equipo (laboratorio=Diego, coordinacion=Osores, dueno=el jefe). Úsalo cuando haya que pedirle o avisarle algo a alguien del equipo (ej: 'avísale a Diego que revise la OT X'). Redacta el mensaje en PRIMERA PERSONA, como la coordinadora que les pide/instruye: directo, breve, cercano pero con autoridad. NUNCA digas 'de parte de' nadie — el mensaje es tuyo.", input_schema: { type: "object", properties: { area: { type: "string", enum: ["laboratorio", "coordinacion", "dueno"] }, mensaje: { type: "string", description: "el mensaje que TÚ le escribes, en primera persona, sin 'de parte de'" } }, required: ["area", "mensaje"], additionalProperties: false } },
  ];
  if (esJefe) base.push(
    { name: "montos_ot", description: "SOLO JEFE. Los montos (plata) de una OT: cotizado, final cobrado y número de factura.", input_schema: { type: "object", properties: { consulta: { type: "string", description: "número de OT, cliente o patente" } }, required: ["consulta"], additionalProperties: false } },
    { name: "facturado_mes", description: "SOLO JEFE. Cuánta plata entró en el mes (suma neta de lo cobrado, por fecha de pago).", input_schema: { type: "object", properties: { mes: { type: "string", description: "AAAA-MM-01; por defecto el mes actual" } }, additionalProperties: false } },
  );
  return base;
}

// Clientes que calzan con la consulta: por nombre, y si trae dígitos (un
// teléfono o RUT), por teléfono (comparando solo los dígitos, porque en la
// base pueden estar con +, espacios o guiones). Así PAZ sí puede contestar
// "¿ves a ese cliente?" con un número.
async function clientesQueCalzan(q: string) {
  const raw = limpiar(q);
  const digitos = raw.replace(/\D/g, "");
  const out = new Map<any, any>();
  if (raw && !/^\+?\d[\d\s-]*$/.test(raw)) {
    const { data } = await admin.from("clientes").select("id,nombre,telefono").ilike("nombre", `%${raw}%`).limit(10);
    for (const c of data ?? []) out.set(c.id, c);
  }
  if (digitos.length >= 7) {
    const sig = digitos.slice(-8); // parte única del móvil chileno
    const { data: todos } = await admin.from("clientes").select("id,nombre,telefono").limit(1000);
    for (const c of todos ?? []) {
      const td = String(c.telefono || "").replace(/\D/g, "");
      if (td && (td.includes(sig) || sig.includes(td.slice(-8)))) out.set(c.id, c);
    }
  }
  return [...out.values()];
}

// El teléfono del cliente casi nunca está en la ficha (clientes.telefono);
// vive en las conversaciones de WhatsApp. Así que para "¿ves a este
// cliente?" por número, se busca ahí y se traen sus casos.
async function contactoWhatsApp(q: string) {
  const digitos = limpiar(q).replace(/\D/g, "");
  if (digitos.length < 7) return null;
  const sig = digitos.slice(-8);
  const { data: convs } = await admin.from("nexa_conversaciones").select("id,telefono").limit(2000);
  const match = (convs ?? []).filter((c: any) => String(c.telefono || "").replace(/\D/g, "").includes(sig));
  if (!match.length) return null;
  const ids = match.map((c: any) => c.id);
  const { data: casos } = await admin.from("casos")
    .select("numero_caso,cliente_nombre,patente,vehiculo_modelo,falla_reportada,resumen_tecnico,estado_caso,modo,orden_id")
    .in("conversacion_id", ids).order("actualizado_en", { ascending: false }).limit(10);
  return { escribio_por_whatsapp: true, casos: casos ?? [] };
}

async function buscarOrdenes(q: string, esJefe: boolean) {
  const like = `%${limpiar(q)}%`;
  const [cls, { data: vhs }] = await Promise.all([
    clientesQueCalzan(q),
    admin.from("vehiculos").select("id").ilike("patente", like.toUpperCase()),
  ]);
  const cids = cls.map((x: any) => x.id);
  const vids = (vhs ?? []).map((x: any) => x.id);
  const campos = "id,numero_ot,estado,origen,tipo_trabajo,tipo_modulo,sistema,ubicacion,reparacion,comercial,pagado_en,entregado_en,fecha_ingreso,fecha_agendada,sintoma_cliente,clientes(nombre),vehiculos(patente,marca,modelo,anio)"
    + (esJefe ? ",monto_cotizado,monto_final,numero_factura" : "");
  const orParts = [`numero_ot.ilike.${like}`];
  if (cids.length) orParts.push(`cliente_id.in.(${cids.join(",")})`);
  if (vids.length) orParts.push(`vehiculo_id.in.(${vids.join(",")})`);
  const { data } = await admin.from("ordenes").select(campos)
    .or(orParts.join(",")).order("creado_en", { ascending: false }).limit(8);
  return data ?? [];
}

// Ubica el WhatsApp de un cliente para escribirle: por número directo, o por
// OT/cliente/patente (OT -> caso -> conversación -> teléfono). Devuelve también
// la conversación, para chequear la ventana de 24h y dejar registrado lo que
// PAZ le mandó (así la PAZ cara al cliente no se contradice después).
async function destinoCliente(destino: string) {
  const raw = limpiar(destino);
  const dig = raw.replace(/\D/g, "");
  if (dig.length >= 8 && /^\+?[\d\s-]+$/.test(raw)) {
    const sig = dig.slice(-8);
    const { data: convs } = await admin.from("nexa_conversaciones").select("id,telefono").limit(2000);
    const c = (convs ?? []).find((x: any) => String(x.telefono || "").replace(/\D/g, "").includes(sig));
    return { telefono: dig, conversacion_id: c?.id ?? null };
  }
  let cid: number | null = null;
  const ots = await buscarOrdenes(destino, false);
  if (ots.length) {
    const { data } = await admin.from("casos").select("conversacion_id")
      .in("orden_id", ots.map((o: any) => o.id)).not("conversacion_id", "is", null).limit(1);
    cid = data?.[0]?.conversacion_id ?? null;
  }
  if (!cid) {
    const { data } = await admin.from("casos").select("conversacion_id")
      .or(`cliente_nombre.ilike.%${raw}%,patente.ilike.%${raw.toUpperCase()}%`)
      .not("conversacion_id", "is", null).order("actualizado_en", { ascending: false }).limit(1);
    cid = data?.[0]?.conversacion_id ?? null;
  }
  if (!cid) return { telefono: null, conversacion_id: null };
  const { data: c } = await admin.from("nexa_conversaciones").select("telefono").eq("id", cid).maybeSingle();
  return { telefono: c?.telefono ? String(c.telefono).replace(/\D/g, "") : null, conversacion_id: cid };
}

async function ejecutar(nombre: string, input: any, esJefe: boolean, solicitante: string, simular: boolean): Promise<string> {
  // Doble llave: aunque la herramienta no debería existir para no-jefes,
  // el ejecutor vuelve a cortar la plata.
  if ((nombre === "montos_ot" || nombre === "facturado_mes") && !esJefe) {
    return "No autorizado: la información de dinero es solo para el jefe.";
  }
  try {
    if (nombre === "avisar_a_area") {
      const area = String(input?.area ?? "").trim();
      const mensaje = String(input?.mensaje ?? "").trim();
      if (!area || !mensaje) return "Falta el área o el mensaje.";
      const { data: dest } = await admin.from("paz_equipo")
        .select("telefono,nombre,ultimo_inbound_en").eq("area", area).eq("activo", true).maybeSingle();
      if (!dest) return `No hay nadie activo en el área ${area}.`;
      const abierta = dest.ultimo_inbound_en && (Date.now() - Date.parse(dest.ultimo_inbound_en)) < 24 * 3600 * 1000;
      if (!abierta) return `No le puedo escribir a ${dest.nombre} ahora: su ventana de WhatsApp está cerrada (tiene que escribirle algo a PAZ para abrirla). Avísale por otro medio o inténtalo cuando él escriba.`;
      if (simular) return `(simulado, no se envió) habría escrito a ${dest.nombre}: ${mensaje}`;
      const ok = await enviarWA(dest.telefono, mensaje);
      await admin.from("wa_log").insert({
        metodo: "ASISTENTE-AVISO", firma_ok: ok,
        nota: `${solicitante} → ${dest.nombre} (${area})`, cuerpo: mensaje.slice(0, 1000),
      }).then(() => {}, () => {});
      return ok ? `Listo, le envié el mensaje a ${dest.nombre}.` : `No pude enviarle el mensaje a ${dest.nombre} (error de WhatsApp).`;
    }
    if (nombre === "generar_informe") {
      const detalle = String(input?.detalle ?? "").trim();
      if (detalle.length < 40) {
        return "Necesito que me cuentes con un poco más de detalle qué se hizo en el trabajo (qué se revisó, qué se cambió, qué quedó) para poder redactar el informe. Cuéntame y lo redacto.";
      }
      const r = await buscarOrdenes(input?.ot ?? "", false);
      if (!r.length) return "No encontré esa OT. Dime el número de OT, la patente o el cliente.";
      const ot: any = r[0];
      if (simular) return `(simulado, no se generó) habría redactado el informe de ${ot.numero_ot} con el detalle dado.`;
      // El Redactor va con --no-verify-jwt; la autenticación real es x-paz-key
      // (el propio Redactor comprueba la llave y usa el usuario agente).
      const resp = await fetch(`${SUPA_URL}/functions/v1/informe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-paz-key": Deno.env.get("PAZ_EQUIPO_KEY") ?? "",
        },
        body: JSON.stringify({ accion: "redactar", orden_id: ot.id, respuestas: detalle }),
      });
      if (!resp.ok) return `No se pudo generar el informe (error ${resp.status}). Inténtalo de nuevo en un rato.`;
      const d = await resp.json();
      if (d?.error) return `No se pudo generar el informe: ${d.error}`;
      const b = d?.borrador ?? {};
      return JSON.stringify({
        ok: true, numero_ot: ot.numero_ot, guardado_en_la_app: true,
        borrador: {
          trabajos: b.detalle_diagnostico, resultado: b.resultado_pruebas,
          conclusion: b.causa_conclusion, observaciones: b.observaciones,
        },
      });
    }
    if (nombre === "escribir_al_cliente") {
      const mensaje = String(input?.mensaje ?? "").trim();
      if (!mensaje) return "Falta el mensaje que hay que enviarle al cliente.";
      const { telefono, conversacion_id } = await destinoCliente(String(input?.destino ?? ""));
      if (!telefono) {
        return "No tengo el número de WhatsApp de ese cliente (no te ha escrito al taller). Pásame el número, o pídele que le mande un 'hola' al +56 9 3374 0440 y ahí le escribo.";
      }
      // Ventana de 24h: PAZ (por la API) solo puede escribir si el cliente
      // escribió al taller en las últimas 24h. Si no, haría falta plantilla.
      let abierta = false;
      if (conversacion_id) {
        const { data: ult } = await admin.from("nexa_mensajes")
          .select("creado_en").eq("conversacion_id", conversacion_id).eq("rol", "user")
          .order("creado_en", { ascending: false }).limit(1).maybeSingle();
        abierta = !!(ult && (Date.now() - Date.parse(ult.creado_en)) < 24 * 3600 * 1000);
      }
      if (!abierta) {
        return "No le puedo escribir ahora: ese cliente no te ha escrito al WhatsApp del taller en las últimas 24h, y WhatsApp no deja iniciar sin una plantilla aprobada. Pídele que te mande un 'hola' al +56 9 3374 0440 y se lo envío al tiro.";
      }
      // Candado anti-duplicado: si ya le mandó algo a este cliente hace pocos
      // minutos, no reenvía (pasó de verdad: PAZ dudó de su propio envío y lo
      // mandó dos veces). Solo reenvía si el equipo lo confirma (forzar).
      const forzar = input?.forzar === true;
      if (!forzar && conversacion_id) {
        const hace6 = new Date(Date.now() - 6 * 60000).toISOString();
        const { data: reciente } = await admin.from("nexa_mensajes")
          .select("contenido,creado_en").eq("conversacion_id", conversacion_id)
          .eq("rol", "assistant").eq("humano_asistido", true)
          .gte("creado_en", hace6).order("creado_en", { ascending: false }).limit(1).maybeSingle();
        if (reciente) {
          return `Ya le mandé un mensaje a este cliente hace unos minutos: "${String(reciente.contenido).slice(0, 160)}". NO se lo reenvío para no duplicar. Si de verdad quieres mandarle otro, confírmamelo explícito.`;
        }
      }
      if (simular) return `(simulado, no se envió) habría escrito al cliente (${telefono}): ${mensaje}`;
      const ok = await enviarWA(telefono, mensaje);
      if (ok && conversacion_id) {
        // Se registra como mensaje de PAZ (humano_asistido) para que la PAZ
        // cara al cliente lo vea y no se contradiga en el siguiente turno.
        await admin.from("nexa_mensajes")
          .insert({ conversacion_id, rol: "assistant", contenido: mensaje, humano_asistido: true })
          .then(() => {}, () => {});
      }
      await admin.from("wa_log").insert({
        metodo: "ASISTENTE-CLIENTE", firma_ok: ok,
        nota: `${solicitante} → cliente ${telefono}`, cuerpo: mensaje.slice(0, 1000),
      }).then(() => {}, () => {});
      return ok ? "Listo, le envié el mensaje al cliente." : "No pude enviarle el mensaje al cliente (error de WhatsApp).";
    }
    if (nombre === "ver_conversacion_cliente") {
      const { telefono, conversacion_id } = await destinoCliente(String(input?.destino ?? ""));
      if (!conversacion_id) return "No encuentro una conversación de WhatsApp con ese cliente.";
      const { data: msgs } = await admin.from("nexa_mensajes")
        .select("rol,contenido,humano_asistido,creado_en")
        .eq("conversacion_id", conversacion_id).order("creado_en", { ascending: false }).limit(15);
      const orden = (msgs ?? []).reverse().map((m: any) => ({
        de: m.rol === "user" ? "cliente" : (m.humano_asistido ? "equipo (vía PAZ)" : "PAZ automática"),
        texto: String(m.contenido || "").slice(0, 300),
        cuando: m.creado_en,
      }));
      return JSON.stringify({ telefono, mensajes: orden });
    }
    if (nombre === "buscar_ot") {
      const q = input?.consulta ?? "";
      const [ots, cls, wa] = await Promise.all([
        buscarOrdenes(q, false), clientesQueCalzan(q), contactoWhatsApp(q),
      ]);
      if (!ots.length && !cls.length && !wa) return "No encontré ninguna OT, cliente ni contacto de WhatsApp con eso.";
      return JSON.stringify({
        ordenes: ots,
        clientes_encontrados: cls.map((c: any) => ({ nombre: c.nombre, telefono: c.telefono })),
        contacto_whatsapp: wa, // si el número escribió por WhatsApp: sus casos
      });
    }
    if (nombre === "montos_ot") {
      const r = await buscarOrdenes(input?.consulta ?? "", true);
      return r.length ? JSON.stringify(r.map((o: any) => ({
        numero_ot: o.numero_ot, cliente: o.clientes?.nombre, patente: o.vehiculos?.patente,
        monto_cotizado: o.monto_cotizado, monto_final: o.monto_final, numero_factura: o.numero_factura,
      }))) : "No encontré ninguna OT con eso.";
    }
    if (nombre === "pendientes") {
      const { data: casos } = await admin.from("casos")
        .select("numero_caso,cliente_nombre,patente,vehiculo_modelo,motivo_alerta")
        .eq("modo", "produccion").eq("archivado", false).eq("requiere_respuesta_humana", true);
      const { data: recep } = await admin.from("ordenes")
        .select("numero_ot,clientes(nombre),vehiculos(patente)").eq("estado", "retirado").limit(20);
      return JSON.stringify({
        casos_esperando_respuesta: casos ?? [],
        modulos_por_recepcionar: (recep ?? []).map((o: any) => ({ numero_ot: o.numero_ot, cliente: o.clientes?.nombre, patente: o.vehiculos?.patente })),
      });
    }
    if (nombre === "agenda") {
      const dias = Number(input?.dias) > 0 ? Number(input.dias) : 7;
      const hoy = new Date(); const fin = new Date(Date.now() + dias * 86400000);
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const { data } = await admin.from("ordenes")
        .select("numero_ot,fecha_agendada,franja,origen,tipo_trabajo,clientes(nombre),vehiculos(patente)")
        .gte("fecha_agendada", iso(hoy)).lte("fecha_agendada", iso(fin))
        .order("fecha_agendada", { ascending: true }).limit(30);
      const r = (data ?? []).map((o: any) => ({ numero_ot: o.numero_ot, fecha: o.fecha_agendada, franja: o.franja, origen: o.origen, cliente: o.clientes?.nombre, patente: o.vehiculos?.patente }));
      return r.length ? JSON.stringify(r) : `No hay nada agendado en los próximos ${dias} días.`;
    }
    if (nombre === "historial_patente") {
      const pat = limpiar(input?.patente ?? "").toUpperCase();
      const { data: vh } = await admin.from("vehiculos").select("id,marca,modelo,anio").ilike("patente", `%${pat}%`).limit(1).maybeSingle();
      if (!vh) return "No tengo ninguna patente parecida registrada.";
      const { data } = await admin.from("ordenes")
        .select("numero_ot,estado,reparacion,pagado_en,sintoma_cliente,fecha_ingreso")
        .eq("vehiculo_id", vh.id).order("creado_en", { ascending: false }).limit(5);
      return JSON.stringify({ vehiculo: vh, ultimas_ot: data ?? [] });
    }
    if (nombre === "facturado_mes") {
      const mes = /^\d{4}-\d{2}/.test(input?.mes ?? "") ? input.mes.slice(0, 7) + "-01" : new Date().toISOString().slice(0, 7) + "-01";
      const ini = new Date(mes); const fin = new Date(ini); fin.setMonth(fin.getMonth() + 1);
      const { data } = await admin.from("ordenes").select("monto_final,pagado_en")
        .not("pagado_en", "is", null).gte("pagado_en", ini.toISOString()).lt("pagado_en", fin.toISOString());
      const total = (data ?? []).reduce((s: number, o: any) => s + (Number(o.monto_final) || 0), 0);
      return JSON.stringify({ mes: mes.slice(0, 7), facturado_neto: total, ots_cobradas: (data ?? []).length, nota: "Es lo cobrado (neto). El margen completo (con gastos y mano de obra) está en la app." });
    }
    return "Herramienta desconocida.";
  } catch (e) {
    console.error("ejecutar", nombre, e);
    return "Hubo un error consultando eso.";
  }
}

async function turno(apiKey: string, system: string, messages: any[], tools: any[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELO, max_tokens: 1024, system, messages, tools }),
  });
  if (!r.ok) throw new Error(`IA ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return { content: d?.content ?? [], stop: d?.stop_reason };
}

async function responder(apiKey: string, system: string, messages: any[], esJefe: boolean, solicitante: string, simular: boolean): Promise<string> {
  const tools = herramientas(esJefe);
  let salida = "";
  for (let ronda = 0; ronda < 6; ronda++) {
    const { content, stop } = await turno(apiKey, system, messages, tools);
    for (const b of content) if (b?.type === "text" && b.text) salida += b.text;
    const usos = content.filter((b: any) => b?.type === "tool_use");
    if (stop === "tool_use" && usos.length) {
      messages.push({ role: "assistant", content });
      const resultados: any[] = [];
      for (const tu of usos) {
        const res = await ejecutar(tu.name, tu.input ?? {}, esJefe, solicitante, simular);
        resultados.push({ type: "tool_result", tool_use_id: tu.id, content: String(res).slice(0, 6000) });
      }
      messages.push({ role: "user", content: resultados });
      salida = "";
      continue;
    }
    break;
  }
  return salida.replaceAll("**", "").replaceAll("*", "").trim();
}

Deno.serve(async (req) => {
  if (req.headers.get("x-paz-key") !== Deno.env.get("PAZ_EQUIPO_KEY")) {
    return new Response("no autorizado", { status: 401 });
  }
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return Response.json({ error: "falta ANTHROPIC_API_KEY" }, { status: 503 });

  let body: any = {};
  try { body = await req.json(); } catch { /* vacío */ }
  const telefono = String(body?.telefono ?? "").trim();
  const texto = String(body?.texto ?? "").trim();
  const probar = body?.probar === true || new URL(req.url).searchParams.get("probar") === "1";
  if (!telefono || !texto) return Response.json({ error: "faltan telefono/texto" }, { status: 400 });

  const { data: miembro } = await admin.from("paz_equipo")
    .select("nombre,area,activo").eq("telefono", telefono).eq("activo", true).maybeSingle();
  if (!miembro) return Response.json({ error: "no es del equipo" }, { status: 403 });
  const esJefe = miembro.area === "dueno";

  // Datos de pago del taller (con/sin factura), para que PAZ se los pueda
  // enviar al cliente cuando el equipo se lo pida. El equipo decide cuál.
  const { data: cfgPago } = await admin.from("nexa_config").select("datos_pago").eq("id", 1).maybeSingle();
  const datosPago = (cfgPago?.datos_pago ?? "").trim();

  const system = [
    `Eres PAZ, la coordinadora del taller Paz Services (camiones Mercedes-Benz, Talca, Chile). Tu lugar: estás por SOBRE el equipo (Diego=laboratorio, Osores=coordinación) y por DEBAJO del jefe, Jonatan — solo él te dirige a ti. Con el equipo hablas con autoridad propia, cercana pero firme.`,
    `Estás hablando por WhatsApp con ${miembro.nombre} (${esJefe ? "el JEFE: a él le respondes, no le das órdenes" : "del equipo: puedes pedirle o instruirle cosas"}).`,
    `Responde su consulta operativa usando las herramientas para mirar la base (la misma que ve la app): estado de OT, pendientes, agenda, historial de una patente.`,
    `Habla español chileno, directo y BREVE (es WhatsApp): sin rodeos, sin markdown, frases cortas.`,
    `Nunca inventes. Si una herramienta no encuentra nada, dilo claro. Si no entiendes la consulta, pide que la precise.`,
    esJefe
      ? `${miembro.nombre} es el jefe: puedes darle montos y lo facturado del mes con las herramientas de plata.`
      : `IMPORTANTE: NO des montos, precios, cotizaciones ni nada de dinero. Si pregunta por plata, dile con amabilidad que esa información es solo para el jefe y que la revise en la app.`,
    `Puedes ESCRIBIRLE tú al equipo con la herramienta avisar_a_area: si hay que avisarle o pedirle algo a alguien (ej: "avísale a Diego que revise la OT X"), primero mira lo que haga falta (buscar_ot, etc.) y después usa avisar_a_area. El mensaje lo escribes TÚ en primera persona, como la coordinadora que les instruye — directo y con autoridad cercana. NUNCA "de parte de" nadie: es tu mensaje. (laboratorio=Diego, coordinacion=Osores, dueno=el jefe.)`,
    `Puedes REDACTAR el informe técnico de una OT con generar_informe, pero NECESITAS que el técnico te cuente qué se hizo en el trabajo (qué revisó, cambió, solucionó). Si te piden el informe y no te han dado ese detalle, PÍDELO primero; no inventes el trabajo. El informe que redactes queda guardado en la app para que lo revisen y lo finalicen ahí (el PDF para el cliente se genera en la app, con revisión humana).`,
    `Puedes ESCRIBIRLE al cliente por ti (herramienta escribir_al_cliente) cuando el equipo te lo pide, para que ellos NO tengan que entrar al chat del cliente: la única voz hacia el cliente eres tú. Redacta el mensaje cordial y claro. Solo funciona si el cliente escribió al taller en las últimas 24h (si no, dilo). CUANDO EL TOOL TE DIGA "Listo, le envié", YA SE ENVIÓ DE VERDAD: confía en eso, no lo mandes otra vez aunque dudes o te reconfirmen. Si el tool te avisa que ya le escribiste hace poco, NO reenvíes: avísale al equipo y reenvía (forzar) solo si te lo confirman explícito. Nunca le mandes dos mensajes casi iguales al cliente. Cuando dudes si ya se le escribió algo al cliente, o te pregunten qué se le dijo, usa ver_conversacion_cliente para MIRAR la conversación real (ahí ves lo que el cliente escribió y lo que ya se le mandó) en vez de adivinar o dudar.`,
    datosPago
      ? `${datosPago}\n(Cuando el equipo te pida enviarle "los datos de pago" al cliente, usa estos y mándalos con escribir_al_cliente. Con o sin factura lo decide el EQUIPO, no tú y NUNCA el cliente: si no te lo dijeron, pregúntaselo A QUIEN TE ESTÁ ESCRIBIENDO (el equipo) en ESTE chat, jamás al cliente. Al cliente mándale solo los datos ya elegidos, cordial, SIN preguntarle nada de factura ni mencionarle que había opciones.)`
      : "",
    `Tienes memoria de esta conversación: si te dicen "sí, revísalo" o "mándalo", mira los mensajes anteriores para saber a qué se refieren; no vuelvas a pedir el dato que ya está en el hilo.`,
    `No eres la PAZ que habla con clientes. No agendas, no cambias estados ni creas OT: para eso están la app y la otra PAZ. Tú consultas, informas y avisas al equipo.`,
  ].join("\n");

  // Memoria: el hilo reciente de ESTE miembro, para que los "sí, revísalo"
  // tengan contexto. Se guarda aparte de las conversaciones de clientes.
  const { data: hist } = await admin.from("paz_equipo_chat")
    .select("rol,contenido").eq("telefono", telefono)
    .order("creado_en", { ascending: false }).limit(12);
  const previos = (hist ?? []).reverse().map((h: any) => ({ role: h.rol, content: h.contenido }));
  // Alternancia que exige Claude: fusiona roles repetidos y arranca en user.
  const crudo = [...previos, { role: "user", content: texto }];
  const messages: any[] = [];
  for (const m of crudo) {
    if (messages.length && messages[messages.length - 1].role === m.role) {
      messages[messages.length - 1].content += "\n" + m.content;
    } else messages.push({ role: m.role, content: m.content });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();

  try {
    const respuesta = await responder(apiKey, system, messages, esJefe, miembro.nombre, probar);
    const txt = respuesta || "No pude armar una respuesta. ¿Me lo preguntas de otra forma?";
    if (!probar) {
      await enviarWA(telefono, txt);
      await admin.from("paz_equipo_chat").insert([
        { telefono, rol: "user", contenido: texto },
        { telefono, rol: "assistant", contenido: txt },
      ]).then(() => {}, () => {});
      await admin.from("wa_log").insert({
        metodo: "ASISTENTE", firma_ok: true,
        nota: `${miembro.nombre} (jefe=${esJefe}) preguntó: ${texto.slice(0, 200)}`,
        cuerpo: txt.slice(0, 3000),
      }).then(() => {}, () => {});
    }
    return Response.json({ ok: true, jefe: esJefe, respuesta: txt });
  } catch (e) {
    console.error("paz-asistente error:", e);
    if (!probar) {
      await enviarWA(telefono, "Uf, no pude revisar eso ahora. Inténtalo de nuevo en un rato.");
      await admin.from("wa_log").insert({
        metodo: "ASISTENTE", firma_ok: false,
        nota: `error con ${miembro.nombre}: ${texto.slice(0, 160)}`,
        cuerpo: String(e).slice(0, 2500),
      }).then(() => {}, () => {});
    }
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
