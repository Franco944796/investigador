import { setTimeout as esperar } from "node:timers/promises";
import { parseHTML } from "linkedom";

const LIMITE_MS = 20000;
const PAUSA_DUCKDUCKGO_MS = 1200;
const AGENTE = "Mozilla/5.0 (compatible; investigador/0.1)";

// DuckDuckGo no enlaza directo: envuelve el destino en /l/?uddg=<url codificada>.
function destinoReal(href) {
  if (!href) return null;
  let url;
  try {
    url = new URL(href, "https://duckduckgo.com");
  } catch {
    return null;
  }
  const destino = url.hostname.endsWith("duckduckgo.com") ? url.searchParams.get("uddg") : url.href;
  return destino && /^https?:\/\//.test(destino) && !destino.includes("duckduckgo.com/") ? destino : null;
}

export function parsearDuckDuckGo(html) {
  const { document } = parseHTML(html);
  const resultados = [];
  for (const nodo of document.querySelectorAll(".result")) {
    if (nodo.classList.contains("result--ad")) continue;
    const enlace = nodo.querySelector("a.result__a");
    const url = destinoReal(enlace?.getAttribute("href"));
    if (!url) continue;
    resultados.push({
      titulo: enlace.textContent.trim(),
      url,
      resumen: nodo.querySelector(".result__snippet")?.textContent.trim() ?? "",
    });
  }
  return resultados;
}

const conLimite = (signal) => AbortSignal.any([signal, AbortSignal.timeout(LIMITE_MS)].filter(Boolean));

export function crearBuscador({ tavilyClave }) {
  let turnoDuckDuckGo = Promise.resolve();

  async function conTavily(consulta, cantidad, signal) {
    const respuesta = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavilyClave}` },
      // El texto de cada página viene incluido sin costo extra y sirve justo donde la lectura
      // propia falla: sitios que bloquean (403) o que arman el contenido con JavaScript.
      body: JSON.stringify({
        query: consulta,
        max_results: cantidad,
        search_depth: "basic",
        include_raw_content: "text",
      }),
      signal: conLimite(signal),
    });
    if (!respuesta.ok) throw new Error(`Tavily respondió ${respuesta.status}`);
    const datos = await respuesta.json();
    return (datos.results ?? []).map((resultado) => ({
      titulo: resultado.title ?? "",
      url: resultado.url,
      resumen: resultado.content ?? "",
      contenido: (resultado.raw_content ?? "").replace(/\n{3,}/g, "\n\n").trim(),
    }));
  }

  // En serie y espaciadas: DuckDuckGo bloquea las ráfagas de pedidos.
  function conDuckDuckGo(consulta, signal) {
    const turno = turnoDuckDuckGo.then(async () => {
      const respuesta = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(consulta)}`,
        { headers: { "User-Agent": AGENTE }, signal: conLimite(signal) },
      );
      if (!respuesta.ok) throw new Error(`DuckDuckGo respondió ${respuesta.status}`);
      return parsearDuckDuckGo(await respuesta.text());
    });
    turnoDuckDuckGo = turno.then(
      () => esperar(PAUSA_DUCKDUCKGO_MS),
      () => esperar(PAUSA_DUCKDUCKGO_MS),
    );
    return turno;
  }

  return async function buscar(consulta, { cantidad, signal }) {
    if (tavilyClave) {
      try {
        const resultados = await conTavily(consulta, cantidad, signal);
        if (resultados.length) return { motor: "Tavily", resultados };
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`Tavily falló, se usa DuckDuckGo: ${error.message}`);
      }
    }
    const resultados = await conDuckDuckGo(consulta, signal);
    return { motor: "DuckDuckGo", resultados: resultados.slice(0, cantidad) };
  };
}
