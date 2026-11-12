import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Acceso } from "../src/acceso.js";
import { crearAlmacenSQL } from "../src/almacen.js";
import { crearApp } from "../src/app.js";
import { leerConfig } from "../src/config.js";
import { crearInvestigador } from "../src/investigador.js";
import { crearLLM } from "../src/llm.js";
import { generarPDF } from "../src/pdf.js";
import { buscarSimulado, crearLectorSimulado } from "./simulados.js";

const TERMINALES = new Set(["fin", "error", "cancelada"]);

export function crearAcceso(codigos) {
  return new Acceso({
    codigos,
    limiteDiario: 5,
    secreto: "secreto-de-prueba",
    archivoUso: join(mkdtempSync(join(tmpdir(), "investigador-")), "uso.json"),
  });
}

export async function crearAlmacenPGlite() {
  const base = new PGlite();
  return crearAlmacenSQL(async (texto, parametros) => (await base.query(texto, parametros)).rows);
}

export async function levantar({ acceso, almacen, urlLLM, entorno = {}, demoraLectorMs = 0 }) {
  const config = leerConfig(entorno);
  const investigador = crearInvestigador({
    llm: crearLLM([{ urlBase: urlLLM, clave: "", modelo: "auto" }], { esperas: [5, 5] }),
    buscar: buscarSimulado,
    leerPagina: crearLectorSimulado({ demoraMs: demoraLectorMs }),
    opciones: config.investigacion,
  });
  await almacen.preparar();
  const app = crearApp({ config, acceso, investigador, almacen, generarPDF });
  const servidor = app.listen(0, "127.0.0.1");
  await new Promise((listo) => servidor.once("listening", listo));
  return { app, servidor, base: `http://127.0.0.1:${servidor.address().port}` };
}

export function cliente(base) {
  let token = "";
  const pedir = (ruta, { metodo = "GET", cuerpo, signal, cabeceras = {} } = {}) =>
    fetch(base + ruta, {
      method: metodo,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...cabeceras,
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal,
    });

  return {
    pedir,
    async entrar(codigo) {
      const respuesta = await pedir("/api/entrar", { metodo: "POST", cuerpo: { codigo } });
      if (respuesta.ok) token = (await respuesta.clone().json()).token;
      return respuesta;
    },
    async investigar(tema) {
      return pedir("/api/investigar", { metodo: "POST", cuerpo: { tema } });
    },
    // Lee el flujo de una conversación hasta juntar `terminales` turnos terminados (o hasta el
    // evento "listo", si se pide) y corta la conexión.
    async eventos(id, { terminales = 1, hastaListo = false } = {}) {
      const control = new AbortController();
      const respuesta = await pedir(`/api/conversaciones/${id}/eventos`, { signal: control.signal });
      if (!respuesta.ok) return { estado: respuesta.status, eventos: [] };
      const eventos = [];
      let pendiente = "";
      let cuenta = 0;
      const decodificador = new TextDecoder();
      try {
        for await (const trozo of respuesta.body) {
          pendiente += decodificador.decode(trozo, { stream: true });
          const bloques = pendiente.split("\n\n");
          pendiente = bloques.pop();
          for (const bloque of bloques) {
            const tipo = bloque.match(/^event: (.+)$/m)?.[1];
            if (!tipo) continue;
            eventos.push({ tipo, datos: JSON.parse(bloque.match(/^data: (.+)$/m)[1]) });
            if (TERMINALES.has(tipo)) cuenta++;
            if ((hastaListo && tipo === "listo") || (!hastaListo && cuenta >= terminales)) {
              control.abort();
              return { estado: 200, eventos };
            }
          }
        }
      } catch (error) {
        if (!control.signal.aborted) throw error;
      }
      return { estado: 200, eventos };
    },
  };
}

export const textoDe = (eventos) =>
  eventos
    .filter((evento) => evento.tipo === "texto")
    .map((evento) => evento.datos.delta)
    .join("");

// Eventos del último turno (desde la última "pregunta").
export function ultimoTurno(eventos) {
  const inicio = eventos.findLastIndex((evento) => evento.tipo === "pregunta");
  return eventos.slice(inicio);
}
