import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const LIMITE_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECCIONES = 5;
const MINIMO_CARACTERES = 200;
const AGENTE = "Mozilla/5.0 (compatible; investigador/0.1)";

// Las URLs salen de buscadores y de páginas ajenas: sin este filtro, una redirección podría
// hacer que el servidor lea su propia red interna (SSRF).
const privadas = new BlockList();
for (const [red, prefijo] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
]) {
  privadas.addSubnet(red, prefijo, "ipv4");
}
for (const [red, prefijo] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  privadas.addSubnet(red, prefijo, "ipv6");
}

export function esDireccionPrivada(direccion) {
  const familia = isIP(direccion);
  return familia === 0 || privadas.check(direccion, familia === 6 ? "ipv6" : "ipv4");
}

async function exigirDestinoPublico(url) {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("dirección no permitida");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const direcciones = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!direcciones.length || direcciones.some(({ address }) => esDireccionPrivada(address))) {
    throw new Error("dirección no permitida");
  }
}

async function descargar(direccion, signal) {
  let url = new URL(direccion);
  for (let salto = 0; salto <= MAX_REDIRECCIONES; salto++) {
    await exigirDestinoPublico(url);
    const respuesta = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": AGENTE, Accept: "text/html,text/plain;q=0.8" },
    });
    const destino = respuesta.headers.get("location");
    if (respuesta.status < 300 || respuesta.status >= 400 || !destino) return respuesta;
    await respuesta.body?.cancel();
    url = new URL(destino, url);
  }
  throw new Error("demasiadas redirecciones");
}

async function leerConTope(respuesta) {
  const trozos = [];
  let total = 0;
  for await (const trozo of respuesta.body) {
    trozos.push(trozo);
    total += trozo.length;
    if (total >= MAX_BYTES) break;
  }
  return Buffer.concat(trozos);
}

function decodificar(bytes, tipo) {
  const declarado =
    tipo.match(/charset=["']?([\w-]+)/i)?.[1] ??
    bytes.subarray(0, 2048).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(declarado || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const ordenar = (texto) =>
  texto
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

export function extraerTexto(html) {
  const { document } = parseHTML(html);
  const tituloPagina = document.title ?? "";
  const articulo = new Readability(document).parse();
  if (articulo?.textContent) {
    return { titulo: (articulo.title || tituloPagina).trim(), texto: ordenar(articulo.textContent) };
  }
  // Readability modifica el documento que recibe, por eso el respaldo vuelve a parsear.
  const respaldo = parseHTML(html).document;
  for (const nodo of respaldo.querySelectorAll("script, style, noscript, nav, footer")) nodo.remove();
  return { titulo: tituloPagina.trim(), texto: ordenar(respaldo.body?.textContent ?? "") };
}

export async function leerPagina(url, { signal, maxCaracteres }) {
  let respuesta;
  let bytes;
  try {
    const limite = AbortSignal.any([signal, AbortSignal.timeout(LIMITE_MS)].filter(Boolean));
    respuesta = await descargar(url, limite);
    if (respuesta.ok) bytes = await leerConTope(respuesta);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.name === "TimeoutError") throw new Error("tardó demasiado en responder");
    throw new Error(/no permitida|redirecciones/.test(error.message) ? error.message : "no se pudo abrir");
  }
  if (!respuesta.ok) throw new Error(`respondió ${respuesta.status}`);

  const tipo = respuesta.headers.get("content-type") ?? "";
  if (!/html|text\/plain/i.test(tipo)) throw new Error("no es una página de texto");

  const contenido = decodificar(bytes, tipo);
  const { titulo, texto } = /html/i.test(tipo)
    ? extraerTexto(contenido)
    : { titulo: "", texto: ordenar(contenido) };
  if (texto.length < MINIMO_CARACTERES) throw new Error("sin contenido legible");
  return { titulo, texto: texto.slice(0, maxCaracteres) };
}
