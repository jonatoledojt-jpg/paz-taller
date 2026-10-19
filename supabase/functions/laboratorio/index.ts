// Agente de Diagnóstico de Laboratorio — módulo interno, STANDALONE.
//
// NO ES PAZ, ni el Redactor, ni el agente de Terreno. Diagnostica módulos
// electrónicos en el banco (hoy el MCM2.1). Lo usan Diego y Jonatan.
//
// El conocimiento vive en las tablas ecu_* (37/38) cargadas del paquete
// verificado. El agente tiene HERRAMIENTAS reales (tool-calling de Claude):
// busca solo los circuitos, pines, componentes, canales, síntomas y zonas que
// necesita -- ya no le pide al técnico lo que la base ya tiene. Toda tensión
// con su base; no hay medición de fábrica y así hay que darlo.
//
// LLAVES (migrado a Claude el 18-10-2026, sobre el crédito del plan): el
// razonamiento, las herramientas, la búsqueda web (nativa de Anthropic) y la
// visión van con ANTHROPIC_API_KEY (claude-sonnet-5-5); el AUDIO se transcribe
// con Whisper de OpenAI (OPENAI_API_KEY) — Claude no transcribe. El tool-loop es
// NO-streaming (más robusto con las herramientas), pero el texto de cada vuelta
// se entrega al cliente a medida que llega (antes era streaming token a token).
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

