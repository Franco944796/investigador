import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as esperar } from "node:timers/promises";
import { crearAlmacenMemoria } from "../src/almacen.js";
import { cliente, crearAcceso, levantar } from "./ayuda.js";
import { iniciarLLMSimulado } from "./simulados.js";

let llmSimulado;
let servidor;
let ana;

before(async () => {
  llmSimulado = await iniciarLLMSimulado();
  const levantado = await levantar({
    acceso: crearAcceso("ana:codigo-de-ana:0"),
    almacen: crearAlmacenMemoria(),
    urlLLM: llmSimulado.urlBase,
    entorno: { CONSULTAS_INICIALES: "1", RONDAS_EXTRA: "0", INVESTIGACIONES_SIMULTANEAS: "1" },
    demoraLectorMs: 300,
  });
  servidor = levantado.servidor;
  ana = cliente(levantado.base);
  await ana.entrar("codigo-de-ana");
});

after(() => {
  servidor.close();
  llmSimulado.cerrar();
});

const iniciar = async (tema) => (await (await ana.investigar(tema)).json()).conversacion;
const terminal = async (id) => (await ana.eventos(id)).eventos.at(-1).tipo;
const estadoEnLista = async (id) =>
  (await (await ana.pedir("/api/conversaciones")).json()).find((item) => item.id === id).estado;
const cancelar = (id) => ana.pedir(`/api/conversaciones/${id}/cancelar`, { metodo: "POST" });

test("cerrar la página no corta la investigación; Detener sí, y libera el turno", async () => {
  const primera = await iniciar("Tema que sigue sola");
  const control = new AbortController();
  const vista = ana.pedir(`/api/conversaciones/${primera}/eventos`, { signal: control.signal });
  await vista;
  control.abort();
  assert.equal(await terminal(primera), "fin", "terminó aunque se cortó la conexión");

  const cancelada = await iniciar("Tema que se cancela");
  await esperar(100);
  assert.equal((await cancelar(cancelada)).status, 200);
  assert.equal(await terminal(cancelada), "cancelada");
  assert.equal(await estadoEnLista(cancelada), "cancelada");
  assert.equal((await cancelar(cancelada)).status, 409);

  assert.equal(await terminal(await iniciar("Tema siguiente")), "fin");
});

test("con un solo turno, la segunda espera en cola y se puede cancelar mientras espera", async () => {
  const [primera, segunda] = await Promise.all([iniciar("Tema uno"), iniciar("Tema dos")]);
  const enCola = (await ana.eventos(segunda, { hastaListo: true })).eventos;
  assert.ok(enCola.some((e) => e.tipo === "etapa" && e.datos.texto === "En cola (puesto 1)"));

  await cancelar(segunda);
  assert.equal(await terminal(segunda), "cancelada");
  assert.equal(await estadoEnLista(primera), "en-curso", "la primera sigue mientras tanto");
  assert.equal(await terminal(primera), "fin");

  const [tercera, cuarta] = await Promise.all([iniciar("Tema tres"), iniciar("Tema cuatro")]);
  assert.deepEqual(await Promise.all([terminal(tercera), terminal(cuarta)]), ["fin", "fin"]);
});
