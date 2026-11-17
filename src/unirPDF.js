import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fechaDelPie, textoDelPie } from "./titulos.js";

const cargar = async (parte) =>
  PDFDocument.load(typeof parte === "string" ? await readFile(parte) : parte);

// Une portada, índice y cuerpo (o sus partes) y numera las páginas; la portada va sin pie, pero
// cuenta como página 1, igual que en el índice. El pie va en Helvetica (fuente estándar del PDF,
// sin incrustar): Roboto obligaría a cargar fontkit acá también.
// Cada parte puede ser un PDF o la ruta de uno: se cargan de a una. El pie se dibuja en cada parte
// y se guarda antes de copiarla: dibujado sobre el PDF unido, en un informe de 800 páginas, los
// objetos de dibujo sumaban ~70 MB hasta el final (pico de 374 MB contra 286).
// `paginas` (cuántas tiene cada parte) evita cargarlas dos veces para saber el total.
export async function unirPartes(partes, titulo, paginas = null) {
  const conteos = paginas ?? [];
  if (!paginas) for (const parte of partes) conteos.push((await cargar(parte)).getPageCount());
  const total = conteos.reduce((suma, cantidad) => suma + cantidad, 0);
  const fecha = fechaDelPie();
  const unido = await PDFDocument.create();
  let previas = 0;
  for (const [k, parte] of partes.entries()) {
    const documento = await cargar(parte);
    const fuente = await documento.embedFont(StandardFonts.Helvetica);
    documento.getPages().forEach((pagina, i) => {
      const numero = previas + i + 1;
      if (numero === 1) return;
      const texto = textoDelPie(fecha, numero, total);
      pagina.drawText(texto, {
        x: (pagina.getWidth() - fuente.widthOfTextAtSize(texto, 8)) / 2,
        y: 30,
        size: 8,
        font: fuente,
        color: rgb(0.47, 0.47, 0.47),
      });
    });
    const compacta = await PDFDocument.load(await documento.save({ useObjectStreams: false }));
    for (const pagina of await unido.copyPages(compacta, compacta.getPageIndices())) {
      unido.addPage(pagina);
    }
    previas += conteos[k];
  }
  unido.setTitle(titulo);
  // Sin flujos de objetos: los nombres de las fuentes quedan legibles y lo abren lectores viejos.
  return Buffer.from(await unido.save({ useObjectStreams: false }));
}
