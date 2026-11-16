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