// Normaliza una conversación a la alternancia user/assistant que exige Claude
// (fusiona consecutivos del mismo rol, empieza en user). Solo mensajes de texto.
function aMensajesClaude(arr: any[]): { role: "user" | "assistant"; content: string }[] {
  const norm = (Array.isArray(arr) ? arr : [])
    .map((m: any) => ({ role: (m?.role === "assistant" ? "assistant" : "user") as "user" | "assistant", content: String(m?.content ?? "").trim() }))
    .filter((m) => m.content);
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of norm) {
    const ult = out[out.length - 1];
    if (ult && ult.role === m.role) ult.content += "\n\n" + m.content;
    else out.push({ ...m });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length) out.push({ role: "user", content: "(sin contenido)" });
  return out;
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
  const b64 = encodeBase64(buf);
  const mt = (file.type && file.type.startsWith("image/")) ? file.type : "image/jpeg";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: modelo, max_tokens: 1500, system: REGLAS_OJOS_LAB,
      messages: [{ role: "user", content: [
        { type: "text", text: "Describe esta foto del banco." },
        { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
      ] }],
    }),
  });
  if (!r.ok) throw new Error(`No se pudo leer la imagen: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const bloque = (data?.content ?? []).find((b: any) => b?.type === "text");
  return (bloque?.text ?? "").trim();
}

// --- Herramientas (tool-calling de Claude): el agente saca los datos SOLO ---
// Formato Claude: { name, description, input_schema }. La búsqueda web es la
// herramienta nativa de Anthropic (server-side). El prompt la pone como último
// recurso y siempre citando la fuente; los foros de camioneros no valen.
const HERRAMIENTAS = [
  { name: "listar_circuitos", description: "Lista los circuitos trazados disponibles (id y título).", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "ver_circuito", description: "Topología de un circuito: etapas, señales, mediciones esperadas (con su base), ramas, cobertura y lo no dibujado.", input_schema: { type: "object", properties: { id: { type: "string", description: "id del circuito, ej: iny-b1, imv, ckp, can1" } }, required: ["id"], additionalProperties: false } },
  { name: "buscar_pin", description: "Función de uno o varios pines del conector (1-120).", input_schema: { type: "object", properties: { pines: { type: "array", items: { type: "integer" } } }, required: ["pines"], additionalProperties: false } },
  { name: "buscar_componente", description: "Busca componentes del listado de fábrica por designador o texto.", input_schema: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"], additionalProperties: false } },
  { name: "ver_canal", description: "Un canal de válvula proporcional (PWM1..PWM18): su cadena y pin de salida.", input_schema: { type: "object", properties: { canal: { type: "string" } }, required: ["canal"], additionalProperties: false } },
  { name: "ver_sintoma", description: "Una ruta de diagnóstico por síntoma (id), con sus pasos y circuitos.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "ver_zona", description: "Una zona de la placa (1-31).", input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } },
  { name: "buscar_casos", description: "Reparaciones reales del taller. Los de resultado confirmado mandan sobre el análisis del circuito; uno en proceso es solo hipótesis del taller.", input_schema: { type: "object", properties: { consulta: { type: "string" } }, additionalProperties: false } },
  { name: "ver_reglas_banco", description: "Reglas de seguridad del banco, obligatorias antes de energizar un circuito de potencia. La primera salió de quemar un componente de verdad.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { type: "web_search_20250305", name: "web_search", max_uses: 4 },
];

function textoCircuito(ci: any, et: any[], med: any[], ram: any[]): string {
  let t = `CIRCUITO ${ci.id} — ${ci.titulo} (hoja ${ci.hoja})\n${ci.funcion ?? ""}\ncobertura: ${ci.cobertura ?? "—"}`;
  t += `\nCONFIANZA: ${ci.verificado_en_placa ? "verificado midiendo en placa" : "NO verificado en placa (solo lectura del plano)"}${ci.confianza_nota ? " — " + ci.confianza_nota : ""}`;
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
      const { data } = await admin.from("ecu_componentes").select("designador,nombre,parte,valor,descripcion,hoja,circuitos").eq("modulo_id", MOD)
        .or(`designador.ilike.%${q}%,descripcion.ilike.%${q}%,nombre.ilike.%${q}%`).limit(20);
      if (!data || !data.length) return `Sin resultados para "${q}".`;
      // Equivalente comercial: lo que el técnico puede comprar. Se cruza por designador.
      const { data: eqs } = await admin.from("ecu_equivalencias").select("equivalente_comercial,que_es,conseguir,designadores,ojo");
      const eqMap: Record<string, any> = {};
      for (const e of eqs ?? []) for (const d of (e.designadores ?? [])) eqMap[d] = e;
      return data.map((c: any) => {
        let l = `${c.designador}: ${c.nombre ?? ""} ${c.valor ? "(" + c.valor + ")" : ""} — parte ${c.parte ?? "—"} · hoja ${c.hoja ?? "—"}${c.descripcion ? " · " + c.descripcion : ""}${(c.circuitos ?? []).length ? " · circuitos: " + c.circuitos.join(", ") : ""}`;
        const e = eqMap[c.designador];
        if (e) l += `\n   EQUIVALENTE COMERCIAL (lo que se compra): ${e.equivalente_comercial}${e.que_es ? " — " + e.que_es : ""}${e.conseguir ? " · " + e.conseguir : ""}${e.ojo ? " · ojo: " + e.ojo : ""}`;
        return l;
      }).join("\n");
    }
    if (name === "ver_reglas_banco") {
      const { data } = await admin.from("ecu_reglas_banco").select("n,regla,por_que,que_hacer").order("n");
      if (!data || !data.length) return "No hay reglas de banco cargadas.";
      return "REGLAS DE BANCO (obligatorias antes de energizar):\n" + data.map((r: any) => `${r.n}. ${r.regla}${r.por_que ? " — " + r.por_que : ""}${r.que_hacer ? " → " + r.que_hacer : ""}`).join("\n");
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

// Un turno NO-streaming de Claude con herramientas. Devuelve el content
// completo (bloques text / tool_use / server tools) y el stop_reason.
async function turnoClaude(apiKey: string, modelo: string, system: string, messages: any[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: modelo, max_tokens: 4096, system, messages, tools: HERRAMIENTAS }),
  });
  if (!r.ok) throw new Error(`La IA respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return { content: d?.content ?? [], stop: d?.stop_reason };
}

