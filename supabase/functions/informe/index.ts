// Redactor IA (Agente Redactor de Informes) — módulo interno.
//
// ESTO NO ES PAZ (el agente de WhatsApp). Es un módulo distinto: NO
// conversa con clientes, NO envía mensajes, NO agenda, NO cambia estados
// de OT, NO crea cobros y NO toma decisiones técnicas. SOLO transforma el
// historial de una OT en un borrador PROFESIONAL de informe técnico
// (redacción de diagnóstico/reparación Mercedes-Benz), ordenando y
// redactando lo que YA existe, sin inventar. El texto vuelve a la app en
// campos editables y una persona lo revisa antes de generar PDF o enviar
// (ver "Redactor IA" en CLAUDE.md).
//
// Va en una función aparte de `nexa` a propósito: es independiente del chat
// con clientes y no debe romperse ni depender de que PAZ esté activa.
// Comparte solo el secreto OPENAI_API_KEY (es del proyecto), con su propio
// prompt separado (REGLAS, abajo).
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

// Tope de llamadas por usuario por hora (cost guard). Cubre "analizar" y
// "redactar" juntas. El dedup real ("no regenerar si el historial no
// cambió") lo hace el front con el hash antes de llegar acá.
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

function leerJSON(salida: string): any {
  const limpio = salida.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(limpio);
}

// Identidad + reglas duras, comunes a todas las acciones. Van en el prompt,
// no confían en el modelo.
const REGLAS = [
  "Eres el Redactor de Informes Técnicos de Paz Services, taller de",
  "reparación de módulos electrónicos y sistemas de camiones Mercedes-Benz",
  "en Talca, Chile. Redactas informes PROFESIONALES de diagnóstico/reparación",
  "automotriz, del estilo que se le entrega a un cliente.",
  "",
  "ESTILO: técnico, formal, directo y claro. Usa expresiones como: 'Se",
  "realizó diagnóstico en terreno', 'Se verificó', 'Se inspeccionó', 'Se",
  "retiró', 'Se corrigió', 'Se reemplazó', 'Se efectuó prueba de ruta', 'Se",
  "realizó prueba en banco', 'Se constató', 'La falla persiste', 'El sistema",
  "requiere revisión adicional'. Cuando hay varias visitas, NO narres cada",
  "fecha como bitácora: usa 'En una primera intervención...', 'Posteriormente...',",
  "'En una nueva revisión...', 'Durante la prueba final...'.",
  "",
  "NUNCA uses lenguaje interno de la app ni de gestión, como: 'la OT pasa a",
  "terreno', 'queda resuelto en terreno', 'ingresa a reparación', 'se agenda",
  "una visita', 'estado actual', 'según historial', 'se registra', 'se cambia",
  "el estado', 'la app indica'. El informe habla del vehículo y del trabajo,",
  "no del sistema.",
  "",
  "NO es un resumen narrativo del historial día por día: es un informe",
  "técnico que explica la falla, el diagnóstico, los trabajos, las pruebas,",
  "el resultado y la condición final.",
  "",
  "REGLAS CRÍTICAS (no las rompas nunca):",
  "- No inventes piezas, pruebas, fechas, diagnósticos ni valores.",
  "- No digas que algo fue REEMPLAZADO si solo fue revisado; ni REPARADO si",
  "  solo fue diagnosticado.",
  "- No digas que el vehículo quedó operativo ni que un módulo quedó reparado",
  "  si el historial no lo afirma.",
  "- Si la falla persiste (total o parcial), déjalo EXPLÍCITO. Nunca lo",
  "  ocultes con redacción bonita.",
  "- No agregues garantía, condiciones comerciales, cobros, promesas al",
  "  cliente, fechas de entrega ni compromisos de nueva visita si no están",
  "  en el historial.",
  "- No transformes una sospecha en certeza ni cambies una conclusión técnica.",
  "- Si algo no está en el historial, no lo incluyas. Nunca rellenes vacíos",
  "  técnicos inventando.",
].join("\n");

