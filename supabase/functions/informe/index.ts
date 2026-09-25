// Informe — redacta el informe técnico desde el historial de la OT.
//
// La IA SOLO ordena y redacta lo que YA existe en la OT: no diagnostica,
// no agrega hechos, no cambia la conclusión técnica. El texto vuelve a la
// app en campos editables y una persona lo revisa antes de enviarlo al
// cliente (ver sección "INFORME AUTOMÁTICO" en CLAUDE.md).
//
// Va aparte de la función `nexa` a propósito: es un feature independiente
// del chat con clientes, y no debe romperse ni depender de que PAZ esté
// activa. Comparte el mismo secreto OPENAI_API_KEY (es del proyecto).
//
// Desplegar:  .\.tools\supabase.exe functions deploy informe --use-api

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

// Tope de llamadas por usuario por hora. Cada llamada a la IA cuesta; esto
// es la red de seguridad contra un reintento masivo o un botón apretado en
// loop. El dedup real ("no regenerar si el historial no cambió") lo hace el
// front con el hash antes de llegar acá.
const TOPE_POR_HORA = 25;

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

// Reglas duras de redacción, iguales para "redactar" y "mejorar": la IA
// nunca inventa. Van en el propio prompt, no confían en el modelo.
const REGLAS = [
  "Eres un redactor técnico de Paz Services, taller de reparación de módulos",
  "electrónicos de camiones Mercedes-Benz en Talca, Chile.",
  "",
  "TU ÚNICO TRABAJO es ordenar y redactar profesionalmente información que YA",
  "existe. NO diagnosticas, NO agregas hechos nuevos, NO cambias la conclusión",
  "técnica. Reglas que no puedes romper:",
  "- Redacta en español técnico correcto, con terminología de diagnóstico",
  "  automotriz Mercedes-Benz (módulos, tacógrafo, vector, GS, ADM, MR, caja,",
  "  sensores, etc. — usa solo las que aparezcan en el historial).",
  "- Corrige ortografía y ordena las ideas de forma clara y cronológica.",
  "- Mantén los hechos EXACTAMENTE como están. No agregues piezas, pruebas,",
  "  fechas, módulos, visitas, valores ni conclusiones que no estén en el texto.",
  "- Si algo no está claro, déjalo como 'no especificado' o no lo incluyas.",
  "- NO transformes sospechas en conclusiones. NO conviertas una observación",
  "  preliminar en diagnóstico final.",
].join("\n");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Falta la sesión." }, 401);

    const comoUsuario = createClient(URL_SUPABASE, ANON, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await comoUsuario.auth.getUser();
    if (!user) return json({ error: "Sesión no válida. Vuelve a entrar." }, 401);

    const { data: perfil } = await comoUsuario
      .from("perfiles").select("rol").eq("id", user.id).single();
    if (!perfil || !["dueno", "coordinador"].includes(perfil.rol)) {
      return json({ error: "No tienes permiso para redactar informes con IA." }, 403);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ error: "Falta configurar OPENAI_API_KEY." }, 503);
    }

    // El modelo vive en nexa_config (mismo que usa PAZ). Se lee con service
    // role. Si por alguna razón no está, un modelo por defecto sensato.
    const admin = createClient(URL_SUPABASE, SERVICE);
    const { data: cfg } = await admin.from("nexa_config").select("modelo").eq("id", 1).single();
    const modelo = cfg?.modelo?.trim() || "gpt-5.5";

    const { accion = "redactar", orden_id, fuente = "", fuente_hash = "", texto = "" } =
      await req.json();

    // Tope de frecuencia por usuario (cost guard), común a las dos acciones.
    const hace1h = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await comoUsuario
      .from("informes_ia")
      .select("id", { count: "exact", head: true })
      .eq("generado_por", user.id)
      .gte("generado_en", hace1h);
    if ((count ?? 0) >= TOPE_POR_HORA) {
      return json({
        error: "Llegaste al tope de redacciones por hora. Espera un rato antes de generar más.",
      }, 429);
    }

    // ── Redactar el informe desde el historial ──
    if (accion === "redactar") {
      if (!orden_id) return json({ error: "Falta la OT." }, 400);
      if (!fuente.trim()) return json({ error: "No hay historial que redactar." }, 400);

      const instrucciones = [
        REGLAS,
        "",
        "Recibes el HISTORIAL COMPLETO de una OT, en orden cronológico:",
        "observaciones cargadas por técnicos (pueden venir mal escritas o en",
        "lenguaje coloquial), diagnósticos, trabajos y estados. Tu salida debe",
        "ser EXCLUSIVAMENTE un objeto JSON válido, sin texto fuera del JSON, con",
        "esta forma exacta:",
        '{',
        '  "trabajos_realizados": "Qué se hizo, qué se revisó, qué se probó y en',
        '     qué etapa. Redactado profesional y cronológico. Solo lo que está',
        '     en el historial.",',
        '  "causa_falla": "Solo si existe una conclusión técnica CLARA en el',
        '     historial. Si no existe, deja exactamente el texto: No hay',
        '     conclusión técnica suficiente en el historial para redactar esta',
        '     sección.",',
        '  "advertencias_internas": ["lista breve de datos ambiguos,',
        '     contradictorios o insuficientes que la persona debería revisar.',
        '     Esta lista NO sale en el informe final, solo ayuda a revisar.",',
        '     "una advertencia por elemento; [] si no hay ninguna."]',
        '}',
      ].join("\n");

      const salida = await llamarIA(apiKey, modelo, instrucciones, fuente);
      const limpio = salida.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      let borrador: any;
      try {
        borrador = JSON.parse(limpio);
      } catch {
        return json({ error: "La IA no devolvió un informe legible. Reintenta.", crudo: limpio }, 502);
      }
      const normal = {
        trabajos_realizados: String(borrador?.trabajos_realizados ?? "").trim(),
        causa_falla: String(borrador?.causa_falla ?? "").trim(),
        advertencias_internas: Array.isArray(borrador?.advertencias_internas)
          ? borrador.advertencias_internas.map((x: unknown) => String(x)).filter(Boolean)
          : [],
      };

      // Rastro de auditoría: qué generó la IA, con qué historial (hash) y
      // quién. La aprobación (texto final + quién + cuándo) la agrega el
      // front al guardar el informe.
      const { data: fila, error: eIns } = await comoUsuario
        .from("informes_ia")
        .insert({
          orden_id,
          fuente_hash,
          borrador_ia: normal,
          generado_por: user.id,
        })
        .select("id")
        .single();
      if (eIns) return json({ error: "No se pudo guardar el borrador: " + eIns.message }, 500);

      return json({ borrador: normal, informe_id: fila.id });
    }

    // ── Mejorar la redacción de un borrador escrito por la persona ──
    // Solo mejora ortografía, claridad y tono. No agrega contenido.
    if (accion === "mejorar") {
      if (!texto.trim()) return json({ error: "No hay texto que mejorar." }, 400);
      const instrucciones = [
        REGLAS,
        "",
        "Recibes un borrador escrito por una persona del equipo. Devuelve el",
        "MISMO texto con mejor ortografía, claridad y tono profesional. No",
        "agregues ninguna idea, dato ni frase que no esté en el borrador.",
        "Devuelve solo el texto mejorado, sin comillas ni encabezados.",
      ].join("\n");
      const mejorado = await llamarIA(apiKey, modelo, instrucciones, texto);
      if (!mejorado) return json({ error: "La IA no devolvió texto. Reintenta." }, 502);
      return json({ texto: mejorado });
    }

    return json({ error: `Acción desconocida: ${accion}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Error inesperado." }, 500);
  }
});
