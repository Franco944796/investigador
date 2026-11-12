import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { crearAlmacenMemoria } from "../src/almacen.js";
import { cliente, crearAcceso, crearAlmacenPGlite, levantar, textoDe, ultimoTurno } from "./ayuda.js";
import { iniciarLLMSimulado } from "./simulados.js";

const ENTORNO = {
  CONSULTAS_INICIALES: "2",
  RESULTADOS_POR_CONSULTA: "4",
  ORIGENES_PERMITIDOS: "https://franco944796.github.io/",
};
const PAGES = "https://franco944796.github.io";
const cerrar = [];

let llmSimulado;
let base;

before(async () => {
  llmSimulado = await iniciarLLMSimulado();
  const levantado = await levantar({
    acceso: crearAcceso("ana:codigo-de-ana:1,beto:codigo-de-beto:0"),
    almacen: crearAlmacenMemoria(),
    urlLLM: llmSimulado.urlBase,
    entorno: ENTORNO,
  });
  cerrar.push(levantado.servidor);
  base = levantado.base;
});

after(() => {
  for (const servidor of cerrar) servidor.close();
  llmSimulado.cerrar();
});

test("sin sesión no se puede investigar y el código incorrecto se rechaza", async () => {
  const anonimo = cliente(base);
  assert.equal((await anonimo.investigar("algo")).status, 401);
  assert.equal((await anonimo.entrar("codigo-falso")).status, 401);
  const falso = { cabeceras: { Authorization: "Bearer YW5h.9999999999999.firma" } };
  assert.equal((await anonimo.pedir("/api/sesion", falso)).status, 401);
});

test("la sesión viaja como token en la cabecera, sin cookie", async () => {
  const ana = cliente(base);
  const respuesta = await ana.entrar("codigo-de-ana");
  assert.equal(respuesta.headers.get("set-cookie"), null);
  const { nombre, token } = await respuesta.json();
  assert.equal(nombre, "ana");
  assert.match(token, /^[\w-]+\.\d+\.[\w-]+$/);
  assert.equal((await ana.pedir("/api/sesion")).status, 200);
});

test("la API acepta pedidos desde GitHub Pages y no desde otros sitios", async () => {
  const anonimo = cliente(base);
  const previo = await anonimo.pedir("/api/investigar", {
    metodo: "OPTIONS",
    cabeceras: {
      Origin: PAGES,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    },
  });
  assert.equal(previo.status, 204);
  assert.equal(previo.headers.get("access-control-allow-origin"), PAGES);
  assert.match(previo.headers.get("access-control-allow-headers"), /Authorization/);
  assert.match(previo.headers.get("access-control-allow-methods"), /DELETE/);

  const permitido = await anonimo.pedir("/api/sesion", { cabeceras: { Origin: PAGES } });
  assert.equal(permitido.headers.get("access-control-allow-origin"), PAGES);
  assert.match(permitido.headers.get("access-control-expose-headers"), /Content-Disposition/);
  assert.match(permitido.headers.get("vary"), /Origin/);

  const ajeno = await anonimo.pedir("/api/sesion", {
    cabeceras: { Origin: "https://otro.github.io" },
  });
  assert.equal(ajeno.headers.get("access-control-allow-origin"), null);
});

