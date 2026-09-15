// PAZ por WhatsApp — recibe lo que escriben los clientes y, si está
// habilitado, les contesta.
//
// Esta función la llama Meta, no la app. Por eso va SIN verificación de
// sesión (--no-verify-jwt): Meta no tiene sesión de Supabase. Lo que la
// protege es la firma del cuerpo con el App Secret. Sin esa verificación,
// cualquiera podría inventar mensajes de clientes en el sistema.
//
// Desplegar:  supabase functions deploy whatsapp --use-api --no-verify-jwt
//
// Secretos que necesita:
//   OPENAI_API_KEY         llave de la IA
//   WHATSAPP_TOKEN         token de acceso de la app de Meta
//   WHATSAPP_PHONE_ID      identificador del número (Phone Number ID)
//   WHATSAPP_APP_SECRET    clave secreta de la app, para validar la firma
//   WHATSAPP_VERIFY_TOKEN  palabra acordada con Meta al enlazar el webhook

import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_SUPABASE = Deno.env.get("SUPABASE_URL")!;
const SERVICE      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH        = "https://graph.facebook.com/v21.0";

// Tope por teléfono y por hora. Un reintento masivo de Meta, un cliente
// nervioso mandando veinte mensajes seguidos o alguien jugando con el
// número no pueden costarnos la cuota de la IA.
const TOPE_POR_HORA = 30;

const admin = createClient(URL_SUPABASE, SERVICE);

// ---------- Firma de Meta ----------
// Sin esto el webhook es un buzón abierto: cualquiera podría meter
// conversaciones falsas y hacer que PAZ conteste a quien quiera.
async function firmaValida(secreto: string, cuerpo: string, cabecera: string | null) {
  if (!cabecera?.startsWith("sha256=")) return false;
  const clave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secreto),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const firma = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(cuerpo));
  const esperado = [...new Uint8Array(firma)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const recibido = cabecera.slice(7);
  if (recibido.length !== esperado.length) return false;
  // Comparación en tiempo constante: comparar con === filtra por tiempo.
  let dif = 0;
  for (let i = 0; i < esperado.length; i++) {
    dif |= esperado.charCodeAt(i) ^ recibido.charCodeAt(i);
  }
  return dif === 0;
}

// ---------- IA ----------
function extraerTexto(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const partes: string[] = [];
  for (const item of data?.output ?? []) {
    for (const c of item?.content ?? []) {
      if (typeof c?.text === "string") partes.push(c.text);
    }
  }
  if (partes.length) return partes.join("\n").trim();
  const viejo = data?.choices?.[0]?.message?.content;
  return typeof viejo === "string" ? viejo.trim() : "";
}

async function llamarIA(modelo: string, instrucciones: string, entrada: unknown) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY.");
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelo, instructions: instrucciones, input: entrada }),
  });
  if (!r.ok) throw new Error(`La IA respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return extraerTexto(await r.json());
}

// ---------- WhatsApp ----------
async function responderWhatsApp(para: string, texto: string) {
  const r = await fetch(`${GRAPH}/${Deno.env.get("WHATSAPP_PHONE_ID")}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("WHATSAPP_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "text",
      text: { body: texto },
    }),
  });
  if (!r.ok) console.error("No se pudo responder por WhatsApp:", await r.text());
}

// Baja la foto de Meta y la guarda. Las capturas del escáner son
// justamente lo que el taller revisa: perderlas sería perder el caso.
async function guardarAdjunto(conversacion_id: number, mediaId: string, mime: string, cat: string) {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  const cab = { Authorization: `Bearer ${token}` };

  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: cab });
  if (!meta.ok) throw new Error(`Meta no entregó el archivo: ${await meta.text()}`);
  const { url } = await meta.json();

  const bin = await fetch(url, { headers: cab });
  if (!bin.ok) throw new Error("No se pudo descargar el archivo.");
  const datos = new Uint8Array(await bin.arrayBuffer());

  const ext = mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : "jpg";
  const ruta = `${conversacion_id}/${mediaId}.${ext}`;

  const { error } = await admin.storage.from("paz-adjuntos")
    .upload(ruta, datos, { contentType: mime, upsert: true });
  if (error) throw error;

  await admin.from("nexa_archivos").insert({
    conversacion_id, ruta, mime, wa_media_id: mediaId, categoria: cat,
  });
  await admin.from("nexa_conversaciones")
    .update({ tiene_fotos: true }).eq("id", conversacion_id);
}

