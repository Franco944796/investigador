import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consultasDe,
  crearConversacion,
  crearInvestigador,
  interpretarNotas,
  parecidas,
  porTurnos,
  seccionesDe,
} from "../src/investigador.js";
import { promptRevision } from "../src/prompts.js";

const OPCIONES = {
  consultasIniciales: 1,
  resultadosPorConsulta: 4,
  rondasExtra: 0,
  consultasPorRonda: 1,
  maxFuentes: 10,
  fuentesPorSeguimiento: 2,
  caracteresPorFuente: 1000,
  tareasEnParalelo: 2,
};

const llmFijo = {
  completar: async () => "Notas de la fuente.",
  completarJSON: async () => ({ consultas: ["consulta"] }),
  completarEnVivo: async (mensajes, { alRecibir }) => {
    alRecibir("# Informe [1]");
    return "# Informe [1]";
  },
};

test("el texto de una fuente sale de la búsqueda, de la lectura o del resumen largo", async () => {
  const leidas = [];
  const investigador = crearInvestigador({
    llm: llmFijo,
    opciones: OPCIONES,
    buscar: async () => ({
      motor: "simulado",
      resultados: [
        { titulo: "Con contenido", url: "https://a.test/contenido", contenido: "x".repeat(5000) },
        { titulo: "Legible", url: "https://a.test/legible", resumen: "corto" },
        { titulo: "Bloqueada", url: "https://a.test/bloqueada", resumen: "r".repeat(500) },
        { titulo: "Sin nada", url: "https://a.test/vacia", resumen: "corto" },
      ],
    }),
    leerPagina: async (url) => {
      leidas.push(new URL(url).pathname);
      if (url.endsWith("/legible")) return { titulo: "Legible", texto: "texto de la página" };
      throw new Error("respondió 403");
    },
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, {
    emitir: (tipo, datos) => eventos.push({ tipo, datos }),
    signal: new AbortController().signal,
  });

  assert.deepEqual(leidas.sort(), ["/bloqueada", "/legible", "/vacia"], "con contenido no se descarga");
  assert.deepEqual(
    conversacion.fuentes.map((fuente) => new URL(fuente.url).pathname).sort(),
    ["/bloqueada", "/contenido", "/legible"],
  );
  const descartadas = eventos.filter((e) => e.tipo === "fuente" && e.datos.estado === "descartada");
  assert.deepEqual(descartadas.map((e) => e.datos.motivo), ["respondió 403"]);
});

const LARGO = "contenido ".repeat(40);
const flujoDe = (eventos) => ({
  emitir: (tipo, datos) => eventos.push({ tipo, datos }),
  signal: new AbortController().signal,
});

test("consultas e índice del modelo se normalizan; las fuentes sin sección no se pierden", () => {
  assert.deepEqual(
    consultasDe(["  uno ", { idioma: "ZH", texto: "太阳能" }, { texto: "uno" }, 3, { idioma: "en" }]),
    [{ texto: "uno" }, { texto: "太阳能", idioma: "zh" }],
  );
  const muchas = Array.from({ length: 50 }, (_, i) => i + 1);
  const secciones = seccionesDe(
    [
      { titulo: "Grande", enfoque: "a", fuentes: [...muchas, 999, "2", 0] },
      { titulo: "Vacía", fuentes: [] },
      { titulo: "", fuentes: [1] },
    ],
    95,
  );
  assert.deepEqual(
    secciones.map((s) => [s.titulo, s.fuentes.length]),
    [
      ["Grande", 40],
      ["Otros hallazgos (1 de 2)", 40],
      ["Otros hallazgos (2 de 2)", 15],
    ],
  );
  assert.deepEqual(secciones[1].fuentes.slice(0, 2), [41, 42]);
});

test("exhaustiva: busca en varios idiomas y escribe el informe por secciones", async () => {
  const pedidos = [];
  const llm = {
    completarJSON: async (mensajes) => {
      const texto = mensajes.at(-1).content;
      pedidos.push(texto);
      if (texto.includes('"secciones"')) {
        return { titulo: "Informe solar", secciones: [{ titulo: "Costos", enfoque: "precios", fuentes: [1, 2] }] };
      }
      return {
        idiomas: [
          { codigo: "es", nombre: "español" },
          { codigo: "en", nombre: "inglés" },
        ],
        consultas: [
          { idioma: "es", texto: "costo paneles solares" },
          { idioma: "en", texto: "solar panel cost" },
          { idioma: "zh", texto: "太阳能 成本" },
        ],
      };
    },
    completar: async (mensajes) => {
      const texto = mensajes.at(-1).content;
      if (texto.includes("Te toca la sección")) return `## ${texto.match(/sección \d+: "([^"]+)"/)[1]}\n\nDato [1].`;
      if (texto.includes("comienzo del informe")) return "# Informe solar\n\n## Resumen\n\nHallazgos [2].";
      if (texto.includes("cierre del informe")) return "## Conclusiones\n\nConviene [3].";
      return "Notas de la fuente.";
    },
    completarEnVivo: async () => assert.fail("con secciones no se escribe en una sola respuesta"),
  };
  const investigador = crearInvestigador({
    llm,
    opciones: { ...OPCIONES, consultasIniciales: 5, multilingue: true, informePorSecciones: true },
    buscar: async (consulta) => ({
      resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }],
    }),
    leerPagina: async () => assert.fail("no hace falta leer"),
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Pregunta: ¿Conviene la energía solar?");
  await investigador.investigar(conversacion, flujoDe(eventos));

  assert.match(pedidos[0], /Investigación multilingüe/);
  assert.deepEqual(
    eventos.filter((e) => e.tipo === "consulta").map((e) => e.datos.idioma),
    ["es", "en", "zh"],
  );
  const etapas = eventos.filter((e) => e.tipo === "etapa").map((e) => e.datos.texto);
  assert.ok(etapas.includes("Buscando y leyendo fuentes en español, inglés y chino"));
  assert.ok(etapas.includes("Redactando el informe (sección 2 de 2)"));

  const titulos = conversacion.informe.match(/^#{1,2} .+$/gm);
  assert.deepEqual(titulos, [
    "# Informe solar",
    "## Resumen",
    "## Costos",
    "## Otros hallazgos",
    "## Conclusiones",
    "## Fuentes",
  ]);
  const textos = eventos.filter((e) => e.tipo === "texto").map((e) => e.datos.delta);
  assert.equal(textos.join(""), conversacion.informe, "lo mostrado coincide con lo guardado");
});

test("tras N fuentes seguidas que no aportan, deja de buscar y redacta con lo que hay", async () => {
  // Orden de lectura: aporta, no aporta, caída (no cuenta), no aporta, no aporta → corta.
  const paginas = ["util", "nada-1", "caida", "nada-2", "nada-3", "nada-4", "util-2"];
  let revisiones = 0;
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        if (mensajes.at(-1).content.includes('"completo"')) revisiones++;
        return { consultas: ["consulta"], completo: false };
      },
      completar: async (mensajes) =>
        mensajes.at(-1).content.includes("a.test/nada") ? "IRRELEVANTE" : "Notas útiles.",
    },
    opciones: {
      ...OPCIONES,
      resultadosPorConsulta: 10,
      rondasExtra: 3,
      tareasEnParalelo: 1,
      irrelevantesSeguidas: 3,
    },
    buscar: async () => ({
      resultados: paginas.map((nombre) => ({
        titulo: nombre,
        url: `https://a.test/${nombre}`,
        ...(nombre !== "caida" && { contenido: LARGO }),
      })),
    }),
    leerPagina: async () => {
      throw new Error("respondió 403");
    },
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, flujoDe(eventos));

  const leidas = eventos.filter((e) => e.tipo === "fuente" && e.datos.estado === "leyendo");
  assert.deepEqual(
    leidas.map((e) => e.datos.titulo),
    ["util", "nada-1", "caida", "nada-2", "nada-3"],
  );
  assert.equal(revisiones, 0, "no se piden rondas extra");
  assert.match(eventos.find((e) => e.tipo === "aviso").datos.texto, /últimas 3 fuentes no aportaban/);
  assert.equal(conversacion.fuentes.length, 1);
  assert.ok(conversacion.informe.startsWith("# Informe [1]"));
});

