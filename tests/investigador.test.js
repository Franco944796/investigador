import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consultasDe,
  crearConversacion,
  crearInvestigador,
  interpretarNotas,
  parecidas,
  porTurnos,
  leerUbicacion,
  seccionesConFuentes,
  seccionesPropuestas,
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
});

test("secciones: las fuentes van a donde las ubicó el modelo; las grandes se parten y las sueltas van a Otros hallazgos", () => {
  const propuestas = seccionesPropuestas([
    { titulo: "Grande", enfoque: "a" },
    { titulo: "Chica", enfoque: "b" },
    { titulo: "" },
    { titulo: "Otros hallazgos" },
  ]);
  assert.deepEqual(propuestas.map((s) => s.titulo), ["Grande", "Chica"]);
  const ubicacion = new Map();
  // Respuesta con formatos mezclados: lista, número suelto, 0, fuera de rango, repetidos y una sin mencionar.
  const respuesta = { fuentes: { 1: [1, 2, 2], 2: 2, 3: [0], 4: [7], 5: [1, 2, 1] } };
  leerUbicacion(respuesta, [1, 2, 3, 4, 5, 6], 2, ubicacion);
  assert.deepEqual([...ubicacion], [[1, [1, 2]], [2, [2]], [3, []], [4, []], [5, [1, 2]]]);
  for (let n = 7; n <= 130; n++) ubicacion.set(n, [1]);
  const secciones = seccionesConFuentes(propuestas, ubicacion, 130);
  assert.deepEqual(
    secciones.map((s) => [s.titulo, s.fuentes.length]),
    [
      ["Grande (parte 1 de 3)", 42],
      ["Grande (parte 2 de 3)", 42],
      ["Grande (parte 3 de 3)", 42],
      ["Chica", 3],
      ["Otros hallazgos", 3],
    ],
  );
  assert.deepEqual(secciones.at(-2).fuentes, [1, 2, 5]);
  assert.deepEqual(secciones.at(-1).fuentes, [3, 4, 6], "0, fuera de rango y sin mencionar");
});

test("informe: las fuentes se ubican por tandas; las salteadas se piden otra vez; si no entra, se resume cada sección", async () => {
  const ubicar = [];
  const resumenesPedidos = [];
  let cierre = "";
  const largo = "x".repeat(90000);
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        const texto = mensajes.at(-1).content;
        if (texto.includes('"secciones"')) {
          return { titulo: "T", secciones: [{ titulo: "Costos", enfoque: "a" }, { titulo: "Usos", enfoque: "b" }] };
        }
        if (texto.includes("Ubica cada fuente")) {
          const numeros = [...texto.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
          ubicar.push(numeros);
          // La primera vez saltea la 3; la segunda la ubica.
          return { fuentes: Object.fromEntries(numeros.filter((n) => ubicar.length > 1 || n !== 3).map((n) => [n, [n % 2 ? 1 : 2]])) };
        }
        return { consultas: ["consulta"] };
      },
      completar: async (mensajes) => {
        const texto = mensajes.at(-1).content;
        if (texto.includes("Te toca la sección")) {
          const fuentes = [...texto.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]).join(",");
          return `## ${texto.match(/sección \d+: "([^"]+)"/)[1]}\n\nFuentes ${fuentes} [1]. ${largo}`;
        }
        if (texto.includes("Resume esta sección")) {
          resumenesPedidos.push(texto.match(/Fuentes ([\d,]+)/)[1]);
          return `Resumen de ${texto.match(/## (\w+)/)[1]} [1].`;
        }
        if (texto.includes("comienzo del informe")) return "# T\n\n## Resumen\n\nHallazgos [1].";
        if (texto.includes("cierre del informe")) {
          cierre = texto;
          return "## Conclusiones\n\nConviene [1].";
        }
        return "Notas útiles.";
      },
    },
    opciones: { ...OPCIONES, resultadosPorConsulta: 4, informePorSecciones: true },
    buscar: async () => ({
      resultados: [1, 2, 3, 4].map((n) => ({ titulo: `F${n}`, url: `https://a.test/${n}`, contenido: LARGO })),
    }),
    leerPagina: async () => assert.fail("no hace falta leer"),
  });
  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, flujoDe(eventos));

  assert.deepEqual(ubicar, [[1, 2, 3, 4], [3]]);
  assert.deepEqual(resumenesPedidos, ["1,3", "2,4"], "Costos: 1 y 3 (la que faltaba); Usos: 2 y 4");
  assert.ok(cierre.includes("Resumen de cada sección del informe"));
  assert.ok(cierre.includes("## Costos\n\nResumen de Costos [1]."));
  assert.ok(!cierre.includes(largo), "el cierre no recibe el texto completo");
  const etapas = eventos.filter((e) => e.tipo === "etapa").map((e) => e.datos.texto);
  assert.ok(etapas.includes("Ubicando las fuentes en las secciones (tanda 1 de 1)"));
  assert.ok(etapas.includes("Ubicando las fuentes en las secciones (tanda 1 de 1, las que faltaban)"));
  assert.ok(etapas.includes("Resumiendo cada sección para el resumen y las conclusiones"));
});

