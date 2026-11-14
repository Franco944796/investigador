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

const NO_ES_FIGURA = /logo|icon|sprite|avatar|banner|badge|button|btn|close|arrow|flag|emoji|pixel|spacer|\.gif|\.svg/i;

// De las imágenes de una página (Tavily trae decenas: logos, íconos, botones) quedan como mucho 3
// con texto alternativo descriptivo, que es lo único que dice qué muestran.
export function figurasDe(imagenes) {
  return (Array.isArray(imagenes) ? imagenes : [])
    .filter(
      (imagen) =>
        typeof imagen?.url === "string" &&
        imagen.url.startsWith("https://") &&
        imagen.description_source === "alt" &&
        typeof imagen.description === "string" &&
        imagen.description.trim().length >= 12 &&
        !NO_ES_FIGURA.test(imagen.url) &&
        !NO_ES_FIGURA.test(imagen.description),
    )
    .slice(0, 3)
    .map((imagen) => ({ url: imagen.url, descripcion: imagen.description.trim().slice(0, 160) }));
}

const conLimite = (signal) => AbortSignal.any([signal, AbortSignal.timeout(LIMITE_MS)].filter(Boolean));

const sitioDe = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// Solo se descarta la cola muy lejos del mejor resultado. Con un corte a la mitad se perdían
// fuentes buenas: en una búsqueda real, eia.gov e iea.org tenían 0,32 frente a 0,75 del primero.
const CORTE_DE_PUNTAJE = 0.3;