test("con tope de búsquedas, las rondas se recortan y termina al agotarlas", async () => {
  const buscadas = [];
  let ronda = 0;
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        if (!mensajes.at(-1).content.includes('"completo"')) return { consultas: ["a", "b"] };
        ronda++;
        return { completo: false, consultas: [`r${ronda}-1`, `r${ronda}-2`, `r${ronda}-3`] };
      },
    },
    opciones: {
      ...OPCIONES,
      consultasIniciales: 2,
      consultasPorRonda: 3,
      rondasExtra: 10,
      maxBusquedas: 6,
      maxFuentes: Infinity,
    },
    buscar: async (consulta) => {
      buscadas.push(consulta);
      return { resultados: [{ titulo: consulta, url: `https://a.test/${consulta}`, contenido: LARGO }] };
    },
    leerPagina: async () => assert.fail("no hace falta leer"),
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, flujoDe(eventos));

  assert.deepEqual(buscadas, ["a", "b", "r1-1", "r1-2", "r1-3", "r2-1"]);
  assert.equal(conversacion.fuentes.length, 6, "sin tope de fuentes, entran todas");
  assert.match(eventos.find((e) => e.tipo === "aviso").datos.texto, /las 6 búsquedas previstas/);
});

test("sitios y papers: cada uno con su cupo, y se dejan cuando ya no traen páginas nuevas", async () => {
  const web = [];
  const enSitios = [];
  const academicas = [];
  const revisiones = [];
  const llm = {
    ...llmFijo,
    completarJSON: async (mensajes) => {
      const texto = mensajes.at(-1).content;
      if (texto.includes('"completo"')) {
        revisiones.push(texto);
        const ronda = revisiones.length;
        return { completo: false, consultas: [`web r${ronda}`], dirigidas: [`dirigida r${ronda}`] };
      }
      return {
        consultas: ["web 1", "web 2"],
        dirigidas: [{ idioma: "en", texto: "paper 1" }, "sitio 1"],
        sitios: ["who.int"],
      };
    },
  };
  const investigador = crearInvestigador({
    llm,
    opciones: { ...OPCIONES, consultasIniciales: 4, consultasPorRonda: 2, rondasExtra: 3, maxBusquedas: 40 },
    buscar: async (consulta, { dominios }) => {
      (dominios ? enSitios : web).push(consulta);
      // Lo que se busca en los sitios siempre devuelve la misma página: no aporta nada nuevo.
      const url = dominios ? "https://who.int/unica" : `https://a.test/${encodeURIComponent(consulta)}`;
      return { resultados: [{ titulo: consulta, url, contenido: LARGO }] };
    },
    buscarAcademico: async (consulta) => {
      academicas.push(consulta);
      return { resultados: [{ titulo: consulta, url: "https://doi.org/10.1/unico", contenido: LARGO }] };
    },
    leerPagina: async () => assert.fail("no hace falta leer"),
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Pregunta: algo\nFuentes: Google Scholar, la OMS");
  await investigador.investigar(conversacion, flujoDe(eventos));

  assert.deepEqual(web, ["web 1", "web 2", "web r1", "web r2", "web r3"]);
  // Sin destino indicado, las dirigidas se turnan entre papers y sitios.
  assert.deepEqual(academicas, ["paper 1", "dirigida r1", "dirigida r3"]);
  assert.deepEqual(enSitios, ["sitio 1", "dirigida r2"]);
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.equal(avisos[0], "La mitad de las búsquedas web va a: who.int.");
  assert.match(avisos[1], /^Además busco artículos académicos \(OpenAlex, en lugar de Google Scholar\): hasta/);
  assert.ok(avisos.some((texto) => /sitios indicados ya no traen resultados nuevos/.test(texto)));
  assert.ok(avisos.some((texto) => /Papers y libros ya no traen resultados nuevos/.test(texto)));
  assert.ok(revisiones[0].includes('con destino "sitios"'));
  assert.ok(!revisiones.at(-1).includes('con destino "sitios"'), "agotados los sitios, ya no se piden");
  const destinos = eventos.filter((e) => e.tipo === "consulta").map((e) => e.datos.destino ?? "web");
  assert.deepEqual(destinos.slice(0, 4), ["web", "web", "sitios", "academico"]);
});

test("si el tema amerita libros, se buscan aparte de las búsquedas web", async () => {
  const libros = [];
  const web = [];
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) =>
        mensajes.at(-1).content.includes('"completo"')
          ? { completo: true }
          : { consultas: ["w1", "w2", "w3", "w4"], dirigidas: ["historia del peronismo"], libros: true },
    },
    opciones: { ...OPCIONES, consultasIniciales: 4, maxBusquedas: 40, maxAcademicas: 50 },
    buscar: async (consulta) => {
      web.push(consulta);
      return { resultados: [{ titulo: consulta, url: `https://a.test/${consulta}`, contenido: LARGO }] };
    },
    buscarLibros: async (consulta) => {
      libros.push(consulta);
      return { resultados: [{ titulo: "Libro", url: "https://openalex.org/W9", contenido: LARGO }] };
    },
    leerPagina: async () => assert.fail("no hace falta leer"),
  });

  const eventos = [];
  await investigador.investigar(crearConversacion("id", "ana", "Pregunta: el peronismo"), flujoDe(eventos));

  assert.deepEqual(libros, ["historia del peronismo"]);
  assert.deepEqual(web, ["w1", "w2", "w3", "w4"], "los libros no le quitan lugar a la web");
  assert.ok(
    eventos.some(
      (e) => e.tipo === "aviso" && e.datos.texto === "Además busco libros: hasta 50 búsquedas, aparte de las de la web.",
    ),
  );
  assert.ok(eventos.some((e) => e.tipo === "consulta" && e.datos.destino === "libros"));
});

