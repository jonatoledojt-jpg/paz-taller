// Agente de Diagnóstico de Laboratorio — módulo interno, STANDALONE.
//
// NO ES PAZ, ni el Redactor, ni el agente de Terreno. Diagnostica módulos
// electrónicos en el banco (hoy el MCM2.1). Lo usan Diego y Jonatan.
//
// El conocimiento vive en las tablas ecu_* (37/38) cargadas del paquete
// verificado. El agente tiene HERRAMIENTAS reales (function calling): busca
// solo los circuitos, pines, componentes, canales, síntomas y zonas que
// necesita -- ya no le pide al técnico lo que la base ya tiene. La respuesta
// va con STREAMING (aparece escribiéndose). Toda tensión con su base; no hay
// medición de fábrica y así hay que darlo.
//
// Solo dueño / coordinador de laboratorio (ve_laboratorio()).
// Desplegar:  .\.tools\supabase.exe functions deploy laboratorio --use-api

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const URL_SUPABASE = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MOD = "mcm2.1-hdep-eu";
const TOPE_POR_HORA = 60;

function extraerTexto(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const partes: string[] = [];
  for (const item of data?.output ?? []) for (const c of item?.content ?? []) if (typeof c?.text === "string") partes.push(c.text);
  return partes.join("\n").trim();
}

// --- Audio (Whisper) y foto (visión), para las entradas multimedia ---
async function transcribir(apiKey: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", "whisper-1");
  form.append("language", "es");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  });
  if (!r.ok) throw new Error(`No se pudo transcribir el audio: ${(await r.text()).slice(0, 200)}`);
  const { text } = await r.json();
  return (text ?? "").trim();
}

const REGLAS_OJOS_LAB = [
  "Extrae SOLO lo útil para diagnosticar de esta foto del banco, en pocas líneas.",
  "Según lo que sea:",
  "- Pantalla de escáner / Xentry: SOLO los códigos de falla (código + texto + estado",
  "  actual/memorizado) y los valores en vivo relevantes (tensiones, etc.).",
  "- Componente: cuál es y su estado (quemado, hinchado, marca de calor, corrosión,",
  "  soldadura fría, pista dañada).",
  "- Instrumento: el valor con su unidad (multímetro, o fuente y su consumo).",
  "- Curva del trazador: la forma (abierta, en corto, deformada, simétrica).",
  "NO describas la laptop, el sistema operativo, la barra de tareas, la fecha, la hora,",
  "los reflejos ni el entorno. NO diagnostiques. Sé breve. Si algo no se lee, dilo.",
].join("\n");

async function leerImagen(apiKey: string, modelo: string, file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dataUrl = `data:${file.type || "image/jpeg"};base64,${encodeBase64(buf)}`;
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelo, instructions: REGLAS_OJOS_LAB,
      input: [{ role: "user", content: [
        { type: "input_text", text: "Describe esta foto del banco." },
        { type: "input_image", image_url: dataUrl },
      ] }],
    }),
  });
  if (!r.ok) throw new Error(`No se pudo leer la imagen: ${(await r.text()).slice(0, 200)}`);
  return extraerTexto(await r.json()).trim();
}

