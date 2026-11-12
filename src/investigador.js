import { ErrorFormato, ErrorLLM } from "./llm.js";
import {
  promptConclusiones,
  promptDecision,
  promptIndice,
  promptInforme,
  promptNotas,
  promptPlan,
  promptResumen,
  promptRevision,
  promptSeccion,
  promptSeguimiento,
} from "./prompts.js";

export class ErrorInvestigacion extends Error {}

const PARAMETROS_DE_RASTREO = /^(utm_\w+|fbclid|gclid|mc_[ce]id|ref)$/i;
const MINIMO_CONTENIDO = 200;
// Los resúmenes de DuckDuckGo (una o dos líneas) no alcanzan; los de Tavily sí.
const MINIMO_RESUMEN = 400;

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

// Las consultas llegan como textos o, en la búsqueda multilingüe, como {idioma, texto}.
export function consultasDe(valor) {
  if (!Array.isArray(valor)) return [];
  const vistas = new Set();
  return valor.flatMap((consulta) => {
    const texto = typeof consulta === "string" ? consulta : consulta?.texto;
    if (typeof texto !== "string" || !texto.trim() || vistas.has(texto.trim())) return [];
    vistas.add(texto.trim());
    const idioma = typeof consulta?.idioma === "string" ? consulta.idioma.trim().toLowerCase() : "";
    return [idioma ? { texto: texto.trim(), idioma } : { texto: texto.trim() }];
  });
}

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
const NO_SON_DOMINIOS = new Set(["js", "ts", "py", "md", "txt", "pdf", "html", "css", "json", "csv"]);
const MAX_DOMINIOS = 10;