test("al recortar consultas, cada idioma entra por turno", () => {
  const consultas = ["es1", "es2", "es3", "en1", "en2", "ja1"].map((texto) => ({
    texto,
    idioma: texto.slice(0, 2),
  }));
  assert.deepEqual(
    porTurnos(consultas).slice(0, 4).map((consulta) => consulta.texto),
    ["es1", "en1", "ja1", "es2"],
  );
});

test("antes del mínimo de búsquedas no acepta que ya alcanza y pide profundizar", async () => {
  const revisiones = [];
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        const texto = mensajes.at(-1).content;
        if (!texto.includes('"completo"')) return { consultas: ["a", "b"] };
        revisiones.push(texto.includes("Todavía no alcanza"));
        // El modelo siempre dice que alcanza, pero deja consultas por si se las exigen.
        return { completo: true, consultas: [`r${revisiones.length}-1`, `r${revisiones.length}-2`] };
      },
    },
    opciones: {
      ...OPCIONES,
      consultasIniciales: 2,
      consultasPorRonda: 2,
      rondasExtra: 10,
      minBusquedas: 6,
      maxBusquedas: 20,
    },
    buscar: async (consulta) => ({
      resultados: [{ titulo: consulta, url: `https://a.test/${consulta}`, contenido: LARGO }],
    }),
    leerPagina: async () => assert.fail("no hace falta leer"),
  });
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, flujoDe([]));
  assert.deepEqual(revisiones, [true, true, false], "exige hasta llegar a 6 y después acepta");
  assert.equal(conversacion.consultas.length, 6);
});

