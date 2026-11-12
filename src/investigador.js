import { ErrorFormato } from "./llm.js";
import {
  promptDecision,
  promptInforme,
  promptNotas,
  promptPlan,
  promptRevision,
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

const listaDeTextos = (valor) =>
  Array.isArray(valor)
    ? valor.filter((texto) => typeof texto === "string" && texto.trim()).map((texto) => texto.trim())
    : [];

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
      if (!notas || /^\W*IRRELEVANTE\W*$/i.test(notas)) throw new Error("no aporta al tema");

      const fuente = { n: conversacion.fuentes.length + 1, url: candidata.url, titulo, notas };
      conversacion.fuentes.push(fuente);
      emitir("fuente", { id, url: fuente.url, titulo, estado: "lista", n: fuente.n });
    } catch (error) {
      if (signal.aborted) throw error;
      emitir("fuente", { id, estado: "descartada", motivo: error.message });
    }
  }

  async function incorporar(conversacion, consultas, contexto, cupo) {
    const { emitir, signal } = contexto;
    const porConsulta = [];
    await enParalelo(consultas, opciones.tareasEnParalelo, async (consulta, indice) => {
      emitir("consulta", { texto: consulta });
      conversacion.consultas.push(consulta);
      try {
        const { resultados } = await buscar(consulta, {
          cantidad: opciones.resultadosPorConsulta,
          signal,
        });
        porConsulta[indice] = resultados;
      } catch (error) {
        if (signal.aborted) throw error;
        console.warn(`Falló la búsqueda "${consulta}": ${error.message}`);
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
    await enParalelo(candidatas, opciones.tareasEnParalelo, (candidata) =>
      analizar(conversacion, candidata, contexto),
    );
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
    try {
      const plan = await llm.completarJSON(
        promptPlan(conversacion.tema, opciones.consultasIniciales),
        contexto,
      );
      consultas = listaDeTextos(plan.consultas).slice(0, opciones.consultasIniciales);
    } catch (error) {
      if (!(error instanceof ErrorFormato)) throw error;
    }
    if (!consultas.length) consultas = [conversacion.tema];

    emitir("etapa", { texto: "Buscando y leyendo fuentes" });
    await incorporar(conversacion, consultas, contexto, cupo());

    for (let ronda = 1; ronda <= opciones.rondasExtra && cupo() > 0; ronda++) {
      if (!conversacion.fuentes.length) break;
      emitir("etapa", { texto: "Revisando qué falta cubrir" });
      let nuevas = [];
      try {
        const revision = await llm.completarJSON(
          promptRevision(conversacion, opciones.consultasPorRonda),
          contexto,
        );
        if (revision.completo !== true) {
          nuevas = listaDeTextos(revision.consultas)
            .filter((consulta) => !conversacion.consultas.includes(consulta))
            .slice(0, opciones.consultasPorRonda);
        }
      } catch (error) {
        if (!(error instanceof ErrorFormato)) throw error;
      }
      if (!nuevas.length) break;
      emitir("etapa", { texto: `Profundizando (ronda ${ronda + 1})` });
      await incorporar(conversacion, nuevas, contexto, cupo());
    }

    if (!conversacion.fuentes.length) {
      throw (
        conversacion.ultimoFallo ??
        new ErrorInvestigacion("No encontré fuentes legibles sobre ese tema. Probá reformularlo.")
      );
    }

    emitir("etapa", { texto: "Redactando el informe" });
    const cuerpo = await llm.completarEnVivo(promptInforme(conversacion), {
      ...contexto,
      alRecibir: (delta) => emitir("texto", { delta }),
    });
    const anexo = listaDeFuentes(conversacion.fuentes, cuerpo);
    emitir("texto", { delta: anexo });
    conversacion.informe = cuerpo + anexo;
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
        consultas = listaDeTextos(decision.consultas).slice(0, opciones.consultasPorRonda);
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
