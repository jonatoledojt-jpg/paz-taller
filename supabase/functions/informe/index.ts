// Redactor IA (Agente Redactor de Informes) — módulo interno.
//
// ESTO NO ES PAZ (el agente de WhatsApp). Es un módulo distinto: NO
// conversa con clientes, NO envía mensajes, NO agenda, NO cambia estados
// de OT, NO crea cobros y NO toma decisiones técnicas. SOLO transforma un
// detalle técnico (escrito por el equipo) + el historial de la OT en un
// INFORME FINAL PROFESIONAL, listo para el cliente. Ordena y redacta lo que
// YA existe, sin inventar. El texto vuelve a la app en campos editables y
// una persona lo revisa antes de generar PDF o enviar (ver "Redactor IA"
// en CLAUDE.md).
//
// Va en una función aparte de `nexa` a propósito: es independiente del chat
// con clientes y no depende de que PAZ esté activa. Comparte solo el secreto
// OPENAI_API_KEY (del proyecto), con su propio prompt separado (REGLAS).
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

// Junta el detalle técnico manual (la declaración del equipo, es lo principal)
// con el registro de la OT.
function armarEntrada(fuente: string, respuestas: string): string {
  const p: string[] = [];
  if (respuestas.trim()) {
    p.push("DECLARACIÓN TÉCNICA DEL EQUIPO (esto es lo principal: es el detalle en bruto del trabajo, en lenguaje de taller; transfórmalo en el informe):\n" + respuestas.trim());
  }
  if (fuente.trim()) {
    p.push("REGISTRO DE LA OT (contexto de apoyo; úsalo solo si aporta hechos técnicos reales):\n" + fuente.trim());
  }
  return p.join("\n\n");
}

// Identidad + reglas de estilo + reglas duras. Van en el prompt, no confían
// en el modelo.
const REGLAS = [
  "Eres el Redactor de Informes Técnicos de Paz Services, taller de",
  "reparación de módulos electrónicos y sistemas de camiones Mercedes-Benz",
  "en Talca, Chile. Escribes el INFORME FINAL que se le entrega al cliente.",
  "",
  "MODO DOCUMENTO FINAL: el resultado debe sonar como un informe técnico",
  "profesional escrito por Paz Services para un cliente — técnico, claro,",
  "formal, fluido, explicativo y defendible ante el cliente. NO es un resumen",
  "automático, NO es una bitácora, NO es un checklist, NO es un historial de",
  "OT, NO es una copia corregida del texto del usuario. Trata el detalle que",
  "recibes como una DECLARACIÓN TÉCNICA EN BRUTO: entiende la secuencia,",
  "ordena los hechos, separa problemas distintos y redáctalo de nuevo en",
  "párrafos profesionales fluidos.",
  "",
  "ESTILO — usa expresiones como: 'El vehículo fue atendido por...', 'Durante",
  "el diagnóstico inicial se detectó...', 'Una vez corregida esta condición...',",
  "'Posteriormente, durante la prueba de ruta...', 'En una nueva intervención",
  "se verificó...', 'Se corrigió...', 'Se reemplazó...', 'Se validó...', 'No",
  "obstante...', 'Debido a que la falla persistió...', 'Se determina que...',",
  "'Se recomienda...'.",
  "",
  "PROHIBIDO — nunca uses lenguaje de sistema ni frases pobres: 'Se registra',",
  "'Se informa', 'Según historial', 'La OT pasa', 'queda resuelto en terreno',",
  "'ingresa a reparación', 'se agenda', 'estado actual', 'se cambia el estado',",
  "'la app indica', ni 'Durante el proceso' de forma repetitiva. Tampoco",
  "devuelvas listas ni copies la estructura del texto del usuario.",
  "",
  "SEPARAR PROBLEMAS: si hay varias fallas (programación GS, sensor de recorrido",
  "del servo embrague, vector de giro/tacógrafo, falla mecánica de caja/GP),",
  "sepáralas conceptualmente y deja CLARO cuál fue corregida y cuál quedó",
  "pendiente. Nunca mezcles una falla corregida con una persistente como si",
  "fueran una sola. Si algo mejoró pero sigue fallando, dilo explícito.",
  "",
  "NO INVENTAR (mejora la forma, nunca los hechos): no inventes pruebas,",
  "componentes, valores ni fechas; no digas REEMPLAZADO si solo se revisó, ni",
  "REPARADO si solo se diagnosticó; no digas que quedó operativo si no lo",
  "afirma el detalle; no ocultes que una falla persiste; no transformes",
  "sospechas en conclusiones; no agregues garantía, cobros ni compromisos",
  "comerciales si no fueron indicados. Repite literal solo códigos, piezas o",
  "conclusiones técnicas; el resto, redáctalo de nuevo.",
].join("\n");

