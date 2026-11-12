import { setTimeout as esperar } from "node:timers/promises";

const ESPERAS_MS = [2000, 5000, 10000, 20000, 40000];
const ESPERA_MAXIMA_MS = 60000;
const REINTENTABLES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const ETIQUETA = "<think>";
// Los temporizadores pueden dispararse un instante antes: sin margen, al despertar el proveedor
// todavía figura descansando y se pierde una vuelta.
const MARGEN_MS = 20;

export class ErrorLLM extends Error {}
export class ErrorFormato extends ErrorLLM {}

// Los modelos con razonamiento lo mandan dentro de <think>…</think> en el mismo contenido.
export function quitarPensamiento(texto) {
  const sinBloques = texto.replace(/<think>[\s\S]*?<\/think>/g, "");
  const abierto = sinBloques.indexOf(ETIQUETA);
  return abierto === -1 ? sinBloques : sinBloques.slice(0, abierto);
}

// En vivo la etiqueta puede llegar partida entre dos trozos: se retiene la cola dudosa.
function visibleParcial(texto) {
  const limpio = quitarPensamiento(texto);
  for (let largo = Math.min(ETIQUETA.length - 1, limpio.length); largo > 0; largo--) {
    if (ETIQUETA.startsWith(limpio.slice(-largo))) return limpio.slice(0, -largo);
  }
  return limpio;
}

// Los modelos gratuitos a veces cierran mal el JSON (por ejemplo `["a", "b"} }`). Todos los
// pedidos de la app esperan un objeto plano de booleanos y listas de textos, así que esos
// campos se pueden rescatar sueltos.
function rescatarCampos(texto) {
  const campos = {};
  for (const [, clave, valor] of texto.matchAll(/"(\w+)"\s*:\s*(true|false)\b/g)) {
    campos[clave] = valor === "true";
  }
  for (const [, clave, lista] of texto.matchAll(/"(\w+)"\s*:\s*\[([^\]{}]*)/g)) {
    campos[clave] = [...lista.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([literal]) => JSON.parse(literal));
  }
  return campos;
}

export function extraerJSON(texto) {
  const limpio = quitarPensamiento(texto);
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio === -1 || fin <= inicio) throw new ErrorFormato("El modelo no devolvió un JSON.");
  try {
    return JSON.parse(limpio.slice(inicio, fin + 1));
  } catch {
    const campos = rescatarCampos(limpio.slice(inicio));
    if (Object.keys(campos).length) return campos;
    throw new ErrorFormato("El modelo devolvió un JSON inválido.");
  }
}

async function* leerEventos(cuerpo) {
  const decodificador = new TextDecoder();
  let pendiente = "";
  for await (const trozo of cuerpo) {
    pendiente += decodificador.decode(trozo, { stream: true });
    const lineas = pendiente.split("\n");
    pendiente = lineas.pop();
    for (const linea of lineas) {
      const dato = linea.startsWith("data:") ? linea.slice(5).trim() : "";
      if (!dato || dato === "[DONE]") continue;
      let evento;
      try {
        evento = JSON.parse(dato);
      } catch {
        // Algunos gateways intercalan líneas que no son JSON (avisos, latidos).
        continue;
      }
      if (evento.error) throw new ErrorLLM(evento.error.message || "El proveedor cortó la respuesta.");
      yield evento;
    }
  }
}