test("exhaustiva: busca en varios idiomas y escribe el informe por secciones", async () => {
  const pedidos = [];
  const llm = {
    completarJSON: async (mensajes) => {
      const texto = mensajes.at(-1).content;
      pedidos.push(texto);
      if (texto.includes('"secciones"')) {
        return { titulo: "Informe solar", secciones: [{ titulo: "Costos", enfoque: "precios" }] };
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
  assert.ok(etapas.includes("Redactando el informe (sección 1 de 1)"), "con una sola sección, todas las fuentes van ahí");

  const titulos = conversacion.informe.match(/^#{1,2} .+$/gm);
  assert.deepEqual(titulos, [
    "# Informe solar",
    "## Resumen",
    "## Costos",
    "## Conclusiones",
    "## Fuentes",
  ]);
  const textos = eventos.filter((e) => e.tipo === "texto").map((e) => e.datos.delta);
  assert.equal(textos.join(""), conversacion.informe, "lo mostrado coincide con lo guardado");
});

test("pasado el mínimo, la web termina tras N búsquedas seguidas sin aporte; las sin acceso reinician la cuenta", async () => {
  // Qué trae cada búsqueda: q0 aporta; r1 y r2 no (pero todavía no se llegó al mínimo de 4);
  // r3 solo trae una página sin acceso (reinicia); r4 no aporta; r5 da error al leer (cuenta) → corta.
  const paginas = { q0: "util", r1: "nada-1", r2: "nada-2", r3: "muro", r4: "nada-3", r5: "caida", r6: "util-2" };
  const buscadas = [];
  let revisiones = 0;
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        if (!mensajes.at(-1).content.includes("La investigación sigue")) return { consultas: ["q0"] };
        revisiones++;
        return { consultas: [`r${revisiones}`] };
      },
      completar: async (mensajes) => {
        const texto = mensajes.at(-1).content;
        if (texto.includes("a.test/nada")) return "IRRELEVANTE";
        return texto.includes("a.test/muro") ? "SIN ACCESO" : "Notas útiles.";
      },
    },
    opciones: {
      ...OPCIONES,
      consultasIniciales: 1,
      consultasPorRonda: 1,
      resultadosPorConsulta: 1,
      rondasExtra: 20,
      maxBusquedas: 40,
      minBusquedas: 4,
      busquedasSinAporte: 2,
    },
    buscar: async (consulta) => {
      buscadas.push(consulta);
      const nombre = paginas[consulta];
      return {
        resultados: [{ titulo: nombre, url: `https://a.test/${nombre}`, ...(nombre !== "caida" && { contenido: LARGO }) }],
      };
    },
    leerPagina: async () => {
      throw new Error("respondió 403");
    },
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, flujoDe(eventos));

  assert.deepEqual(buscadas, ["q0", "r1", "r2", "r3", "r4", "r5"]);
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.deepEqual(avisos, [
    "Las últimas 2 búsquedas web no aportaron información nueva (van 6).",
    "Búsqueda terminada (6 búsquedas web): redacto con lo encontrado.",
  ]);
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
        if (!mensajes.at(-1).content.includes("La investigación sigue")) return { consultas: ["a", "b"] };
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
  assert.match(eventos.find((e) => e.tipo === "aviso").datos.texto, /las 6 búsquedas web previstas/);
});

test("sitios y papers: cada uno con su cupo; los sitios se dejan sin páginas nuevas, los papers no", async () => {
  const web = [];
  const enSitios = [];
  const academicas = [];
  const revisiones = [];
  const llm = {
    ...llmFijo,
    completarJSON: async (mensajes) => {
      const texto = mensajes.at(-1).content;
      if (texto.includes("La investigación sigue")) {
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

  // Cada ronda pide el resto del cupo una vez (r2, r4, r6 son esos pedidos).
  assert.deepEqual(web, ["web 1", "web 2", "web r1", "web r3", "web r4", "web r5", "web r6"]);
  // Sin destino indicado, las dirigidas se turnan entre papers y sitios; agotados los sitios, van a papers.
  // Aunque siempre traen el mismo paper, siguen: solo los corta una racha larga sin aporte.
  assert.deepEqual(academicas, ["paper 1", "dirigida r1", "dirigida r3", "dirigida r4", "dirigida r5", "dirigida r6"]);
  assert.deepEqual(enSitios, ["sitio 1", "web r2"], "una web que sobra completa el cupo de los sitios");
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.equal(avisos[0], "La mitad de las búsquedas web va a: who.int.");
  assert.match(avisos[1], /^Además busco artículos académicos \(OpenAlex, en lugar de Google Scholar\): hasta/);
  assert.ok(avisos.some((texto) => /sitios indicados ya no traen resultados nuevos/.test(texto)));
  assert.ok(!avisos.some((texto) => /Papers y libros ya no traen/.test(texto)));
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
        mensajes.at(-1).content.includes("La investigación sigue")
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

test("cada ronda pide llenar el cupo; si el modelo deja menos de 3/4, pide lo que falta", async () => {
  const pedidos = [];
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        const texto = mensajes.at(-1).content;
        if (!texto.includes("La investigación sigue")) return { consultas: ["a", "b"] };
        assert.ok(!texto.includes('"completo"'), "el modelo ya no decide cuándo termina");
        const pedidas = Number(texto.match(/exactamente (\d+) consultas nuevas para la web/)[1]);
        pedidos.push(pedidas);
        // La primera vez de cada ronda propone una sola; la segunda, todas las que le piden.
        const cuantas = pedidos.length % 2 ? 1 : pedidas;
        // Textos sin palabras en común, para que el filtro de casi iguales no descarte ninguna.
        return { consultas: Array.from({ length: cuantas }, (_, i) => `tema${pedidos.length}x${i} detalle${pedidos.length}y${i}`) };
      },
    },
    opciones: { ...OPCIONES, consultasIniciales: 2, consultasPorRonda: 4, rondasExtra: 10, maxBusquedas: 10 },
    buscar: async (consulta) => ({
      resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }],
    }),
    leerPagina: async () => assert.fail("no hace falta leer"),
  });
  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, flujoDe(eventos));
  assert.deepEqual(pedidos, [4, 3, 4, 3]);
  assert.equal(conversacion.consultas.length, 10);
  assert.equal(eventos.find((e) => e.tipo === "aviso").datos.texto, "Se usaron las 10 búsquedas web previstas.");
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
        if (mensajes.at(-1).content.includes("La investigación sigue")) {
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

  assert.deepEqual(
    enSitios,
    ["informe de mercado", "fabricantes líderes"],
    "la de site: va al sitio aunque dijera academico; una web que sobra completa el cupo de los sitios",
  );
  assert.deepEqual(libros, ["historia de la energía"]);
  assert.deepEqual(
    web,
    ["costo general", "panorama mundial", "paper uno", "precios regionales", "perovskita estabilidad", "tándem eficiencia"],
    "sin la casi repetida; las de papers van a la web cuando OpenAlex falla",
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
        if (!texto.includes("La investigación sigue")) return { consultas: ["costo de instalación", "ahorro anual"] };
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
        if (!texto.includes("La investigación sigue")) {
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
    // Como el de verdad: lo que queda baja con cada búsqueda.
    saldoAcademico: async () => ({ busquedas: 3 - papers.length, renuevaEnSegundos: 7200 }),
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
  assert.ok(revisiones[0].includes("en esta ronda no van más consultas web"));
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.match(avisos[0], /hasta 3 búsquedas, aparte de las de la web \(hoy quedan 3 en OpenAlex\)/);
  assert.deepEqual(avisos.slice(1), [
    "Se usaron las 2 búsquedas web previstas: sigo solo con papers y libros.",
    "Se usaron las 3 búsquedas de papers y libros que permitía el saldo de hoy de OpenAlex.",
    "Búsqueda terminada (2 búsquedas web y 3 de papers y libros): redacto con lo encontrado.",
  ]);
});

test("sin saldo en OpenAlex se avisa y las consultas de papers se hacen en la web", async () => {
  const web = [];
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) =>
        mensajes.at(-1).content.includes("La investigación sigue")
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

test("las páginas sin acceso o que no se pudieron leer quedan para revisar a mano", async () => {
  const paginas = ["util", "ficha-1", "bloqueada", "ficha-2", "ficha-3", "ficha-4", "otra-util"];
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) =>
        mensajes.at(-1).content.includes("La investigación sigue") ? { completo: true } : { consultas: ["consulta"] },
      completar: async (mensajes) =>
        mensajes.at(-1).content.includes("a.test/ficha") ? "SIN ACCESO" : "Notas útiles.",
    },
    opciones: { ...OPCIONES, resultadosPorConsulta: 10, tareasEnParalelo: 1 },
    buscar: async () => ({
      resultados: paginas.map((nombre) => ({
        titulo: `Página [${nombre}]`,
        url: `https://a.test/${nombre}`,
        ...(nombre !== "bloqueada" && { contenido: LARGO }),
      })),
    }),
    leerPagina: async () => {
      throw new Error("respondió 403");
    },
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, flujoDe(eventos));

  assert.equal(conversacion.fuentes.length, 2);
  assert.ok(!eventos.some((e) => e.tipo === "aviso"));
  const descartadas = eventos.filter((e) => e.tipo === "fuente" && e.datos.estado === "descartada");
  assert.ok(descartadas.every((e) => e.datos.revisar === true));
  assert.deepEqual(
    conversacion.pendientes.map((pendiente) => pendiente.motivo),
    ["sin acceso al contenido", "respondió 403", "sin acceso al contenido", "sin acceso al contenido", "sin acceso al contenido"],
  );
  assert.deepEqual(conversacion.pendientes[0], {
    url: "https://a.test/ficha-1",
    titulo: "Página [ficha-1]",
    motivo: "sin acceso al contenido",
  });
  assert.ok(!conversacion.informe.includes("revisar a mano"), "ya no van en el informe ni en el PDF");
  assert.equal(conversacion.fuentesEnInforme, 2);
});