export function crearBuscador({ tavilyClave, excluidos = [] }) {
  let turnoDuckDuckGo = Promise.resolve();
  const excluido = (url) => {
    const sitio = sitioDe(url);
    return excluidos.some((dominio) => sitio === dominio || sitio.endsWith(`.${dominio}`));
  };

  async function conTavily(consulta, cantidad, signal, dominios, reciente) {
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
        // Mismo costo (1 crédito): trae las imágenes de cada resultado para los gráficos del informe.
        include_images: true,
        include_image_descriptions: true,
        ...(reciente && { time_range: "year" }),
        ...(dominios?.length
          ? { include_domains: dominios }
          : excluidos.length && { exclude_domains: excluidos }),
      }),
      signal: conLimite(signal),
    });
    if (!respuesta.ok) throw new Error(`Tavily respondió ${respuesta.status}`);
    const datos = await respuesta.json();
    const resultados = datos.results ?? [];
    const mejor = Math.max(0, ...resultados.map((resultado) => resultado.score ?? 0));
    return resultados
      .filter((resultado) => (resultado.score ?? mejor) >= mejor * CORTE_DE_PUNTAJE)
      .map((resultado) => ({
        titulo: resultado.title ?? "",
        url: resultado.url,
        resumen: resultado.content ?? "",
        contenido: (resultado.raw_content ?? "").replace(/\n{3,}/g, "\n\n").trim(),
        imagenes: figurasDe(resultado.images),
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

  // Con `dominios`, la búsqueda se limita a esos sitios (y ahí no rige la lista de excluidos: si
  // el pedido nombra un sitio, se respeta). `reciente` limita al último año.
  return async function buscar(consulta, { cantidad, signal, dominios, reciente }) {
    const permitido = (resultado) => dominios?.length || !excluido(resultado.url);
    if (tavilyClave) {
      try {
        const resultados = (await conTavily(consulta, cantidad, signal, dominios, reciente)).filter(permitido);
        if (resultados.length) return { motor: "Tavily", resultados };
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`Tavily falló, se usa DuckDuckGo: ${error.message}`);
      }
    }
    const sitios = dominios?.length ? ` ${dominios.map((dominio) => `site:${dominio}`).join(" OR ")}` : "";
    const resultados = await conDuckDuckGo(consulta + sitios, signal);
    return { motor: "DuckDuckGo", resultados: resultados.filter(permitido).slice(0, cantidad) };
  };
}

// OpenAlex guarda el resumen como índice invertido ({palabra: [posiciones]}) por derechos de autor.
export function resumenDe(indiceInvertido) {
  if (!indiceInvertido) return "";
  const palabras = [];
  for (const [palabra, posiciones] of Object.entries(indiceInvertido)) {
    for (const posicion of posiciones) palabras[posicion] = palabra;
  }
  return palabras.filter(Boolean).join(" ");
}

export function deOpenAlex(obra) {
  const titulo = obra.display_name ?? obra.title ?? "";
  const resumen = resumenDe(obra.abstract_inverted_index);
  const autores = (obra.authorships ?? []).map((autoria) => autoria.author?.display_name).filter(Boolean);
  const firma = autores.length > 3 ? `${autores.slice(0, 3).join(", ")} et al.` : autores.join(", ");
  const revista = obra.primary_location?.source?.display_name;
  const ficha = [
    titulo,
    firma,
    [obra.publication_year, revista].filter(Boolean).join(" · "),
    `Citas: ${obra.cited_by_count ?? 0}`,
    resumen && `Resumen: ${resumen}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    titulo,
    url: obra.doi || obra.open_access?.oa_url || obra.primary_location?.landing_page_url || obra.id,
    resumen: ficha,
    // Sin resumen no hay qué analizar: se intenta leer la página del artículo.
    contenido: resumen ? ficha : "",
    tipo: "académico",
    ...(obra.publication_year && { fecha: String(obra.publication_year) }),
  };
}

const CAMPOS_OPENALEX = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "cited_by_count",
  "primary_location",
  "open_access",
  "authorships",
  "abstract_inverted_index",
].join(",");

const PAUSA_SEMANTICA_MS = 1100;
let turnoSemantico = Promise.resolve();

// OpenAlex admite una búsqueda semántica por segundo: se hacen en fila.
function enTurnoSemantico(tarea) {
  const turno = turnoSemantico.then(tarea);
  turnoSemantico = turno.then(
    () => esperar(PAUSA_SEMANTICA_MS),
    () => esperar(PAUSA_SEMANTICA_MS),
  );
  return turno;
}

async function pedirOpenAlex(parametro, consulta, { cantidad, signal, clave, filtro }) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set(parametro, consulta);
  url.searchParams.set("per_page", String(cantidad));
  url.searchParams.set("select", CAMPOS_OPENALEX);
  // Sin resumen casi nunca se puede analizar: la página de la editorial suele estar cerrada.
  url.searchParams.set("filter", ["has_abstract:true", filtro].filter(Boolean).join(","));
  if (clave) url.searchParams.set("api_key", clave);
  const respuesta = await fetch(url, { headers: { "User-Agent": AGENTE }, signal: conLimite(signal) });
  if (!respuesta.ok) throw new Error(`OpenAlex respondió ${respuesta.status}`);
  const { results = [] } = await respuesta.json();
  return results.map(deOpenAlex);
}

// La búsqueda semántica entiende frases completas; la común exige que estén todas las palabras
// (una consulta larga o con un año de más no devuelve nada). Si la semántica falla, queda la común.
async function conOpenAlex(consulta, opciones) {
  try {
    const resultados = await enTurnoSemantico(() => pedirOpenAlex("search.semantic", consulta, opciones));
    if (resultados.length) return resultados;
  } catch (error) {
    if (opciones.signal?.aborted) throw error;
  }
  return pedirOpenAlex("search", consulta, opciones);
}

// Google Scholar no tiene API y prohíbe las consultas automáticas; OpenAlex cubre lo mismo con
// datos abiertos. Sin clave comparte un presupuesto diario chico con toda la IP de salida.
export function crearBuscadorAcademico({ clave }) {
  return async function buscarAcademico(consulta, { cantidad, signal }) {
    return { motor: "OpenAlex", resultados: await conOpenAlex(consulta, { cantidad, signal, clave }) };
  };
}

export function deGoogleBooks(volumen) {
  const info = volumen.volumeInfo ?? {};
  const titulo = [info.title, info.subtitle].filter(Boolean).join(": ");
  const descripcion = (info.description ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const fragmento = (volumen.searchInfo?.textSnippet ?? "").replace(/<[^>]+>/g, "").trim();
  const ficha = [
    titulo,
    (info.authors ?? []).join(", "),
    [info.publishedDate?.slice(0, 4), info.publisher].filter(Boolean).join(" · "),
    descripcion && `Descripción: ${descripcion}`,
    fragmento && `Fragmento: ${fragmento}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    titulo,
    url: info.canonicalVolumeLink || info.infoLink || `https://books.google.com/books?id=${volumen.id}`,
    resumen: ficha,
    contenido: descripcion.length >= 150 ? ficha : "",
  };
}

// Libros: los de OpenAlex (con resumen) y, si hay clave, Google Books, que suma descripciones de
// editorial de libros no académicos. Google Books sin clave comparte una cuota que suele estar
// agotada (429). Open Library se descartó: su catálogo no trae texto para analizar.
export function crearBuscadorDeLibros({ claveOpenAlex, claveGoogleBooks }) {
  async function conGoogleBooks(consulta, cantidad, signal) {
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", consulta);
    url.searchParams.set("maxResults", String(Math.min(cantidad, 40)));
    url.searchParams.set("printType", "books");
    url.searchParams.set("key", claveGoogleBooks);
    const respuesta = await fetch(url, { signal: conLimite(signal) });
    if (!respuesta.ok) throw new Error(`Google Books respondió ${respuesta.status}`);
    return ((await respuesta.json()).items ?? []).map(deGoogleBooks);
  }

  return async function buscarLibros(consulta, { cantidad, signal }) {
    const mitad = claveGoogleBooks ? Math.ceil(cantidad / 2) : cantidad;
    const [abiertos, google] = await Promise.allSettled([
      conOpenAlex(consulta, { cantidad: mitad, signal, clave: claveOpenAlex, filtro: "type:book" }),
      claveGoogleBooks ? conGoogleBooks(consulta, cantidad - mitad, signal) : Promise.resolve([]),
    ]);
    if (signal?.aborted) throw signal.reason;
    const resultados = [abiertos, google].flatMap((parte) =>
      parte.status === "fulfilled" ? parte.value : [],
    );
    // Un fallo que deja la búsqueda vacía tiene que verse como fallo, no como «sin resultados».
    if (!resultados.length && abiertos.status === "rejected") throw abiertos.reason;
    return { motor: "libros", resultados: resultados.map((libro) => ({ tipo: "libro", ...libro })) };
  };
}

const COSTO_OPENALEX_USD = 0.001;

// Cuántas búsquedas quedan hoy en OpenAlex con esta clave y en cuánto se renuevan (o null si no
// se puede saber: sin clave el saldo es compartido por IP y no se informa).
export async function saldoDeOpenAlex(clave, { signal } = {}) {
  if (!clave) return null;
  const url = new URL("https://api.openalex.org/rate-limit");
  url.searchParams.set("api_key", clave);
  const respuesta = await fetch(url, { headers: { "User-Agent": AGENTE }, signal: conLimite(signal) });
  if (!respuesta.ok) throw new Error(`OpenAlex respondió ${respuesta.status}`);
  const limite = (await respuesta.json()).rate_limit ?? {};
  const costo = limite.endpoint_costs_usd?.search ?? COSTO_OPENALEX_USD;
  const dolares = (limite.daily_remaining_usd ?? 0) + (limite.prepaid_remaining_usd ?? 0);
  return {
    busquedas: Math.max(0, Math.floor(dolares / costo + 1e-6)),
    renuevaEnSegundos: limite.resets_in_seconds ?? null,
  };
}

// Búsquedas web usadas y disponibles en el mes del plan de Tavily.
export async function saldoDeTavily(clave, { signal } = {}) {
  if (!clave) return null;
  const respuesta = await fetch("https://api.tavily.com/usage", {
    headers: { Authorization: `Bearer ${clave}` },
    signal: conLimite(signal),
  });
  if (!respuesta.ok) throw new Error(`Tavily respondió ${respuesta.status}`);
  const { account = {} } = await respuesta.json();
  if (typeof account.plan_limit !== "number") return null;
  return { usadas: account.plan_usage ?? 0, limite: account.plan_limit };
}
