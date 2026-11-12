import assert from "node:assert/strict";
import { test } from "node:test";
import { dibujarGrafico, imagenDe, tipoDeGrafico } from "../public/graficos.js";
import { figurasDe } from "../src/busqueda.js";
import { generarPDF } from "../src/pdf.js";
import { promptSeccion } from "../src/prompts.js";

const barras = {
  tipo: "barras",
  titulo: "Densidad <b>",
  unidad: "Wh/kg",
  datos: [
    { etiqueta: "A <script>", valor: 500, cita: 3 },
    { etiqueta: "B", valor: 450, cita: 1 },
    { etiqueta: "C", valor: "no es número", cita: 2 },
    { etiqueta: "D", valor: -4, cita: 2 },
  ],
};

test("barras: escapa el texto del modelo, descarta datos inválidos y junta las citas", () => {
  const grafico = dibujarGrafico(JSON.stringify(barras));
  assert.equal(grafico.titulo, "Densidad <b>");
  assert.deepEqual(grafico.citas, [1, 3]);
  assert.equal(grafico.svg.match(/<rect /g).length, 2);
  assert.ok(grafico.svg.includes("A &lt;script&gt;"));
  assert.ok(!grafico.svg.includes("<script>"));
  assert.ok(grafico.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
});

test("cada tipo dibuja con datos suficientes y devuelve null si no los hay", () => {
  const casos = {
    lineas: { series: [{ nombre: "S", puntos: [{ x: "2020", y: 1, cita: 1 }, { x: "2021", y: 3, cita: 2 }] }] },
    "linea-de-tiempo": { eventos: [{ fecha: "2020", texto: "uno", cita: 1 }, { fecha: "2021", texto: "dos" }] },
    diagrama: { forma: "flujo", pasos: [{ texto: "uno" }, { texto: "dos", cita: 4 }] },
  };
  for (const [tipo, datos] of Object.entries(casos)) {
    assert.ok(dibujarGrafico({ tipo, titulo: tipo, ...datos })?.svg.includes("</svg>"), tipo);
  }
  assert.ok(dibujarGrafico({ tipo: "diagrama", forma: "partes", centro: "Centro", pasos: ["a", "b", "c"] }));
  assert.equal(dibujarGrafico({ tipo: "barras", datos: [{ etiqueta: "solo", valor: 1 }] }), null);
  assert.equal(dibujarGrafico({ tipo: "torta", datos: [] }), null);
  assert.equal(dibujarGrafico('{"tipo": "barras", "datos": ['), null, "bloque a medio llegar");
  assert.equal(dibujarGrafico({ tipo: "mapa", datos: [{ pais: "ARG", valor: 1 }] }), null, "sin geografía");
});

test("mapa: colorea los países con dato y lista los mayores en el detalle", () => {
  const geografia = {
    tamano: [100, 50],
    paises: { ARG: { nombre: "Argentina", d: "M0 0L1 1Z" }, CHL: { nombre: "Chile", d: "M2 2L3 3Z" } },
  };
  const grafico = dibujarGrafico(
    { tipo: "mapa", titulo: "T", unidad: "u", datos: [{ pais: "arg", valor: 5, cita: 2 }, { pais: "XXX", valor: 9 }] },
    { geografia },
  );
  assert.deepEqual(grafico.detalle, ["Argentina: 5 u"]);
  assert.deepEqual(grafico.citas, [2]);
  assert.equal(grafico.svg.match(/<path d=/g).length, 2, "un trazo por país");
});

test("imagen: solo direcciones http(s); el tipo se lee sin dibujar", () => {
  assert.deepEqual(imagenDe('{"tipo": "imagen", "url": "https://a.test/x.png", "pie": "Plano", "cita": 2}'), {
    url: "https://a.test/x.png",
    pie: "Plano",
    cita: 2,
  });
  assert.equal(imagenDe('{"tipo": "imagen", "url": "javascript:alert(1)"}'), null);
  assert.equal(tipoDeGrafico('{"tipo": "mapa"}'), "mapa");
});

test("figuras de Tavily: solo con texto alternativo descriptivo, sin logos ni íconos, hasta 3", () => {
  const imagen = (url, description, description_source = "alt") => ({ url, description, description_source });
  const figuras = figurasDe([
    imagen("https://a.test/logo.png", "Logo de la empresa"),
    imagen("https://a.test/corte.jpg", "Corte transversal de la celda"),
    imagen("http://a.test/inseguro.jpg", "Imagen sin https"),
    imagen("https://a.test/og.jpg", "Portada del sitio para redes", "og:image"),
    imagen("https://a.test/1.jpg", "Plano de la planta 1"),
    imagen("https://a.test/2.jpg", "Plano de la planta 2"),
    imagen("https://a.test/3.jpg", "Plano de la planta 3"),
  ]);
  assert.deepEqual(
    figuras.map((figura) => figura.url),
    ["https://a.test/corte.jpg", "https://a.test/1.jpg", "https://a.test/2.jpg"],
  );
});

test("PDF con gráfico e imagen que no se puede bajar (dirección interna): no falla", async () => {
  const markdown = `# T\n\nTexto [1].\n\n\`\`\`grafico\n${JSON.stringify(barras)}\n\`\`\`\n\n\`\`\`grafico\n{"tipo": "imagen", "url": "https://127.0.0.1/x.png", "pie": "Plano", "cita": 1}\n\`\`\`\n`;
  const pdf = await generarPDF({ titulo: "T", markdown, fuentes: [{ n: 1, url: "https://a.test", titulo: "A" }] });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});

test("las secciones reciben los formatos de gráfico y las imágenes de cada fuente", () => {
  const conversacion = {
    tema: "Tema",
    fuentes: [{ n: 1, url: "https://a.test", titulo: "A", notas: "notas", imagenes: [{ url: "https://a.test/p.jpg", descripcion: "Plano" }] }],
  };
  const texto = promptSeccion(conversacion, [{ titulo: "S", enfoque: "e", fuentes: [1] }], 0).at(-1).content;
  assert.ok(texto.includes('"tipo": "linea-de-tiempo"'));
  assert.ok(texto.includes("Imágenes: https://a.test/p.jpg — Plano"));
});
