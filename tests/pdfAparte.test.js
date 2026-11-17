import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { ErrorPDF, crearGeneradorAparte, partesDelInforme } from "../src/pdfAparte.js";

const datos = {
  titulo: "Prueba",
  markdown: "# Prueba\n\nTexto con una cita [1] y $\\dot{m}$.\n",
  fuentes: [{ n: 1, url: "https://a.test" }],
};

test("PDF aparte: se arma en otro proceso y vuelve entero", async () => {
  const pdf = await crearGeneradorAparte()(datos);
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});

test("PDF aparte: sin memoria suficiente falla ese PDF con un aviso, y el siguiente se arma igual", async () => {
  const chico = crearGeneradorAparte({ memoriaMB: 8 });
  await assert.rejects(chico(datos), (error) => error instanceof ErrorPDF && /memoria del servidor/.test(error.message));
  const normal = crearGeneradorAparte();
  const [uno, dos] = await Promise.all([normal(datos), normal(datos)]);
  assert.equal(uno.subarray(0, 5).toString(), "%PDF-");
  assert.equal(dos.subarray(0, 5).toString(), "%PDF-");
});

test("PDF aparte: el informe largo se corta antes de cada sección y las partes se unen en un solo PDF", async () => {
  const seccion = (k) => `## Sección ${k}\n\n${"Texto de la sección con una cita [1]. ".repeat(60)}\n`;
  const markdown = `# Informe\n\n${[1, 2, 3, 4, 5].map(seccion).join("\n")}`;
  const partes = partesDelInforme(markdown, 5000);
  assert.ok(partes.length >= 2);
  assert.equal(partes.join("\n"), markdown, "no se pierde ni se duplica nada");
  assert.ok(partes.slice(1).every((parte) => parte.startsWith("## Sección")), "cada parte empieza en una sección");
  assert.deepEqual(partesDelInforme("corto", 5000), ["corto"]);

  const pdf = await crearGeneradorAparte({ maxPorParte: 5000 })({ ...datos, titulo: "Largo", markdown });
  const documento = await PDFDocument.load(pdf);
  assert.ok(documento.getPageCount() >= partes.length);
  assert.equal(documento.getTitle(), "Largo");
});

test("PDF: portada e índice con la página de cada sección y subsección", async () => {
  const { generarCuerpo, generarPDF } = await import("../src/pdf.js");
  const { separarTitulo } = await import("../src/titulos.js");
  const relleno = "Texto de relleno para ocupar lugar en la página. ".repeat(120);
  const markdown = `# Informe largo\n\n## Uno\n\n${relleno}\n\n### Uno punto uno\n\n${relleno}\n\n## Dos\n\n${relleno}\n`;
  const separado = separarTitulo(markdown);
  assert.equal(separado.titulo, "Informe largo");
  assert.ok(!separado.cuerpo.includes("# Informe largo"), "el título va solo en la portada");
  const cuerpo = await generarCuerpo({ markdown: separado.cuerpo, fuentes: [] });
  assert.deepEqual(
    cuerpo.titulos.map(({ nivel, texto }) => [nivel, texto]),
    [[2, "Uno"], [3, "Uno punto uno"], [2, "Dos"]],
  );
  const paginas = cuerpo.titulos.map((titulo) => titulo.pagina);
  assert.equal(paginas[0], 1);
  assert.ok(paginas[2] > paginas[0] && paginas[2] <= cuerpo.paginas);

  const pdf = await generarPDF({ titulo: "T", markdown, fuentes: [] });
  const documento = await PDFDocument.load(pdf);
  assert.equal(documento.getPageCount(), 2 + cuerpo.paginas, "portada + una página de índice + cuerpo");
});
