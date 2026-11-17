// Cada tarea carga solo lo suyo: armar, cuerpo y portada usan pdfmake y las fuentes; unir, solo
// pdf-lib; texto, solo pdf.js.
const TAREAS = {
  armar: async (datos) => (await import("./pdf.js")).generarPDF(datos),
  cuerpo: async (datos) => (await import("./pdf.js")).generarCuerpo(datos),
  portada: async (datos) => (await import("./pdf.js")).generarPortada(datos),
  unir: async ({ partes, titulo }) => (await import("./unirPDF.js")).unirPartes(partes, titulo),
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