test("consultas: site: pasa a ser el filtro, se respeta el destino y lo reciente", () => {
  assert.deepEqual(
    consultasDe([
      "site:iea.org solar PV market report",
      { texto: "perovskite tandem stability", destino: "Académico", idioma: "en" },
      { texto: "precio módulos", reciente: true, destino: "inventado" },
    ]),
    [
      { texto: "solar PV market report", destino: "sitios", dominios: ["iea.org"] },
      { texto: "perovskite tandem stability", idioma: "en", destino: "academico" },
      { texto: "precio módulos", reciente: true },
    ],
  );
});

test("el año en curso se quita de la consulta y se pide lo reciente; otros años quedan", () => {
  const anio = new Date().getFullYear();
  assert.deepEqual(
    consultasDe([`bomba de calor COP Europa ${anio}`, `capacidad solar 2010 ${anio}`, "precios 2019", String(anio)]),
    [
      { texto: "bomba de calor COP Europa", reciente: true },
      { texto: `capacidad solar 2010 ${anio}` },
      { texto: "precios 2019" },
      { texto: String(anio) },
    ],
  );
  const reciente = `resultados electorales ${anio - 2}`;
  assert.deepEqual(consultasDe([`cost breakdown ${anio - 2} ${anio - 1}`, reciente]), [
    { texto: "cost breakdown", reciente: true },
    { texto: "resultados electorales", reciente: true },
  ]);
  assert.deepEqual(consultasDe([reciente], new Set([anio - 2])), [{ texto: reciente }], "el pedido nombra ese año");
});

