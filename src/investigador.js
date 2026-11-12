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
  const citadas = new Set([...cuerpo.matchAll(/\[(\d+)\]/g)].map((cita) => Number(cita[1])));
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

export function crearInvestigador({ llm, buscar, leerPagina, opciones }) {
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
    emitir("fuente", { id, url: candidata.url, titulo: candidata.titulo, estado: "leyendo" });
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
    await enParalelo(consultas, opciones.tareasEnParalelo, async ({ texto, idioma }, indice) => {
      emitir("consulta", idioma ? { texto, idioma } : { texto });
      conversacion.consultas.push(texto);
      try {
        const { resultados } = await buscar(texto, {
          cantidad: opciones.resultadosPorConsulta,
          signal,
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
    for (let puesto = 0; puesto < opciones.resultadosPorConsulta; puesto++) {
      for (const resultados of porConsulta) {
        const resultado = resultados[puesto];
        const clave = resultado && normalizarUrl(resultado.url);
        if (!clave || conversacion.vistas.has(clave) || candidatas.length >= cupo) continue;
        conversacion.vistas.add(clave);
        candidatas.push(resultado);
      }
    }
    await enParalelo(candidatas, opciones.tareasEnParalelo, async (candidata) => {
      if (!agotada(conversacion)) await analizar(conversacion, candidata, contexto);
    });
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

    emitir("etapa", { texto: "Planificando la investigación" });
    let consultas = [];
    conversacion.irrelevantesSeguidas = 0;
    try {
      const plan = await llm.completarJSON(
        promptPlan(conversacion.tema, opciones.consultasIniciales, {
          multilingue: opciones.multilingue,
        }),
        contexto,
      );
      consultas = consultasDe(plan.consultas).slice(0, opciones.consultasIniciales);
      if (opciones.multilingue) conversacion.idiomas = idiomasDe(plan.idiomas, consultas);
    } catch (error) {
      if (!(error instanceof ErrorFormato)) throw error;
    }
    if (!consultas.length) consultas = [{ texto: conversacion.tema }];

    const idiomas =
      conversacion.idiomas?.length > 1 ? ` en ${nombresDe(conversacion.idiomas)}` : "";
    emitir("etapa", { texto: `Buscando y leyendo fuentes${idiomas}` });
    await incorporar(conversacion, consultas, contexto, cupo());

    for (let ronda = 1; ronda <= opciones.rondasExtra && cupo() > 0; ronda++) {
      if (!conversacion.fuentes.length || agotada(conversacion)) break;
      emitir("etapa", { texto: "Revisando qué falta cubrir" });
      let nuevas = [];
      try {
        const revision = await llm.completarJSON(
          promptRevision(conversacion, opciones.consultasPorRonda),
          contexto,
        );
        if (revision.completo !== true) {
          nuevas = consultasDe(revision.consultas)
            .filter((consulta) => !conversacion.consultas.includes(consulta.texto))
            .slice(0, opciones.consultasPorRonda);
        }
      } catch (error) {
        if (!(error instanceof ErrorFormato)) throw error;
      }
      if (!nuevas.length) break;
      emitir("etapa", { texto: `Profundizando (ronda ${ronda + 1})` });
      await incorporar(conversacion, nuevas, contexto, cupo());
    }

    if (agotada(conversacion)) {
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
