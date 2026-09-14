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
//   WHATSAPP_TOKEN         token de acceso de la app de Meta
//   WHATSAPP_PHONE_ID      identificador del número (Phone Number ID)
//   WHATSAPP_APP_SECRET    clave secreta de la app, para validar la firma
//   WHATSAPP_VERIFY_TOKEN  palabra acordada con Meta al enlazar el webhook

import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_SUPABASE = Deno.env.get("SUPABASE_URL")!;
const SERVICE      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH        = "https://graph.facebook.com/v21.0";

// PAZ habla con el cliente de verdad acá. No hay nadie intermediando.
const CONTEXTO_WHATSAPP = [
  "CONTEXTO DEL CANAL: estás hablando por WhatsApp directamente con el",
  "cliente. Escribe corto y en mensajes cortos, como se escribe por WhatsApp,",
  "no en párrafos largos. Una pregunta a la vez.",
].join(" ");

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

// Un caso abierto por teléfono. Si el anterior se cerró, se abre otro:
// así una consulta nueva no arrastra el contexto de un camión viejo.
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

async function procesarMensaje(msj: any) {
  const telefono = String(msj.from ?? "").trim();
  if (!telefono) return;

  // Por ahora solo texto. Las fotos del tablero y del escáner valen oro
  // para este taller, pero descargarlas es otro trabajo: por mientras
  // queda constancia de que llegaron para que nadie las dé por perdidas.
  const contenido = msj.type === "text"
    ? String(msj.text?.body ?? "").trim()
    : `[el cliente envió ${msj.type}, revísalo en WhatsApp]`;
  if (!contenido) return;

  const conversacion_id = await conversacionDe(telefono);

  // wa_id tiene índice único: si Meta reintenta el mismo mensaje, el
  // insert falla acá y no se contesta dos veces.
  const { error: errIns } = await admin.from("nexa_mensajes")
    .insert({ conversacion_id, rol: "user", contenido, wa_id: msj.id ?? null });
  if (errIns) {
    if (errIns.code === "23505") return;   // repetido, ya se procesó
    throw errIns;
  }

  const { data: cfg } = await admin.from("nexa_config")
    .select("prompt,prompt_ficha,modelo,activa,responde_whatsapp").eq("id", 1).single();
  if (!cfg?.activa) return;

  const { data: previos } = await admin.from("nexa_mensajes")
    .select("rol,contenido").eq("conversacion_id", conversacion_id).order("creado_en");
  const historial = (previos ?? []).map((m) => ({ role: m.rol, content: m.contenido }));

  // El interruptor arranca apagado. Mientras lo esté, el mensaje del
  // cliente igual queda guardado y visible en la app: alguien del equipo
  // contesta a mano y nadie pierde la consulta.
  if (cfg.responde_whatsapp && msj.type === "text") {
    const texto = await llamarIA(
      cfg.modelo, `${cfg.prompt}\n\n${CONTEXTO_WHATSAPP}`, historial,
    );
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

  // Meta comprueba el enlace una vez, con un GET.
  if (req.method === "GET") {
    const esperado = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
    if (url.searchParams.get("hub.mode") === "subscribe" &&
        esperado && url.searchParams.get("hub.verify_token") === esperado) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("no", { status: 403 });
  }

  if (req.method !== "POST") return new Response("no", { status: 405 });

  const cuerpo = await req.text();
  const secreto = Deno.env.get("WHATSAPP_APP_SECRET");
  if (!secreto) return new Response("sin configurar", { status: 503 });
  if (!await firmaValida(secreto, cuerpo, req.headers.get("x-hub-signature-256"))) {
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
