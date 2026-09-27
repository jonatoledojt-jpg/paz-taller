// Agente de Diagnóstico de Laboratorio — módulo interno, STANDALONE.
//
// NO ES PAZ, ni el Redactor, ni el agente de Terreno. Otro prompt, otras
// tablas (ecu_*), otro tono. Diagnostica módulos electrónicos en el banco
// (hoy el MCM2.1). Lo usan Diego (encargado de laboratorio) y Jonatan.
//
// El conocimiento del módulo vive en las tablas ecu_* (37/38) cargadas del
// paquete verificado. Esta función CONVERSA: en cada mensaje ubica en la base
// lo que el técnico menciona (código, circuito, pin, componente, canal,
// síntoma, zona) y se lo entrega al modelo como contexto. El modelo razona
// con el prompt del diagnosticador (ecu_config.prompt), y toda tensión que da
// viene con su `base` -- no hay una sola medición de fábrica, y así hay que
// darlo. No inventa puntos de prueba que no estén en los datos.
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
  if (!r.ok) throw new Error(`La IA respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return extraerTexto(await r.json());
}

// Transcribe un audio grabado en el navegador (manos ocupadas en el banco).
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

// Los OJOS en el banco: describe LITERAL lo que se ve en una foto del taller
// (componente y su estado, lectura de instrumento, curva del trazador, zona de
// la placa). NO diagnostica -- eso lo hace el agente con esta descripción.
const REGLAS_OJOS_LAB = [
  "Describe LITERAL lo que se ve en esta foto de un banco de reparación de módulos",
  "electrónicos. Puede ser: un componente y su estado (quemado, hinchado, con marca",
  "de calor, corrosión, soldadura fría, pista dañada), una lectura de instrumento",
  "(multímetro con su valor y unidad, fuente con su consumo), la curva de un trazador",
  "(forma: abierta, en corto, deformada, simétrica), o una zona de la placa con sus",
  "designadores visibles. NO diagnostiques ni interpretes la causa: solo describe lo",
  "que se ve, con los números y textos que alcances a leer. Si algo está borroso, dilo.",
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

// Arma el bloque de contexto: lo que el técnico mencionó, buscado en las
// tablas ecu_*. Devuelve texto para meter en las instrucciones del modelo.
async function armarContexto(admin: any, mensaje: string): Promise<string> {
  const bloques: string[] = [];
  const up = mensaje.toUpperCase();
  const low = mensaje.toLowerCase();

  // Catálogo compacto: qué circuitos/códigos/síntomas existen (para que el
  // agente sepa qué puede pedir por id).
  const { data: circs } = await admin.from("ecu_circuitos").select("id,titulo,cobertura").order("id");
  const { data: cods } = await admin.from("ecu_codigos").select("codigo,texto");
  const { data: sints } = await admin.from("ecu_sintomas").select("id,titulo");
  const catalogo =
    "CIRCUITOS TRAZADOS (id — título): " + (circs ?? []).map((c: any) => `${c.id} — ${c.titulo}`).join("; ") +
    "\nSÍNTOMAS: " + (sints ?? []).map((s: any) => `${s.id} — ${s.titulo}`).join("; ") +
    "\nCÓDIGOS CARGADOS: " + (cods ?? []).map((c: any) => c.codigo).join(", ");
  bloques.push(catalogo);

  const idsCirc = new Set<string>();

  // Códigos mencionados
  for (const c of cods ?? []) {
    if (up.includes(String(c.codigo).toUpperCase())) {
      const { data: full } = await admin.from("ecu_codigos").select("*").eq("codigo", c.codigo).single();
      bloques.push(`CÓDIGO ${full.codigo}: ${full.texto}\n  circuito: ${full.circuito_id ?? "—"} · componente externo: ${full.componente_externo ?? "—"} · tipo: ${full.tipo_falla ?? "—"}`);
      if (full.circuito_id) idsCirc.add(full.circuito_id);
    }
  }

  // Circuitos por id como palabra
  for (const c of circs ?? []) {
    const re = new RegExp(`\\b${c.id.replace(/[-]/g, "\\-")}\\b`, "i");
    if (re.test(mensaje)) idsCirc.add(c.id);
  }

  // Detalle de hasta 3 circuitos
  let usados = 0;
  for (const id of idsCirc) {
    if (usados++ >= 3) break;
    const { data: ci } = await admin.from("ecu_circuitos")
      .select("id,titulo,subtitulo,hoja,funcion,alimentacion,cobertura,nota,no_dibujados_componentes,no_dibujados_puntos,sin_ficha_en_el_listado").eq("id", id).single();
    if (!ci) continue;
    const { data: et } = await admin.from("ecu_etapas").select("n,nombre,tipo,senal_entra,senal_sale,puntos_prueba,que_revisar").eq("circuito_id", id).order("n");
    const { data: med } = await admin.from("ecu_mediciones").select("punto,que_es,valor_esperado,base,nota").eq("circuito_id", id);
    const { data: ram } = await admin.from("ecu_ramas").select("nombre,nodo,detalle").eq("circuito_id", id);
    let t = `CIRCUITO ${ci.id} — ${ci.titulo} (hoja ${ci.hoja})\n  ${ci.funcion ?? ""}\n  cobertura: ${ci.cobertura ?? "—"}`;
    if (ci.alimentacion) t += `\n  alimentación: ${ci.alimentacion}`;
    if ((ci.no_dibujados_componentes ?? []).length) t += `\n  NO dibujados (no ofrezcas su ficha): ${ci.no_dibujados_componentes.join(", ")}`;
    if ((ci.sin_ficha_en_el_listado ?? []).length) t += `\n  sin ficha en el listado de fábrica: ${ci.sin_ficha_en_el_listado.join(", ")}`;
    t += "\n  ETAPAS:" + (et ?? []).map((e: any) => `\n   ${e.n}. [${e.tipo}] ${e.nombre} — entra ${e.senal_entra ?? "?"} / sale ${e.senal_sale ?? "?"}${(e.puntos_prueba ?? []).length ? " · PP: " + e.puntos_prueba.join(",") : ""}${e.que_revisar ? "\n      qué revisar: " + e.que_revisar : ""}`).join("");
    t += "\n  MEDICIONES ESPERADAS (cada una con su base):" + (med ?? []).map((m: any) => `\n   • ${m.punto}: ${m.valor_esperado ?? "?"} [base: ${m.base ?? "supuesto"}]${m.que_es ? " — " + m.que_es : ""}${m.nota ? " (" + m.nota + ")" : ""}`).join("");
    if ((ram ?? []).length) t += "\n  RAMAS:" + ram.map((r: any) => `\n   • ${r.nombre}${r.nodo ? " (" + r.nodo + ")" : ""}: ${r.detalle ?? ""}`).join("");
    bloques.push(t);
  }

  // Pines mencionados
  const pines = [...low.matchAll(/\bpin(?:es)?\s+(\d{1,3})(?:\s+y\s+(\d{1,3}))?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean).map(Number);
  if (pines.length) {
    const { data } = await admin.from("ecu_pines").select("pin,descripcion,sistema,en_uso").eq("modulo_id", MOD).in("pin", pines);
    if ((data ?? []).length) bloques.push("PINES:" + data.map((p: any) => `\n   • pin ${p.pin}: ${p.descripcion}${p.en_uso ? "" : " (sin uso)"}`).join(""));
  }

  // Componentes por designador
  const desig = [...up.matchAll(/\b([A-Z]\d{3,4})\b/g)].map((m) => m[1]);
  if (desig.length) {
    const { data } = await admin.from("ecu_componentes").select("designador,nombre,parte,valor,descripcion,hoja").eq("modulo_id", MOD).in("designador", [...new Set(desig)].slice(0, 20));
    if ((data ?? []).length) bloques.push("COMPONENTES:" + data.map((c: any) => `\n   • ${c.designador}: ${c.nombre ?? ""} ${c.valor ? "(" + c.valor + ")" : ""} — parte ${c.parte ?? "—"} · hoja ${c.hoja ?? "—"}${c.descripcion ? " · " + c.descripcion : ""}`).join(""));
  }

  // Canales PWM
  const pwm = [...up.matchAll(/\bPWM\s?(\d{1,2})\b/g)].map((m) => "PWM" + m[1]);
  if (pwm.length) {
    const { data } = await admin.from("ecu_canales_pv").select("*").in("canal", [...new Set(pwm)]);
    if ((data ?? []).length) bloques.push("CANALES PV:" + data.map((c: any) => `\n   • ${c.canal} (riel ${c.riel}, ${c.poblado ? "poblado" : "NO poblado"}): pre-driver ${c.pre_driver}, MOSFET ${c.mosfet ?? "—"}, sale por pin ${c.pin_x0120 ?? "—"} del X0120. PP salida ${c.tp_salida ?? "—"}`).join(""));
  }

  // Síntomas por id
  for (const s of sints ?? []) {
    if (low.includes(s.id.toLowerCase())) {
      const { data: sy } = await admin.from("ecu_sintomas").select("*").eq("id", s.id).single();
      const { data: pasos } = await admin.from("ecu_sintoma_pasos").select("n,titulo,detalle").eq("sintoma_id", s.id).order("n");
      let t = `SÍNTOMA ${sy.id} — ${sy.titulo}\n  ${sy.detalle ?? ""}`;
      if ((pasos ?? []).length) t += "\n  PASOS:" + pasos.map((p: any) => `\n   ${p.n}. ${p.titulo ?? ""} ${p.detalle ?? ""}`).join("");
      bloques.push(t);
    }
  }

  bloques.push("Si necesitas otro circuito, pin, componente, canal, síntoma o zona que no esté arriba, pídelo por su id/número y te lo entrego en el próximo mensaje. No inventes puntos de prueba ni valores que no estén en estos datos.");
  return bloques.join("\n\n");
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

    // Tope por hora (cubre texto, audio e imagen: todos llaman al modelo).
    const hace1h = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await comoUsuario.from("ia_uso").select("id", { count: "exact", head: true })
      .eq("usuario_id", user.id).eq("accion", "lab").gte("creado_en", hace1h);
    if ((count ?? 0) >= TOPE_POR_HORA) return json({ error: "Llegaste al tope por hora. Espera un rato." }, 429);
    await comoUsuario.from("ia_uso").insert({ usuario_id: user.id, accion: "lab" });

    // La entrada puede ser JSON (texto) o multipart (audio / imagen).
    let hist: any[] = [];
    let textoUsuario: string | null = null;
    const tipo = req.headers.get("content-type") ?? "";
    if (tipo.includes("multipart/form-data")) {
      const form = await req.formData();
      try { hist = JSON.parse(String(form.get("historial") ?? "[]")); } catch { hist = []; }
      hist = Array.isArray(hist) ? hist.filter((m: any) => m && typeof m.content === "string") : [];
      const audio = form.get("audio");
      const imagen = form.get("imagen");
      if (audio instanceof File) textoUsuario = await transcribir(apiKey, audio);
      else if (imagen instanceof File) { const d = await leerImagen(apiKey, modelo, imagen); textoUsuario = d ? `[Foto del banco] ${d}` : ""; }
      else return json({ error: "No llegó ni audio ni imagen." }, 400);
      if (!textoUsuario) return json({ error: "No se entendió el audio o la imagen. Reintenta." }, 400);
      hist.push({ role: "user", content: textoUsuario });
    } else {
      const { historial = [] } = await req.json();
      hist = Array.isArray(historial) ? historial.filter((m: any) => m && typeof m.content === "string") : [];
    }
    if (!hist.length) return json({ error: "No hay mensaje." }, 400);

    const ultimo = [...hist].reverse().find((m: any) => m.role === "user")?.content ?? hist[hist.length - 1].content;
    const contexto = await armarContexto(admin, String(ultimo));
    const instrucciones = prompt + "\n\n## DATOS DEL MÓDULO QUE EL SISTEMA UBICÓ PARA ESTA CONSULTA\n(Reemplaza a las herramientas: es lo que se encontró en la base para lo que se mencionó.)\n\n" + contexto;
    const texto = await llamarIA(apiKey, modelo, instrucciones, hist.map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })));
    const limpio = texto.replaceAll("**", "");
    if (!limpio) return json({ error: "La IA no devolvió respuesta. Reintenta." }, 502);
    return json({ respuesta: limpio, texto_usuario: textoUsuario });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Error inesperado." }, 500);
  }
});
