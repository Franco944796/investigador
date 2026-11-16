import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fechaDelPie, textoDelPie } from "./titulos.js";

// Une las partes de un PDF grande y numera todas las páginas. El pie va en Helvetica (fuente
// estándar del PDF, sin incrustar): Roboto obligaría a cargar fontkit acá también.
export async function unirPartes(partes, titulo) {
  const unido = await PDFDocument.create();
  for (const bytes of partes) {
    const parte = await PDFDocument.load(bytes);
    for (const pagina of await unido.copyPages(parte, parte.getPageIndices()))
      unido.addPage(pagina);
  }
  const fuente = await unido.embedFont(StandardFonts.Helvetica);
  const fecha = fechaDelPie();
  const paginas = unido.getPages();
  paginas.forEach((pagina, i) => {
    const texto = textoDelPie(fecha, i + 1, paginas.length);
    const ancho = fuente.widthOfTextAtSize(texto, 8);
    pagina.drawText(texto, {
      x: (pagina.getWidth() - ancho) / 2,
      y: 30,
      size: 8,
      font: fuente,
      color: rgb(0.47, 0.47, 0.47),
    });
  });
  unido.setTitle(titulo);
  return Buffer.from(await unido.save());
}
