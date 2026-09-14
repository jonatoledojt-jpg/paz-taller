// Nexa — puente entre la app y la IA.
//
// La llave de la IA vive acá (como secreto de Supabase), nunca en el
// index.html, que es público. El prompt vive en la tabla nexa_config,
// no en este archivo, porque tiene precios y reglas comerciales y este
// repo es público.
//
// Desplegar:  supabase functions deploy nexa --use-api
// Llave:      supabase secrets set OPENAI_API_KEY=...

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const URL_SUPABASE = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// El prompt de PAZ está escrito pensando en el cliente por WhatsApp. Cuando
// la llaman desde la app, quien escribe es alguien del equipo pasando lo que
// dijo el cliente — si no se le aclara, PAZ le habla al colega como si fuera
// el cliente y dice cosas como "avísame por este mismo canal".
const CONTEXTO_APP = [
  "CONTEXTO DEL CANAL: estás dentro de la app interna de Paz Services.",
  "Quien te escribe NO es el cliente: es alguien del equipo que te está",
  "pasando lo que el cliente dijo por teléfono o por WhatsApp.",
  "Redacta igual que si le hablaras al cliente, porque tu respuesta se le va",
  "a copiar tal cual. Pero nunca digas 'por este mismo canal', 'por acá' ni",
  "'respóndeme aquí': di 'por WhatsApp' cuando necesites que el cliente",
  "mande algo.",
].join(" ");

// La API devuelve el texto en distintos lugares según el modelo.
// Se prueban las formas conocidas en vez de asumir una sola.
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

async function llamarIA(apiKey: string, modelo: string, instrucciones: string, entrada: unknown) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelo, instructions: instrucciones, input: entrada }),
  });
  if (!r.ok) {
    const detalle = await r.text();
    throw new Error(`La IA respondió ${r.status}: ${detalle.slice(0, 300)}`);
  }
  return extraerTexto(await r.json());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Falta la sesión." }, 401);

    // Con el token del usuario: así sabemos quién es y el RLS sigue aplicando.
    const comoUsuario = createClient(URL_SUPABASE, ANON, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await comoUsuario.auth.getUser();
    if (!user) return json({ error: "Sesión no válida. Vuelve a entrar." }, 401);

    const { data: perfil } = await comoUsuario
      .from("perfiles").select("rol").eq("id", user.id).single();
    if (!perfil || !["dueno", "coordinador"].includes(perfil.rol)) {
      return json({ error: "No tienes permiso para usar Nexa." }, 403);
    }

    // El prompt se lee con service_role: es el único que puede verlo.
    const admin = createClient(URL_SUPABASE, SERVICE);
    const { data: cfg } = await admin
      .from("nexa_config").select("prompt,prompt_ficha,modelo,activa").eq("id", 1).single();

    if (!cfg?.activa) return json({ error: "Nexa está desactivada." }, 503);
    if (!cfg.prompt?.trim()) {
      return json({ error: "Nexa no tiene instrucciones cargadas todavía." }, 503);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({
        error: "Falta configurar la llave de la IA. Corre: supabase secrets set OPENAI_API_KEY=tu-llave",
      }, 503);
    }

    const { accion = "responder", historial = [] } = await req.json();

    if (!Array.isArray(historial) || !historial.length) {
      return json({ error: "No hay conversación que procesar." }, 400);
    }

    if (accion === "responder") {
      const texto = await llamarIA(
        apiKey, cfg.modelo, `${cfg.prompt}\n\n${CONTEXTO_APP}`, historial);
      if (!texto) return json({ error: "La IA no devolvió respuesta. Reintenta." }, 502);
      return json({ respuesta: texto.replaceAll("**", "").replaceAll("*", "") });
    }

    // Segunda pasada: saca la ficha del caso de lo conversado.
    // Va aparte para no ensuciar el prompt conversacional con
    // instrucciones de formato.
    //
    // Las instrucciones viven en nexa_config.prompt_ficha, no acá: la
    // función de WhatsApp usa exactamente las mismas, y si cada una
    // tuviera su copia terminarían armando fichas distintas.
    if (accion === "ficha") {
      if (!cfg.prompt_ficha?.trim()) {
        return json({ error: "Faltan las instrucciones de la ficha en nexa_config." }, 503);
      }
      const texto = await llamarIA(apiKey, cfg.modelo, cfg.prompt_ficha, historial);
      const limpio = texto.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      try {
        return json({ ficha: JSON.parse(limpio) });
      } catch {
        return json({ error: "No se pudo leer la ficha que devolvió la IA.", crudo: limpio }, 502);
      }
    }

    return json({ error: `Acción desconocida: ${accion}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Error inesperado en Nexa." }, 500);
  }
});