// Hay modelos gratuitos que tardan varios minutos en contestar (GLM, ~5 min para un pedido
// corto): el límite es generoso y el orden de los proveedores pone primero a los rápidos.
export function crearLLM(proveedores, { esperas = ESPERAS_MS, limiteMs = 30 * 60 * 1000 } = {}) {
  const estados = proveedores.map((proveedor) => ({
    ...proveedor,
    nombre: new URL(proveedor.urlBase).host,
    descansaHasta: 0,
  }));
  let preferido = 0;

  async function intentar(proveedor, cuerpo, signal, limiteMs) {
    let respuesta;
    try {
      respuesta = await fetch(`${proveedor.urlBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(proveedor.clave && { Authorization: `Bearer ${proveedor.clave}` }),
        },
        body: JSON.stringify({ model: proveedor.modelo, ...cuerpo }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(limiteMs)].filter(Boolean)),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        error: new ErrorLLM(`No se pudo conectar con ${proveedor.nombre} (${error.message}).`),
        reintentable: true,
      };
    }
    if (respuesta.ok) return { respuesta };

    const detalle = (await respuesta.text().catch(() => "")).slice(0, 300);
    const segundos = Number(respuesta.headers.get("retry-after"));
    return {
      error: new ErrorLLM(`${proveedor.nombre} respondió ${respuesta.status}. ${detalle}`),
      reintentable: REINTENTABLES.has(respuesta.status),
      esperaMs: segundos > 0 ? Math.min(segundos * 1000, ESPERA_MAXIMA_MS) : undefined,
    };
  }

  // Una vuelta prueba cada proveedor que no esté descansando, empezando por el último que
  // respondió bien. Cualquier fallo pasa al siguiente: lo que uno rechaza (cupo, tamaño del
  // pedido, clave) otro puede aceptarlo.
  async function darVuelta(cuerpo, signal, limiteMs, descansoMs) {
    let error = new ErrorLLM(
      estados.length
        ? "Todos los proveedores de modelos están sin cupo."
        : "No hay proveedores de modelos configurados (faltan las claves LLM_n_CLAVE).",
    );
    let reintentable = false;
    for (let paso = 0; paso < estados.length; paso++) {
      const indice = (preferido + paso) % estados.length;
      const proveedor = estados[indice];
      if (proveedor.descansaHasta > Date.now()) {
        reintentable = true;
        continue;
      }
      const resultado = await intentar(proveedor, cuerpo, signal, limiteMs);
      if (resultado.respuesta) {
        preferido = indice;
        return resultado;
      }
      if (resultado.reintentable) {
        reintentable = true;
        proveedor.descansaHasta = Date.now() + (resultado.esperaMs ?? descansoMs);
      }
      error = resultado.error;
    }
    return { error, reintentable };
  }

  async function solicitar(cuerpo, { signal, alEsperar }) {
    for (let intento = 0; ; intento++) {
      const pausa = esperas[intento];
      const { respuesta, error, reintentable } = await darVuelta(cuerpo, signal, limiteMs, pausa ?? 0);
      if (respuesta) return respuesta;
      if (!reintentable || pausa === undefined) throw error;
      const descansos = estados
        .map((estado) => estado.descansaHasta - Date.now())
        .filter((restante) => restante > 0);
      const espera =
        Math.min(descansos.length ? Math.min(...descansos) : pausa, ESPERA_MAXIMA_MS) + MARGEN_MS;
      alEsperar?.(Math.ceil(espera / 1000));
      await esperar(espera, undefined, { signal });
    }
  }

  async function completar(mensajes, { signal, alEsperar, temperatura = 0.3 } = {}) {
    const respuesta = await solicitar(
      { messages: mensajes, temperature: temperatura },
      { signal, alEsperar },
    );
    const datos = await respuesta.json();
    const texto = datos.choices?.[0]?.message?.content;
    if (typeof texto !== "string") throw new ErrorLLM("El modelo devolvió una respuesta vacía.");
    return quitarPensamiento(texto).trim();
  }

  async function completarJSON(mensajes, opciones) {
    try {
      return extraerJSON(await completar(mensajes, opciones));
    } catch (error) {
      if (!(error instanceof ErrorFormato)) throw error;
      return extraerJSON(await completar(mensajes, opciones));
    }
  }

  async function completarEnVivo(mensajes, { signal, alEsperar, alRecibir, temperatura = 0.4 } = {}) {
    const respuesta = await solicitar(
      { messages: mensajes, temperature: temperatura, stream: true },
      { signal, alEsperar },
    );

    let crudo = "";
    let emitido = "";
    const emitir = (visible) => {
      if (visible.length <= emitido.length) return;
      alRecibir(visible.slice(emitido.length));
      emitido = visible;
    };

    // Hay proveedores que ignoran `stream` y contestan con un JSON completo.
    if (respuesta.headers.get("content-type")?.includes("json")) {
      const datos = await respuesta.json();
      crudo = datos.choices?.[0]?.message?.content ?? "";
    } else {
      for await (const evento of leerEventos(respuesta.body)) {
        const delta = evento.choices?.[0]?.delta?.content;
        if (!delta) continue;
        crudo += delta;
        emitir(visibleParcial(crudo));
      }
    }
    emitir(quitarPensamiento(crudo));
    if (!emitido.trim()) throw new ErrorLLM("El modelo devolvió una respuesta vacía.");
    return emitido;
  }

  return { completar, completarJSON, completarEnVivo };
}