// Lo que se guarda en la base y vuelve tras un reinicio (ver aRegistro en src/app.js).
function recargada(conversacion) {
  const { fuentes, consultas, vistas, candidatas, aspectos, pendientes, rendimiento, destinos, idiomas, progreso } =
    conversacion;
  const datos = JSON.parse(
    JSON.stringify({ fuentes, consultas, vistas: [...vistas], candidatas, aspectos, pendientes, rendimiento, destinos, idiomas, progreso }),
  );
  return Object.assign(crearConversacion(conversacion.id, conversacion.dueno, conversacion.tema), datos, {
    vistas: new Set(datos.vistas),
  });
}

test("retomar: una investigación cortada sigue sin planificar de nuevo, sin repetir búsquedas y dentro del tope", async () => {
  const buscadas = [];
  let planes = 0;
  let revisiones = 0;
  let cortar = true;
  const control = new AbortController();
  const crear = () =>
    crearInvestigador({
      llm: {
        ...llmFijo,
        completarJSON: async (mensajes) => {
          if (!mensajes.at(-1).content.includes("La investigación sigue")) {
            planes++;
            return { consultas: ["alfa uno", "beta dos"] };
          }
          revisiones++;
          return { consultas: [`tema${revisiones}a detalle${revisiones}a`, `tema${revisiones}b detalle${revisiones}b`] };
        },
      },
      opciones: { ...OPCIONES, consultasIniciales: 2, consultasPorRonda: 2, rondasExtra: 10, maxBusquedas: 8, resultadosPorConsulta: 1 },
      buscar: async (consulta) => {
        buscadas.push(consulta);
        if (cortar && buscadas.length === 5) {
          control.abort();
          throw new Error("se reinició el servidor");
        }
        return { resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }] };
      },
      leerPagina: async () => assert.fail("no hace falta leer"),
    });
  const conversacion = crearConversacion("id", "ana", "Tema");
  await assert.rejects(crear().investigar(conversacion, { emitir: () => {}, signal: control.signal }));
  assert.equal(conversacion.progreso.planificada, true);
  assert.equal(conversacion.progreso.buscada, false);

  cortar = false;
  const eventos = [];
  const retomada = recargada(conversacion);
  await crear().investigar(retomada, flujoDe(eventos), { retomar: true });

  assert.equal(planes, 1, "no se vuelve a planificar");
  assert.equal(buscadas.length, 8, "lo hecho antes del corte cuenta para el tope");
  assert.equal(new Set(buscadas).size, 8, "ninguna búsqueda se repite");
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.match(avisos[0], /^Retomo la investigación desde lo último guardado: \d+ búsquedas web y \d+ fuentes leídas\.$/);
  assert.ok(retomada.informe.startsWith("# Informe"));
  assert.equal(retomada.progreso.buscada, true);
});