// ---------- Conversación ----------
// Un caso abierto por teléfono. Si el anterior se archivó o se cerró,
// se abre otro: así una consulta nueva no arrastra el contexto de un
// camión viejo.
async function conversacionDe(telefono: string) {
  const { data } = await admin.from("nexa_conversaciones")
    .select("id").eq("canal", "whatsapp").eq("telefono", telefono)
    .eq("cerrada", false).maybeSingle();
  if (data) return data.id as number;

  const { data: nueva, error } = await admin.from("nexa_conversaciones")
    .insert({ canal: "whatsapp", telefono }).select("id").single();
  if (error) throw error;
  return nueva.id as number;
}

// ---------- Consultar antes de preguntar ----------
// Patentes chilenas: cuatro letras y dos números (BBBB99), o el
// formato viejo de dos letras y cuatro números.
function patentesEn(texto: string): string[] {
  const limpio = texto.toUpperCase().replace(/[^A-Z0-9\s]/g, " ");
  const encontradas = limpio.match(/\b([A-Z]{4}\d{2}|[A-Z]{2}\d{4})\b/g) ?? [];
  return [...new Set(encontradas)];
}

// Arma lo que el sistema YA sabe, para que PAZ no lo pregunte de nuevo.
// Es texto que se le pasa a la IA, no algo que se le diga al cliente.
async function contextoDelSistema(telefono: string, historial: { content: string }[]) {
  const lineas: string[] = [];

  const { data: cli } = await admin.from("clientes")
    .select("id,nombre,rut,ciudad").eq("telefono", telefono).limit(1);
  if (cli?.length) {
    const c = cli[0];
    lineas.push(`Cliente ya registrado con este teléfono: ${c.nombre}` +
      (c.ciudad ? ` (${c.ciudad})` : "") + ". No le preguntes el nombre.");
  }

  const dichas = patentesEn(historial.map((m) => m.content).join(" "));
  for (const p of dichas.slice(0, 3)) {
    const { data: veh } = await admin.from("vehiculos")
      .select("patente,marca,modelo,anio,clientes(nombre)").eq("patente", p).limit(1);
    if (!veh?.length) {
      lineas.push(`La patente ${p} no está registrada. Pregunta marca, modelo y año.`);
      continue;
    }
    const v: any = veh[0];
    lineas.push(
      `Patente ${p} registrada: ${[v.marca, v.modelo].filter(Boolean).join(" ")}` +
      (v.anio ? ` año ${v.anio}` : "") +
      (v.clientes?.nombre ? `, cliente ${v.clientes.nombre}` : "") +
      ". Confírmalo con el cliente en vez de preguntarle los datos del vehículo. " +
      "Si te dice algo distinto, anótalo sin discutir y sin corregirlo.",
    );

    const { data: ots } = await admin.from("ordenes")
      .select("numero_ot,estado,sintoma_cliente,fecha_ingreso,vehiculos!inner(patente)")
      .eq("vehiculos.patente", p).order("fecha_ingreso", { ascending: false }).limit(3);
    if (ots?.length) {
      lineas.push(
        `Trabajos anteriores de ${p} (contexto interno, no se lo recites al cliente): ` +
        ots.map((o: any) => `${o.numero_ot} ${o.estado} — ${o.sintoma_cliente ?? ""}`).join(" | "),
      );
    }
  }

  return lineas.length
    ? "LO QUE EL SISTEMA YA SABE (no lo preguntes de nuevo, no inventes nada fuera de esto):\n- " +
      lineas.join("\n- ")
    : "";
}

// ---------- Reglas de canal ----------
// El prompt de nexa_config es el documento comercial. Esto es lo que
// cambia por hablar con el cliente en vivo y sin nadie en el medio.
const REGLAS_WHATSAPP = `
CANAL: WhatsApp, directo con el cliente. Nadie revisa tus mensajes antes de que los lea.

CÓMO ESCRIBES
- Mensajes cortos, como se escribe por WhatsApp. Nada de párrafos largos.
- UNA pregunta por mensaje. Nunca pidas tres cosas juntas.
- Te llamas Paz. Te presentas UNA sola vez, al inicio de una conversación nueva:
  "Hola, soy Paz. ¿En qué te puedo ayudar?". Después no repites tu nombre
  ni digas "Paz, de Paz Services": es redundante.

NUNCA DEJES LA CONVERSACIÓN COLGADA
Cada mensaje tuyo termina de una de estas dos formas, sin excepción:
  1. Con una pregunta concreta, si falta un dato.
  2. Con el cierre, si el caso ya está completo:
     "Con esto el caso queda listo para revisión del equipo técnico. La visita
     todavía no está agendada: primero validamos disponibilidad y condiciones.
     Te contactamos por este mismo WhatsApp."
Nunca cierres con "queda preparado", "gracias" o "lo revisaremos" a secas. Si el
cliente tiene que escribirte "¿y ahora qué?", te equivocaste.

ORDEN DE LA CONVERSACIÓN
Primero escucha la falla. Después, y solo lo que falte: nombre, patente,
ubicación o comuna, si el camión se desplaza, código del escáner, trabajos
previos. La foto se pide al final y no bloquea el cierre.

LO QUE NO HACES
- No das diagnóstico definitivo.
- No prometes horario ni visita.
- No dices que ya avisaste a alguien del equipo.
- No das un precio final cerrado.
- No recomiendas una reparación que no esté en tus instrucciones.
Si no estás segura de algo, dilo y déjalo para que lo vea una persona.
`.trim();

