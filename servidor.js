import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Acceso } from "./src/acceso.js";
import { conectarPostgres, crearAlmacenMemoria, crearAlmacenSQL } from "./src/almacen.js";
import { crearApp } from "./src/app.js";
import {
  crearBuscador,
  crearBuscadorAcademico,
  crearBuscadorDeLibros,
  saldoDeOpenAlex,
  saldoDeTavily,
} from "./src/busqueda.js";
import { leerConfig } from "./src/config.js";
import { crearInvestigador } from "./src/investigador.js";
import { leerPagina } from "./src/lector.js";
import { crearLLM } from "./src/llm.js";
import { generarPDF } from "./src/pdf.js";

// Sin SECRETO_SESION se genera uno y se guarda: así las sesiones sobreviven a un reinicio.
function secretoDeSesion({ secreto, carpetaDatos }) {
  if (secreto) return secreto;
  const archivo = join(carpetaDatos, "secreto-sesion");
  try {
    return readFileSync(archivo, "utf8");
  } catch {
    const nuevo = randomBytes(32).toString("hex");
    mkdirSync(carpetaDatos, { recursive: true });
    writeFileSync(archivo, nuevo, { mode: 0o600 });
    return nuevo;
  }
}

const config = leerConfig();

let acceso;
try {
  acceso = new Acceso({
    codigos: config.acceso.codigos,
    limiteDiario: config.acceso.limiteDiario,
    secreto: secretoDeSesion(config.acceso),
    archivoUso: join(config.acceso.carpetaDatos, "uso.json"),
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const almacen = config.baseDeDatos
  ? crearAlmacenSQL(conectarPostgres(config.baseDeDatos))
  : crearAlmacenMemoria();
try {
  await almacen.preparar();
} catch (error) {
  console.error(`No se pudo preparar la base de datos: ${error.message}`);
  process.exit(1);
}

const llm = crearLLM(config.proveedores, { limiteMs: config.limiteLLMMs });
const buscar = crearBuscador({
  tavilyClave: config.tavilyClave,
  excluidos: config.dominiosExcluidos,
});
const buscarAcademico = crearBuscadorAcademico({ clave: config.openalexClave });
const buscarLibros = crearBuscadorDeLibros({
  claveOpenAlex: config.openalexClave,
  claveGoogleBooks: config.googleBooksClave,
});
const investigador = crearInvestigador({
  llm,
  buscar,
  buscarAcademico,
  buscarLibros,
  saldoAcademico: () => saldoDeOpenAlex(config.openalexClave),
  leerPagina,
  opciones: config.investigacion,
});

// Los saldos se consultan a los proveedores como mucho una vez por minuto.
let saldosGuardados = { hasta: 0, datos: {} };
async function saldos() {
  if (saldosGuardados.hasta > Date.now()) return saldosGuardados.datos;
  const [web, papers] = await Promise.all([
    saldoDeTavily(config.tavilyClave).catch(() => null),
    saldoDeOpenAlex(config.openalexClave).catch(() => null),
  ]);
  saldosGuardados = { hasta: Date.now() + 60000, datos: { web, papers } };
  return saldosGuardados.datos;
}

const app = crearApp({ config, acceso, investigador, almacen, generarPDF, saldos });

// Render duerme el servicio tras 15 minutos sin pedidos entrantes, aunque haya una
// investigación corriendo: mientras la haya, el servidor se pide a sí mismo por la URL pública.
if (config.urlPublica) {
  setInterval(
    () => {
      if (app.locals.hayTrabajo()) fetch(`${config.urlPublica}/salud`).catch(() => {});
    },
    10 * 60 * 1000,
  );
}

app.listen(config.puerto, config.host, () => {
  console.log(`Investigador en http://${config.host}:${config.puerto}`);
  console.log(
    almacen.tipo === "memoria"
      ? "Historial: en memoria (se pierde al reiniciar; falta DATABASE_URL)"
      : "Historial: Postgres",
  );
  for (const { urlBase, modelo } of config.proveedores) console.log(`Modelos: ${urlBase} (${modelo})`);
  if (!config.proveedores.length) {
    console.warn("Sin proveedores de modelos: cargá al menos una clave LLM_n_CLAVE en .env.");
  }
  console.log(`Búsqueda: ${config.tavilyClave ? "Tavily + DuckDuckGo" : "solo DuckDuckGo"}`);
  console.log(`Académico: OpenAlex ${config.openalexClave ? "con clave" : "sin clave (presupuesto compartido por IP)"}`);
  console.log(`Libros: OpenAlex${config.googleBooksClave ? " + Google Books" : " (sin clave de Google Books)"}`);
});
