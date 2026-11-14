import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Acceso, parsearCodigos } from "../src/acceso.js";
import {
  crearBuscador,
  crearBuscadorDeLibros,
  deGoogleBooks,
  deOpenAlex,
  parsearDuckDuckGo,
  resumenDe,
} from "../src/busqueda.js";
import { destinosDe } from "../src/investigador.js";
import { listaDeFuentes, normalizarUrl } from "../src/investigador.js";
import { esDireccionPrivada, extraerTexto } from "../src/lector.js";
import { ErrorFormato, extraerJSON, quitarPensamiento } from "../src/llm.js";
import { aptoParaPDF, generarPDF, nombreDeArchivo, tituloDelPedido } from "../src/pdf.js";

const nuevoAcceso = (archivoUso = join(mkdtempSync(join(tmpdir(), "investigador-")), "uso.json")) =>
  new Acceso({
    codigos: "ana:codigo-de-ana:2,beto:codigo-de-beto",
    limiteDiario: 5,
    secreto: "secreto",
    archivoUso,
  });

test("códigos de acceso: formato y validaciones", () => {
  const [ana, beto] = parsearCodigos("ana:codigo-de-ana:2, beto:codigo-de-beto", 5);
  assert.deepEqual([ana.nombre, ana.limite, beto.limite], ["ana", 2, 5]);
  assert.throws(() => parsearCodigos("ana:corto", 5), /menos de 8/);
  assert.throws(() => parsearCodigos("ana", 5), /mal formado/);
  assert.throws(() => parsearCodigos("ana:codigo-uno-1,ana:codigo-dos-2", 5), /repetidos/);
  assert.throws(() => new Acceso({ codigos: "", limiteDiario: 5, secreto: "s", archivoUso: "x" }));
});

test("sesiones: el token solo vale firmado y para una persona existente", () => {
  const acceso = nuevoAcceso();
  const { token, persona } = acceso.entrar("codigo-de-ana", "1.1.1.1");
  assert.equal(persona.nombre, "ana");
  assert.equal(acceso.verificar(token).nombre, "ana");
  assert.equal(acceso.verificar(`${token}x`), null);
  assert.equal(acceso.verificar(token.replace(/^[^.]+/, Buffer.from("beto").toString("base64url"))), null);
  assert.equal(acceso.verificar(undefined), null);
});

test("sesiones: se bloquea la IP tras muchos intentos fallidos", () => {
  const acceso = nuevoAcceso();
  for (let intento = 0; intento < 8; intento++) {
    assert.deepEqual(acceso.entrar("codigo-malo", "2.2.2.2"), {});
  }
  assert.deepEqual(acceso.entrar("codigo-de-ana", "2.2.2.2"), { bloqueado: true });
  assert.ok(acceso.entrar("codigo-de-ana", "3.3.3.3").persona);
});

test("límite diario: cuenta, devuelve y persiste en disco", () => {
  const archivo = join(mkdtempSync(join(tmpdir(), "investigador-")), "uso.json");
  const acceso = nuevoAcceso(archivo);
  const { persona } = acceso.entrar("codigo-de-ana", "1.1.1.1");
  acceso.registrarUso(persona);
  acceso.registrarUso(persona);
  assert.equal(acceso.puedeInvestigar(persona), false);
  acceso.registrarUso(persona, -1);
  assert.equal(acceso.puedeInvestigar(persona), true);
  assert.deepEqual(nuevoAcceso(archivo).uso(persona), { usadas: 1, limite: 2 });
});

test("DuckDuckGo: extrae resultados, resuelve el enlace real y omite anuncios", () => {
  const html = `
    <div class="result results_links web-result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fejemplo.org%2Fnota%3Fa%3D1&rut=abc">Una nota</a>
      <a class="result__snippet">Resumen de la nota</a>
    </div>
    <div class="result result--ad">
      <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Anuncio</a>
    </div>
    <div class="result"><a class="result__a" href="https://directo.org/pagina">Directo</a></div>`;
  assert.deepEqual(parsearDuckDuckGo(html), [
    { titulo: "Una nota", url: "https://ejemplo.org/nota?a=1", resumen: "Resumen de la nota" },
    { titulo: "Directo", url: "https://directo.org/pagina", resumen: "" },
  ]);
});

