// Texto de un PDF que sube la persona (una fuente que el buscador no pudo leer). Corre en el
// proceso aparte de los PDF (src/pdfProceso.js).
// La versión "legacy" de pdf.js, que recomiendan para Node, ocupa ~300 MB solo al cargarse; la
// normal, ~12 MB, y en Node 22+ extrae el texto igual (avisa por consola que no es la legacy).
const MAXIMO = 600000;

export async function extraerTextoPDF(bytes) {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc ||= new URL(
    "../node_modules/pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url,
  ).href;
  const documento = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  let texto = "";
  for (let numero = 1; numero <= documento.numPages && texto.length < MAXIMO; numero++) {
    const pagina = await documento.getPage(numero);
    const { items } = await pagina.getTextContent();
    texto += `${items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("")}\n\n`;
    pagina.cleanup();
  }
  return { texto: texto.slice(0, MAXIMO).replace(/[ \t]+\n/g, "\n"), paginas: documento.numPages };
}