// Las preguntas que el Redactor debe saber detectar cuando faltan datos
// críticos para un informe certero (sección "DATOS FALTANTES").
const GUIA_FALTANTES = [
  "Revisa si falta información crítica para un informe certero: síntoma",
  "inicial claro; pruebas realizadas y su resultado; componentes",
  "intervenidos; si la falla quedó resuelta, parcial o persistente; causa",
  "técnica definitiva o solo sospecha; condición final del vehículo; si hubo",
  "prueba de ruta / banco / laboratorio; si el módulo se instaló, entregó o",
  "quedó pendiente; recomendaciones o pasos siguientes.",
  "Devuelve preguntas CONCRETAS para que la persona complete, por ejemplo:",
  "'¿La falla quedó completamente resuelta o solo hubo mejora parcial?',",
  "'¿Qué prueba confirmó la causa?', '¿El vehículo fue probado en ruta?',",
  "'¿Qué componente fue reemplazado, reparado o solo revisado?', '¿El módulo",
  "fue instalado o entregado?', '¿Quedó alguna revisión pendiente?'.",
  "Estas preguntas NO salen en el informe del cliente: son solo para revisar.",
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
      return json({ error: "No tienes permiso para usar el Redactor IA." }, 403);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return json({ error: "Falta configurar OPENAI_API_KEY." }, 503);

    const admin = createClient(URL_SUPABASE, SERVICE);
    const { data: cfg } = await admin.from("nexa_config").select("modelo").eq("id", 1).single();
    const modelo = cfg?.modelo?.trim() || "gpt-5.5";

    const { accion = "redactar", orden_id, fuente = "", fuente_hash = "", respuestas = "", texto = "" } =
      await req.json();

    // Tope de frecuencia por usuario, común a todas las acciones.
    const hace1h = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await comoUsuario
      .from("informes_ia").select("id", { count: "exact", head: true })
      .eq("generado_por", user.id).gte("generado_en", hace1h);
    if ((count ?? 0) >= TOPE_POR_HORA) {
      return json({ error: "Llegaste al tope de generaciones por hora. Espera un rato." }, 429);
    }

    // ── Analizar historial: detecta datos faltantes ANTES de redactar ──
    if (accion === "analizar") {
      if (!fuente.trim()) return json({ error: "No hay historial que analizar." }, 400);
      const instrucciones = [
        REGLAS, "",
        "Recibes el HISTORIAL de una OT. NO redactes el informe todavía.",
        GUIA_FALTANTES, "",
        "Devuelve EXCLUSIVAMENTE un JSON válido, sin texto fuera del JSON:",
        '{ "datos_faltantes": ["pregunta concreta", "..."] }',
        "Si no falta nada crítico, devuelve una lista vacía.",
      ].join("\n");
      const salida = await llamarIA(apiKey, modelo, instrucciones, fuente);
      let out: any;
      try { out = leerJSON(salida); } catch {
        return json({ error: "La IA no devolvió un análisis legible. Reintenta." }, 502);
      }
      const faltantes = Array.isArray(out?.datos_faltantes)
        ? out.datos_faltantes.map((x: unknown) => String(x)).filter(Boolean) : [];
      return json({ datos_faltantes: faltantes });
    }

    // ── Redactar el informe profesional en 4 secciones ──
    if (accion === "redactar") {
      if (!orden_id) return json({ error: "Falta la OT." }, 400);
      if (!fuente.trim()) return json({ error: "No hay historial que redactar." }, 400);

      const entrada = respuestas.trim()
        ? `${fuente}\n\nRESPUESTAS DE LA PERSONA A LOS DATOS FALTANTES (úsalas como hechos confirmados):\n${respuestas}`
        : fuente;

      const instrucciones = [
        REGLAS, "",
        "Redacta el informe PROFESIONAL de esta OT en cuatro secciones.",
        "Devuelve EXCLUSIVAMENTE un JSON válido, sin texto fuera del JSON, con",
        "esta forma exacta (cada valor es texto redactado, en párrafos):",
        "{",
        '  "detalle_diagnostico": "DETALLE DE DIAGNÓSTICO Y TRABAJOS REALIZADOS:',
        '     la falla inicial (síntoma del cliente, códigos relevantes) y lo que',
        '     se hizo — pruebas, componentes revisados/retirados/reparados/',
        '     reemplazados, intervención en terreno o laboratorio, pruebas',
        '     posteriores. Solo lo que está en el historial.",',
        '  "resultado_pruebas": "RESULTADO DE LAS PRUEBAS: qué cambió después del',
        '     trabajo. Di claramente si hubo mejora, si quedó operativo, si la',
        '     falla persiste total o parcialmente, si la prueba fue limitada, y',
        '     qué condición se observó al final. Si mejoró pero sigue fallando,',
        '     dilo: \'Se observa una mejora parcial, sin embargo la falla',
        '     persiste.\'",',
        '  "causa_conclusion": "CAUSA DE LA FALLA / CONCLUSIÓN TÉCNICA: solo si',
        '     está claramente indicada. Si no hay causa definitiva, escribe',
        '     exactamente: No se establece una causa definitiva con los',
        '     antecedentes disponibles. Nunca conviertas una sospecha en',
        '     diagnóstico final ni digas que quedó resuelto si la falla persiste.",',
        '  "observaciones": "OBSERVACIONES: recomendaciones TÉCNICAS,',
        '     limitaciones o puntos pendientes (ej: continuar revisión del',
        '     sistema GP; validar en ruta; no considerar la falla resuelta hasta',
        '     validar). SOLO técnico: nada de garantía, cobros, condiciones',
        '     comerciales ni promesas. Deja \'\' si no hay nada que observar.",',
        '  "datos_faltantes": ["si aún ves vacíos importantes, pregúntalos acá.',
        '     No salen en el informe del cliente. [] si no hay."]',
        "}",
      ].join("\n");

      const salida = await llamarIA(apiKey, modelo, instrucciones, entrada);
      let b: any;
      try { b = leerJSON(salida); } catch {
        return json({ error: "La IA no devolvió un informe legible. Reintenta.", crudo: salida.slice(0, 400) }, 502);
      }
      const borrador = {
        detalle_diagnostico: String(b?.detalle_diagnostico ?? "").trim(),
        resultado_pruebas: String(b?.resultado_pruebas ?? "").trim(),
        causa_conclusion: String(b?.causa_conclusion ?? "").trim(),
        observaciones: String(b?.observaciones ?? "").trim(),
        datos_faltantes: Array.isArray(b?.datos_faltantes)
          ? b.datos_faltantes.map((x: unknown) => String(x)).filter(Boolean) : [],
      };

      // Se guarda la FUENTE exacta (y las respuestas) que se le mandó a la
      // IA: así nunca se pierde lo que la persona escribió, aunque después
      // borre sus observaciones de la OT.
      const { data: fila, error: eIns } = await comoUsuario
        .from("informes_ia")
        .insert({
          orden_id, fuente_hash, borrador_ia: borrador, generado_por: user.id,
          fuente, respuestas: respuestas.trim() || null,
        })
        .select("id").single();
      if (eIns) return json({ error: "No se pudo guardar el borrador: " + eIns.message }, 500);

      return json({ borrador, informe_id: fila.id });
    }

    // ── Mejorar la redacción de un borrador escrito por la persona ──
    if (accion === "mejorar") {
      if (!texto.trim()) return json({ error: "No hay texto que mejorar." }, 400);
      const instrucciones = [
        REGLAS, "",
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