test("consultas casi iguales se reconocen aunque cambie el orden o el año", () => {
  assert.ok(parecidas("solar PV LCOE trend 2010 2026", "2026 PV LCOE global trend"));
  assert.ok(parecidas("光伏度电成本 趋势 2026", "光伏度电成本趋势"));
  assert.ok(!parecidas("solar PV LCOE trend", "solar module price history"));
  assert.ok(!parecidas("web 1", "web 2"), "con una sola palabra clave solo vale la igualdad");
});

test("notas: el encabezado da fecha, tipo y subpreguntas; sin encabezado todo es texto", () => {
  assert.deepEqual(
    interpretarNotas("**Fecha:** marzo de 2025 (2025-03)\nTipo: Académico\nAspectos: 2, 5 y 2\nNotas: Dato [x].\nOtra línea."),
    { notas: "Dato [x].\nOtra línea.", aspectos: [2, 5], fecha: "2025-03", tipo: "académico" },
  );
  assert.deepEqual(interpretarNotas("Fecha: desconocida\nTipo: raro\nAspectos: ninguno\nNotas: Texto."), {
    notas: "Texto.",
    aspectos: [],
  });
  assert.deepEqual(interpretarNotas("Solo un párrafo.\nFecha: no es encabezado"), {
    notas: "Solo un párrafo.\nFecha: no es encabezado",
    aspectos: [],
  });
  assert.equal(interpretarNotas("IRRELEVANTE").notas, "IRRELEVANTE");
});

test("cada dirigida va a su destino; si un buscador falla se avisa, va a la web y se deja de usar", async () => {
  const web = [];
  const enSitios = [];
  const libros = [];
  let ronda = 0;
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completar: async () => "Fecha: 2024\nTipo: prensa\nAspectos: 1\nNotas: Dato útil.",
      completarJSON: async (mensajes) => {
        if (mensajes.at(-1).content.includes('"completo"')) {
          ronda++;
          return {
            completo: false,
            consultas: [["precios regionales", "fabricantes líderes"][ronda - 1]],
            dirigidas: [
              { texto: ["perovskita estabilidad", "tándem eficiencia"][ronda - 1], destino: "academico" },
            ],
            aspectos_nuevos: ronda === 1 ? ["¿Y los riesgos?"] : [],
          };
        }
        return {
          aspectos: ["¿Cuánto cuesta?"],
          consultas: ["costo general", "costo general 2026", "panorama mundial"],
          dirigidas: [
            { texto: "site:iea.org informe de mercado", destino: "academico" },
            { texto: "historia de la energía", destino: "libros" },
            { texto: "paper uno", destino: "academico" },
          ],
          sitios: ["iea.org"],
          academico: true,
          libros: true,
        };
      },
    },
    opciones: { ...OPCIONES, consultasIniciales: 6, consultasPorRonda: 2, rondasExtra: 2, maxBusquedas: 40 },
    buscar: async (consulta, { dominios }) => {
      (dominios ? enSitios : web).push(consulta);
      return { resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }] };
    },
    buscarAcademico: async () => {
      throw new Error("OpenAlex respondió 429");
    },
    buscarLibros: async (consulta) => {
      libros.push(consulta);
      return { resultados: [{ titulo: consulta, url: "https://libros.test/1", contenido: LARGO, tipo: "libro" }] };
    },
    leerPagina: async () => assert.fail("no hace falta leer"),
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Pregunta: costos");
  await investigador.investigar(conversacion, flujoDe(eventos));

  assert.deepEqual(enSitios, ["informe de mercado"], "la de site: va al sitio aunque dijera academico");
  assert.deepEqual(libros, ["historia de la energía"]);
  assert.deepEqual(
    web,
    ["costo general", "panorama mundial", "paper uno", "precios regionales", "perovskita estabilidad", "fabricantes líderes"],
    "sin la casi repetida; las de papers van a la web cuando OpenAlex falla, y después solo si hay cupo web",
  );
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.equal(avisos.filter((texto) => /artículos académicos no respondió \(OpenAlex respondió 429\)/.test(texto)).length, 1);
  assert.equal(conversacion.destinos.academico, false);
  assert.deepEqual(conversacion.aspectos, ["¿Cuánto cuesta?", "¿Y los riesgos?"]);
  const fuente = conversacion.fuentes.find((f) => f.url === "https://libros.test/1");
  assert.deepEqual(
    { tipo: fuente.tipo, fecha: fuente.fecha, aspectos: fuente.aspectos, notas: fuente.notas },
    { tipo: "libro", fecha: "2024", aspectos: [1], notas: "Dato útil." },
    "el tipo que da el buscador vale más que el del modelo",
  );
});

