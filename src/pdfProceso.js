// Cada pedido carga solo lo suyo: armar usa pdfmake y las fuentes; unir, solo pdf-lib.
process.once("message", async ({ armar, unir }) => {
  try {
    const pdf = armar
      ? await (await import("./pdf.js")).generarPDF(armar)
      : await (await import("./unirPDF.js")).unirPartes(unir.partes, unir.titulo);
    process.send({ pdf }, () => process.exit(0));
  } catch (error) {
    process.send({ error: error.message }, () => process.exit(1));
  }
});
