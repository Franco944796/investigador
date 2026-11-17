import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { conectarPostgres } from "../src/almacen.js";
import { datosDeInvestigacion } from "../src/app.js";
import { crearGeneradorAparte } from "../src/pdfAparte.js";
import { nombreDeArchivo, sinPendientes, tituloDelPedido } from "../src/titulos.js";

// Copia fija del informe de muestra para la página pública (public/muestra.html): el JSON tiene la
// misma forma que GET /api/conversaciones/:id/informe, sin el pedido ni lo que es solo del dueño.
const SALIDA = fileURLToPath(new URL("../public/muestra/", import.meta.url));
const FIRMA = "https://github.com/Franco944796";

if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL (se lee de .env con npm run muestra).");
  process.exit(1);
}
const consulta = conectarPostgres(process.env.DATABASE_URL);
const [id] = process.argv.slice(2);
const [fila] = id
  ? await consulta("SELECT id, tema, creada, datos FROM investigaciones WHERE id = $1", [id])
  : await consulta(
      `SELECT id, tema, creada, datos FROM investigaciones
       WHERE profundidad = 'exhaustiva' AND estado = 'lista' AND datos ? 'informe'
       ORDER BY creada DESC LIMIT 1`,
    );
if (!fila?.datos.informe) {
  console.error(id ? `No hay un informe terminado con id ${id}.` : "No hay Exhaustivas terminadas.");
  process.exit(1);
}

const { datos } = fila;
const informe = sinPendientes(datos.informe);
const fuentes = datos.fuentes.map(({ n, url, titulo, tipo, fecha }) => ({
  n,
  url,
  titulo,
  ...(tipo && { tipo }),
  ...(fecha && { fecha }),
}));
const muestra = {
  id: fila.id,
  titulo: tituloDelPedido(fila.tema),
  creada: Number(fila.creada),
  archivo: nombreDeArchivo(fila.tema).replace(/\.pdf$/, ""),
  informe,
  fuentes,
  intercambios: datos.intercambios ?? [],
  datos: datosDeInvestigacion(datos.eventos ?? []),
};

mkdirSync(SALIDA, { recursive: true });
writeFileSync(join(SALIDA, "informe.json"), `${JSON.stringify(muestra, null, 2)}\n`);
console.log(`Informe ${fila.id}: ${informe.length} caracteres, ${fuentes.length} fuentes.`);

// En la PC no hay el tope de memoria de Render.
const generarPDF = crearGeneradorAparte({ memoriaMB: 1024, limiteMs: 20 * 60 * 1000 });
const pdf = await generarPDF({
  titulo: muestra.titulo,
  markdown: informe,
  fuentes: datos.fuentes,
  firma: FIRMA,
});
writeFileSync(join(SALIDA, "informe.pdf"), pdf);
console.log(`PDF: ${(pdf.length / 1024 / 1024).toFixed(1)} MB en ${SALIDA}`);
process.exit(0);