test("la revisión ve qué rindió cada búsqueda y la cobertura de cada subpregunta", () => {
  const conversacion = {
    tema: "Tema",
    consultas: ["costo solar", "papers perovskita", "sitio caído"],
    rendimiento: [
      { destino: "web", idioma: "es", nuevas: 8, leidas: 6 },
      { destino: "academico", idioma: "en", nuevas: 0, leidas: 0 },
      { destino: "sitios", nuevas: 0, leidas: 0, fallo: true },
    ],
    aspectos: ["¿Cuánto cuesta?", "¿Quién fabrica?"],
    fuentes: [
      { n: 1, titulo: "A", url: "https://a.test", notas: "Nota uno", tipo: "blog", fecha: "2021", aspectos: [1] },
      { n: 2, titulo: "B", url: "https://b.test", notas: "Nota dos", tipo: "oficial", fecha: "2025-03", aspectos: [1] },
      { n: 3, titulo: "C", url: "https://c.test", notas: "Nota tres" },
    ],
    idiomas: [{ codigo: "es", nombre: "español" }],
  };
  const texto = promptRevision(conversacion, { web: 4, sitios: 0, libres: 0 }).at(-1).content;
  assert.ok(texto.includes("- [web·es] costo solar → 6 útiles de 8 páginas nuevas"));
  assert.ok(texto.includes("- [academico·en] papers perovskita → sin páginas nuevas"));
  assert.ok(texto.includes("- [sitios] sitio caído → falló"));
  assert.ok(texto.includes("1. ¿Cuánto cuesta? — 2 fuentes, 1 oficiales, académicas o libros; la más reciente, de 2025-03"));
  assert.ok(texto.indexOf("[2] (oficial, 2025-03) Nota dos") < texto.indexOf("[1] (blog, 2021) Nota uno"));
  assert.ok(texto.includes("2. ¿Quién fabrica? — 0 fuentes"));
  assert.ok(texto.includes("Fuentes que no responden a ninguna subpregunta: 1"));
  assert.ok(texto.includes('"aspectos_nuevos"'));
});

test("si el filtro deja la ronda vacía se reintenta mostrando lo descartado; dos rondas así terminan", async () => {
  const revisiones = [];
  const buscadas = [];
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        const texto = mensajes.at(-1).content;
        if (!texto.includes('"completo"')) return { consultas: ["costo de instalación", "ahorro anual"] };
        revisiones.push(texto);
        // Insiste con lo mismo; solo en el primer reintento propone algo distinto.
        return revisiones.length === 2
          ? { completo: false, consultas: ["subsidios vigentes"] }
          : { completo: true, consultas: ["instalación costo", "anual ahorro"] };
      },
    },
    opciones: { ...OPCIONES, consultasIniciales: 2, consultasPorRonda: 2, rondasExtra: 10, minBusquedas: 20, maxBusquedas: 40 },
    buscar: async (consulta) => {
      buscadas.push(consulta);
      return { resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }] };
    },
    leerPagina: async () => assert.fail("no hace falta leer"),
  });
  const eventos = [];
  await investigador.investigar(crearConversacion("id", "ana", "Tema"), flujoDe(eventos));

  assert.deepEqual(buscadas, ["costo de instalación", "ahorro anual", "subsidios vigentes"]);
  assert.ok(!revisiones[0].includes("se descartaron"));
  assert.match(revisiones[1], /se descartaron por ser casi iguales[^]*- instalación costo\n- anual ahorro/);
  assert.equal(revisiones.length, 6, "ronda 1: dos pedidos; rondas 2 y 3: dos cada una, sin nada nuevo");
  assert.match(eventos.filter((e) => e.tipo === "aviso").at(-1).datos.texto, /ya no propone búsquedas distintas/);
});