test("lector: bloquea direcciones internas", () => {
  for (const interna of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254", "::1", "fe80::1", "::ffff:127.0.0.1", "no-es-ip"]) {
    assert.equal(esDireccionPrivada(interna), true, interna);
  }
  for (const publica of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(esDireccionPrivada(publica), false, publica);
  }
});

test("lector: extrae el texto principal de una página", () => {
  const parrafo = "<p>El contenido principal de la nota habla de energía solar y de sus costos en detalle.</p>";
  const html = `<html><head><title>Energía solar</title><script>var basura = 1;</script></head>
    <body><nav>Inicio | Contacto</nav><article><h1>Energía solar</h1>${parrafo.repeat(12)}</article></body></html>`;
  const { titulo, texto } = extraerTexto(html);
  assert.equal(titulo, "Energía solar");
  assert.ok(texto.includes("energía solar y de sus costos"));
  assert.ok(!texto.includes("basura"));
});

test("modelo: se descarta el razonamiento y se tolera JSON envuelto", () => {
  assert.equal(quitarPensamiento("<think>a</think>hola<think>sin cerrar"), "hola");
  assert.deepEqual(extraerJSON('Claro:\n```json\n{"a": [1, 2]}\n```'), { a: [1, 2] });
  assert.throws(() => extraerJSON("sin json"), ErrorFormato);
  assert.throws(() => extraerJSON("{roto}"), ErrorFormato);
  assert.deepEqual(extraerJSON('{"consultas": ["precio \\"real\\"", "costo"} }'), {
    consultas: ['precio "real"', "costo"],
  });
  assert.deepEqual(extraerJSON('{"completo": false, "consultas": ["a",]}'), {
    completo: false,
    consultas: ["a"],
  });
});

test("fuentes: URLs equivalentes se unifican y la lista respeta los números citados", () => {
  assert.equal(
    normalizarUrl("https://Ejemplo.org/nota/?utm_source=x&id=7#parte"),
    "https://ejemplo.org/nota?id=7",
  );
  assert.equal(normalizarUrl("no es una url"), null);
  const fuentes = [
    { n: 1, titulo: "Uno", url: "https://a.org/1" },
    { n: 2, titulo: "Dos [beta]", url: "https://a.org/2_(x)" },
    { n: 3, titulo: "Tres", url: "https://a.org/3" },
  ];
  assert.equal(
    listaDeFuentes(fuentes, "Dato [3] y otro [2]."),
    "\n\n## Fuentes\n\n- **2.** [Dos beta](https://a.org/2_%28x%29)\n- **3.** [Tres](https://a.org/3)\n",
  );
  assert.match(listaDeFuentes(fuentes, "Sin citas."), /\*\*1\.\*\*[\s\S]+\*\*3\.\*\*/);
});

test("PDF: se genera con tablas, listas, citas y caracteres especiales", async () => {
  const markdown = `# Título con acentos: información & "comillas"

Párrafo con **negrita**, *cursiva*, \`código\`, un [enlace](https://a.org) y una cita [1].

| Columna | Valor |
| --- | --- |
| A & B | 10 [2] |

1. Uno
2. Dos
   - Anidado

> Una cita textual

\`\`\`
bloque de código
\`\`\`

---
`;
  const pdf = await generarPDF({
    titulo: "Prueba",
    markdown,
    fuentes: [
      { n: 1, url: "https://a.org/1" },
      { n: 2, url: "https://a.org/2" },
    ],
  });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 5000);
  assert.equal(nombreDeArchivo("¿Energía solar en Argentina? Costos 2026"), "energia-solar-en-argentina-costos-2026.pdf");
  assert.equal(nombreDeArchivo("¿¡!?"), "informe.pdf");
});

test("PDF: los símbolos que la fuente no tiene se reemplazan o se quitan", () => {
  assert.equal(aptoParaPDF("5 kWp → 18 kWh ≈ 540 ✅ ⚠ listo 🔥"), "5 kWp -> 18 kWh ≈ 540 √ (!) listo ");
  assert.equal(aptoParaPDF("Ñandú ¿qué? «sí» – 20 °C · x² ≤ 3"), "Ñandú ¿qué? «sí» – 20 °C · x² ≤ 3");
  const markdown = "# Informe\r\n\n## Resumen\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\tcódigo";
  assert.equal(aptoParaPDF(markdown), markdown, "los saltos de línea y tabulaciones se conservan");
  assert.equal(aptoParaPDF("Qingtao (清陶能源, China) y Sunwoda (欣旺达) [3]"), "Qingtao (China) y Sunwoda [3]");
  assert.equal(aptoParaPDF("f(x) = (a, b)"), "f(x) = (a, b)", "sin caracteres quitados no se toca nada");
});

