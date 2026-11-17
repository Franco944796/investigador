import { ErrorFormato, ErrorLLM } from "./llm.js";
import { direccionCorta, tituloLegible } from "../public/direcciones.js";
import { graficoValido } from "../public/graficos.js";
import { seleccionarPasajes, terminosDe } from "./pasajes.js";
import {
  MAX_CUERPO,
  promptConclusiones,
  promptDecision,
  promptIndice,
  promptInforme,
  promptNotas,
  promptPlan,
  promptResumen,
  promptResumenDeSeccion,
  promptRevision,
  promptSeccion,
  promptSeguimiento,
  promptUbicar,
} from "./prompts.js";

export class ErrorInvestigacion extends Error {}

const PARAMETROS_DE_RASTREO = /^(utm_\w+|fbclid|gclid|mc_[ce]id|ref)$/i;
const MINIMO_CONTENIDO = 200;
// Los resúmenes de DuckDuckGo (una o dos líneas) no alcanzan; los de Tavily sí.
const MINIMO_RESUMEN = 400;
// Tope de lo que se pide al lector propio antes de elegir pasajes (ya corta a 2 MB de descarga).
const MAXIMO_LEIDO = 600000;
const NOMBRES_DE_DESTINOS = { academico: "artículos académicos", libros: "libros" };
const MAX_ASPECTOS = 15;
const NO_APORTA = "no aporta al tema";
const SIN_ACCESO = "sin acceso al contenido";