// Sitios y fuentes académicas que pide el campo «Fuentes» (o todo el pedido, si no lo usa).
// `sugeridos` son los dominios que el modelo dedujo de nombres («la OMS» → who.int).
export function destinosDe(tema, sugeridos = []) {
  const texto = tema.match(/^\s*fuentes\s*:(.*)$/im)?.[1] ?? tema;
  const dominios = new Set();
  const agregar = (valor) => {
    const dominio = String(valor)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(/[/?#\s,;:)\]]/)[0];
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(dominio)) return;
    if (NO_SON_DOMINIOS.has(dominio.split(".").at(-1)) || /(^|\.)scholar\.google\./.test(dominio)) return;
    dominios.add(dominio);
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

const activos = ({ academico, dominios, libros }) =>
  [academico && "academico", dominios.length && "sitios", libros && "libros"].filter(Boolean);

const describirDestinos = ({ academico, dominios, libros }) =>
  [
    academico && "artículos académicos (OpenAlex, en lugar de Google Scholar)",
    libros && "libros",
    ...dominios,
  ]
    .filter(Boolean)
    .join(", ");

// Con varios destinos (académico, sitios, libros), las consultas dirigidas se turnan entre ellos.
const conDestino = (consultas, destinos) => {
  const lista = activos(destinos);
  return consultas.map((consulta, indice) => ({ ...consulta, destino: lista[indice % lista.length] }));
};

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

const MAX_POR_SECCION = 40;

// Normaliza el índice que propone el modelo. Las fuentes que no quedaron en ninguna sección van a
// secciones extra, para que el informe aproveche todas.
export function seccionesDe(valor, total) {
  const secciones = (Array.isArray(valor) ? valor : [])
    .map((seccion) => ({
      titulo: typeof seccion?.titulo === "string" ? seccion.titulo.trim() : "",
      enfoque: typeof seccion?.enfoque === "string" ? seccion.enfoque.trim() : "",
      fuentes: [
        ...new Set(
          (Array.isArray(seccion?.fuentes) ? seccion.fuentes : [])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= total),
        ),
      ].slice(0, MAX_POR_SECCION),
    }))
    .filter((seccion) => seccion.titulo && seccion.fuentes.length);
  const asignadas = new Set(secciones.flatMap((seccion) => seccion.fuentes));
  const sueltas = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !asignadas.has(n));
  const partes = Math.ceil(sueltas.length / MAX_POR_SECCION);
  for (let parte = 0; parte < partes; parte++) {
    secciones.push({
      titulo: partes > 1 ? `Otros hallazgos (${parte + 1} de ${partes})` : "Otros hallazgos",
      enfoque: "Lo que aportan estas fuentes y no se cubrió en las secciones anteriores.",
      fuentes: sueltas.slice(parte * MAX_POR_SECCION, (parte + 1) * MAX_POR_SECCION),
    });
  }
  return secciones;
}

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
    const titulo = fuente.titulo.replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim() || fuente.url;
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
    irrelevantesSeguidas: 0,
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
  leerPagina,
  opciones,
}) {
  async function obtenerTexto(candidata, signal) {
    const maximo = opciones.caracteresPorFuente;
    if (candidata.contenido?.length >= MINIMO_CONTENIDO) {
      return { titulo: candidata.titulo, texto: candidata.contenido.slice(0, maximo) };
    }
    try {
      return await leerPagina(candidata.url, { signal, maxCaracteres: maximo });
    } catch (error) {
      if (signal.aborted || !(candidata.resumen?.length >= MINIMO_RESUMEN)) throw error;
      return { titulo: candidata.titulo, texto: candidata.resumen };
    }
  }

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
      const pagina = await obtenerTexto(candidata, signal);
      const titulo = pagina.titulo || candidata.titulo || candidata.url;
      let notas;
      try {
        notas = await llm.completar(
          promptNotas(conversacion.tema, { titulo, url: candidata.url, texto: pagina.texto }),
          { signal, alEsperar },
        );
      } catch (error) {
        if (signal.aborted) throw error;
        conversacion.ultimoFallo = error;
        throw new Error("no se pudo analizar");
      }
      if (!notas || /^\W*IRRELEVANTE\W*$/i.test(notas)) {
        conversacion.irrelevantesSeguidas++;
        throw new Error("no aporta al tema");
      }

      conversacion.irrelevantesSeguidas = 0;
      const fuente = { n: conversacion.fuentes.length + 1, url: candidata.url, titulo, notas };
      if (candidata.imagenes?.length) fuente.imagenes = candidata.imagenes;
      conversacion.fuentes.push(fuente);
      emitir("fuente", { id, url: fuente.url, titulo, estado: "lista", n: fuente.n });
    } catch (error) {
      if (signal.aborted) throw error;
      emitir("fuente", { id, estado: "descartada", motivo: error.message });
    }
  }

  // Si las últimas fuentes no aportan nada, seguir buscando solo gasta tiempo y cuota.
  const agotada = (conversacion) =>
    opciones.irrelevantesSeguidas > 0 &&
    conversacion.irrelevantesSeguidas >= opciones.irrelevantesSeguidas;

  async function incorporar(conversacion, consultas, contexto, cupo) {
    const { emitir, signal } = contexto;
    const porConsulta = [];
    const numeros = [];
    await enParalelo(consultas, opciones.tareasEnParalelo, async (consulta, indice) => {
      const { texto, idioma, destino } = consulta;
      // El número permite que la página cuelgue cada fuente de la búsqueda que la trajo.
      const numero = conversacion.consultas.push(texto);
      numeros[indice] = numero;
      emitir("consulta", { id: numero, texto, ...(idioma && { idioma }), ...(destino && { destino }) });
      const pedido = { cantidad: opciones.resultadosPorConsulta, signal };
      try {
        const especial = { academico: buscarAcademico, libros: buscarLibros }[destino];
        const { resultados } = especial
          ? await especial(texto, pedido)
          : await buscar(texto, {
              ...pedido,
              ...(destino === "sitios" && { dominios: conversacion.destinos.dominios }),
            });
        porConsulta[indice] = resultados;
      } catch (error) {
        if (signal.aborted) throw error;
        console.warn(`Falló la búsqueda "${texto}": ${error.message}`);
        porConsulta[indice] = [];
      }
    });

    // Se intercalan para que todas las consultas aporten fuentes antes de llegar al tope.
    const candidatas = [];
    let nuevasDirigidas = 0;
    for (let puesto = 0; puesto < opciones.resultadosPorConsulta; puesto++) {
      for (const [indice, resultados] of porConsulta.entries()) {
        const resultado = resultados[puesto];
        const clave = resultado && normalizarUrl(resultado.url);
        if (!clave || conversacion.vistas.has(clave) || candidatas.length >= cupo) continue;
        conversacion.vistas.add(clave);
        candidatas.push({ ...resultado, consulta: numeros[indice] });
        if (consultas[indice].destino) nuevasDirigidas++;
      }
    }
    await enParalelo(candidatas, opciones.tareasEnParalelo, async (candidata) => {
      if (!agotada(conversacion)) await analizar(conversacion, candidata, contexto);
    });
    return { dirigidas: consultas.filter((consulta) => consulta.destino).length, nuevasDirigidas };
  }

  const contextoDe = ({ emitir, signal }) => ({
    emitir,
    signal,
    alEsperar: (segundos) => emitir("espera", { segundos }),
  });

  async function investigar(conversacion, flujo) {
    const contexto = contextoDe(flujo);
    const { emitir } = contexto;
    const cupo = () => opciones.maxFuentes - conversacion.fuentes.length;
    const busquedasRestantes = () =>
      (opciones.maxBusquedas ?? Infinity) - conversacion.consultas.length;

    // La mitad de las búsquedas puede ir a los sitios pedidos, al buscador académico o a libros
    // (solo libros: una cuarta parte); si dejan de traer resultados nuevos, lo que queda va a la web.
    const total = opciones.maxBusquedas ?? opciones.consultasIniciales * 2;
    let dirigidasHechas = 0;
    const dirigidasRestantes = () => {
      const lista = activos(conversacion.destinos);
      if (!lista.length || conversacion.destinos.agotados) return 0;
      const tope = Math.floor(total / (lista.length === 1 && lista[0] === "libros" ? 4 : 2));
      return tope - dirigidasHechas;
    };
    const parteDirigida = () =>
      activos(conversacion.destinos).join() === "libros" ? "Una cuarta parte" : "La mitad";
    const reparto = (cantidad) => {
      const solo = activos(conversacion.destinos).join() === "libros";
      const parte = Math.floor(cantidad / (solo ? 4 : 2));
      const dirigidas = Math.min(parte, Math.max(0, dirigidasRestantes()));
      return { web: cantidad - dirigidas, dirigidas };
    };
    const filtrar = (lista, maximo) =>
      porTurnos(
        consultasDe(lista).filter((consulta) => !conversacion.consultas.includes(consulta.texto)),
      ).slice(0, maximo);
    const buscarTanda = async (web, dirigidas) => {
      const tanda = [...web, ...conDestino(dirigidas, conversacion.destinos)];
      const resultado = await incorporar(conversacion, tanda, contexto, cupo());
      dirigidasHechas += resultado.dirigidas;
      if (resultado.dirigidas && !resultado.nuevasDirigidas && !conversacion.destinos.agotados) {
        conversacion.destinos.agotados = true;
        emitir("aviso", {
          texto: "Los sitios indicados ya no traen resultados nuevos: sigo buscando en toda la web.",
        });
      }
    };

    emitir("etapa", { texto: "Planificando la investigación" });
    conversacion.irrelevantesSeguidas = 0;
    conversacion.destinos = destinosDe(conversacion.tema);
    let web = [];
    let dirigidas = [];
    const iniciales = Math.min(opciones.consultasIniciales, busquedasRestantes());
    try {
      const plan = await llm.completarJSON(
        promptPlan(conversacion.tema, iniciales, { multilingue: opciones.multilingue }),
        contexto,
      );
      conversacion.destinos = destinosDe(conversacion.tema, plan.sitios);
      if (plan.academico === true) conversacion.destinos.academico = true;
      if (plan.libros === true) conversacion.destinos.libros = true;
      const todas = consultasDe([...(plan.consultas ?? []), ...(plan.dirigidas ?? [])]);
      if (opciones.multilingue) conversacion.idiomas = idiomasDe(plan.idiomas, todas);
      const cupos = reparto(iniciales);
      web = filtrar(plan.consultas, cupos.web);
      dirigidas = filtrar(plan.dirigidas, cupos.dirigidas);
      // Si el modelo no separó las dirigidas, salen de sus propias consultas.
      if (cupos.dirigidas && !dirigidas.length) {
        dirigidas = filtrar(plan.consultas, iniciales).slice(cupos.web, iniciales);
      }
      if (!cupos.dirigidas) web = filtrar([...(plan.consultas ?? []), ...(plan.dirigidas ?? [])], iniciales);
    } catch (error) {
      if (!(error instanceof ErrorFormato)) throw error;
    }
    if (!web.length && !dirigidas.length) web = [{ texto: conversacion.tema }];

    const idiomas =
      conversacion.idiomas?.length > 1 ? ` en ${nombresDe(conversacion.idiomas)}` : "";
    emitir("etapa", { texto: `Buscando y leyendo fuentes${idiomas}` });
    if (dirigidasRestantes() > 0) {
      emitir("aviso", {
        texto: `${parteDirigida()} de las búsquedas va a: ${describirDestinos(conversacion.destinos)}.`,
      });
    }
    await buscarTanda(web, dirigidas);

    for (let ronda = 1; ronda <= opciones.rondasExtra && cupo() > 0; ronda++) {
      if (!conversacion.fuentes.length || agotada(conversacion) || busquedasRestantes() <= 0) break;
      const cupos = reparto(Math.min(opciones.consultasPorRonda, busquedasRestantes()));
      emitir("etapa", { texto: "Revisando qué falta cubrir" });
      const exigir = conversacion.consultas.length < Math.min(opciones.minBusquedas ?? 0, total);
      let nuevasWeb = [];
      let nuevasDirigidas = [];
      try {
        const revision = await llm.completarJSON(
          promptRevision(conversacion, cupos.web, cupos.dirigidas, { exigir }),
          contexto,
        );
        if (exigir || revision.completo !== true) {
          nuevasWeb = filtrar(revision.consultas, cupos.web);
          nuevasDirigidas = filtrar(revision.dirigidas, cupos.dirigidas);
        }
      } catch (error) {
        if (!(error instanceof ErrorFormato)) throw error;
      }
      if (!nuevasWeb.length && !nuevasDirigidas.length) break;
      emitir("etapa", { texto: `Profundizando (ronda ${ronda + 1})` });
      await buscarTanda(nuevasWeb, nuevasDirigidas);
    }

    if (busquedasRestantes() <= 0) {
      emitir("aviso", {
        texto: `Se usaron las ${opciones.maxBusquedas} búsquedas previstas: redacto con lo encontrado.`,
      });
    } else if (agotada(conversacion)) {
      emitir("aviso", {
        texto: `Las últimas ${opciones.irrelevantesSeguidas} fuentes no aportaban al tema: dejo de buscar y redacto con lo encontrado.`,
      });
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
    const anexo = listaDeFuentes(conversacion.fuentes, cuerpo);
    emitir("texto", { delta: anexo });
    conversacion.informe = cuerpo + anexo;
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
  async function redactarPorSecciones(conversacion, contexto) {
    const { emitir, signal } = contexto;
    emitir("etapa", { texto: "Organizando el informe" });
    let indice = {};
    try {
      indice = await llm.completarJSON(promptIndice(conversacion), contexto);
    } catch (error) {
      if (!(error instanceof ErrorFormato)) throw error;
    }
    const secciones = seccionesDe(indice.secciones, conversacion.fuentes.length);
    const titulo =
      (typeof indice.titulo === "string" && indice.titulo.trim()) ||
      `Informe: ${conversacion.tema.split("\n")[0].replace(/^pregunta:\s*/i, "")}`;

    const partes = [];
    let fallidas = 0;
    for (const [numero, seccion] of secciones.entries()) {
      emitir("etapa", {
        texto: `Redactando el informe (sección ${numero + 1} de ${secciones.length})`,
      });
      try {
        const texto = await llm.completar(promptSeccion(conversacion, secciones, numero), contexto);
        partes.push(texto.trim());
      } catch (error) {
        if (signal.aborted || !(error instanceof ErrorLLM)) throw error;
        fallidas++;
        partes.push(`## ${seccion.titulo}\n\n_No se pudo redactar esta sección: ${error.message}_`);
      }
    }
    if (fallidas === secciones.length) throw new ErrorLLM("No se pudo redactar ninguna sección.");

    const cuerpo = partes.join("\n\n");
    emitir("etapa", { texto: "Redactando el resumen y las conclusiones" });
    const inicio = await llm.completar(promptResumen(conversacion, titulo, cuerpo), contexto);
    const cierre = await llm.completar(promptConclusiones(conversacion, cuerpo), contexto);
    const informe = [inicio.trim(), cuerpo, cierre.trim()].join("\n\n");
    emitir("texto", { delta: informe });
    return informe;
  }

  async function seguir(conversacion, pregunta, flujo) {
    const contexto = contextoDe(flujo);
    const { emitir } = contexto;
    conversacion.irrelevantesSeguidas = 0;

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

  return { investigar, seguir };
}
