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
const GRAPH = "https://graph.facebook.com/v21.0";
const VENTANA_MS = 24 * 3600_000;

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

// El mismo cálculo de "Enviar mensaje" de la función de WhatsApp, acá
// también: los secretos WHATSAPP_* son del proyecto, no de una función
// en particular, así que están disponibles igual.
async function responderWhatsApp(telefono: string, texto: string) {
  const r = await fetch(`${GRAPH}/${Deno.env.get("WHATSAPP_PHONE_ID")}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("WHATSAPP_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: telefono, type: "text", text: { body: texto },
    }),
  });
  const cuerpo = await r.text();
  return { ok: r.ok, status: r.status, cuerpo };
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
      .from("perfiles").select("rol,nombre").eq("id", user.id).single();
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

    const {
      accion = "responder", historial = [], texto = "",
      caso_id, instruccion, mensaje,
    } = await req.json();

    // Enseñarle a PAZ: se le pega una conversación real o una corrección
    // y ella destila los criterios. No los guarda: los propone, y el
    // dueño decide. Solo el dueño, porque los criterios son reglas
    // comerciales del taller.
    if (accion === "aprender") {
      if (perfil.rol !== "dueno") {
        return json({ error: "Solo el dueño puede enseñarle a PAZ." }, 403);
      }
      if (!texto.trim()) return json({ error: "No hay texto que revisar." }, 400);

      const instrucciones = [
        "Eres quien entrena a PAZ, la asistente de un taller de módulos",
        "electrónicos de camiones Mercedes Benz en Talca, Chile.",
        "Te van a pasar una conversación real con un cliente, o una",
        "corrección escrita por el dueño.",
        "Saca de ahí los CRITERIOS que PAZ debería seguir de ahora en adelante.",
        "El texto puede traer una sola conversación corta o varias conversaciones",
        "reales seguidas (exportadas de WhatsApp, separadas con '--- nombre.txt ---').",
        "Si son varias, revísalas todas: cada una puede enseñar algo distinto.",
        "",
        "Devuelve SOLO un objeto JSON, sin texto alrededor, con esta forma:",
        '{"criterios":[{"titulo":"...","contenido":"..."}]}',
        "",
        "Reglas para redactarlos:",
        "- No hay un máximo fijo: saca todos los criterios reales y distintos que",
        "  encuentres, uno por cada cosa concreta que aprendiste del texto. Si el",
        "  texto no enseña nada nuevo, devuelve la lista vacía. No inventes",
        "  criterios de relleno solo para completar un número.",
        "- No repitas el mismo criterio con otras palabras: si dos partes del",
        "  texto enseñan lo mismo, es un solo criterio.",
        "- El título es corto, una frase, en minúsculas salvo nombres propios.",
        "- El contenido le habla a PAZ de tú y dice QUÉ HACER, no qué evitar.",
        "- Concreto y accionable. Nada de 'ser profesional' o 'dar buen servicio'.",
        "- Español chileno, directo, sin adornos.",
        "- Si el texto menciona un precio, condición comercial o plazo, recógelo tal cual sin redondear ni inventar.",
        "- No inventes reglas que no estén en el texto.",
      ].join("\n");

      const crudo = await llamarIA(apiKey, cfg.modelo, instrucciones, [
        { role: "user", content: texto },
      ]);
      const limpio = crudo.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      try {
        const { criterios } = JSON.parse(limpio);
        return json({ criterios: Array.isArray(criterios) ? criterios : [] });
      } catch {
        return json({ error: "No se entendió lo que devolvió la IA.", crudo: limpio }, 502);
      }
    }

    // ── Modo asistido: dueño/coordinador le dictan a PAZ qué decirle
    // al cliente, en vez de escribirle ellos mismos por WhatsApp. ──
    //
    // "instrucción interna" es para PAZ, nunca se manda tal cual al
    // cliente: PAZ la redacta en un mensaje claro y corto, y una persona
    // la revisa antes de que salga.
    if (accion === "redactar_respuesta" || accion === "enviar_respuesta") {
      if (!caso_id) return json({ error: "Falta el caso." }, 400);
      const admin = createClient(URL_SUPABASE, SERVICE);
      const { data: caso } = await admin.from("casos")
        .select("id,conversacion_id,cliente_nombre,patente,vehiculo_modelo,falla_reportada,resumen_tecnico,atencion,ubicacion_texto,modo")
        .eq("id", caso_id).single();
      if (!caso) return json({ error: "No se encontró el caso." }, 404);

      const { data: conv } = await admin.from("nexa_conversaciones")
        .select("telefono").eq("id", caso.conversacion_id).single();
      if (!conv?.telefono) return json({ error: "El caso no tiene un teléfono asociado." }, 400);

      // La ventana de 24 horas: si el cliente escribió último hace menos
      // de 24 horas, se le puede responder texto libre y gratis. Si no,
      // WhatsApp solo deja plantillas aprobadas — no construidas todavía.
      const { data: ultimo } = await admin.from("nexa_mensajes")
        .select("creado_en").eq("conversacion_id", caso.conversacion_id).eq("rol", "user")
        .order("creado_en", { ascending: false }).limit(1).maybeSingle();
      const msRestantes = ultimo
        ? VENTANA_MS - (Date.now() - new Date(ultimo.creado_en).getTime())
        : -1;
      const ventanaAbierta = msRestantes > 0;

      if (accion === "redactar_respuesta") {
        if (!instruccion?.trim()) return json({ error: "Escribe primero qué le tienes que decir al cliente." }, 400);

        // Los criterios aplican acá igual que en la conversación en vivo:
        // no tiene sentido que una regla del negocio valga cuando PAZ
        // responde sola y se pueda saltar cuando alguien la asiste.
        const { data: apr } = await admin.from("paz_aprendizajes")
          .select("titulo,contenido").eq("activo", true).order("id");
        const aprendizajes = apr?.length
          ? "CRITERIOS DEL TALLER (mandan sobre cualquier costumbre tuya):\n" +
            apr.map((a) => `- ${a.titulo}: ${a.contenido}`).join("\n")
          : "";

        const contexto = [
          `Cliente: ${caso.cliente_nombre ?? "sin nombre"}.`,
          caso.patente ? `Patente: ${caso.patente}.` : "",
          caso.vehiculo_modelo ? `Vehículo: ${caso.vehiculo_modelo}.` : "",
          (caso.resumen_tecnico || caso.falla_reportada) ? `Caso: ${caso.resumen_tecnico ?? caso.falla_reportada}.` : "",
          caso.atencion ? `Tipo de atención: ${caso.atencion === "envio" ? "envío de módulo" : "terreno"}.` : "",
          caso.ubicacion_texto ? `Ubicación: ${caso.ubicacion_texto}.` : "",
        ].filter(Boolean).join(" ");

        const instrucciones = [
          cfg.prompt,
          "",
          aprendizajes,
          "",
          "AHORA NO ESTÁS CONVERSANDO CON EL CLIENTE. Alguien del equipo te está",
          "dando una instrucción interna sobre qué decirle. Redacta el mensaje",
          "que se le va a mandar al cliente por WhatsApp, listo para enviar.",
          "",
          `Contexto del caso: ${contexto}`,
          "",
          "REGLAS DE REDACCIÓN:",
          "- Corto, claro, como se escribe por WhatsApp. Nada de firma ni encabezados.",
          "- Sigue la instrucción: no inventes compromisos, plazos ni datos del caso",
          "  que ni la instrucción ni el contexto de arriba hayan dado.",
          "- Sin nombres de personas del equipo ni jerga interna.",
          "- Devuelve SOLO el mensaje, sin comillas ni explicación.",
          "- La instrucción puede hablar de forma vaga (\"el camión de este caso\", \"ese",
          "  equipo\", \"la visita reciente\"): tú no puedes ser vaga con el cliente. El",
          "  mismo WhatsApp puede tener otros camiones o casos mezclados, así que si el",
          "  contexto trae una patente, MENCIÓNALA siempre en el mensaje (\"el camión",
          "  PP1865\", no \"el camión\" a secas), para que el cliente sepa sin dudar de",
          "  cuál caso le estás hablando. Si no hay patente pero hay un módulo",
          "  identificado, nombra el módulo de la misma forma.",
          "",
          "REGLAS COMERCIALES SOBRE MONTOS — estas SÍ se aplican aunque la",
          "instrucción no las mencione, porque son obligatorias en el negocio:",
          "- Todo monto que des es NETO. Si la instrucción no dice explícitamente",
          "  \"IVA incluido\" o \"total\", agrégale \"+ IVA\" al comunicarlo.",
          "- Si la instrucción dice \"total\" o \"IVA incluido\", comunícalo como total,",
          "  sin volver a sumarle IVA.",
          "- Si el monto es un valor referencial de visita o diagnóstico (no un",
          "  precio ya cerrado y aceptado), agrégale \"sujeto a validación por",
          "  disponibilidad, distancia y condiciones\".",
          "- Si el caso está fuera de la Región del Maule y la instrucción no dio un",
          "  valor cerrado de forma explícita, no cierres tú un valor: dilo sujeto a",
          "  validación por distancia.",
          "- Nunca cambies el monto que dio la instrucción: la regla es sobre CÓMO",
          "  se comunica, no sobre inventar un número distinto.",
        ].join("\n");

        const texto = await llamarIA(apiKey, cfg.modelo, instrucciones, [
          { role: "user", content: instruccion },
        ]);
        if (!texto) return json({ error: "La IA no devolvió nada. Reintenta." }, 502);

        return json({
          mensaje: texto.replaceAll("**", "").replaceAll("*", ""),
          ventana_abierta: ventanaAbierta,
          ventana_horas_restantes: ventanaAbierta ? Math.floor(msRestantes / 3600_000) : 0,
          ventana_minutos_restantes: ventanaAbierta ? Math.floor((msRestantes % 3600_000) / 60_000) : 0,
        });
      }

      // accion === "enviar_respuesta"
      //
      // Modo aprendizaje: mientras dure el mes de entrenamiento, esto NO
      // manda un WhatsApp de verdad. El dueño puede seguir redactando y
      // revisando respuestas, pero el envío real queda cortado acá — es
      // la misma regla que "PAZ no crea OT ni agenda visita real" aplicada
      // al mensaje saliente.
      if (caso.modo === "aprendizaje") {
        return json({
          error: "Este caso está en modo aprendizaje: no se manda WhatsApp real. " +
                 "Revisa la respuesta y, si te sirve, márcala como Positivo en vez de enviarla.",
        }, 409);
      }

      if (!mensaje?.trim()) return json({ error: "El mensaje está vacío." }, 400);
      if (!ventanaAbierta) {
        return json({
          error: "Pasaron más de 24 horas desde el último mensaje del cliente. " +
                 "WhatsApp ya no deja texto libre; hace falta una plantilla aprobada, que todavía no está lista.",
        }, 409);
      }

      const envio = await responderWhatsApp(conv.telefono, mensaje);
      // Se guarda el intento haya salido bien o mal: si falló, queda el
      // rastro y el texto no se pierde. El id que devuelve este insert es
      // la llave que va a atar el mensaje a esta auditoría — sin ese id
      // no hay forma de que un mensaje se marque como confirmado por el
      // equipo, ni por error de código ni de otra forma.
      const { data: registro } = await admin.from("paz_respuestas_asistidas").insert({
        caso_id: caso.id, conversacion_id: caso.conversacion_id,
        instruccion_interna: instruccion ?? "", mensaje_generado: mensaje,
        mensaje_enviado: envio.ok ? mensaje : null, enviado: envio.ok,
        error: envio.ok ? null : envio.cuerpo.slice(0, 500),
        creado_por: user.id, rol_creador: perfil.rol, nombre_creador: perfil.nombre ?? null,
        enviado_en: envio.ok ? new Date().toISOString() : null,
      }).select("id").single();

      if (!envio.ok) {
        return json({ error: "WhatsApp no aceptó el envío. El texto no se perdió, puedes reintentar." }, 502);
      }

      await admin.from("nexa_mensajes").insert({
        conversacion_id: caso.conversacion_id, rol: "assistant", contenido: mensaje,
        humano_asistido: true, escrito_por: user.id, respuesta_asistida_id: registro?.id ?? null,
      });
      await admin.from("casos").update({
        requiere_respuesta_humana: false, atendida_por: user.id, atendida_en: new Date().toISOString(),
      }).eq("id", caso.id);

      return json({ ok: true });
    }

    if (accion === "marcar_atendido") {
      if (!caso_id) return json({ error: "Falta el caso." }, 400);
      const admin = createClient(URL_SUPABASE, SERVICE);
      const { error } = await admin.from("casos").update({
        requiere_respuesta_humana: false, atendida_por: user.id, atendida_en: new Date().toISOString(),
      }).eq("id", caso_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── Modo aprendizaje: reintentar el mismo escenario ──
    //
    // Después de agregar una regla correctiva, esto vuelve a generar la
    // respuesta al ÚLTIMO mensaje del cliente en ese caso, con la regla
    // ya activa, para comparar antes/después sin esperar a que el caso
    // se repita de verdad. Solo el dueño: es parte de gestionar
    // aprendizajes, igual que "Enseñarle a PAZ".
    if (accion === "reintentar_caso") {
      if (perfil.rol !== "dueno") {
        return json({ error: "Solo el dueño puede reintentar un caso." }, 403);
      }
      if (!caso_id) return json({ error: "Falta el caso." }, 400);
      const admin = createClient(URL_SUPABASE, SERVICE);

      const { data: caso } = await admin.from("casos")
        .select("conversacion_id").eq("id", caso_id).single();
      if (!caso) return json({ error: "No se encontró el caso." }, 404);

      const { data: previos } = await admin.from("nexa_mensajes")
        .select("rol,contenido,creado_en").eq("conversacion_id", caso.conversacion_id).order("creado_en");
      if (!previos?.length) return json({ error: "Ese caso todavía no tiene mensajes." }, 400);

      const historialCompleto = previos.map((m) => ({ role: m.rol, content: m.contenido }));

      // Se corta el historial justo después del último mensaje del
      // cliente: así la IA responde a lo mismo que respondió antes, no
      // a lo que vino después en la conversación real.
      let idxUltimoUser = -1;
      for (let i = historialCompleto.length - 1; i >= 0; i--) {
        if (historialCompleto[i].role === "user") { idxUltimoUser = i; break; }
      }
      if (idxUltimoUser < 0) return json({ error: "Ese caso no tiene ningún mensaje del cliente." }, 400);
      const historialParaReintento = historialCompleto.slice(0, idxUltimoUser + 1);
      const ultimaDelCliente = historialParaReintento[idxUltimoUser];

      const ultimaDePaz = previos
        .slice().reverse().find((m) => m.rol === "assistant" && new Date(m.creado_en) > new Date(previos[idxUltimoUser].creado_en));

      const { data: apr } = await admin.from("paz_aprendizajes")
        .select("titulo,contenido").eq("activo", true).order("id");
      const aprendizajes = apr?.length
        ? "CRITERIOS DEL TALLER (mandan sobre cualquier costumbre tuya):\n" +
          apr.map((a) => `- ${a.titulo}: ${a.contenido}`).join("\n")
        : "";

      const instrucciones = [
        cfg.prompt,
        "",
        aprendizajes,
        "",
        "CANAL: WhatsApp con el cliente. Mensajes cortos, una pregunta por vez.",
        "No repitas lo ya confirmado ni dejes la conversación colgada.",
      ].filter(Boolean).join("\n");

      const respuestaNueva = await llamarIA(apiKey, cfg.modelo, instrucciones, historialParaReintento);
      if (!respuestaNueva) return json({ error: "La IA no devolvió nada. Reintenta." }, 502);

      return json({
        mensaje_cliente: ultimaDelCliente.content,
        respuesta_original: ultimaDePaz?.contenido ?? "(PAZ no había respondido antes en este caso.)",
        respuesta_nueva: respuestaNueva.replaceAll("**", "").replaceAll("*", ""),
      });
    }

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
        const datos = JSON.parse(limpio);
        // Las instrucciones devuelven {casos:[...]} desde que un cliente
        // puede reportar varios camiones. Esta pantalla muestra una ficha
        // sola, así que se queda con el caso que se está conversando.
        const casos = Array.isArray(datos?.casos) ? datos.casos : null;
        return json({
          ficha: casos ? (casos[casos.length - 1] ?? {}) : datos,
          total_casos: casos ? casos.length : 1,
        });
      } catch {
        return json({ error: "No se pudo leer la ficha que devolvió la IA.", crudo: limpio }, 502);
      }
    }

    return json({ error: `Acción desconocida: ${accion}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Error inesperado en Nexa." }, 500);
  }
});