test("retomar: si ya había terminado de buscar, solo vuelve a redactar", async () => {
  const conversacion = crearConversacion("id", "ana", "Tema");
  conversacion.fuentes.push({ n: 1, url: "https://a.test/1", titulo: "Uno", notas: "Dato." });
  conversacion.rendimiento = [{ texto: "consulta", destino: "web", nuevas: 1, leidas: 1, sinAcceso: 0 }];
  conversacion.destinos = { dominios: [], academico: false, libros: false };
  conversacion.progreso = {
    planificada: true,
    buscada: true,
    ronda: 3,
    rondasVacias: 0,
    tandasLibresVacias: 0,
    sinAporte: { pagas: 0, libres: 0 },
    terminados: [],
  };
  const eventos = [];
  const investigador = crearInvestigador({
    llm: { ...llmFijo, completarJSON: async () => assert.fail("no se planifica ni se revisa") },
    opciones: OPCIONES,
    buscar: async () => assert.fail("no se busca"),
    leerPagina: async () => assert.fail("no se lee"),
  });
  await investigador.investigar(recargada(conversacion), flujoDe(eventos), { retomar: true });
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.deepEqual(avisos, [
    "Retomo la investigación: las búsquedas ya estaban terminadas (1 búsqueda web); vuelvo a redactar el informe (1 fuente leída).",
  ]);
  assert.ok(eventos.some((e) => e.tipo === "texto"));
});