// --- Herramientas (function calling): el agente saca los datos SOLO ---
const HERRAMIENTAS = [
  { type: "function", name: "listar_circuitos", description: "Lista los circuitos trazados disponibles (id y título).", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "ver_circuito", description: "Topología de un circuito: etapas, señales, mediciones esperadas (con su base), ramas, cobertura y lo no dibujado.", parameters: { type: "object", properties: { id: { type: "string", description: "id del circuito, ej: iny-b1, imv, ckp, can1" } }, required: ["id"], additionalProperties: false } },
  { type: "function", name: "buscar_pin", description: "Función de uno o varios pines del conector (1-120).", parameters: { type: "object", properties: { pines: { type: "array", items: { type: "integer" } } }, required: ["pines"], additionalProperties: false } },
  { type: "function", name: "buscar_componente", description: "Busca componentes del listado de fábrica por designador o texto.", parameters: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"], additionalProperties: false } },
  { type: "function", name: "ver_canal", description: "Un canal de válvula proporcional (PWM1..PWM18): su cadena y pin de salida.", parameters: { type: "object", properties: { canal: { type: "string" } }, required: ["canal"], additionalProperties: false } },
  { type: "function", name: "ver_sintoma", description: "Una ruta de diagnóstico por síntoma (id), con sus pasos y circuitos.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { type: "function", name: "ver_zona", description: "Una zona de la placa (1-31).", parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } },
  { type: "function", name: "buscar_casos", description: "Reparaciones reales del taller. Los de resultado confirmado mandan sobre el análisis del circuito; uno en proceso es solo hipótesis del taller.", parameters: { type: "object", properties: { consulta: { type: "string" } }, additionalProperties: false } },
  // Búsqueda web nativa de OpenAI: códigos de falla, hojas de datos y
  // equivalencias. El prompt la pone como último recurso y siempre citando
  // la fuente; los foros de camioneros no valen como dato del esquema.
  { type: "web_search" },
];

function textoCircuito(ci: any, et: any[], med: any[], ram: any[]): string {
  let t = `CIRCUITO ${ci.id} — ${ci.titulo} (hoja ${ci.hoja})\n${ci.funcion ?? ""}\ncobertura: ${ci.cobertura ?? "—"}`;
  if (ci.alimentacion) t += `\nalimentación: ${ci.alimentacion}`;
  if ((ci.no_dibujados_componentes ?? []).length) t += `\nNO dibujados (no ofrezcas su ficha): ${ci.no_dibujados_componentes.join(", ")}`;
  if ((ci.sin_ficha_en_el_listado ?? []).length) t += `\nsin ficha en el listado: ${ci.sin_ficha_en_el_listado.join(", ")}`;
  t += "\nETAPAS:" + (et ?? []).map((e: any) => `\n ${e.n}. [${e.tipo}] ${e.nombre} — entra ${e.senal_entra ?? "?"} / sale ${e.senal_sale ?? "?"}${(e.puntos_prueba ?? []).length ? " · PP: " + e.puntos_prueba.join(",") : ""}${e.que_revisar ? "\n    qué revisar: " + e.que_revisar : ""}`).join("");
  t += "\nMEDICIONES ESPERADAS (cada una con su base):" + (med ?? []).map((m: any) => `\n • ${m.punto}: ${m.valor_esperado ?? "?"} [base: ${m.base ?? "supuesto"}]${m.que_es ? " — " + m.que_es : ""}${m.nota ? " (" + m.nota + ")" : ""}`).join("");
  if ((ram ?? []).length) t += "\nRAMAS:" + ram.map((r: any) => `\n • ${r.nombre}${r.nodo ? " (" + r.nodo + ")" : ""}: ${r.detalle ?? ""}`).join("");
  return t;
}

async function ejecutarHerramienta(admin: any, name: string, args: any): Promise<string> {
  try {
    if (name === "listar_circuitos") {
      const { data } = await admin.from("ecu_circuitos").select("id,titulo,hoja").order("hoja");
      return (data ?? []).map((c: any) => `${c.id} — ${c.titulo} (hoja ${c.hoja})`).join("\n");
    }
    if (name === "ver_circuito") {
      const id = String(args?.id ?? "").trim().toLowerCase();
      const { data: ci } = await admin.from("ecu_circuitos").select("*").eq("id", id).single();
      if (!ci) return `No existe el circuito "${id}". Usa listar_circuitos para ver los ids.`;
      const [{ data: et }, { data: med }, { data: ram }] = await Promise.all([
        admin.from("ecu_etapas").select("n,nombre,tipo,senal_entra,senal_sale,puntos_prueba,que_revisar").eq("circuito_id", id).order("n"),
        admin.from("ecu_mediciones").select("punto,que_es,valor_esperado,base,nota").eq("circuito_id", id),
        admin.from("ecu_ramas").select("nombre,nodo,detalle").eq("circuito_id", id),
      ]);
      return textoCircuito(ci, et ?? [], med ?? [], ram ?? []);
    }
    if (name === "buscar_pin") {
      const pines = (args?.pines ?? []).map(Number).filter((n: number) => n >= 1 && n <= 120);
      const { data } = await admin.from("ecu_pines").select("pin,descripcion,sistema,en_uso").eq("modulo_id", MOD).in("pin", pines.length ? pines : [-1]);
      return (data ?? []).map((p: any) => `pin ${p.pin}: ${p.descripcion}${p.en_uso ? "" : " (sin uso)"}`).join("\n") || "Sin datos de esos pines.";
    }
    if (name === "buscar_componente") {
      const q = String(args?.consulta ?? "").trim();
      if (!q) return "Falta la consulta.";
      const { data } = await admin.from("ecu_componentes").select("designador,nombre,parte,valor,descripcion,hoja").eq("modulo_id", MOD)
        .or(`designador.ilike.%${q}%,descripcion.ilike.%${q}%,nombre.ilike.%${q}%`).limit(20);
      return (data ?? []).map((c: any) => `${c.designador}: ${c.nombre ?? ""} ${c.valor ? "(" + c.valor + ")" : ""} — parte ${c.parte ?? "—"} · hoja ${c.hoja ?? "—"}${c.descripcion ? " · " + c.descripcion : ""}`).join("\n") || `Sin resultados para "${q}".`;
    }
    if (name === "ver_canal") {
      const canal = String(args?.canal ?? "").toUpperCase().replace(/\s/g, "");
      const { data } = await admin.from("ecu_canales_pv").select("*").eq("canal", canal).single();
      if (!data) return `No existe el canal ${canal}.`;
      return `${data.canal} (riel ${data.riel}, ${data.poblado ? "poblado" : "NO poblado"}): pre-driver ${data.pre_driver}, MOSFET ${data.mosfet ?? "—"}, diodo ${data.diodo ?? "—"}, sale por pin ${data.pin_x0120 ?? "—"} del X0120. PP: puerta ${data.tp_puerta ?? "—"}, drenaje ${data.tp_drenaje ?? "—"}, salida ${data.tp_salida ?? "—"}.`;
    }
    if (name === "ver_sintoma") {
      const id = String(args?.id ?? "").trim();
      const { data: sy } = await admin.from("ecu_sintomas").select("*").eq("id", id).single();
      if (!sy) return `No existe el síntoma "${id}".`;
      const [{ data: pasos }, { data: cir }] = await Promise.all([
        admin.from("ecu_sintoma_pasos").select("n,titulo,detalle").eq("sintoma_id", id).order("n"),
        admin.from("ecu_sintoma_circuitos").select("circuito_id").eq("sintoma_id", id),
      ]);
      return `${sy.titulo}\n${sy.detalle ?? ""}\nCircuitos: ${(cir ?? []).map((c: any) => c.circuito_id).join(", ")}\nPasos:\n${(pasos ?? []).map((p: any) => `${p.n}. ${p.titulo ?? ""} ${p.detalle ?? ""}`).join("\n")}`;
    }
    if (name === "ver_zona") {
      const n = Number(args?.n);
      const { data } = await admin.from("ecu_zonas_placa").select("*").eq("modulo_id", MOD).eq("n", n).single();
      if (!data) return `No existe la zona ${n}.`;
      return `Zona ${data.n}: ${data.titulo} (hoja ${data.hoja ?? "—"})${data.nota ? " — " + data.nota : ""}`;
    }
    if (name === "buscar_casos") {
      const { data } = await admin.from("ecu_casos")
        .select("texto_scanner,condiciones,hipotesis,hallazgo_confirmado,accion,resultado,creado_en")
        .order("creado_en", { ascending: false }).limit(10);
      if (!data || !data.length) return "No hay casos del taller registrados todavía. Diagnostica con los datos del circuito.";
      return data.map((c: any) => `[${c.resultado ?? "?"}] ${c.texto_scanner ?? ""} | condiciones: ${c.condiciones ?? "—"} | hallazgo confirmado: ${c.hallazgo_confirmado ?? "—"} | acción: ${c.accion ?? "—"}`).join("\n");
    }
    return `Herramienta desconocida: ${name}`;
  } catch (e) {
    return `Error consultando: ${e instanceof Error ? e.message : e}`;
  }
}

// Corre UN turno del modelo con streaming. Relaya el texto por onText y
// junta los function_call que pida. Devuelve el id de respuesta (para
// encadenar con previous_response_id) y los llamados a herramientas.
async function streamTurno(apiKey: string, body: any, onText: (t: string) => Promise<void>) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!r.ok || !r.body) throw new Error(`La IA respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let responseId: string | null = null;
  const fns: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const partes = buf.split("\n\n");
    buf = partes.pop() ?? "";
    for (const p of partes) {
      const linea = p.split("\n").find((l) => l.startsWith("data:"));
      if (!linea) continue;
      const s = linea.slice(5).trim();
      if (!s || s === "[DONE]") continue;
      let ev: any; try { ev = JSON.parse(s); } catch { continue; }
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        await onText(ev.delta);
      } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
        fns.push({ name: ev.item.name, arguments: ev.item.arguments, call_id: ev.item.call_id });
      } else if (ev.type === "response.completed") {
        responseId = ev.response?.id ?? responseId;
      }
    }
  }
  return { responseId, functionCalls: fns };
}

// El agente conversa y usa herramientas hasta dar la respuesta final; el texto
// se va entregando por onText a medida que se genera.
async function correrLoop(apiKey: string, admin: any, modelo: string, instrucciones: string, inputInicial: any, onText: (t: string) => Promise<void>) {
  let body: any = { model: modelo, instructions: instrucciones, input: inputInicial, tools: HERRAMIENTAS };
  for (let ronda = 0; ronda < 6; ronda++) {
    const { responseId, functionCalls } = await streamTurno(apiKey, body, onText);
    if (!functionCalls.length) return;
    const outputs: any[] = [];
    for (const fc of functionCalls) {
      let args: any = {}; try { args = JSON.parse(fc.arguments || "{}"); } catch { /* deja {} */ }
      const res = await ejecutarHerramienta(admin, fc.name, args);
      outputs.push({ type: "function_call_output", call_id: fc.call_id, output: String(res).slice(0, 6000) });
    }
    body = { model: modelo, previous_response_id: responseId, input: outputs, tools: HERRAMIENTAS };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Falta la sesión." }, 401);
    const comoUsuario = createClient(URL_SUPABASE, ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await comoUsuario.auth.getUser();
    if (!user) return json({ error: "Sesión no válida. Vuelve a entrar." }, 401);

    const { data: perfil } = await comoUsuario.from("perfiles").select("rol,area").eq("id", user.id).single();
    const puede = perfil && (perfil.rol === "dueno" || (perfil.rol === "coordinador" && perfil.area === "laboratorio"));
    if (!puede) return json({ error: "El Diagnóstico de laboratorio es solo para el dueño o el encargado de laboratorio." }, 403);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return json({ error: "Falta configurar OPENAI_API_KEY." }, 503);

    const admin = createClient(URL_SUPABASE, SERVICE);
    const { data: cfg } = await admin.from("ecu_config").select("prompt,modelo").eq("id", 1).single();
    let modelo = cfg?.modelo?.trim();
    if (!modelo) { const { data: nx } = await admin.from("nexa_config").select("modelo").eq("id", 1).single(); modelo = nx?.modelo?.trim() || "gpt-5.5"; }
    const prompt = cfg?.prompt?.trim();
    if (!prompt) return json({ error: "El agente de laboratorio no está configurado (falta el prompt)." }, 503);

    // Tope por hora.
    const hace1h = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await comoUsuario.from("ia_uso").select("id", { count: "exact", head: true })
      .eq("usuario_id", user.id).eq("accion", "lab").gte("creado_en", hace1h);
    if ((count ?? 0) >= TOPE_POR_HORA) return json({ error: "Llegaste al tope por hora. Espera un rato." }, 429);
    await comoUsuario.from("ia_uso").insert({ usuario_id: user.id, accion: "lab" });

    // Entrada: JSON (texto) o multipart (audio / imagen).
    let hist: any[] = [];
    let textoUsuario: string | null = null;
    let esMultipart = false;
    const tipo = req.headers.get("content-type") ?? "";
    if (tipo.includes("multipart/form-data")) {
      esMultipart = true;
      const form = await req.formData();
      try { hist = JSON.parse(String(form.get("historial") ?? "[]")); } catch { hist = []; }
      hist = Array.isArray(hist) ? hist.filter((m: any) => m && typeof m.content === "string") : [];
      const audio = form.get("audio");
      const imagen = form.get("imagen");
      if (audio instanceof File) textoUsuario = await transcribir(apiKey, audio);
      else if (imagen instanceof File) { const d = await leerImagen(apiKey, modelo, imagen); textoUsuario = d ? `[Pantalla del escáner / foto del banco] ${d}` : ""; }
      else return json({ error: "No llegó ni audio ni imagen." }, 400);
      if (!textoUsuario) return json({ error: "No se entendió el audio o la imagen. Reintenta." }, 400);
      hist.push({ role: "user", content: textoUsuario });
    } else {
      const { historial = [] } = await req.json();
      hist = Array.isArray(historial) ? historial.filter((m: any) => m && typeof m.content === "string") : [];
    }
    if (!hist.length) return json({ error: "No hay mensaje." }, 400);

    const { data: circs } = await admin.from("ecu_circuitos").select("id").order("id");
    const instrucciones = prompt +
      "\n\nTIENES HERRAMIENTAS DE VERDAD: úsalas para sacar tú mismo los datos del módulo (ver_circuito, buscar_pin, buscar_componente, ver_canal, ver_sintoma, ver_zona, listar_circuitos). NUNCA le pidas al técnico una foto de un diagrama ni pines que puedes obtener con ver_circuito. Los diagramas y datos ya están en el sistema; búscalos tú." +
      "\n\nCircuitos disponibles (id para ver_circuito): " + (circs ?? []).map((c: any) => c.id).join(", ");

    const input = hist.map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

    // Multipart: se corre el loop juntando el texto y se devuelve JSON (con lo
    // que se transcribió/leyó). Texto: se transmite con streaming.
    if (esMultipart) {
      let out = "";
      await correrLoop(apiKey, admin, modelo, instrucciones, input, async (t) => { out += t; });
      return json({ texto_usuario: textoUsuario, respuesta: out.replaceAll("**", "") });
    }

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          await correrLoop(apiKey, admin, modelo, instrucciones, input, async (t) => controller.enqueue(enc.encode(t.replaceAll("**", ""))));
        } catch (e) {
          controller.enqueue(enc.encode("\n[Error: " + (e instanceof Error ? e.message : e) + "]"));
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Error inesperado." }, 500);
  }
});