test("PDF: con la plantilla, la línea Pregunta da el título y el nombre del archivo", () => {
  const pedido = "Pregunta: ¿Conviene la energía solar?\nContexto: Córdoba, 2026\nExcluir: baterías";
  assert.equal(tituloDelPedido(pedido), "¿Conviene la energía solar?");
  assert.equal(nombreDeArchivo(pedido), "conviene-la-energia-solar.pdf");
  assert.equal(tituloDelPedido("Pregunta:\nContexto: algo"), "Pregunta:\nContexto: algo");
  assert.equal(tituloDelPedido("Tema libre sin plantilla"), "Tema libre sin plantilla");
});

test("destinos: sitios y pedido académico salen del campo Fuentes", () => {
  const pedido = `Pregunta: ¿Sirve Node.js para esto?
Fuentes: https://www.who.int/es/temas, argentina.gob.ar; Google Scholar y papers recientes`;
  assert.deepEqual(destinosDe(pedido, ["CEPAL.org", "no es dominio", "scholar.google.com"]), {
    dominios: ["who.int", "argentina.gob.ar", "cepal.org"],
    academico: true,
    libros: false,
  });
  assert.deepEqual(destinosDe("Pregunta: costos\nFuentes: oficiales"), {
    dominios: [],
    academico: false,
    libros: false,
  });
  assert.deepEqual(destinosDe("Buscá en arxiv.org sobre Node.js"), {
    dominios: ["arxiv.org"],
    academico: false,
    libros: false,
  });
  assert.equal(destinosDe("Fuentes: libros y bibliotecas nacionales").libros, true);
});

test("OpenAlex: arma la ficha con el resumen reconstruido y sin resumen no da contenido", () => {
  assert.equal(resumenDe({ baterías: [0, 3], sólidas: [1], mejores: [2] }), "baterías sólidas mejores baterías");
  const obra = {
    id: "https://openalex.org/W1",
    doi: "https://doi.org/10.1/x",
    display_name: "Solid-state batteries",
    publication_year: 2025,
    cited_by_count: 12,
    primary_location: { source: { display_name: "Nature Energy" } },
    authorships: ["A", "B", "C", "D"].map((nombre) => ({ author: { display_name: nombre } })),
    abstract_inverted_index: { Dense: [0], cells: [1] },
  };
  assert.deepEqual(deOpenAlex(obra), {
    titulo: "Solid-state batteries",
    url: "https://doi.org/10.1/x",
    resumen: "Solid-state batteries\nA, B, C et al.\n2025 · Nature Energy\nCitas: 12\nResumen: Dense cells",
    contenido: "Solid-state batteries\nA, B, C et al.\n2025 · Nature Energy\nCitas: 12\nResumen: Dense cells",
    tipo: "académico",
    fecha: "2025",
  });
  assert.equal(deOpenAlex({ ...obra, abstract_inverted_index: null }).contenido, "");
});

