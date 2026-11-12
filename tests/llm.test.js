import assert from "node:assert/strict";
import { test } from "node:test";
import { leerConfig } from "../src/config.js";
import { crearLLM, ErrorLLM } from "../src/llm.js";
import { iniciarLLMSimulado } from "./simulados.js";

const PEDIDO = [{ role: "user", content: "Resumí la página o respondé IRRELEVANTE" }];
const proveedor = (simulado) => ({ urlBase: simulado.urlBase, clave: "", modelo: "auto" });

test("si un proveedor no tiene cupo se pasa al siguiente sin esperar y se lo deja descansar", async () => {
  const agotado = await iniciarLLMSimulado({ sinCupo: true });
  const disponible = await iniciarLLMSimulado({ fallaPrimero: false });
  const esperas = [];
  const llm = crearLLM([proveedor(agotado), proveedor(disponible)], { esperas: [10000] });
  try {
    const opciones = { alEsperar: (segundos) => esperas.push(segundos) };
    assert.match(await llm.completar(PEDIDO, opciones), /Notas/);
    assert.match(await llm.completar(PEDIDO, opciones), /Notas/);
    assert.deepEqual(esperas, []);
    assert.equal(agotado.estado.pedidos, 1, "el agotado no se vuelve a probar mientras descansa");
    assert.equal(disponible.estado.pedidos, 2);
  } finally {
    agotado.cerrar();
    disponible.cerrar();
  }
});

test("si todos fallan se reintenta con espera y al final se informa el error", async () => {
  const agotado = await iniciarLLMSimulado({ sinCupo: true });
  const esperas = [];
  const llm = crearLLM([proveedor(agotado)], { esperas: [5, 5] });
  try {
    await assert.rejects(
      llm.completar(PEDIDO, { alEsperar: (segundos) => esperas.push(segundos) }),
      (error) => error instanceof ErrorLLM && /respondió 429/.test(error.message),
    );
    assert.equal(esperas.length, 2);
    assert.equal(agotado.estado.pedidos, 3);
  } finally {
    agotado.cerrar();
  }
});

test("sin proveedores configurados el error lo dice, sin reintentar", async () => {
  const esperas = [];
  await assert.rejects(
    crearLLM([]).completar(PEDIDO, { alEsperar: (segundos) => esperas.push(segundos) }),
    /No hay proveedores de modelos configurados/,
  );
  assert.deepEqual(esperas, []);
});

test("configuración: proveedores numerados con clave, o el endpoint único como respaldo", () => {
  const varios = leerConfig({
    LLM_1_URL: "https://uno.test/v1/",
    LLM_1_CLAVE: "clave-uno",
    LLM_1_MODELO: "modelo-uno, modelo-respaldo",
    LLM_2_URL: "https://sin-clave.test/v1",
    LLM_3_URL: "https://tres.test/v1",
    LLM_3_CLAVE: "clave-tres",
    PORT: "10000",
    CONFIAR_EN_PROXY: "2",
  });
  assert.deepEqual(varios.proveedores, [
    { urlBase: "https://uno.test/v1", clave: "clave-uno", modelo: "modelo-uno" },
    { urlBase: "https://uno.test/v1", clave: "clave-uno", modelo: "modelo-respaldo" },
    { urlBase: "https://tres.test/v1", clave: "clave-tres", modelo: "auto" },
  ]);
  assert.equal(varios.puerto, 10000);
  assert.equal(varios.confiarEnProxy, 2);
  assert.deepEqual(leerConfig({}).proveedores, []);
  assert.deepEqual(leerConfig({ LLM_URL_BASE: "http://localhost:8080/v1/" }).proveedores, [
    { urlBase: "http://localhost:8080/v1", clave: "", modelo: "auto" },
  ]);
});
