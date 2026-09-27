// Agente de Diagnóstico de Terreno — módulo interno, STANDALONE.
//
// NO ES PAZ ni el Redactor. NO conversa con clientes, NO toca OT, NO toca el
// informe, NO cambia estados ni crea cobros. Su única entrada es el botón
// "Diagnóstico de terreno" en Herramientas (pedido de Jonatan, 27-09-2026:
// "un botón limpio... esa es la única entrada al agente").
//
// FASE 1 (hoy): CAPTURA. El técnico (Jonatan, el cuello de botella) DICTA por
// voz cómo diagnosticó un camión; esta función transcribe (Whisper), ORDENA
// lo dicho en una ficha y le PREGUNTA lo que falta. NO diagnostica ella, NO
// inventa causas ni soluciones -- eso lo pone el técnico. Solo organiza lo
// que se dijo. Cada diagnóstico real queda documentado en terreno_diagnosticos.
// (Fase 2, después: el agente asiste al técnico desde estos casos. No ahora.)
//
// Solo el dueño (mismo criterio que la RLS de 35-agente-terreno.sql).
// Comparte con el resto solo OPENAI_API_KEY y el modelo de nexa_config.
//
// Desplegar:  .\.tools\supabase.exe functions deploy terreno --use-api

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

const TOPE_POR_HORA = 40;

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

function leerJSON(salida: string): any {
  const limpio = salida.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(limpio);
}

// Transcribe un audio subido desde el navegador (MediaRecorder). Whisper
// acepta webm/ogg/m4a/mp3/mp4/wav, que es justo lo que graba el celular.
async function transcribir(apiKey: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", "whisper-1");
  form.append("language", "es");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`No se pudo transcribir el audio: ${(await r.text()).slice(0, 200)}`);
  const { text } = await r.json();
  return (text ?? "").trim();
}