test("si el saldo de OpenAlex se renueva a mitad de la investigación, sigue con papers hasta el tope", async () => {
  const papers = [];
  let revisiones = 0;
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        if (!mensajes.at(-1).content.includes("La investigación sigue")) {
          return { consultas: ["uno web", "dos web"], dirigidas: [{ texto: "tema0x detalle0y", destino: "academico" }] };
        }
        revisiones++;
        return { consultas: [], dirigidas: [{ texto: `tema${revisiones}x detalle${revisiones}y`, destino: "academico" }] };
      },
    },
    opciones: {
      ...OPCIONES,
      consultasIniciales: 2,
      rondasExtra: 20,
      maxBusquedas: 2,
      maxAcademicas: 5,
      academicasIniciales: 1,
      academicasPorRonda: 1,
    },
    // Quedan 2 en el día; al gastarlas, se renueva con 10.
    saldoAcademico: async () =>
      papers.length >= 2 ? { busquedas: 10 - (papers.length - 2) } : { busquedas: 2 - papers.length },
    buscar: async (consulta) => ({
      resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }],
    }),
    buscarAcademico: async (consulta) => {
      papers.push(consulta);
      return { resultados: [{ titulo: consulta, url: `https://doi.org/${encodeURIComponent(consulta)}`, contenido: LARGO }] };
    },
    leerPagina: async () => assert.fail("no hace falta leer"),
  });
  const eventos = [];
  await investigador.investigar(crearConversacion("id", "ana", "Pregunta: x\nFuentes: papers"), flujoDe(eventos));
  assert.equal(papers.length, 5, "llega al tope aunque al empezar solo quedaban 2");
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.ok(avisos.includes("Se renovó el saldo de OpenAlex: sigo con papers y libros (hoy quedan 10)."));
  assert.ok(avisos.some((texto) => /^Se usaron las 5 búsquedas de papers y libros previstas/.test(texto)));
});