// Ejemplo de estilo (few-shot): ancla la forma esperada. Contenido LIMPIO,
// sin títulos de sección adentro (los títulos los pone la interfaz).
const EJEMPLO = [
  "EJEMPLO. Para esta declaración del equipo:",
  '"En la primera visita Talca Viña del Mar se revisa con equipo de',
  "diagnóstico y se encuentra que el conector X2 del GS está mal conectado.",
  "Al conectarlo bien se logra poner la caja en modo programación y da GS31",
  "que hace mención al sensor de recorrido. Se reemplaza y la caja logra pasar",
  "la programación del servo embrague. Luego se deja el diagnóstico hasta ahí",
  "porque las calles estaban cerradas para pruebas de ruta. El cliente sale a",
  "prueba de ruta y la pasada de 4ta a 5ta se traba y la 8 no pasa a 8va alta.",
  "Se cita a patio en Santiago. Se detecta falla en el vector de giro mal",
  "calibrado, por eso se limita antes de la 8 alta. Se soluciona cambiando la",
  "limitación de velocidad y se destraba esa marcha, pero lo del cambio de 4 a",
  "5 sigue. Tercera visita: cambio de aguja del GP, se retira tacógrafo y",
  "sensor para ajustar vector. Se cambia la aguja, se instala el tacógrafo",
  "calibrado, se corrige el límite a 95 km/h y prueba en ruta. La velocidad se",
  'valida con GPS, pero la pasada del GP sigue con fallo. Se determina falla',
  'mecánica interna de la caja y se recomienda contactar mecánico de transmisión."',
  "",
  "La salida correcta es (nota: SIN títulos dentro del texto, párrafos fluidos):",
  JSON.stringify({
    detalle_diagnostico:
      "El vehículo fue atendido por falla asociada al sistema GS, dificultad de programación de la caja y problemas de paso de marchas, específicamente entre 4ª y 5ª, además de limitación para alcanzar 8ª alta.\n\n" +
      "En la primera visita, realizada en ruta Talca - Viña del Mar, se efectuó diagnóstico con equipo especializado. Durante la revisión se detectó que el conector X2 del módulo GS se encontraba mal conectado. Una vez corregida la conexión, fue posible ingresar la caja en modo programación. Posteriormente se presentó código GS31, asociado al sensor de recorrido del servo embrague. Se reemplazó dicho sensor y, luego de la intervención, la caja logró completar correctamente la programación del servo embrague. En esa oportunidad no fue posible continuar con pruebas de ruta debido a que las calles se encontraban cerradas.\n\n" +
      "Luego de la prueba realizada por el cliente, se informó que el vehículo presentaba dificultad en el paso de 4ª a 5ª marcha, con sensación de trabamiento, y que no lograba pasar a 8ª alta. Por este motivo se coordinó una nueva revisión en patio en Santiago. Durante la segunda intervención se detectó una condición asociada al vector de giro del tacógrafo, el cual se encontraba mal calibrado. Se corrigió la limitación de velocidad, logrando destrabar el paso a dicha marcha. Debido a que la falla entre 4ª y 5ª continuó presente, se retiró el tacógrafo y su sensor asociado para ajuste y calibración del vector de giro, y se coordinó una tercera intervención para reemplazar la aguja del GP.\n\n" +
      "En la tercera visita se reemplazó la aguja del GP, se instaló nuevamente el tacógrafo calibrado junto a su sensor, se corrigió el límite de velocidad a 95 km/h y se efectuó prueba de ruta.",
    resultado_pruebas:
      "Durante la prueba de ruta final, la velocidad fue validada contra GPS, confirmando que el vector de giro quedó corregido. No obstante, la falla en la pasada donde actúa el GP continuó presente, tanto al subir como al bajar cambios.",
    causa_conclusion:
      "Debido a que la corrección del tacógrafo, el ajuste del vector de giro y el reemplazo de la aguja del GP no eliminaron la condición de trabamiento entre 4ª y 5ª marcha, se determina que la falla corresponde a una condición mecánica interna de la caja de cambios.",
    observaciones:
      "Se recomienda al cliente contactar a su mecánico especialista en transmisión para realizar la revisión y reparación mecánica correspondiente de la caja de cambios.",
    datos_faltantes: [],
  }, null, 0),
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

    const hace1h = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await comoUsuario
      .from("informes_ia").select("id", { count: "exact", head: true })
      .eq("generado_por", user.id).gte("generado_en", hace1h);
    if ((count ?? 0) >= TOPE_POR_HORA) {
      return json({ error: "Llegaste al tope de generaciones por hora. Espera un rato." }, 429);
    }

    const entrada = armarEntrada(fuente, respuestas);

    // ── Analizar: detecta datos faltantes ANTES de redactar ──
    if (accion === "analizar") {
      if (!entrada.trim()) return json({ error: "No hay detalle que analizar." }, 400);
      const instrucciones = [
        REGLAS, "",
        "NO redactes el informe todavía. Revisa si falta información crítica",
        "para un informe certero: síntoma inicial claro; pruebas realizadas y su",
        "resultado; componentes intervenidos; si la falla quedó resuelta, parcial",
        "o persistente; causa técnica definitiva o solo sospecha; condición final;",
        "si hubo prueba de ruta / banco / laboratorio; si el módulo se instaló,",
        "entregó o quedó pendiente; recomendaciones o pasos siguientes.",
        "Devuelve EXCLUSIVAMENTE un JSON válido, sin texto fuera del JSON:",
        '{ "datos_faltantes": ["pregunta concreta", "..."] }',
        "Preguntas concretas y accionables. Lista vacía si no falta nada crítico.",
      ].join("\n");
      const salida = await llamarIA(apiKey, modelo, instrucciones, entrada);
      let out: any;
      try { out = leerJSON(salida); } catch {
        return json({ error: "La IA no devolvió un análisis legible. Reintenta." }, 502);
      }
      const faltantes = Array.isArray(out?.datos_faltantes)
        ? out.datos_faltantes.map((x: unknown) => String(x)).filter(Boolean) : [];
      return json({ datos_faltantes: faltantes });
    }

    // ── Redactar el informe FINAL profesional ──
    if (accion === "redactar") {
      if (!orden_id) return json({ error: "Falta la OT." }, 400);
      if (!entrada.trim()) return json({ error: "No hay detalle que redactar." }, 400);

      const instrucciones = [
        REGLAS, "",
        "Redacta el INFORME FINAL de esta OT y devuélvelo EXCLUSIVAMENTE como un",
        "JSON válido (sin texto fuera del JSON). Cada valor es TEXTO LIMPIO en",
        "párrafos, SIN títulos de sección adentro (la interfaz ya pone los",
        "títulos). Reparte el informe así:",
        '- "detalle_diagnostico": antecedente de la falla + diagnóstico inicial +',
        "  todos los trabajos realizados, en secuencia profesional (una o varias",
        "  intervenciones). Es el cuerpo principal del informe.",
        '- "resultado_pruebas": qué se validó y qué cambió tras el trabajo; di',
        "  explícito si la falla persiste total o parcialmente.",
        '- "causa_conclusion": la conclusión técnica. Si no hay causa clara,',
        '  escribe exactamente: No se establece una causa definitiva con los',
        "  antecedentes disponibles.",
        '- "observaciones": recomendación/observación final SOLO técnica (nada de',
        '  garantía, cobros ni promesas). "" si no hay.',
        '- "datos_faltantes": preguntas internas si aún ves vacíos (no salen en el',
        "  informe del cliente). [] si no hay.",
        "Forma exacta:",
        '{ "detalle_diagnostico": "...", "resultado_pruebas": "...", "causa_conclusion": "...", "observaciones": "...", "datos_faltantes": [] }',
        "", EJEMPLO,
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

      // Se guarda la FUENTE y las RESPUESTAS exactas: así nunca se pierde lo
      // que la persona escribió, y un auditor puede comparar entrada vs salida.
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