test("papers tienen su propio tope, limitado por el saldo de hoy, y siguen cuando se acaba la web", async () => {
  const revisiones = [];
  const papers = [];
  const web = [];
  const temas = ["grafeno conductividad", "litio densidad", "sodio costo", "azufre ciclos"];
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        const texto = mensajes.at(-1).content;
        if (!texto.includes('"completo"')) {
          return { consultas: ["baterías panorama", "mercado actual"], dirigidas: [{ texto: temas[0], destino: "academico" }] };
        }
        revisiones.push(texto);
        return { completo: false, consultas: ["otra de la web"], dirigidas: [{ texto: temas[revisiones.length], destino: "academico" }] };
      },
    },
    opciones: {
      ...OPCIONES,
      consultasIniciales: 2,
      consultasPorRonda: 2,
      rondasExtra: 10,
      maxBusquedas: 2,
      maxAcademicas: 50,
      academicasIniciales: 1,
      academicasPorRonda: 1,
    },
    saldoAcademico: async () => ({ busquedas: 3, renuevaEnSegundos: 7200 }),
    buscar: async (consulta) => {
      web.push(consulta);
      return { resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }] };
    },
    buscarAcademico: async (consulta) => {
      papers.push(consulta);
      return { resultados: [{ titulo: consulta, url: `https://doi.org/${encodeURIComponent(consulta)}`, contenido: LARGO }] };
    },
    leerPagina: async () => assert.fail("no hace falta leer"),
  });
  const eventos = [];
  await investigador.investigar(crearConversacion("id", "ana", "Pregunta: baterías\nFuentes: papers"), flujoDe(eventos));

  assert.deepEqual(web, ["baterías panorama", "mercado actual"], "la web no pasa de su tope");
  assert.deepEqual(papers, temas.slice(0, 3), "papers sigue hasta agotar el saldo de hoy");
  assert.ok(revisiones[0].includes("ya no quedan búsquedas web"));
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.match(avisos[0], /hasta 3 búsquedas, aparte de las de la web \(hoy quedan 3 en OpenAlex\)/);
  assert.equal(avisos.at(-1), "Se usaron las 2 búsquedas previstas y 3 de papers y libros: redacto con lo encontrado.");
});

test("sin saldo en OpenAlex se avisa y las consultas de papers se hacen en la web", async () => {
  const web = [];
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) =>
        mensajes.at(-1).content.includes('"completo"')
          ? { completo: true }
          : { consultas: ["panorama general"], dirigidas: [{ texto: "estudio revisado", destino: "academico" }] },
    },
    opciones: { ...OPCIONES, consultasIniciales: 3, maxBusquedas: 40, maxAcademicas: 500 },
    saldoAcademico: async () => ({ busquedas: 0, renuevaEnSegundos: 36000 }),
    buscar: async (consulta) => {
      web.push(consulta);
      return { resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }] };
    },
    buscarAcademico: async () => assert.fail("sin saldo no se consulta OpenAlex"),
    leerPagina: async () => assert.fail("no hace falta leer"),
  });
  const eventos = [];
  await investigador.investigar(crearConversacion("id", "ana", "Pregunta: algo\nFuentes: Google Scholar"), flujoDe(eventos));

  assert.deepEqual(web, ["panorama general", "estudio revisado"]);
  assert.equal(
    eventos.find((e) => e.tipo === "aviso").datos.texto,
    "Hoy no quedan búsquedas de papers ni de libros en OpenAlex (se renuevan en unas 10 h): esta investigación usa solo la web.",
  );
});