// El agente conversa y usa herramientas hasta dar la respuesta final. Las
// herramientas propias (ver_circuito, etc.) las ejecuto yo y le devuelvo el
// resultado; la búsqueda web la resuelve Claude solo (server tool). El texto
// de cada vuelta se entrega por onText a medida que llega.
async function correrLoop(apiKey: string, admin: any, modelo: string, system: string, mensajesIniciales: any[], onText: (t: string) => Promise<void>) {
  const messages: any[] = [...mensajesIniciales];
  for (let ronda = 0; ronda < 8; ronda++) {
    const { content, stop } = await turnoClaude(apiKey, modelo, system, messages);
    for (const b of content) {
      if (b?.type === "text" && b.text) await onText(b.text);
    }
    const usos = content.filter((b: any) => b?.type === "tool_use"); // solo herramientas propias
    if (stop === "tool_use" && usos.length) {
      messages.push({ role: "assistant", content });
      const resultados: any[] = [];
      for (const tu of usos) {
        const res = await ejecutarHerramienta(admin, tu.name, tu.input ?? {});
        resultados.push({ type: "tool_result", tool_use_id: tu.id, content: String(res).slice(0, 6000) });
      }
      messages.push({ role: "user", content: resultados });
      continue;
    }
    // pause_turn: la búsqueda web quedó a medias; se reenvía el parcial y sigue.
    if (stop === "pause_turn") { messages.push({ role: "assistant", content }); continue; }
    return; // end_turn / max_tokens / etc.
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

    const apiKey = Deno.env.get("OPENAI_API_KEY");           // Whisper (audio)
    const apiKeyClaude = Deno.env.get("ANTHROPIC_API_KEY");  // razonamiento, herramientas, visión, web
    if (!apiKeyClaude) return json({ error: "Falta configurar ANTHROPIC_API_KEY." }, 503);
    const modelo = "claude-sonnet-5-5";

    const admin = createClient(URL_SUPABASE, SERVICE);
    const { data: cfg } = await admin.from("ecu_config").select("prompt").eq("id", 1).single();
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
      if (audio instanceof File) {
        if (!apiKey) return json({ error: "Falta OPENAI_API_KEY para transcribir el audio." }, 503);
        textoUsuario = await transcribir(apiKey, audio);
      }
      else if (imagen instanceof File) { const d = await leerImagen(apiKeyClaude, modelo, imagen); textoUsuario = d ? `[Pantalla del escáner / foto del banco] ${d}` : ""; }
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
      "\n\nTIENES HERRAMIENTAS DE VERDAD: úsalas para sacar tú mismo los datos del módulo (ver_circuito, buscar_pin, buscar_componente, ver_canal, ver_sintoma, ver_zona, listar_circuitos, ver_reglas_banco). NUNCA le pidas al técnico una foto de un diagrama ni pines que puedes obtener con ver_circuito. Los diagramas y datos ya están en el sistema; búscalos tú." +
      "\n\nHONESTIDAD DEL DATO: ningún circuito está verificado midiendo en placa (ver_circuito te dice la confianza de cada uno). Toda tensión trae su base; si dice 'supuesto', avísale que hay que confirmarla midiendo. buscar_componente ya te da el equivalente comercial (lo que se compra) cuando existe. Antes de proponer energizar un circuito de potencia, llama ver_reglas_banco y dísela al técnico — la primera salió de quemar un componente de verdad (nunca una ampolleta como carga de prueba)." +
      "\n\nCircuitos disponibles (id para ver_circuito): " + (circs ?? []).map((c: any) => c.id).join(", ");

    const input = aMensajesClaude(hist);

    // Multipart: se corre el loop juntando el texto y se devuelve JSON (con lo
    // que se transcribió/leyó). Texto: se va entregando por el stream a medida
    // que Claude termina cada vuelta.
    if (esMultipart) {
      let out = "";
      await correrLoop(apiKeyClaude, admin, modelo, instrucciones, input, async (t) => { out += t; });
      return json({ texto_usuario: textoUsuario, respuesta: out.replaceAll("**", "") });
    }

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          await correrLoop(apiKeyClaude, admin, modelo, instrucciones, input, async (t) => controller.enqueue(enc.encode(t.replaceAll("**", ""))));
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
