import { writeFile } from "node:fs/promises";

// Cada tarea carga solo lo suyo: armar, cuerpo y portada usan pdfmake y las fuentes; unir, solo
// pdf-lib; texto, solo pdf.js. Con `salida`, el PDF va a ese archivo en vez de volver por el canal
// del proceso: las partes de un informe grande se unen después leyéndolas de a una del disco.
const aArchivo = async ({ pdf, ...resto }, salida) => {
  if (!salida) return { pdf, ...resto };
  await writeFile(salida, pdf);
  return resto;
};

const TAREAS = {
  armar: async (datos) => (await import("./pdf.js")).generarPDF(datos),
  cuerpo: async (datos) =>
    aArchivo(await (await import("./pdf.js")).generarCuerpo(datos), datos.salida),
  portada: async (datos) =>
    aArchivo(await (await import("./pdf.js")).generarPortada(datos), datos.salida),
  unir: async ({ partes, titulo, paginas }) =>
    (await import("./unirPDF.js")).unirPartes(partes, titulo, paginas),
  texto: async (datos) => (await import("./extraerPDF.js")).extraerTextoPDF(datos),
};

process.once("message", async ({ tarea, datos }) => {
  try {
    const resultado = await TAREAS[tarea](datos);
    process.send({ resultado }, () => process.exit(0));
  } catch (error) {
    process.send({ error: error.message }, () => process.exit(1));
  }
});