test("papers: se dejan solo tras N búsquedas seguidas sin aporte, sin mínimo", async () => {
  const papers = [];
  let revisiones = 0;
  const investigador = crearInvestigador({
    llm: {
      ...llmFijo,
      completarJSON: async (mensajes) => {
        if (!mensajes.at(-1).content.includes("La investigación sigue")) {
          return { consultas: ["uno web"], dirigidas: [{ texto: "tema0x detalle0y", destino: "academico" }] };
        }
        revisiones++;
        return { consultas: [], dirigidas: [{ texto: `tema${revisiones}x detalle${revisiones}y`, destino: "academico" }] };
      },
      completar: async (mensajes) =>
        mensajes.at(-1).content.includes("doi.org/vacio") ? "IRRELEVANTE" : "Notas útiles.",
    },
    opciones: {
      ...OPCIONES,
      consultasIniciales: 1,
      rondasExtra: 30,
      maxBusquedas: 1,
      maxAcademicas: 50,
      academicasIniciales: 1,
      academicasPorRonda: 1,
      papersSinAporte: 3,
    },
    buscar: async (consulta) => ({
      resultados: [{ titulo: consulta, url: `https://a.test/${encodeURIComponent(consulta)}`, contenido: LARGO }],
    }),
    // Los dos primeros aportan; después ninguno.
    buscarAcademico: async (consulta) => {
      papers.push(consulta);
      const url = papers.length <= 2 ? `https://doi.org/${papers.length}` : `https://doi.org/vacio-${papers.length}`;
      return { resultados: [{ titulo: consulta, url, contenido: LARGO }] };
    },
    leerPagina: async () => assert.fail("no hace falta leer"),
  });
  const eventos = [];
  await investigador.investigar(crearConversacion("id", "ana", "Pregunta: x\nFuentes: papers"), flujoDe(eventos));
  assert.equal(papers.length, 5, "2 que aportan + 3 seguidas sin aporte");
  const avisos = eventos.filter((e) => e.tipo === "aviso").map((e) => e.datos.texto);
  assert.ok(avisos.includes("Las últimas 3 búsquedas de papers y libros no aportaron información nueva (van 5)."));
});

test("enlaces caídos: se usa otro enlace vivo de la misma obra o la fuente se descarta sin quedar para revisar", async () => {
  const comprobados = [];
  const investigador = crearInvestigador({
    llm: llmFijo,
    opciones: OPCIONES,
    buscar: async () => ({
      motor: "simulado",
      resultados: [
        {
          titulo: "Paper con DOI caído",
          url: "https://doi.test/caido",
          alternativas: ["https://repo.test/caido", "https://repo.test/vivo"],
          contenido: "x".repeat(500),
        },
        { titulo: "Página borrada", url: "https://web.test/borrada", contenido: "x".repeat(500) },
        {
          titulo: "Lectura con 404",
          url: "https://web.test/404",
          alternativas: ["https://repo.test/otra"],
          resumen: "r".repeat(500),
        },
      ],
    }),
    leerPagina: async (url) => {
      if (url.endsWith("/404")) throw Object.assign(new Error("respondió 404"), { caido: true });
      return { titulo: "Otra", texto: "texto de la otra copia" };
    },
    enlaceVivo: async (url) => {
      comprobados.push(url);
      return url.startsWith("https://repo.test/") && !url.endsWith("/caido");
    },
  });

  const eventos = [];
  const conversacion = crearConversacion("id", "ana", "Tema");
  await investigador.investigar(conversacion, flujoDe(eventos));

  assert.deepEqual(conversacion.fuentes.map((fuente) => fuente.url).sort(), [
    "https://repo.test/otra",
    "https://repo.test/vivo",
  ]);
  assert.ok(!comprobados.includes("https://web.test/404"), "lo que ya dio 404 al leer no se vuelve a probar");
  const descartadas = eventos.filter((e) => e.tipo === "fuente" && e.datos.estado === "descartada");
  assert.deepEqual(descartadas.map((e) => [e.datos.motivo, e.datos.revisar]), [["el enlace ya no existe", undefined]]);
  assert.equal(conversacion.pendientes, undefined);
});
