import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VENDOR } from "../src/vendor.js";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const META_API = '<meta name="api" content="" />';

// Copia public/ y las librerías a `destino`, apuntando la página a la API de `urlApi`.
export function armarPagina(destino, urlApi) {
  const api = new URL(urlApi).origin;
  cpSync(join(RAIZ, "public"), destino, { recursive: true });
  mkdirSync(join(destino, "vendor"), { recursive: true });
  for (const [nombre, archivo] of Object.entries(VENDOR)) {
    cpSync(join(RAIZ, archivo), join(destino, "vendor", nombre));
  }

  const indice = join(destino, "index.html");
  const html = readFileSync(indice, "utf8");
  if (html.split(META_API).length !== 2) {
    throw new Error(`index.html debe tener una sola vez: ${META_API}`);
  }
  // GitHub Pages no deja poner cabeceras: la política va en la página. Limita a dónde podría mandar
  // datos un script inyectado, porque el token de sesión queda en localStorage.
  const politica = [
    "default-src 'self'",
    `connect-src 'self' ${api}`,
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  writeFileSync(
    indice,
    html.replace(
      META_API,
      `<meta name="api" content="${api}" />\n` +
        `    <meta http-equiv="Content-Security-Policy" content="${politica}" />`,
    ),
  );
  return api;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [destino, urlApi] = process.argv.slice(2);
  if (!destino || !urlApi) {
    console.error("Uso: node scripts/pagina.js <carpeta de salida> <dirección de la API>");
    process.exit(1);
  }
  console.log(`Página armada en ${destino} (API: ${armarPagina(destino, urlApi)})`);
}