test("investigación en segundo plano, seguimiento, PDF, historial y límite diario", async () => {
  const ana = cliente(base);
  await ana.entrar("codigo-de-ana");

  const pedido = await ana.investigar("Tema de prueba");
  assert.equal(pedido.status, 202);
  const { conversacion, uso } = await pedido.json();
  assert.deepEqual(uso, { usadas: 1, limite: 1 });

  const { eventos } = await ana.eventos(conversacion);
  const tipos = eventos.map((evento) => evento.tipo);
  assert.deepEqual(tipos.slice(0, 2), ["pregunta", "inicio"]);
  assert.equal(tipos.at(-1), "fin");
  assert.ok(tipos.includes("espera"), "el 429 inicial debe avisar que espera");

  const consultas = eventos.filter((evento) => evento.tipo === "consulta").map((e) => e.datos.texto);
  assert.deepEqual(consultas, ["primera consulta", "segunda consulta", "consulta extra"]);

  const fuentes = eventos.filter((evento) => evento.tipo === "fuente").map((evento) => evento.datos);
  const listas = fuentes.filter((fuente) => fuente.estado === "lista");
  assert.equal(listas.length, 6);
  const motivos = fuentes.filter((f) => f.estado === "descartada").map((f) => f.motivo);
  assert.equal(motivos.filter((motivo) => motivo === "respondió 403").length, 3);
  assert.equal(motivos.filter((motivo) => motivo === "no aporta al tema").length, 3);

  const informe = textoDe(eventos);
  assert.ok(informe.startsWith("# Informe de prueba"));
  assert.ok(!informe.includes("plan interno"), "el razonamiento del modelo no se muestra");
  assert.match(informe, /## Fuentes\n\n- \*\*1\.\*\* \[.+\]\(https:\/\/ejemplo\.test\/.+\)\n- \*\*2\.\*\*/);
  assert.ok(!informe.includes("**3.**"), "solo se listan las fuentes citadas");
  const repeticion = (await ana.eventos(conversacion)).eventos;
  assert.equal(repeticion.filter((e) => e.tipo === "texto").length, 1, "el texto se guarda unido");
  assert.equal(textoDe(repeticion), informe);

  const seguir = await ana.pedir(`/api/conversaciones/${conversacion}/preguntas`, {
    metodo: "POST",
    cuerpo: { pregunta: "¿Cuál conviene?" },
  });
  assert.equal(seguir.status, 202);
  const turno = ultimoTurno((await ana.eventos(conversacion, { terminales: 2 })).eventos);
  assert.deepEqual(turno[0], { tipo: "pregunta", datos: { texto: "¿Cuál conviene?" } });
  assert.equal(textoDe(turno), "Según el informe, la opción B duplica a la A [2].");
  assert.ok(turno.some((e) => e.tipo === "consulta" && e.datos.texto === "consulta de seguimiento"));
  assert.equal(turno.at(-1).tipo, "fin");

  const pdf = await ana.pedir(`/api/informe/${conversacion}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-disposition"), /filename="tema-de-prueba\.pdf"/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");

  const lista = await (await ana.pedir("/api/conversaciones")).json();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].estado, "lista");
  assert.equal(lista[0].titulo, "Tema de prueba");

  const beto = cliente(base);
  await beto.entrar("codigo-de-beto");
  assert.equal((await beto.pedir(`/api/informe/${conversacion}`)).status, 404);
  assert.equal((await beto.eventos(conversacion)).estado, 404);
  assert.deepEqual(await (await beto.pedir("/api/conversaciones")).json(), []);

  assert.equal((await ana.investigar("Otro tema")).status, 429);
  assert.equal((await ana.investigar("Otro tema", "inventada")).status, 400);
});

test("el historial sobrevive a un reinicio del servidor y se puede borrar", async () => {
  const almacen = await crearAlmacenPGlite();
  const acceso = crearAcceso("ana:codigo-de-ana:0");
  const primero = await levantar({ acceso, almacen, urlLLM: llmSimulado.urlBase, entorno: ENTORNO });
  const antes = cliente(primero.base);
  await antes.entrar("codigo-de-ana");
  const { conversacion } = await (await antes.investigar("Pregunta: ¿Sirve?\nExcluir: nada")).json();
  const original = (await antes.eventos(conversacion)).eventos;
  assert.equal(original.at(-1).tipo, "fin");
  primero.servidor.close();

  const segundo = await levantar({ acceso, almacen, urlLLM: llmSimulado.urlBase, entorno: ENTORNO });
  cerrar.push(segundo.servidor);
  const despues = cliente(segundo.base);
  await despues.entrar("codigo-de-ana");

  const lista = await (await despues.pedir("/api/conversaciones")).json();
  assert.deepEqual(
    lista.map(({ titulo, estado }) => ({ titulo, estado })),
    [{ titulo: "¿Sirve?", estado: "lista" }],
  );

  const repetidos = (await despues.eventos(conversacion, { hastaListo: true })).eventos;
  const sinTexto = (lista) => lista.filter((evento) => !["texto", "listo"].includes(evento.tipo));
  assert.deepEqual(sinTexto(repetidos.slice(0, -1)), sinTexto(original));
  assert.equal(textoDe(repetidos), textoDe(original));
  assert.deepEqual(repetidos.at(-1), { tipo: "listo", datos: { ocupada: false } });

  const pdf = await despues.pedir(`/api/informe/${conversacion}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-disposition"), /filename="sirve\.pdf"/);

  await despues.pedir(`/api/conversaciones/${conversacion}/preguntas`, {
    metodo: "POST",
    cuerpo: { pregunta: "¿Y entonces?" },
  });
  const turno = ultimoTurno((await despues.eventos(conversacion, { terminales: 2 })).eventos);
  assert.equal(turno.at(-1).tipo, "fin");

  assert.equal((await despues.pedir(`/api/conversaciones/${conversacion}`, { metodo: "DELETE" })).status, 204);
  assert.equal((await despues.eventos(conversacion)).estado, 404);
  assert.deepEqual(await (await despues.pedir("/api/conversaciones")).json(), []);
  assert.equal(await almacen.obtener(conversacion), null);
});