// ---------- Procesar un mensaje ----------
async function procesarMensaje(msj: any) {
  const telefono = String(msj.from ?? "").trim();
  if (!telefono) return;

  const conversacion_id = await conversacionDe(telefono);

  // Tope por hora. Se cuenta antes de guardar y antes de llamar a la IA.
  const desde = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("nexa_mensajes")
    .select("id", { count: "exact", head: true })
    .eq("conversacion_id", conversacion_id).eq("rol", "user").gte("creado_en", desde);
  if ((count ?? 0) >= TOPE_POR_HORA) {
    await admin.from("wa_log").insert({
      metodo: "LIMITE", firma_ok: true,
      nota: `tope por hora alcanzado (${telefono})`, cuerpo: "",
    });
    // No se le deja hablando solo al cliente, pero no se gasta la IA.
    await responderWhatsApp(telefono,
      "Recibí tus mensajes. Los está revisando el equipo y te respondemos en un rato.");
    return;
  }

  let contenido: string;
  let adjunto: { id: string; mime: string; cat: string } | null = null;

  if (msj.type === "text") {
    contenido = String(msj.text?.body ?? "").trim();
  } else if (msj.type === "image" || msj.type === "document") {
    const m = msj[msj.type];
    adjunto = {
      id: m?.id,
      mime: m?.mime_type ?? "image/jpeg",
      cat: msj.type === "image" ? "foto_cliente" : "otro",
    };
    contenido = m?.caption?.trim() || "[el cliente envió una imagen]";
  } else if (msj.type === "location") {
    const l = msj.location ?? {};
    const texto = [l.name, l.address].filter(Boolean).join(", ");
    await admin.from("nexa_conversaciones").update({
      ubicacion_gps: `${l.latitude},${l.longitude}`,
      ubicacion_texto: texto || null,
    }).eq("id", conversacion_id);
    contenido = `[el cliente compartió su ubicación${texto ? ": " + texto : ""}]`;
  } else {
    contenido = `[el cliente envió ${msj.type}, revísalo en WhatsApp]`;
  }
  if (!contenido) return;

  // wa_id tiene índice único: si Meta reintenta el mismo mensaje, el
  // insert falla acá y no se contesta dos veces.
  const { error: errIns } = await admin.from("nexa_mensajes")
    .insert({ conversacion_id, rol: "user", contenido, wa_id: msj.id ?? null });
  if (errIns) {
    if (errIns.code === "23505") return;   // repetido, ya se procesó
    throw errIns;
  }

  if (adjunto?.id) {
    try {
      await guardarAdjunto(conversacion_id, adjunto.id, adjunto.mime, adjunto.cat);
    } catch (e) {
      console.error("No se pudo guardar el adjunto:", e);
    }
  }

  const { data: cfg } = await admin.from("nexa_config")
    .select("prompt,prompt_ficha,modelo,activa,responde_whatsapp").eq("id", 1).single();
  if (!cfg?.activa) return;

  const { data: previos } = await admin.from("nexa_mensajes")
    .select("rol,contenido").eq("conversacion_id", conversacion_id).order("creado_en");
  const historial = (previos ?? []).map((m) => ({ role: m.rol, content: m.contenido }));

  // Los aprendizajes se leen en cada respuesta: así una corrección que
  // hace el dueño vale desde el mensaje siguiente, sin desplegar nada.
  const { data: apr } = await admin.from("paz_aprendizajes")
    .select("titulo,contenido").eq("activo", true).order("id");
  const aprendizajes = apr?.length
    ? "CRITERIOS DEL TALLER (mandan sobre cualquier costumbre tuya):\n" +
      apr.map((a) => `- ${a.titulo}: ${a.contenido}`).join("\n")
    : "";

  const contexto = await contextoDelSistema(telefono, historial);

  if (cfg.responde_whatsapp) {
    const instrucciones = [cfg.prompt, REGLAS_WHATSAPP, aprendizajes, contexto]
      .filter(Boolean).join("\n\n");
    const texto = await llamarIA(cfg.modelo, instrucciones, historial);
    const limpio = texto.replaceAll("**", "").replaceAll("*", "");
    if (limpio) {
      await responderWhatsApp(telefono, limpio);
      await admin.from("nexa_mensajes")
        .insert({ conversacion_id, rol: "assistant", contenido: limpio });
      historial.push({ role: "assistant", content: limpio });
    }
  }

  // La ficha se arma igual, conteste PAZ o no: sirve para que el equipo
  // vea de qué se trata el caso sin leer toda la conversación.
  try {
    const crudo = await llamarIA(cfg.modelo, cfg.prompt_ficha, historial);
    const ficha = JSON.parse(crudo.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    await admin.from("nexa_conversaciones")
      .update({ ficha, titulo: ficha.cliente || null })
      .eq("id", conversacion_id);
  } catch (e) {
    console.error("No se pudo armar la ficha:", e);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Mantenimiento: suscribe la cuenta de WhatsApp Business a esta app.
  //
  // En WhatsApp hay DOS suscripciones distintas y es un enredo clásico:
  // una es el campo "messages" en el webhook de la app (se hace en el
  // panel), y otra es que la cuenta de WhatsApp Business quede suscrita
  // a la app. Sin la segunda, Meta genera los avisos pero no los entrega
  // a nadie. El panel no siempre hace esta.
  //
  // Se protege con la misma palabra acordada con Meta, que solo conoce
  // el dueño. El token nunca sale de Supabase.
  if (req.method === "GET" && url.searchParams.has("clave")) {
    const clave = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
    if (!clave || url.searchParams.get("clave")!.trim() !== clave.trim()) {
      return new Response("La palabra no coincide con la guardada.", { status: 403 });
    }
    const waba = url.searchParams.get("waba")?.trim();
    if (!waba) {
      return new Response("La palabra está bien, pero falta el waba.", { status: 400 });
    }
    const cab = { Authorization: `Bearer ${Deno.env.get("WHATSAPP_TOKEN")}` };
    const alta = await fetch(`${GRAPH}/${waba}/subscribed_apps`, { method: "POST", headers: cab });
    const textoAlta = await alta.text();
    const estado = await fetch(`${GRAPH}/${waba}/subscribed_apps`, { headers: cab });
    return new Response(
      JSON.stringify({
        suscripcion: { http: alta.status, respuesta: textoAlta },
        apps_suscritas_ahora: await estado.text(),
      }, null, 2),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
    );
  }

  // Meta comprueba el enlace una vez, con un GET.
  if (req.method === "GET") {
    const esperado = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
    if (url.searchParams.get("hub.mode") === "subscribe" &&
        esperado && url.searchParams.get("hub.verify_token") === esperado) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    const recibidos = [...url.searchParams.keys()];
    return new Response(
      "Puerta de PAZ para WhatsApp.\n\n" +
      (recibidos.length
        ? `Recibí estos datos: ${recibidos.join(", ")}\n`
        : "No recibí ningún dato.\n") +
      "Para suscribir la cuenta hacen falta dos: clave y waba.\n",
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  if (req.method !== "POST") return new Response("no", { status: 405 });

  const cuerpo = await req.text();
  const secreto = Deno.env.get("WHATSAPP_APP_SECRET");

  const anotar = (firma_ok: boolean | null, nota: string) =>
    admin.from("wa_log").insert({
      metodo: req.method, firma_ok, nota, cuerpo: cuerpo.slice(0, 4000),
    }).then(() => {}, () => {});

  if (!secreto) {
    await anotar(null, "falta WHATSAPP_APP_SECRET");
    return new Response("sin configurar", { status: 503 });
  }
  const ok = await firmaValida(secreto, cuerpo, req.headers.get("x-hub-signature-256"));
  if (!ok) {
    await anotar(false, "firma no coincide");
    return new Response("firma inválida", { status: 401 });
  }

  let datos: any;
  try { datos = JSON.parse(cuerpo); } catch { return new Response("ok", { status: 200 }); }

  const mensajes: any[] = [];
  for (const entrada of datos?.entry ?? []) {
    for (const cambio of entrada?.changes ?? []) {
      // value.statuses son acuses de entrega; no interesan.
      for (const m of cambio?.value?.messages ?? []) mensajes.push(m);
    }
  }

  // Meta reintenta si no le respondemos rápido, y la IA se demora varios
  // segundos. Se le contesta al tiro y el trabajo sigue por detrás.
  const trabajo = (async () => {
    for (const m of mensajes) {
      try { await procesarMensaje(m); } catch (e) { console.error("Error procesando:", e); }
    }
  })();
  // @ts-ignore: lo provee el runtime de Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(trabajo);
  else await trabajo;

  return new Response("ok", { status: 200 });
});
