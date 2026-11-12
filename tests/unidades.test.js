import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Acceso, parsearCodigos } from "../src/acceso.js";
import { parsearDuckDuckGo } from "../src/busqueda.js";
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
});

test("PDF: con la plantilla, la línea Pregunta da el título y el nombre del archivo", () => {
  const pedido = "Pregunta: ¿Conviene la energía solar?\nContexto: Córdoba, 2026\nExcluir: baterías";
  assert.equal(tituloDelPedido(pedido), "¿Conviene la energía solar?");
  assert.equal(nombreDeArchivo(pedido), "conviene-la-energia-solar.pdf");
  assert.equal(tituloDelPedido("Pregunta:\nContexto: algo"), "Pregunta:\nContexto: algo");
  assert.equal(tituloDelPedido("Tema libre sin plantilla"), "Tema libre sin plantilla");
});