test("Tavily recibe los dominios cuando la búsqueda va a sitios", async () => {
  const original = globalThis.fetch;
  const cuerpos = [];
  globalThis.fetch = async (url, opciones) => {
    cuerpos.push(JSON.parse(opciones.body));
    return new Response(JSON.stringify({ results: [{ title: "t", url: "https://who.int/a" }] }));
  };
  try {
    const buscar = crearBuscador({ tavilyClave: "clave" });
    await buscar("malaria", { cantidad: 3, dominios: ["who.int"] });
    await buscar("malaria", { cantidad: 3 });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(cuerpos[0].include_domains, ["who.int"]);
  assert.equal("include_domains" in cuerpos[1], false);
});

test("Google Books: la ficha usa descripción y fragmento sin HTML; sin descripción no da contenido", () => {
  const volumen = {
    id: "abc",
    volumeInfo: {
      title: "Historia",
      subtitle: "del peronismo",
      authors: ["Ana", "Beto"],
      publishedDate: "1999-05-01",
      publisher: "Sudamericana",
      description: `<p>${"Un recorrido amplio. ".repeat(10)}</p>`,
      canonicalVolumeLink: "https://books.google.com/books/about/x?id=abc",
    },
    searchInfo: { textSnippet: "el <b>17 de octubre</b>" },
  };
  const ficha = deGoogleBooks(volumen);
  assert.equal(ficha.titulo, "Historia: del peronismo");
  assert.equal(ficha.url, "https://books.google.com/books/about/x?id=abc");
  assert.match(ficha.contenido, /^Historia: del peronismo\nAna, Beto\n1999 · Sudamericana\nDescripción: Un recorrido/);
  assert.match(ficha.contenido, /Fragmento: el 17 de octubre$/);
  assert.equal(deGoogleBooks({ id: "x", volumeInfo: { title: "Corto" } }).contenido, "");
});

test("libros: OpenAlex filtra solo libros con resumen; si Google Books falla, quedan los de OpenAlex", async () => {
  const original = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url) => {
    pedidos.push(String(url));
    if (String(url).includes("googleapis")) return new Response("{}", { status: 429 });
    const obra = { id: "W1", display_name: "Libro", abstract_inverted_index: { Texto: [0] } };
    return new Response(JSON.stringify({ results: [obra] }));
  };
  let resultado;
  try {
    const buscarLibros = crearBuscadorDeLibros({ claveOpenAlex: "", claveGoogleBooks: "clave" });
    resultado = await buscarLibros("peronismo", { cantidad: 8 });
  } finally {
    globalThis.fetch = original;
  }
  const openAlex = new URL(pedidos.find((url) => url.includes("openalex")));
  assert.equal(openAlex.searchParams.get("filter"), "has_abstract:true,type:book");
  assert.equal(openAlex.searchParams.get("per_page"), "4");
  assert.ok(pedidos.some((url) => url.includes("googleapis") && url.includes("maxResults=4")));
  assert.deepEqual(resultado.resultados.map((libro) => libro.titulo), ["Libro"]);
});

test("Tavily: excluye video y redes, limita al último año si se pide y corta la cola de bajo puntaje", async () => {
  const original = globalThis.fetch;
  const cuerpos = [];
  globalThis.fetch = async (url, opciones) => {
    cuerpos.push(JSON.parse(opciones.body));
    const resultado = (sitio, score) => ({ title: sitio, url: `https://${sitio}/a`, score });
    return new Response(
      JSON.stringify({
        results: [resultado("iea.org", 0.8), resultado("m.youtube.com", 0.7), resultado("flojo.test", 0.2)],
      }),
    );
  };
  let resultados;
  try {
    const buscar = crearBuscador({ tavilyClave: "clave", excluidos: ["youtube.com"] });
    ({ resultados } = await buscar("costo solar", { cantidad: 8, reciente: true }));
    await buscar("costo solar", { cantidad: 8, dominios: ["youtube.com"] });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(cuerpos[0].exclude_domains, ["youtube.com"]);
  assert.equal(cuerpos[0].time_range, "year");
  assert.deepEqual(resultados.map((r) => r.url), ["https://iea.org/a"], "sin YouTube ni el de 0,2");
  assert.equal("exclude_domains" in cuerpos[1], false, "si el pedido nombra el sitio, no se excluye");
});

test("papers: primero la búsqueda semántica y, si falla, la común", async () => {
  const original = globalThis.fetch;
  const parametros = [];
  globalThis.fetch = async (url) => {
    const direccion = new URL(url);
    const semantica = direccion.searchParams.has("search.semantic");
    parametros.push(semantica ? "semántica" : "común");
    if (semantica) return new Response("{}", { status: 400 });
    const obra = { id: "W1", display_name: "Paper", abstract_inverted_index: { Texto: [0] } };
    return new Response(JSON.stringify({ results: [obra] }));
  };
  try {
    const { crearBuscadorAcademico } = await import("../src/busqueda.js");
    const { resultados } = await crearBuscadorAcademico({ clave: "" })("frase larga", { cantidad: 3 });
    assert.deepEqual(resultados.map((r) => [r.titulo, r.tipo]), [["Paper", "académico"]]);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(parametros, ["semántica", "común"]);
});
