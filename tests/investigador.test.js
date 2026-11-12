import assert from "node:assert/strict";
import { test } from "node:test";
import { crearConversacion, crearInvestigador } from "../src/investigador.js";

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