// Identidad + reglas duras. FASE 1 = capturar, no diagnosticar.
const REGLAS = [
  "Eres el asistente de Diagnóstico de Terreno de Paz Services, taller de",
  "reparación de módulos electrónicos de camiones Mercedes-Benz en Talca, Chile.",
  "",
  "TU TRABAJO ES ORDENAR Y PREGUNTAR, NO DIAGNOSTICAR. Un técnico experto te",
  "dicta por voz cómo diagnosticó un camión que YA revisó. Tú SOLO ordenas lo",
  "que él te cuenta en una ficha, y le preguntas lo que falte para que el caso",
  "quede bien documentado. NUNCA propones causas, soluciones ni pasos propios;",
  "no diagnosticas tú; no inventas datos. Si algo no lo dijo, va en null.",
  "",
  "El técnico habla en jerga de taller chilena. Respétala. Repite literal los",
  "códigos de falla, patentes, nombres de módulos y valores que mencione.",
  "",
  "Haz UNA sola pregunta por vez: la del dato más importante que todavía falta",
  "(en este orden si aplica: qué se revisó, qué se encontró, la causa, qué lo",
  "solucionó, si necesitó entrar por remoto/Xentry). Pregunta corta y concreta,",
  "en tono de compañero de taller, no de formulario. Si ya está todo lo",
  "esencial, deja la pregunta en null.",
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
    if (!perfil || perfil.rol !== "dueno") {
      return json({ error: "El Diagnóstico de terreno es solo para el dueño." }, 403);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return json({ error: "Falta configurar OPENAI_API_KEY." }, 503);

    const admin = createClient(URL_SUPABASE, SERVICE);
    const { data: cfg } = await admin.from("nexa_config").select("modelo").eq("id", 1).single();
    const modelo = cfg?.modelo?.trim() || "gpt-5.5";

    // Tope por hora, sobre ia_uso (misma tabla que el Redactor).
    const hace1h = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await comoUsuario
      .from("ia_uso").select("id", { count: "exact", head: true })
      .eq("usuario_id", user.id).eq("accion", "diag_terreno").gte("creado_en", hace1h);
    if ((count ?? 0) >= TOPE_POR_HORA) {
      return json({ error: "Llegaste al tope por hora. Espera un rato." }, 429);
    }
    await comoUsuario.from("ia_uso").insert({ usuario_id: user.id, accion: "diag_terreno" });

    // La entrada puede venir como audio (multipart) o como texto (JSON).
    let transcripcion = "";
    let textoNuevo = "";
    const tipo = req.headers.get("content-type") ?? "";

    if (tipo.includes("multipart/form-data")) {
      const form = await req.formData();
      const audio = form.get("audio");
      const previa = String(form.get("transcripcion_previa") ?? "").trim();
      if (!(audio instanceof File)) return json({ error: "No llegó el audio." }, 400);
      textoNuevo = await transcribir(apiKey, audio);
      transcripcion = [previa, textoNuevo].filter(Boolean).join("\n").trim();
    } else {
      const cuerpo = await req.json().catch(() => ({}));
      transcripcion = String(cuerpo?.transcripcion ?? "").trim();
    }

    if (!transcripcion) {
      return json({ error: "No hay nada que ordenar todavía.", transcripcion, texto_nuevo: textoNuevo });
    }

    const instrucciones = [
      REGLAS, "",
      "Ordena TODO lo que el técnico ha dictado hasta ahora (te paso la",
      "transcripción completa) y devuelve EXCLUSIVAMENTE un JSON válido, sin",
      "texto fuera del JSON, con esta forma exacta:",
      '{ "vehiculo": null, "patente": null, "codigo": null, "sintoma": null,',
      '  "reviso": null, "hallazgo": null, "causa": null, "solucion": null,',
      '  "requirio_remoto": null, "resumen": null, "pregunta": null }',
      "",
      'Reglas de cada campo:',
      '- "patente" en MAYÚSCULAS, sin puntos ni guiones.',
      '- "codigo": el/los código(s) de falla del escáner, tal cual se dijeron.',
      '- "sintoma": qué hacía o reportaba el camión.',
      '- "reviso": qué se revisó o midió.',
      '- "hallazgo": qué se encontró.',
      '- "causa": la causa determinada por el técnico (solo si la dijo).',
      '- "solucion": qué lo solucionó (solo si lo dijo).',
      '- "requirio_remoto": true si tuvo que entrar por Xentry o remoto, false si',
      "  lo resolvió en terreno, null si no se dijo.",
      '- "resumen": UNA línea (máx 140 caracteres) para leer el caso de un vistazo.',
      '- "pregunta": la siguiente pregunta al técnico por el dato más importante',
      "  que falte, o null si ya está lo esencial.",
      "Usa null en lo que no se haya dicho. No inventes ni deduzcas nada.",
    ].join("\n");

    const salida = await llamarIA(apiKey, modelo, instrucciones, transcripcion);
    let f: any;
    try { f = leerJSON(salida); } catch {
      return json({ error: "La IA no devolvió una ficha legible. Reintenta.", transcripcion, texto_nuevo: textoNuevo }, 502);
    }

    const limpiar = (v: unknown) => {
      const s = String(v ?? "").trim();
      return s && s.toLowerCase() !== "null" ? s : null;
    };
    const ficha = {
      vehiculo: limpiar(f?.vehiculo),
      patente: limpiar(f?.patente),
      codigo: limpiar(f?.codigo),
      sintoma: limpiar(f?.sintoma),
      reviso: limpiar(f?.reviso),
      hallazgo: limpiar(f?.hallazgo),
      causa: limpiar(f?.causa),
      solucion: limpiar(f?.solucion),
      requirio_remoto: typeof f?.requirio_remoto === "boolean" ? f.requirio_remoto : null,
      resumen: limpiar(f?.resumen),
    };
    const pregunta = limpiar(f?.pregunta);

    return json({ transcripcion, texto_nuevo: textoNuevo, ficha, pregunta });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Error inesperado." }, 500);
  }
});
