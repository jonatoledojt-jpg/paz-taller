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
      .from("nexa_config").select("prompt,modelo,activa").eq("id", 1).single();

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
      const texto = await llamarIA(apiKey, cfg.modelo, cfg.prompt, historial);
      if (!texto) return json({ error: "La IA no devolvió respuesta. Reintenta." }, 502);
      return json({ respuesta: texto.replaceAll("**", "").replaceAll("*", "") });
    }

    // Segunda pasada: saca la ficha del caso de lo conversado.
    // Va aparte para no ensuciar el prompt conversacional con
    // instrucciones de formato.
    if (accion === "ficha") {
      const instrucciones = [
        "Lee la conversación y devuelve SOLO un objeto JSON, sin texto alrededor,",
        "con estas claves exactas:",
        '{"cliente":null,"telefono":null,"vehiculo":null,"anio":null,"patente":null,',
        '"ubicacion":null,"codigo":null,"sintoma":null,"modulo":null}',
        "Usa null en lo que el cliente todavía no haya dicho.",
        "No inventes ni deduzcas datos que no estén en la conversación.",
        "patente en mayúsculas y sin puntos.",
      ].join(" ");

      const texto = await llamarIA(apiKey, cfg.modelo, instrucciones, historial);
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