export function normalizarUrl(direccion) {
  let url;
  try {
    url = new URL(direccion);
  } catch {
    return null;
  }
  url.hash = "";
  for (const nombre of [...url.searchParams.keys()]) {
    if (PARAMETROS_DE_RASTREO.test(nombre)) url.searchParams.delete(nombre);
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

async function enParalelo(elementos, limite, tarea) {
  const pendientes = elementos.entries();
  const trabajador = async () => {
    for (const [indice, elemento] of pendientes) await tarea(elemento, indice);
  };
  await Promise.all(Array.from({ length: Math.min(limite, elementos.length) }, trabajador));
}

const sinTildes = (texto) =>
  String(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const DESTINOS = new Set(["academico", "libros", "sitios"]);
const NO_SON_DOMINIOS = new Set(["js", "ts", "py", "md", "txt", "pdf", "html", "css", "json", "csv"]);

function dominioDe(valor) {
  const dominio = String(valor)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#\s,;:)\]]/)[0];
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(dominio)) return null;
  if (NO_SON_DOMINIOS.has(dominio.split(".").at(-1)) || /(^|\.)scholar\.google\./.test(dominio)) {
    return null;
  }
  return dominio;
}

const cuantas = (n, una, varias) => `${n} ${n === 1 ? una : varias}`;
const busquedasHechas = (pagas, libres) =>
  `${cuantas(pagas, "búsqueda web", "búsquedas web")}${libres ? ` y ${libres} de papers y libros` : ""}`;

const esLibre = (destino) => destino === "academico" || destino === "libros";
const claseDe = (destino) => (esLibre(destino) ? "libres" : destino === "sitios" ? "sitios" : "web");

// Las consultas llegan como textos o como {idioma, texto, destino, reciente}. `aniosDelPedido`
// son los años que nombra el pedido: esos no se tocan.
export function consultasDe(valor, aniosDelPedido = new Set()) {
  if (!Array.isArray(valor)) return [];
  const vistas = new Set();
  return valor.flatMap((consulta) => {
    const crudo = typeof consulta === "string" ? consulta : consulta?.texto;
    if (typeof crudo !== "string") return [];
    // «site:iea.org costos» no devuelve nada en un buscador de papers o de libros: el sitio se
    // saca del texto y pasa a ser el filtro de esa búsqueda.
    const dominios = [...crudo.matchAll(/\bsite:(\S+)/gi)]
      .map(([, sitio]) => dominioDe(sitio))
      .filter(Boolean);
    let texto = crudo
      .replace(/\bsite:\S+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Los modelos le pegan un año reciente a casi todas las consultas aunque se les pida que no
    // (59 de 67 en una prueba), y eso angosta la búsqueda: se quita y se pide «lo reciente». Se
    // respetan los años que nombra el pedido (salvo el año en curso) y los rangos históricos.
    let reciente = consulta?.reciente === true;
    const actual = new Date().getFullYear();
    const anios = (texto.match(/\b(19|20)\d\d\b/g) ?? []).map(Number);
    const sobran = anios.filter(
      (anio) => anio >= actual - 3 && (anio === actual || !aniosDelPedido.has(anio)),
    );
    if (sobran.length && sobran.length === anios.length) {
      const sinAnios = texto
        .replace(/\b(19|20)\d\d\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (sinAnios.length >= 6) {
        texto = sinAnios;
        reciente = true;
      }
    }
    if (!texto || vistas.has(texto)) return [];
    vistas.add(texto);
    const idioma = typeof consulta?.idioma === "string" ? consulta.idioma.trim().toLowerCase() : "";
    const pedido = sinTildes(consulta?.destino ?? "");
    const destino = dominios.length ? "sitios" : DESTINOS.has(pedido) ? pedido : "";
    return [
      {
        texto,
        ...(idioma && { idioma }),
        ...(destino && { destino }),
        ...(dominios.length && { dominios }),
        ...(reciente && { reciente: true }),
      },
    ];
  });
}

const ANIO = /^(19|20)\d\d$/;
const clavesDe = (texto) => new Set([...terminosDe(texto)].filter((termino) => !ANIO.test(termino)));

// Dos consultas que comparten casi todas las palabras traen las mismas páginas: gastar una
// búsqueda en la segunda no suma (en una prueba real, el mismo dato se buscó cinco veces).
export function parecidas(una, otra) {
  const [a, b] = [clavesDe(una), clavesDe(otra)];
  if (a.size < 2 || b.size < 2) return sinTildes(una).trim() === sinTildes(otra).trim();
  let comunes = 0;
  for (const termino of a) if (b.has(termino)) comunes++;
  return comunes / (a.size + b.size - comunes) >= 0.6;
}

const TIPOS = {
  oficial: "oficial",
  academico: "académico",
  prensa: "prensa",
  empresa: "empresa",
  blog: "blog",
  foro: "foro",
  libro: "libro",
  otro: "otro",
};

// Las notas llegan con un encabezado (Fecha, Tipo, Aspectos) antes del texto; si el modelo no lo
// pone, todo es texto.
export function interpretarNotas(respuesta) {
  const lineas = respuesta.split("\n");
  const campos = {};
  let inicio = 0;
  for (; inicio < lineas.length; inicio++) {
    if (!lineas[inicio].trim()) continue;
    const campo = lineas[inicio].match(/^\W*(fecha|tipo|aspectos|notas)\W*:\W*(.*)$/i);
    if (!campo) break;
    if (campo[1].toLowerCase() === "notas") {
      lineas[inicio] = campo[2];
      break;
    }
    campos[campo[1].toLowerCase()] = campo[2];
  }
  // «marzo de 2025 (2025-03)»: de las fechas que haya, la más precisa.
  const fecha = (campos.fecha?.match(/\b(19|20)\d\d(-\d\d){0,2}\b/g) ?? []).sort(
    (a, b) => b.length - a.length,
  )[0];
  const tipo = Object.keys(TIPOS).find((clave) => sinTildes(campos.tipo ?? "").includes(clave));
  return {
    notas: lineas.slice(inicio).join("\n").trim(),
    aspectos: [...new Set([...(campos.aspectos ?? "").matchAll(/\d+/g)].map(Number))],
    ...(fecha && { fecha }),
    ...(tipo && { tipo: TIPOS[tipo] }),
  };
}

// Del pedido, lo que describe qué se busca (sin lo que pide excluir ni el formato de entrega).
const terminosDelTema = (tema) =>
  terminosDe(
    tema
      .split("\n")
      .filter((linea) => !/^\s*(excluir|entrega|fuentes)\s*:/i.test(linea))
      .join(" ")
      .replace(/\b(pregunta|contexto|aspectos)\s*:/gi, " "),
  );

const NOMBRES_DE_IDIOMAS = new Intl.DisplayNames(["es"], { type: "language", fallback: "code" });

function nombreDeIdioma(codigo) {
  try {
    return NOMBRES_DE_IDIOMAS.of(codigo);
  } catch {
    return codigo;
  }
}

export function idiomasDe(valor, consultas) {
  const idiomas = (Array.isArray(valor) ? valor : []).flatMap((idioma) => {
    const codigo = typeof idioma?.codigo === "string" ? idioma.codigo.trim().toLowerCase() : "";
    const nombre = typeof idioma?.nombre === "string" ? idioma.nombre.trim() : "";
    return codigo ? [{ codigo, nombre: nombre || nombreDeIdioma(codigo) }] : [];
  });
  for (const { idioma } of consultas) {
    if (idioma && !idiomas.some((conocido) => conocido.codigo === idioma)) {
      idiomas.push({ codigo: idioma, nombre: nombreDeIdioma(idioma) });
    }
  }
  return idiomas;
}

// Google Scholar no se puede consultar: estas pistas activan el buscador académico (OpenAlex).
const ACADEMICO =
  /scholar|openalex|acad[eé]mic|cient[ií]fic|\bpapers?\b|\bjournals?\b|revistas? (cient|indexad|acad)|peer[\s-]?review/i;
const LIBROS = /\blibros?\b|bibliotecas?|bibliograf[ií]a|monograf[ií]as?|\bbooks?\b/i;
const MAX_DOMINIOS = 10;

// Sitios y fuentes académicas que pide el campo «Fuentes» (o todo el pedido, si no lo usa).
// `sugeridos` son los dominios que el modelo dedujo de nombres («la OMS» → who.int).
export function destinosDe(tema, sugeridos = []) {
  const texto = tema.match(/^\s*fuentes\s*:(.*)$/im)?.[1] ?? tema;
  const dominios = new Set();
  const agregar = (valor) => {
    const dominio = dominioDe(valor);
    if (dominio) dominios.add(dominio);
  };
  for (const [encontrado] of texto.matchAll(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\S*/gi)) {
    agregar(encontrado);
  }
  for (const sugerido of Array.isArray(sugeridos) ? sugeridos : []) agregar(sugerido);
  return {
    dominios: [...dominios].slice(0, MAX_DOMINIOS),
    academico: ACADEMICO.test(texto),
    libros: LIBROS.test(texto),
  };
}

// Los sitios que ya no traen páginas nuevas dejan de recibir dirigidas: su cupo es 0 y se perdían.
const activos = ({ academico, dominios, libros, sitiosAgotados }) =>
  [academico && "academico", dominios.length && !sitiosAgotados && "sitios", libros && "libros"].filter(
    Boolean,
  );

// Cada consulta dirigida va a donde el modelo la pensó (papers, libros o sitios). Solo si no lo
// dijo, o eligió un destino que no está activo, se reparten por turno: repartir todas por turno
// mandaba consultas de un sitio al buscador de papers, que no devolvía nada.
function conDestino(consultas, conversacion) {
  const lista = activos(conversacion.destinos);
  return consultas.flatMap((consulta) => {
    if (consulta.dominios || lista.includes(consulta.destino)) return [consulta];
    // Pensada para un buscador que no está activo (o que dejó de responder): va a la web.
    if (consulta.destino || !lista.length) return [sinDestinoInactivo(consulta, conversacion.destinos)];
    const turno = (conversacion.turnoDirigido = (conversacion.turnoDirigido ?? -1) + 1);
    return [{ ...consulta, destino: lista[turno % lista.length] }];
  });
}

// En la lista de consultas para la web, un destino solo vale si está activo o trae su propio sitio.
function sinDestinoInactivo(consulta, destinos) {
  if (consulta.dominios || activos(destinos).includes(consulta.destino)) return consulta;
  const { destino, ...resto } = consulta;
  return resto;
}

// Al recortar una lista de consultas, cada idioma entra por turno: si el modelo las agrupó por
// idioma, recortar las primeras dejaba afuera a los últimos (pasó con el japonés).
export function porTurnos(consultas) {
  const grupos = new Map();
  for (const consulta of consultas) {
    const clave = consulta.idioma ?? "";
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(consulta);
  }
  const resultado = [];
  for (let i = 0; resultado.length < consultas.length; i++) {
    for (const grupo of grupos.values()) if (grupo[i]) resultado.push(grupo[i]);
  }
  return resultado;
}

const MAX_GRAFICOS = 2;

// Los modelos no siempre respetan la consigna de los gráficos: se quitan los que no se pueden
// dibujar o tienen muy pocos datos, los que pasan de dos por sección y el título que a veces
// escriben encima de un gráfico que ya trae el suyo.
export function depurarGraficos(markdown) {
  let puestos = 0;
  return markdown
    .replace(/^```grafico\n([\s\S]*?)\n```[ \t]*$/gm, (bloque, contenido) =>
      graficoValido(contenido) && ++puestos <= MAX_GRAFICOS ? bloque : "",
    )
    .replace(/^#{3,6} [^\n]+\n+(```grafico\n[\s\S]*?\n```)(?=\s*(\n#{2,6} |$))/gm, "$1")
    .replace(/^#{3,6} [^\n]+\n+(?=#{2,6} )/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Con más fuentes, la sección se parte: sus notas ya ocupan ~60.000 caracteres.
const MAX_POR_SECCION = 60;
const FUENTES_POR_TANDA = 80;
const OTROS = "Otros hallazgos";

// Las secciones que propone el índice, sin fuentes todavía.
export function seccionesPropuestas(valor) {
  return (Array.isArray(valor) ? valor : [])
    .map((seccion) => ({
      titulo: typeof seccion?.titulo === "string" ? seccion.titulo.trim() : "",
      enfoque: typeof seccion?.enfoque === "string" ? seccion.enfoque.trim() : "",
    }))
    .filter((seccion) => seccion.titulo && seccion.titulo !== OTROS);
}

// Lee la respuesta de una tanda: {"fuentes": {"12": [3], "13": [1, 5], "14": [0]}}. Cada fuente va a
// hasta 2 secciones; 0 o nada válido = ninguna. Las que el modelo no mencionó quedan sin anotar.
export function leerUbicacion(respuesta, numeros, cantidad, ubicacion = new Map()) {
  const dadas = respuesta?.fuentes && typeof respuesta.fuentes === "object" ? respuesta.fuentes : {};
  for (const n of numeros) {
    if (!(String(n) in dadas)) continue;
    const valor = dadas[String(n)];
    const lista = (Array.isArray(valor) ? valor : [valor])
      .map(Number)
      .filter((k) => Number.isInteger(k) && k >= 1 && k <= cantidad);
    ubicacion.set(n, [...new Set(lista)].slice(0, 2));
  }
  return ubicacion;
}

// Cada sección con las fuentes que se le ubicaron, partida si pasa de MAX_POR_SECCION; las que no
// fueron a ninguna van a «Otros hallazgos», para que el informe aproveche todas.
export function seccionesConFuentes(propuestas, ubicacion, total) {
  const secciones = propuestas.map((seccion) => ({ ...seccion, fuentes: [] }));
  const sueltas = [];
  for (let n = 1; n <= total; n++) {
    const destinos = ubicacion.get(n) ?? [];
    if (!destinos.length) sueltas.push(n);
    for (const k of destinos) secciones[k - 1]?.fuentes.push(n);
  }
  // Partes parejas: 126 fuentes son 3 de 42, no 60 + 60 + 6 (la última quedaba casi vacía).
  const enPartes = ({ titulo, enfoque, fuentes }) => {
    const partes = Math.ceil(fuentes.length / MAX_POR_SECCION);
    const tamano = Math.ceil(fuentes.length / partes);
    return Array.from({ length: partes }, (_, parte) => ({
      titulo: partes > 1 ? `${titulo} (parte ${parte + 1} de ${partes})` : titulo,
      enfoque,
      fuentes: fuentes.slice(parte * tamano, (parte + 1) * tamano),
    }));
  };
  return [
    ...secciones.flatMap(enPartes),
    ...enPartes({
      titulo: OTROS,
      enfoque: "Lo que aportan estas fuentes y no se cubrió en las secciones anteriores.",
      fuentes: sueltas,
    }),
  ];
}

const enTrozos = (lista, tamano) =>
  Array.from({ length: Math.ceil(lista.length / tamano) }, (_, i) => lista.slice(i * tamano, (i + 1) * tamano));

const nombresDe = (idiomas) => {
  const nombres = idiomas.map((idioma) => idioma.nombre);
  return nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} y ${nombres.at(-1)}` : nombres[0];
};

// No se usa una lista numerada de Markdown: renumera 1, 2, 3… y los números dejarían de
// coincidir con las citas del texto.
export function listaDeFuentes(fuentes, cuerpo) {
  // También cuentan las citas de los gráficos ("cita": n dentro de los bloques ```grafico).
  const citadas = new Set(
    [...cuerpo.matchAll(/\[(\d+)\]|"cita"\s*:\s*(\d+)/g)].map((cita) => Number(cita[1] ?? cita[2])),
  );
  const usadas = fuentes.filter((fuente) => citadas.has(fuente.n));
  const lineas = (usadas.length ? usadas : fuentes).map((fuente) => {
    const limpio = fuente.titulo.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
    const titulo = tituloLegible(limpio) ? limpio : direccionCorta(fuente.url);
    const url = fuente.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `- **${fuente.n}.** [${titulo}](${url})`;
  });
  return `\n\n## Fuentes\n\n${lineas.join("\n")}\n`;
}

export function crearConversacion(id, dueno, tema) {
  return {
    id,
    dueno,
    tema,
    fuentes: [],
    vistas: new Set(),
    consultas: [],
    candidatas: 0,
    ultimoFallo: null,
    informe: "",
    intercambios: [],
    ocupada: false,
    actualizada: Date.now(),
  };
}

export function crearInvestigador({
  llm,
  buscar,
  buscarAcademico,
  buscarLibros,
  saldoAcademico,
  leerPagina,
  opciones,
}) {
  // De una página larga se analizan los pasajes que hablan de la búsqueda que la trajo y del
  // tema, no su comienzo (en un informe de 400.000 caracteres, el comienzo es la tapa y el índice).
  async function obtenerTexto(conversacion, candidata, signal) {
    const elegir = (texto) =>
      seleccionarPasajes(texto, {
        terminos: terminosDe(candidata.consultaTexto ?? ""),
        secundarios: (conversacion.terminos ??= terminosDelTema(conversacion.tema)),
        maximo: opciones.caracteresPorFuente,
      });
    if (candidata.contenido?.length >= MINIMO_CONTENIDO) {
      return { titulo: candidata.titulo, texto: elegir(candidata.contenido) };
    }
    try {
      const pagina = await leerPagina(candidata.url, { signal, maxCaracteres: MAXIMO_LEIDO });
      return { titulo: pagina.titulo, texto: elegir(pagina.texto) };
    } catch (error) {
      if (signal.aborted || !(candidata.resumen?.length >= MINIMO_RESUMEN)) throw error;
      return { titulo: candidata.titulo, texto: candidata.resumen };
    }
  }

  // Devuelve "util" si la fuente se leyó y aporta, "sin-acceso" si trata el tema detrás de un muro
  // (cuenta como aporte de su búsqueda: hay información, aunque no se pueda leer) o null.
  async function analizar(conversacion, candidata, { emitir, signal, alEsperar }) {
    const id = ++conversacion.candidatas;
    emitir("fuente", {
      id,
      url: candidata.url,
      titulo: candidata.titulo,
      estado: "leyendo",
      ...(candidata.consulta && { consulta: candidata.consulta }),
    });
    try {
      const pagina = await obtenerTexto(conversacion, candidata, signal);
      const titulo = pagina.titulo || candidata.titulo || candidata.url;
      let respuesta;
      try {
        respuesta = await llm.completar(
          promptNotas(
            conversacion.tema,
            { titulo, url: candidata.url, texto: pagina.texto },
            conversacion.aspectos,
          ),
          { signal, alEsperar },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        conversacion.ultimoFallo = error;
        throw new Error("no se pudo analizar");
      }
      const { notas, aspectos, fecha, tipo } = interpretarNotas(respuesta ?? "");
      // Trata el tema pero solo se ve una ficha o un muro de pago: no cuenta como irrelevante.
      if (/^\W*SIN ACCESO\W*$/i.test(notas)) throw new Error(SIN_ACCESO);
      if (!notas || /^\W*IRRELEVANTE\W*$/i.test(notas)) throw new Error(NO_APORTA);

      const fuente = { n: conversacion.fuentes.length + 1, url: candidata.url, titulo, notas };
      // Lo que ya dice el buscador (un paper y su año) vale más que lo que deduce el modelo.
      const datos = { tipo: candidata.tipo ?? tipo, fecha: candidata.fecha ?? fecha };
      if (datos.tipo) fuente.tipo = datos.tipo;
      if (datos.fecha) fuente.fecha = datos.fecha;
      const validos = aspectos.filter((numero) => numero >= 1 && numero <= (conversacion.aspectos?.length ?? 0));
      if (validos.length) fuente.aspectos = validos;
      if (candidata.imagenes?.length) fuente.imagenes = candidata.imagenes;
      conversacion.fuentes.push(fuente);
      emitir("fuente", { id, url: fuente.url, titulo, estado: "lista", n: fuente.n, ...datos });
      return "util";
    } catch (error) {
      if (signal.aborted) throw error;
      // Todo lo que no se descartó por tratar otro tema (sin acceso, bloqueada, PDF, error al
      // leer) queda anotado para que la persona pueda revisarlo a mano.
      const revisar = error.message !== NO_APORTA;
      if (revisar) {
        (conversacion.pendientes ??= []).push({
          url: candidata.url,
          titulo: candidata.titulo || candidata.url,
          motivo: error.message,
        });
      }
      emitir("fuente", { id, estado: "descartada", motivo: error.message, ...(revisar && { revisar }) });
      return error.message === SIN_ACCESO ? "sin-acceso" : null;
    }
  }

  // Devuelve los resultados de una búsqueda, o null si falló. Un buscador que falla se avisa una
  // vez (antes parecía «sin resultados») y esa búsqueda se hace en la web para no perderla.
  async function buscarUna(conversacion, consulta, { emitir, signal }) {
    const { texto, destino, reciente } = consulta;
    const pedido = { cantidad: opciones.resultadosPorConsulta, signal };
    const avisar = (clave, mensaje) => {
      conversacion.avisados ??= new Set();
      if (conversacion.avisados.has(clave)) return;
      conversacion.avisados.add(clave);
      emitir("aviso", { texto: mensaje });
    };
    const especial = { academico: buscarAcademico, libros: buscarLibros }[destino];
    try {
      if (especial) {
        conversacion.fallos ??= {};
        try {
          const { resultados } = await especial(texto, pedido);
          conversacion.fallos[destino] = 0;
          return resultados;
        } catch (error) {
          if (signal.aborted) throw error;
          conversacion.fallos[destino] = (conversacion.fallos[destino] ?? 0) + 1;
          // Con dos fallos seguidos se deja de dirigir búsquedas a ese buscador.
          if (conversacion.fallos[destino] >= 2 && conversacion.destinos) {
            conversacion.destinos[destino] = false;
          }
          avisar(
            destino,
            `El buscador de ${NOMBRES_DE_DESTINOS[destino]} no respondió (${error.message}): esas búsquedas se hacen en la web.`,
          );
        }
      }
      const dominios = destino === "sitios" && (consulta.dominios ?? conversacion.destinos?.dominios);
      const { resultados } = await buscar(texto, {
        ...pedido,
        ...(reciente && { reciente }),
        ...(dominios && { dominios }),
      });
      return resultados;
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(`Falló la búsqueda "${texto}": ${error.message}`);
      avisar("web", `Una búsqueda en la web falló (${error.message}); sigo con las demás.`);
      return null;
    }
  }

  async function incorporar(conversacion, consultas, contexto, cupo) {
    const { emitir } = contexto;
    const porConsulta = [];
    const numeros = [];
    // Qué rindió cada búsqueda: la revisión lo usa para no insistir con lo que no trae nada.
    conversacion.rendimiento ??= [];
    await enParalelo(consultas, opciones.tareasEnParalelo, async (consulta, indice) => {
      const { texto, idioma, destino } = consulta;
      // El número permite que la página cuelgue cada fuente de la búsqueda que la trajo.
      const numero = conversacion.consultas.push(texto);
      numeros[indice] = numero;
      const registro = { texto, destino: destino ?? "web", idioma, nuevas: 0, leidas: 0, sinAcceso: 0 };
      conversacion.rendimiento[numero - 1] = registro;
      emitir("consulta", { id: numero, texto, ...(idioma && { idioma }), ...(destino && { destino }) });
      const resultados = await buscarUna(conversacion, consulta, contexto);
      if (!resultados) registro.fallo = true;
      porConsulta[indice] = resultados ?? [];
    });

    // Se intercalan para que todas las consultas aporten fuentes antes de llegar al tope.
    const candidatas = [];
    for (let puesto = 0; puesto < opciones.resultadosPorConsulta; puesto++) {
      for (const [indice, resultados] of porConsulta.entries()) {
        const resultado = resultados[puesto];
        const clave = resultado && normalizarUrl(resultado.url);
        if (!clave || conversacion.vistas.has(clave) || candidatas.length >= cupo) continue;
        conversacion.vistas.add(clave);
        candidatas.push({
          ...resultado,
          consulta: numeros[indice],
          consultaTexto: consultas[indice].texto,
        });
        conversacion.rendimiento[numeros[indice] - 1].nuevas++;
      }
    }
    await enParalelo(candidatas, opciones.tareasEnParalelo, async (candidata) => {
      const resultado = await analizar(conversacion, candidata, contexto);
      const registro = conversacion.rendimiento[candidata.consulta - 1];
      if (resultado === "util") registro.leidas++;
      if (resultado === "sin-acceso") registro.sinAcceso++;
    });
    return numeros.map((numero) => conversacion.rendimiento[numero - 1]);
  }

  const contextoDe = ({ emitir, signal }) => ({
    emitir,
    signal,
    alEsperar: (segundos) => emitir("espera", { segundos }),
  });

  // Con `retomar`, sigue una investigación cortada (reinicio del servidor, error) desde lo último
  // guardado: no vuelve a planificar ni repite búsquedas; si ya había terminado de buscar, solo
  // redacta de nuevo.
  // Con `rehacer`, solo redacta de nuevo con las fuentes que hay (por ejemplo, con las agregadas a
  // mano desde «Ver informe»).
  async function investigar(conversacion, flujo, { retomar = false, rehacer = false } = {}) {
    const contexto = contextoDe(flujo);
    const { emitir } = contexto;
    const cupo = () => opciones.maxFuentes - conversacion.fuentes.length;
    // Dos presupuestos: las búsquedas en la web y en sitios gastan la cuota mensual de Tavily; las
    // de papers y libros van a OpenAlex, que tiene su propio saldo diario y su propio tope.
    const hechas = (libres) =>
      (conversacion.rendimiento ?? []).filter(
        (registro) => registro && esLibre(registro.destino) === libres,
      ).length;
    const maxPagas = opciones.maxBusquedas ?? Infinity;
    let maxLibres = opciones.maxAcademicas ?? Infinity;
    // Cada presupuesto termina por su lado: al llegar a su tope o, pasado su mínimo, cuando sus
    // últimas N búsquedas seguidas no aportaron ninguna fuente (las que solo trajeron páginas sin
    // acceso sí cuentan como aporte). El «ya alcanza» del modelo no corta nada.
    // Lo que hace falta para retomar la búsqueda: se guarda con la investigación.
    const progreso = (conversacion.progreso ??= {
      planificada: false,
      buscada: false,
      ronda: 0,
      rondasVacias: 0,
      sinAporte: { pagas: 0, libres: 0 },
      terminados: [],
    });
    const { sinAporte } = progreso;
    if (rehacer) Object.assign(progreso, { planificada: true, buscada: true });
    const retomando = (retomar || rehacer) && progreso.planificada;
    const finDe = (libres) => {
      const { destinos } = conversacion;
      const clave = libres ? "libres" : "pagas";
      const maximo = libres ? maxLibres : maxPagas;
      // Papers y libros no tienen mínimo: siguen hasta el tope salvo que sus últimas
      // `papersSinAporte` (100) búsquedas seguidas no aporten nada (Franco, 2026-11-16).
      const minimo = libres ? 0 : (opciones.minBusquedas ?? 0);
      if (libres && !(destinos.academico || destinos.libros)) return "no-pedidas";
      if (hechas(libres) >= maximo) return libres && maximo < (opciones.maxAcademicas ?? Infinity) ? "saldo" : "tope";
      const limite = (libres ? opciones.papersSinAporte : opciones.busquedasSinAporte) ?? 0;
      if (limite > 0 && hechas(libres) >= minimo && sinAporte[clave] >= limite) return "sin-aporte";
      return null;
    };
    const cuposDe = (pagas, libres) => {
      const { destinos } = conversacion;
      const quedan = finDe(false) ? 0 : Math.max(0, Math.min(pagas, maxPagas - hechas(false)));
      // La mitad de las búsquedas pagas va a los sitios pedidos mientras traigan páginas nuevas.
      const sitios =
        destinos.dominios.length && !destinos.sitiosAgotados ? Math.floor(quedan / 2) : 0;
      return {
        web: quedan - sitios,
        sitios,
        libres: finDe(true) ? 0 : Math.max(0, Math.min(libres, maxLibres - hechas(true))),
      };
    };
    const aniosDelPedido = new Set((conversacion.tema.match(/\b(19|20)\d\d\b/g) ?? []).map(Number));
    // Resuelve el destino de cada consulta propuesta, descarta las casi iguales a una ya hecha en
    // el mismo buscador (o entre sí) y reparte el resto entre los cupos. `previa` es lo ya elegido
    // en esta ronda, cuando se le pide al modelo que complete el cupo.
    const repartir = (propuesta, cupos, previa = null) => {
      const candidatas = [
        ...consultasDe(propuesta.consultas, aniosDelPedido).map((consulta) =>
          sinDestinoInactivo(consulta, conversacion.destinos),
        ),
        ...conDestino(consultasDe(propuesta.dirigidas, aniosDelPedido), conversacion),
      ];
      const sinDirigidas = !consultasDe(propuesta.dirigidas).length;
      const previas = (conversacion.rendimiento ?? []).filter(Boolean);
      const tanda = {
        web: [...(previa?.web ?? [])],
        sitios: [...(previa?.sitios ?? [])],
        libres: [...(previa?.libres ?? [])],
        descartadas: [...(previa?.descartadas ?? [])],
      };
      const lugar = (consulta) => {
        const clase = claseDe(consulta.destino);
        return tanda[clase].length < cupos[clase] ? tanda[clase] : null;
      };
      for (const consulta of porTurnos(candidatas)) {
        const destino = consulta.destino ?? "web";
        const repetida = [...previas, ...tanda.web, ...tanda.sitios, ...tanda.libres].some(
          (otra) => (otra.destino ?? "web") === destino && parecidas(otra.texto, consulta.texto),
        );
        if (repetida) {
          tanda.descartadas.push(consulta.texto);
          continue;
        }
        if (lugar(consulta)) {
          lugar(consulta).push(consulta);
        } else if (!consulta.destino && tanda.sitios.length < cupos.sitios) {
          // Una consulta web que sobra sirve igual dentro de los sitios pedidos: así se llena su cupo.
          tanda.sitios.push({ ...consulta, destino: "sitios" });
        } else if (sinDirigidas && !consulta.destino) {
          // El modelo no separó las dirigidas: lo que sobra de la web va a un buscador dirigido.
          const [dirigida] = conDestino([consulta], conversacion);
          if (dirigida?.destino) lugar(dirigida)?.push(dirigida);
        }
      }
      return tanda;
    };
    const cantidadDe = (tanda) => tanda.web.length + tanda.sitios.length + tanda.libres.length;
    const sumaDe = (cupos) => cupos.web + cupos.sitios + cupos.libres;
    const textos = (lista) =>
      (Array.isArray(lista) ? lista : [])
        .filter((texto) => typeof texto === "string" && texto.trim())
        .map((texto) => texto.trim().slice(0, 200));
    const AVISOS_DE_FIN = {
      pagas: {
        tope: () => `Se usaron las ${hechas(false)} búsquedas web previstas`,
        "sin-aporte": () =>
          `Las últimas ${opciones.busquedasSinAporte} búsquedas web no aportaron información nueva (van ${hechas(false)})`,
      },
      libres: {
        tope: () => `Se usaron las ${hechas(true)} búsquedas de papers y libros previstas`,
        saldo: () => `Se usaron las ${hechas(true)} búsquedas de papers y libros que permitía el saldo de hoy de OpenAlex`,
        "sin-aporte": () =>
          `Las últimas ${opciones.papersSinAporte} búsquedas de papers y libros no aportaron información nueva (van ${hechas(true)})`,
      },
    };
    // Avisa una vez cuando un presupuesto termina; si el otro sigue, la investigación continúa.
    const avisarFines = () => {
      for (const [clave, libres] of [["pagas", false], ["libres", true]]) {
        const motivoDeFin = finDe(libres);
        if (!motivoDeFin || progreso.terminados.includes(clave)) continue;
        progreso.terminados.push(clave);
        const texto = AVISOS_DE_FIN[clave][motivoDeFin]?.();
        if (!texto) continue;
        const otro = libres ? finDe(false) : finDe(true);
        emitir("aviso", {
          texto: otro
            ? `${texto}.`
            : `${texto}: sigo solo con ${libres ? "la web" : "papers y libros"}.`,
        });
      }
    };
    const buscarTanda = async (tanda) => {
      const consultas = [...tanda.web, ...tanda.sitios, ...tanda.libres];
      const registros = await incorporar(conversacion, consultas, contexto, cupo());
      for (const registro of registros) {
        const clave = esLibre(registro.destino) ? "libres" : "pagas";
        sinAporte[clave] = registro.leidas || registro.sinAcceso ? 0 : sinAporte[clave] + 1;
      }
      const sinNuevas = (clase) => {
        const suyos = registros.filter((registro) => claseDe(registro.destino) === clase);
        return suyos.length > 0 && suyos.every((registro) => !registro.nuevas);
      };
      const { destinos } = conversacion;
      if (sinNuevas("sitios") && !destinos.sitiosAgotados) {
        destinos.sitiosAgotados = true;
        emitir("aviso", {
          texto: "Los sitios indicados ya no traen resultados nuevos: sigo buscando en toda la web.",
        });
      }
      avisarFines();
    };

    // El saldo de OpenAlex se consulta antes del plan: si hoy no queda, no se piden papers. Al
    // retomar, lo ya hecho cuenta para el tope y el saldo de hoy limita lo que falta.
    const saldo = saldoAcademico ? await saldoAcademico().catch(() => null) : null;
    if (saldo) maxLibres = Math.min(maxLibres, hechas(true) + saldo.busquedas);
    if (retomando) {
      const hecho = busquedasHechas(hechas(false), hechas(true));
      const leidas = cuantas(conversacion.fuentes.length, "fuente leída", "fuentes leídas");
      const agregadas = conversacion.fuentes.filter((fuente) => fuente.agregada).length;
      emitir("aviso", {
        texto: rehacer
          ? `Rehago el informe con las búsquedas ya hechas (${leidas}${agregadas ? `, ${cuantas(agregadas, "agregada", "agregadas")} a mano` : ""}).`
          : progreso.buscada
            ? `Retomo la investigación: las búsquedas ya estaban terminadas (${hecho}); vuelvo a redactar el informe (${leidas}).`
            : `Retomo la investigación desde lo último guardado: ${hecho} y ${leidas}.`,
      });
    } else {
      emitir("etapa", { texto: "Planificando la investigación" });
      conversacion.destinos = destinosDe(conversacion.tema);
      let inicial = { web: [], sitios: [], libres: [], descartadas: [] };
      // Lo que se pidió buscar en OpenAlex, aunque hoy no haya saldo (para avisarlo).
      let pedidos = {};
      const iniciales = [
        opciones.consultasIniciales,
        opciones.academicasIniciales ?? opciones.consultasIniciales,
      ];
      try {
        const previstos = cuposDe(...iniciales);
        const plan = await llm.completarJSON(
          promptPlan(conversacion.tema, previstos.web + previstos.sitios, {
            multilingue: opciones.multilingue,
            libres: maxLibres > 0 ? iniciales[1] : 0,
          }),
          contexto,
        );
        conversacion.destinos = destinosDe(conversacion.tema, plan.sitios);
        if (plan.academico === true) conversacion.destinos.academico = true;
        if (plan.libros === true) conversacion.destinos.libros = true;
        pedidos = { academico: conversacion.destinos.academico, libros: conversacion.destinos.libros };
        // Sin saldo, las consultas pensadas para papers o libros se hacen en la web.
        if (maxLibres <= 0) Object.assign(conversacion.destinos, { academico: false, libros: false });
        // Las subpreguntas ordenan la investigación: cada fuente dice cuáles responde y cada ronda
        // busca lo que falta de las menos cubiertas.
        conversacion.aspectos = textos(plan.aspectos).slice(0, 12);
        if (conversacion.aspectos.length) emitir("aspectos", { lista: conversacion.aspectos });
        const todas = consultasDe([...(plan.consultas ?? []), ...(plan.dirigidas ?? [])]);
        if (opciones.multilingue) conversacion.idiomas = idiomasDe(plan.idiomas, todas);
        inicial = repartir(plan, cuposDe(...iniciales));
      } catch (error) {
        if (!(error instanceof ErrorFormato)) throw error;
      }
      if (!cantidadDe(inicial)) inicial.web = [{ texto: conversacion.tema }];

      const idiomas =
        conversacion.idiomas?.length > 1 ? ` en ${nombresDe(conversacion.idiomas)}` : "";
      emitir("etapa", { texto: `Buscando y leyendo fuentes${idiomas}` });
      const { destinos } = conversacion;
      if (destinos.dominios.length) {
        emitir("aviso", { texto: `La mitad de las búsquedas web va a: ${destinos.dominios.join(", ")}.` });
      }
      if (pedidos.academico || pedidos.libros) {
        const donde = [
          pedidos.academico && "artículos académicos (OpenAlex, en lugar de Google Scholar)",
          pedidos.libros && "libros",
        ]
          .filter(Boolean)
          .join(" y ");
        const horas = saldo?.renuevaEnSegundos ? Math.max(1, Math.round(saldo.renuevaEnSegundos / 3600)) : null;
        emitir("aviso", {
          texto:
            maxLibres > 0
              ? `Además busco ${donde}: hasta ${Number.isFinite(maxLibres) ? `${maxLibres} búsquedas` : "las búsquedas que hagan falta"}, aparte de las de la web${saldo ? ` (hoy quedan ${saldo.busquedas} en OpenAlex)` : ""}.`
              : `Hoy no quedan búsquedas de papers ni de libros en OpenAlex${horas ? ` (se renuevan en unas ${horas} h)` : ""}: esta investigación usa solo la web.`,
        });
      }
      progreso.planificada = true;
      await buscarTanda(inicial);
    }

    if (!progreso.buscada) {
      // Por qué terminó la búsqueda, para avisarlo.
      let motivo = "rondas";
      for (let ronda = progreso.ronda + 1; ronda <= opciones.rondasExtra && cupo() > 0; ronda++) {
        progreso.ronda = ronda;
        // Sin fuentes tras la primera tanda no hay de dónde seguir; al retomar, en cambio, la
        // primera tanda pudo cortarse antes de leer nada, y se sigue con las rondas.
        if (!conversacion.fuentes.length && !retomando) break;
        // El saldo de OpenAlex se renueva cada día: una investigación larga puede cruzar la
        // renovación y seguir con papers hasta su tope, en vez de quedarse con el saldo del inicio.
        const actual = saldoAcademico ? await saldoAcademico().catch(() => null) : null;
        if (actual) {
          const antes = finDe(true);
          maxLibres = Math.min(opciones.maxAcademicas ?? Infinity, hechas(true) + actual.busquedas);
          if (antes === "saldo" && !finDe(true)) {
            progreso.terminados = progreso.terminados.filter((clave) => clave !== "libres");
            emitir("aviso", {
              texto: `Se renovó el saldo de OpenAlex: sigo con papers y libros (hoy quedan ${actual.busquedas}).`,
            });
          }
        }
        const cupos = cuposDe(
          opciones.consultasPorRonda,
          opciones.academicasPorRonda ?? opciones.consultasPorRonda,
        );
        if (!sumaDe(cupos)) {
          motivo = "presupuesto";
          break;
        }
        emitir("etapa", { texto: "Revisando qué falta cubrir" });
        let tanda = null;
        // Se le pide al modelo que llene el cupo; si el filtro de repetidas (o el modelo) deja la
        // ronda por debajo de 3/4, se le pide el resto mostrándole qué se descartó.
        for (let intento = 0; intento < 2; intento++) {
          if (tanda && cantidadDe(tanda) >= (sumaDe(cupos) * 3) / 4) break;
          const faltan = tanda
            ? {
                web: cupos.web - tanda.web.length,
                sitios: cupos.sitios - tanda.sitios.length,
                libres: cupos.libres - tanda.libres.length,
              }
            : cupos;
          try {
            const revision = await llm.completarJSON(
              promptRevision(conversacion, faltan, { descartadas: tanda?.descartadas ?? [] }),
              contexto,
            );
            tanda = repartir(revision, cupos, tanda);
            const nuevos = intento === 0 ? textos(revision.aspectos_nuevos).slice(0, 2) : [];
            if (conversacion.aspectos?.length && nuevos.length) {
              const sumados = nuevos.slice(0, MAX_ASPECTOS - conversacion.aspectos.length);
              conversacion.aspectos.push(...sumados);
              if (sumados.length) emitir("aspectos", { lista: sumados, nuevos: true });
            }
          } catch (error) {
            if (!(error instanceof ErrorFormato)) throw error;
          }
        }
        if (!tanda || !cantidadDe(tanda)) {
          if (++progreso.rondasVacias >= 2) {
            motivo = "sin-novedades";
            break;
          }
          continue;
        }
        progreso.rondasVacias = 0;
        emitir("etapa", { texto: `Profundizando (ronda ${ronda + 1})` });
        await buscarTanda(tanda);
      }

      const total = busquedasHechas(hechas(false), hechas(true));
      const avisoFinal = {
        presupuesto: `Búsqueda terminada (${total}): redacto con lo encontrado.`,
        rondas:
          opciones.rondasExtra > 0
            ? `Se llegó al máximo de ${opciones.rondasExtra} rondas (${total}): redacto con lo encontrado.`
            : null,
        "sin-novedades": `El modelo ya no propone búsquedas distintas de las que se hicieron (${total}): redacto con lo encontrado.`,
      }[motivo];
      if (avisoFinal && conversacion.fuentes.length) emitir("aviso", { texto: avisoFinal });
      progreso.buscada = true;
    }

    if (!conversacion.fuentes.length) {
      throw (
        conversacion.ultimoFallo ??
        new ErrorInvestigacion("No encontré fuentes legibles sobre ese tema. Probá reformularlo.")
      );
    }

    const cuerpo = opciones.informePorSecciones
      ? await redactarPorSecciones(conversacion, contexto)
      : await redactarDeUnaVez(conversacion, contexto);
    // Las fuentes para revisar a mano ya no van en el informe (ni en el PDF): «Ver informe» las
    // muestra aparte, con la opción de agregar su contenido.
    const anexo = listaDeFuentes(conversacion.fuentes, cuerpo);
    emitir("texto", { delta: anexo });
    conversacion.informe = cuerpo + anexo;
    conversacion.fuentesEnInforme = conversacion.fuentes.length;
  }

  async function redactarDeUnaVez(conversacion, contexto) {
    contexto.emitir("etapa", { texto: "Redactando el informe" });
    return llm.completarEnVivo(promptInforme(conversacion), {
      ...contexto,
      alRecibir: (delta) => contexto.emitir("texto", { delta }),
    });
  }

  // Con cientos de fuentes, una sola respuesta del modelo no alcanza: se arma un índice, cada
  // sección se escribe con las notas de sus fuentes y al final el resumen y las conclusiones.
  // El resumen va arriba pero se escribe último, así que el texto se muestra entero al terminar.
  // Si una tanda falla o el modelo saltea fuentes, se le piden una vez más; las que sigan sin lugar
  // van a «Otros hallazgos».
  async function ubicarFuentes(conversacion, secciones, contexto) {
    const ubicacion = new Map();
    const numeros = conversacion.fuentes.map((fuente) => fuente.n);
    if (secciones.length === 1) {
      for (const n of numeros) ubicacion.set(n, [1]);
    }
    if (secciones.length < 2) return ubicacion;
    const ubicar = async (lote) => {
      try {
        const respuesta = await llm.completarJSON(promptUbicar(conversacion, secciones, lote), contexto);
        leerUbicacion(respuesta, lote, secciones.length, ubicacion);
      } catch (error) {
        if (contexto.signal.aborted || !(error instanceof ErrorFormato || error instanceof ErrorLLM)) throw error;
      }
    };
    for (const pendientes of [numeros, null]) {
      const lista = pendientes ?? numeros.filter((n) => !ubicacion.has(n));
      const tandas = enTrozos(lista, FUENTES_POR_TANDA);
      let empezadas = 0;
      await enParalelo(tandas, opciones.tareasEnParalelo, async (lote) => {
        contexto.emitir("etapa", {
          texto: `Ubicando las fuentes en las secciones (tanda ${++empezadas} de ${tandas.length}${pendientes ? "" : ", las que faltaban"})`,
        });
        await ubicar(lote);
      });
    }
    return ubicacion;
  }

  async function resumirSecciones(conversacion, secciones, partes, contexto) {
    contexto.emitir("etapa", { texto: "Resumiendo cada sección para el resumen y las conclusiones" });
    const resumenes = [];
    await enParalelo(partes, opciones.tareasEnParalelo, async (texto, numero) => {
      let resumen;
      try {
        resumen = (await llm.completar(promptResumenDeSeccion(conversacion, texto), contexto)).trim();
      } catch (error) {
        if (contexto.signal.aborted || !(error instanceof ErrorLLM)) throw error;
        resumen = texto.slice(0, Math.floor(MAX_CUERPO / partes.length));
      }
      resumenes[numero] = `## ${secciones[numero].titulo}\n\n${resumen}`;
    });
    return resumenes.join("\n\n");
  }

  async function redactarPorSecciones(conversacion, contexto) {
    const { emitir, signal } = contexto;
    emitir("etapa", { texto: "Organizando el informe" });
    let indice = {};
    try {
      indice = await llm.completarJSON(promptIndice(conversacion), contexto);
    } catch (error) {
      if (!(error instanceof ErrorFormato)) throw error;
    }
    const propuestas = seccionesPropuestas(indice.secciones);
    const ubicacion = await ubicarFuentes(conversacion, propuestas, contexto);
    const secciones = seccionesConFuentes(propuestas, ubicacion, conversacion.fuentes.length);
    const titulo =
      (typeof indice.titulo === "string" && indice.titulo.trim()) ||
      `Informe: ${conversacion.tema.split("\n")[0].replace(/^pregunta:\s*/i, "")}`;

    // Cada sección depende solo de sus notas, así que se redactan varias a la vez.
    const partes = [];
    let fallidas = 0;
    let empezadas = 0;
    await enParalelo(secciones, opciones.tareasEnParalelo, async (seccion, numero) => {
      emitir("etapa", {
        texto: `Redactando el informe (sección ${++empezadas} de ${secciones.length})`,
      });
      try {
        const texto = await llm.completar(promptSeccion(conversacion, secciones, numero), contexto);
        partes[numero] = depurarGraficos(texto);
      } catch (error) {
        if (signal.aborted || !(error instanceof ErrorLLM)) throw error;
        fallidas++;
        partes[numero] = `## ${seccion.titulo}\n\n_No se pudo redactar esta sección: ${error.message}_`;
      }
    });
    if (fallidas === secciones.length) throw new ErrorLLM("No se pudo redactar ninguna sección.");

    const cuerpo = partes.join("\n\n");
    // Si el informe no entra entero, el resumen y las conclusiones leen un resumen de cada sección
    // (antes leían solo el comienzo y, con mil fuentes, ignoraban la mitad del informe).
    const resumido = cuerpo.length > MAX_CUERPO;
    const material = resumido ? await resumirSecciones(conversacion, secciones, partes, contexto) : cuerpo;
    emitir("etapa", { texto: "Redactando el resumen y las conclusiones" });
    const inicio = await llm.completar(promptResumen(conversacion, titulo, material, { resumido }), contexto);
    const cierre = await llm.completar(promptConclusiones(conversacion, material, { resumido }), contexto);
    const informe = [inicio.trim(), cuerpo, cierre.trim()].join("\n\n");
    emitir("texto", { delta: informe });
    return informe;
  }

  async function seguir(conversacion, pregunta, flujo) {
    const contexto = contextoDe(flujo);
    const { emitir } = contexto;

    emitir("etapa", { texto: "Revisando el informe" });
    let consultas = [];
    try {
      const decision = await llm.completarJSON(
        promptDecision(conversacion, pregunta, opciones.consultasPorRonda),
        contexto,
      );
      if (decision.buscar === true) {
        consultas = consultasDe(decision.consultas).slice(0, opciones.consultasPorRonda);
      }
    } catch (error) {
      if (!(error instanceof ErrorFormato)) throw error;
    }

    if (consultas.length) {
      emitir("etapa", { texto: "Buscando información adicional" });
      await incorporar(conversacion, consultas, contexto, opciones.fuentesPorSeguimiento);
    }

    emitir("etapa", { texto: "Respondiendo" });
    const respuesta = await llm.completarEnVivo(promptSeguimiento(conversacion, pregunta), {
      ...contexto,
      alRecibir: (delta) => emitir("texto", { delta }),
    });
    conversacion.intercambios.push({ pregunta, respuesta });
  }

  // Contenido que la persona agrega a mano para una fuente que no se pudo leer (texto pegado o de
  // un PDF): se analiza como cualquier otra. Devuelve la fuente nueva, o null si no aporta.
  async function agregarContenido(conversacion, { url, titulo, texto }, contexto) {
    const terminos = (conversacion.terminos ??= terminosDelTema(conversacion.tema));
    const elegido = seleccionarPasajes(texto, {
      terminos,
      secundarios: terminos,
      maximo: opciones.caracteresPorFuente,
    });
    const respuesta = await llm.completar(
      promptNotas(conversacion.tema, { titulo, url, texto: elegido }, conversacion.aspectos),
      contexto,
    );
    const { notas, aspectos, fecha, tipo } = interpretarNotas(respuesta ?? "");
    if (!notas || /^\W*(IRRELEVANTE|SIN ACCESO)\W*$/i.test(notas)) return null;
    const fuente = { n: conversacion.fuentes.length + 1, url, titulo, notas, agregada: true };
    if (tipo) fuente.tipo = tipo;
    if (fecha) fuente.fecha = fecha;
    const validos = aspectos.filter((numero) => numero >= 1 && numero <= (conversacion.aspectos?.length ?? 0));
    if (validos.length) fuente.aspectos = validos;
    conversacion.fuentes.push(fuente);
    return fuente;
  }

  return { investigar, seguir, agregarContenido };
}
