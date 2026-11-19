import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { crearConversacion, ErrorInvestigacion, normalizarUrl, numeracionContinua } from "./investigador.js";
import { ErrorLLM } from "./llm.js";
import { ErrorPDF } from "./pdfAparte.js";
import { nombreDeArchivo, tituloDelPedido } from "./titulos.js";
import { VENDOR } from "./vendor.js";

const LATIDO_MS = 15000;
const MAX_TEXTO = 2000;
// Con cientos de fuentes el registro pesa cerca de medio megabyte: reescribirlo cada 30 s durante
// horas generaba más de 100 MB de escrituras en Neon por investigación.
const GUARDADO_MS = 120000;
const RETENER_EN_MEMORIA_MS = 10 * 60 * 1000;
const ESTADO_FINAL = { completa: "lista", fallida: "fallida", cancelada: "cancelada" };

// Se retoma una investigación que se cortó (reinicio del servidor), falló o se detuvo a mano,
// antes de terminar el informe. Las guardadas antes de que existiera `progreso` no tienen con qué
// retomarse.
const retomable = (conversacion) =>
  !conversacion.ocupada &&
  !conversacion.informe &&
  ["interrumpida", "fallida", "cancelada"].includes(conversacion.estado) &&
  Boolean(conversacion.progreso);

// Las fuentes que se estaban leyendo cuando se cortó: se dan por perdidas y su dirección se libera
// para que otra búsqueda pueda traerlas de nuevo.
function lecturasCortadas(eventos) {
  const leyendo = new Map();
  for (const { tipo, datos } of eventos) {
    if (tipo !== "fuente") continue;
    if (datos.estado === "leyendo") leyendo.set(datos.id, datos.url);
    else leyendo.delete(datos.id);
  }
  return leyendo;
}

const ruta = (relativa) => fileURLToPath(new URL(relativa, import.meta.url));

const POLITICA_DE_CONTENIDO = [
  "default-src 'self'",
  // Las imágenes de las fuentes se muestran desde su sitio, con crédito y enlace.
  "img-src 'self' data: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Token en una cabecera y no en una cookie: la página también se publica en GitHub Pages, otro
// sitio, y Safari bloquea las cookies entre sitios distintos.
const leerToken = (req) => req.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? null;

// En Render, X-Forwarded-For termina con la IP del borde de Cloudflare, que cambia entre pedidos:
// los intentos fallidos nunca se juntaban. Cloudflare reescribe CF-Connecting-IP, así que no se
// puede falsificar desde afuera.
const ipDe = (req, cabecera) => (cabecera && req.get(cabecera)?.trim()) || req.ip;

function textoValido(valor) {
  const texto = typeof valor === "string" ? valor.trim() : "";
  return texto.length >= 3 && texto.length <= MAX_TEXTO ? texto : null;
}

function crearCola(simultaneas) {
  let activas = 0;
  const enEspera = [];
  return async function conTurno(tarea, { alEsperar, signal }) {
    if (activas >= simultaneas) {
      alEsperar(enEspera.length + 1);
      await new Promise((seguir, fallar) => {
        const turno = () => {
          signal.removeEventListener("abort", salir);
          seguir();
        };
        const salir = () => {
          enEspera.splice(enEspera.indexOf(turno), 1);
          fallar(signal.reason);
        };
        enEspera.push(turno);
        signal.addEventListener("abort", salir, { once: true });
      });
    } else {
      activas++;
    }
    try {
      return await tarea();
    } finally {
      // Si hay alguien esperando, hereda el lugar: `activas` no cambia.
      const siguiente = enEspera.shift();
      if (siguiente) siguiente();
      else activas--;
    }
  };
}

function abrirFlujo(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    // Sin esto, nginx y otros proxies retienen la respuesta hasta que termina.
    "X-Accel-Buffering": "no",
  });
  const latido = setInterval(() => res.write(": latido\n\n"), LATIDO_MS);
  res.on("close", () => clearInterval(latido));
  return (tipo, datos = {}) => {
    if (!res.writableEnded) res.write(`event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`);
  };
}

function mensajeDeError(error) {
  if (error instanceof ErrorInvestigacion) return error.message;
  if (error instanceof ErrorLLM) {
    return `El servicio de modelos falló. Probá de nuevo en unos minutos. (${error.message.slice(0, 200)})`;
  }
  return "Ocurrió un error inesperado. Probá de nuevo.";
}

function aRegistro(conversacion) {
  const { id, dueno, tema, profundidad, estado, etapa, creada, actualizada } = conversacion;
  return {
    id,
    dueno,
    tema,
    profundidad,
    estado,
    etapa,
    creada,
    actualizada,
    datos: {
      fuentes: conversacion.fuentes,
      consultas: conversacion.consultas,
      vistas: [...conversacion.vistas],
      candidatas: conversacion.candidatas,
      informe: conversacion.informe,
      intercambios: conversacion.intercambios,
      eventos: conversacion.eventos,
      aspectos: conversacion.aspectos,
      pendientes: conversacion.pendientes,
      // Para poder retomarla si se corta (ver investigar con `retomar`).
      rendimiento: conversacion.rendimiento,
      destinos: conversacion.destinos,
      idiomas: conversacion.idiomas,
      progreso: conversacion.progreso,
      fuentesEnInforme: conversacion.fuentesEnInforme,
    },
  };
}

// Resumen de la investigación (primer turno, antes de las preguntas de seguimiento).
export function datosDeInvestigacion(eventos) {
  const fin = eventos.findIndex((evento) => ["fin", "error", "cancelada"].includes(evento.tipo));
  const turno = fin === -1 ? eventos : eventos.slice(0, fin + 1);
  const de = (tipo) => turno.filter((evento) => evento.tipo === tipo);
  const fuentes = de("fuente");
  return {
    busquedas: de("consulta").length,
    idiomas: [...new Set(de("consulta").map((evento) => evento.datos.idioma).filter(Boolean))],
    leidas: fuentes.filter((evento) => evento.datos.estado === "lista").length,
    descartadas: fuentes.filter((evento) => evento.datos.estado === "descartada").length,
    inicio: de("inicio")[0]?.datos.hora ?? null,
    fin: de("fin")[0]?.datos.hora ?? null,
  };
}

function enMemoria(conversacion, extra) {
  return Object.assign(conversacion, {
    eventos: [],
    suscriptores: new Set(),
    control: null,
    guardando: Promise.resolve(),
    ...extra,
  });
}

function desdeRegistro(registro) {
  const { datos, ...campos } = registro;
  const conversacion = crearConversacion(registro.id, registro.dueno, registro.tema);
  return enMemoria(conversacion, { ...campos, ...datos, vistas: new Set(datos.vistas) });
}

const PDFS_GUARDADOS = 3;
const MINIMO_AGREGADO = 200;
const MAX_PDF_SUBIDO = 50 * 1024 * 1024;

// El PDF subido va directo a un archivo temporal mientras llega: guardado en memoria, uno de 50 MB
// (más su copia al proceso que lo lee) dejaba al servidor al borde de los 512 MB de Render.
async function guardarSubida(req, limite) {
  const ruta = join(tmpdir(), `investigador-${randomUUID()}.pdf`);
  let bytes = 0;
  const contar = new Transform({
    transform(trozo, codificacion, listo) {
      bytes += trozo.length;
      listo(bytes > limite ? Object.assign(new Error("PDF demasiado grande"), { status: 413 }) : null, trozo);
    },
  });
  try {
    await pipeline(req, contar, createWriteStream(ruta));
  } catch (error) {
    await rm(ruta, { force: true });
    throw error;
  }
  return { ruta, bytes };
}

// Fuentes que todavía no están en el informe (agregadas a mano después de redactarlo).
const paraRehacer = (conversacion) =>
  conversacion.fuentes.length -
  (conversacion.fuentesEnInforme ??
    conversacion.fuentes.filter((fuente) => !fuente.agregada).length);

export function crearApp({
  config,
  acceso,
  investigador,
  almacen,
  generarPDF,
  extraerTextoPDF,
  saldos,
}) {
  // Los últimos PDF armados (hasta ~4 MB cada uno), para no rearmarlos en cada descarga. Viven en
  // memoria: tras un reinicio se arman de nuevo.
  const pdfsGuardados = new Map();
  const opciones = config.investigacion;
  const activas = new Map();
  const cargando = new Map();
  const programados = new Map();
  // Una sola tarea a la vez, sin variable para cambiarlo (decisión de Franco, 2026-11-16): con
  // 512 MB en Render, dos investigaciones grandes juntas pueden agotar la memoria y reiniciar el
  // servidor, que corta todo lo que esté corriendo. Las demás esperan en cola.
  const conTurno = crearCola(1);
  // Fuentes agregadas a mano que se están analizando ("id url"): se pierde con un reinicio, y
  // entonces su estado «procesando» guardado se muestra como cortado.
  const analizando = new Set();
  const pendientesDe = (conversacion) =>
    (conversacion.pendientes ?? []).map((pendiente) =>
      pendiente.estado === "procesando" && !analizando.has(`${conversacion.id} ${pendiente.url}`)
        ? { ...pendiente, estado: "error", mensaje: "Se cortó mientras se analizaba: probá de nuevo." }
        : pendiente,
    );

  function guardar(conversacion) {
    clearTimeout(programados.get(conversacion.id));
    programados.delete(conversacion.id);
    conversacion.guardando = conversacion.guardando
      .then(() => almacen.guardar(aRegistro(conversacion)))
      .catch((error) => console.error(`No se pudo guardar ${conversacion.id}: ${error.message}`));
    return conversacion.guardando;
  }

  // Mientras investiga se guarda cada tanto, no en cada evento: así la base gratuita no queda
  // trabajando sin pausa durante horas.
  function programarGuardado(conversacion) {
    if (programados.has(conversacion.id)) return;
    programados.set(
      conversacion.id,
      setTimeout(() => guardar(conversacion), GUARDADO_MS),
    );
  }

  function registrar(conversacion, tipo, datos = {}) {
    // Con la hora de cada etapa se puede ver después en qué se fue el tiempo de una investigación.
    if (tipo === "etapa") datos = { ...datos, hora: Date.now() };
    const ultimo = conversacion.eventos.at(-1);
    if (tipo === "texto" && ultimo?.tipo === "texto") {
      ultimo.datos = { delta: ultimo.datos.delta + datos.delta };
    } else {
      conversacion.eventos.push({ tipo, datos });
    }
    if (tipo === "etapa") conversacion.etapa = datos.texto;
    conversacion.actualizada = Date.now();
    for (const enviar of conversacion.suscriptores) enviar(tipo, datos);
    programarGuardado(conversacion);
  }

  setInterval(() => {
    const limite = Date.now() - RETENER_EN_MEMORIA_MS;
    for (const [id, conversacion] of activas) {
      const enUso = conversacion.ocupada || conversacion.suscriptores.size;
      if (enUso || conversacion.actualizada > limite || programados.has(id)) continue;
      conversacion.guardando.then(() => {
        if (!conversacion.ocupada && !conversacion.suscriptores.size) activas.delete(id);
      });
    }
  }, 60 * 1000).unref();

  async function cargar(req, res, id) {
    let conversacion = activas.get(id);
    if (!conversacion && typeof id === "string") {
      if (!cargando.has(id)) {
        cargando.set(
          id,
          almacen
            .obtener(id)
            .then((registro) => {
              if (registro && !activas.has(id)) activas.set(id, desdeRegistro(registro));
              return activas.get(id);
            })
            .finally(() => cargando.delete(id)),
        );
      }
      conversacion = await cargando.get(id);
    }
    if (!conversacion || conversacion.dueno !== req.persona.nombre) {
      res.status(404).json({ error: "Esa investigación ya no existe." });
      return null;
    }
    return conversacion;
  }

  function lanzar(conversacion, persona, tarea, { esInvestigacion, retomada = false }) {
    const control = new AbortController();
    // El texto del informe no va al chat (Franco, 2026-11-16): queda en `conversacion.informe` y
    // se lee con «Ver informe» o el PDF. Así tampoco viaja en cada conexión ni ocupa la base dos
    // veces. El de las preguntas de seguimiento sí se muestra.
    const flujo = {
      signal: control.signal,
      emitir: (tipo, datos) => {
        if (!(esInvestigacion && tipo === "texto")) registrar(conversacion, tipo, datos);
      },
    };
    Object.assign(conversacion, { control, ocupada: true });
    if (esInvestigacion) conversacion.estado = "en-curso";
    flujo.emitir(retomada ? "retomada" : "inicio", { hora: Date.now() });

    return (async () => {
      let resultado = "completa";
      let fallo = null;
      try {
        await conTurno(
          () => {
            control.signal.throwIfAborted();
            return tarea(flujo);
          },
          {
            signal: control.signal,
            alEsperar: (puesto) => flujo.emitir("etapa", { texto: `En cola (puesto ${puesto})` }),
          },
        );
      } catch (error) {
        resultado = control.signal.aborted ? "cancelada" : "fallida";
        fallo = error;
        if (resultado === "fallida") console.error(error);
      }
      Object.assign(conversacion, { control: null, ocupada: false });
      // Si falla al rehacer un informe, el anterior sigue valiendo: queda «lista».
      if (esInvestigacion) {
        conversacion.estado =
          resultado !== "completa" && conversacion.informe ? "lista" : ESTADO_FINAL[resultado];
      }
      // Con el estado ya final, el aviso dice si se puede retomar: la página muestra el botón al
      // momento, sin esperar a reconectarse.
      const retomar = { retomable: retomable(conversacion) };
      if (resultado === "fallida") {
        flujo.emitir("error", { mensaje: mensajeDeError(fallo), hora: Date.now(), ...retomar });
      } else if (resultado === "cancelada") {
        flujo.emitir("cancelada", { hora: Date.now(), ...retomar });
      }
      if (esInvestigacion) {
        // Lo cancelado no se devuelve: cortar a mitad de camino ya gastó cuota de los proveedores.
        if (resultado === "fallida" && !retomada) acceso.registrarUso(persona, -1);
      }
      if (resultado === "completa") {
        flujo.emitir("fin", { uso: acceso.uso(persona), pdf: esInvestigacion, hora: Date.now() });
      }
      await guardar(conversacion);
    })();
  }

  const app = express();
  app.disable("x-powered-by");
  if (config.confiarEnProxy) app.set("trust proxy", config.confiarEnProxy);
  app.locals.hayTrabajo = () => [...activas.values()].some((conversacion) => conversacion.ocupada);

  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": POLITICA_DE_CONTENIDO,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.use((req, res, next) => {
    res.vary("Origin");
    const origen = req.get("origin")?.toLowerCase();
    if (origen && config.origenesPermitidos.includes(origen)) {
      res.set({
        "Access-Control-Allow-Origin": origen,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, DELETE",
        "Access-Control-Expose-Headers": "Content-Disposition",
        "Access-Control-Max-Age": "600",
      });
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  // Los pedidos son chicos; solo el contenido de una fuente agregada a mano puede ser grande y
  // trae su propio límite (ver la ruta de pendientes).
  const jsonChico = express.json({ limit: "20kb" });
  app.use((req, res, next) => (req.path.endsWith("/pendientes") ? next() : jsonChico(req, res, next)));
  app.use(express.static(ruta("../public")));
  for (const [nombre, archivo] of Object.entries(VENDOR)) {
    app.get(`/vendor/${nombre}`, (req, res) => res.sendFile(ruta(`../${archivo}`)));
  }
  app.get("/salud", (req, res) => res.type("text").send("ok"));

  const exigirSesion = (req, res, next) => {
    req.persona = acceso.verificar(leerToken(req));
    if (!req.persona) return res.status(401).json({ error: "Ingresá tu código de acceso." });
    next();
  };

  const datosDeSesion = (persona) => ({ nombre: persona.nombre, uso: acceso.uso(persona) });

  app.post("/api/entrar", (req, res) => {
    const { persona, token, bloqueado } = acceso.entrar(req.body?.codigo, ipDe(req, config.cabeceraIp));
    if (bloqueado) {
      return res.status(429).json({ error: "Demasiados intentos. Esperá unos minutos." });
    }
    if (!persona) return res.status(401).json({ error: "Código incorrecto." });
    res.json({ ...datosDeSesion(persona), token });
  });

  app.get("/api/sesion", exigirSesion, (req, res) => res.json(datosDeSesion(req.persona)));

  app.post("/api/investigar", exigirSesion, (req, res) => {
    const tema = textoValido(req.body?.tema);
    if (!tema) {
      return res.status(400).json({ error: `Escribí un tema de entre 3 y ${MAX_TEXTO} caracteres.` });
    }
    // Hay un solo tipo; el campo queda para distinguir las guardadas antes (normal, profunda).
    const profundidad = "exhaustiva";
    if (!acceso.puedeInvestigar(req.persona)) {
      return res.status(429).json({
        error: `Ya usaste tus ${req.persona.limite} investigaciones de hoy. Mañana se renuevan.`,
      });
    }

    acceso.registrarUso(req.persona);
    const conversacion = enMemoria(crearConversacion(randomUUID(), req.persona.nombre, tema), {
      profundidad,
      estado: "en-curso",
      etapa: "",
      creada: Date.now(),
    });
    activas.set(conversacion.id, conversacion);
    registrar(conversacion, "pregunta", { texto: tema, profundidad });
    lanzar(
      conversacion,
      req.persona,
      (flujo) => investigador.investigar(conversacion, flujo),
      { esInvestigacion: true },
    );
    guardar(conversacion);
    res.status(202).json({ conversacion: conversacion.id, uso: acceso.uso(req.persona) });
  });

  app.get("/api/conversaciones", exigirSesion, async (req, res) => {
    const porId = new Map(
      (await almacen.listar(req.persona.nombre)).map((registro) => [registro.id, registro]),
    );
    for (const conversacion of activas.values()) {
      if (conversacion.dueno === req.persona.nombre) porId.set(conversacion.id, conversacion);
    }
    const lista = [...porId.values()]
      .sort((a, b) => b.creada - a.creada)
      .map((conversacion) => ({
        id: conversacion.id,
        titulo: tituloDelPedido(conversacion.tema),
        profundidad: conversacion.profundidad,
        estado: conversacion.ocupada ? "en-curso" : conversacion.estado,
        etapa: conversacion.etapa,
        creada: conversacion.creada,
      }));
    res.json(lista);
  });

  app.get("/api/conversaciones/:id/eventos", exigirSesion, async (req, res) => {
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    const enviar = abrirFlujo(res);
    // Las guardadas antes de ese cambio tienen el informe en el primer turno: no se manda.
    let preguntas = 0;
    for (const { tipo, datos } of conversacion.eventos) {
      if (tipo === "pregunta") preguntas++;
      if (!(tipo === "texto" && preguntas <= 1)) enviar(tipo, datos);
    }
    // Marca el fin de la repetición; si no está ocupada y el último turno no terminó, el
    // servidor se reinició a mitad de camino.
    enviar("listo", { ocupada: conversacion.ocupada, retomable: retomable(conversacion) });
    conversacion.suscriptores.add(enviar);
    res.on("close", () => conversacion.suscriptores.delete(enviar));
  });

  app.post("/api/conversaciones/:id/preguntas", exigirSesion, async (req, res) => {
    const pregunta = textoValido(req.body?.pregunta);
    if (!pregunta) {
      return res.status(400).json({ error: `Escribí una pregunta de hasta ${MAX_TEXTO} caracteres.` });
    }
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    if (conversacion.ocupada || !conversacion.informe) {
      return res.status(409).json({ error: "Esperá a que termine la respuesta anterior." });
    }
    if (conversacion.intercambios.length >= opciones.seguimientosPorInforme) {
      return res.status(429).json({
        error: "Este informe llegó al máximo de preguntas. Empezá una investigación nueva.",
      });
    }
    registrar(conversacion, "pregunta", { texto: pregunta });
    lanzar(
      conversacion,
      req.persona,
      (flujo) => investigador.seguir(conversacion, pregunta, flujo),
      { esInvestigacion: false },
    );
    res.status(202).json({});
  });

  app.post("/api/conversaciones/:id/retomar", exigirSesion, async (req, res) => {
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    if (!retomable(conversacion)) {
      return res.status(409).json({ error: "Esta investigación no se puede retomar." });
    }
    const cortadas = lecturasCortadas(conversacion.eventos);
    for (const url of cortadas.values()) conversacion.vistas.delete(normalizarUrl(url));
    lanzar(
      conversacion,
      req.persona,
      (flujo) => {
        for (const id of cortadas.keys()) {
          flujo.emitir("fuente", { id, estado: "descartada", motivo: "se cortó mientras se leía" });
        }
        return investigador.investigar(conversacion, flujo, { retomar: true });
      },
      { esInvestigacion: true, retomada: true },
    );
    guardar(conversacion);
    res.status(202).json({ conversacion: conversacion.id });
  });

  // Contenido de una fuente que no se pudo leer: texto pegado (JSON) o su PDF. Se responde enseguida
  // y se analiza aparte; «Ver informe» consulta el estado hasta que termina.
  app.post(
    "/api/conversaciones/:id/pendientes",
    exigirSesion,
    express.json({ limit: "5mb" }),
    async (req, res) => {
      const conversacion = await cargar(req, res, req.params.id);
      if (!conversacion) return;
      const esPDF = Boolean(req.is("application/pdf"));
      const url = esPDF ? req.query.url : req.body?.url;
      const iguales = (conversacion.pendientes ?? []).filter((pendiente) => pendiente.url === url);
      if (!iguales.length) {
        return res.status(404).json({ error: "Esa fuente no está entre las que hay que revisar." });
      }
      const clave = `${conversacion.id} ${url}`;
      if (conversacion.ocupada) {
        return res.status(409).json({ error: "Esperá a que termine lo que está en curso." });
      }
      if (analizando.has(clave)) {
        return res.status(409).json({ error: "Esa fuente ya se está analizando." });
      }
      if (iguales[0].estado === "agregada") {
        return res.status(409).json({ error: "Esa fuente ya se agregó." });
      }
      const texto = esPDF ? null : typeof req.body?.texto === "string" ? req.body.texto.trim() : "";
      if (!esPDF && texto.length < MINIMO_AGREGADO) {
        return res.status(400).json({
          error: `Pegá el texto de la fuente (al menos ${MINIMO_AGREGADO} caracteres) o subí su PDF.`,
        });
      }
      let subido = null;
      if (esPDF) {
        try {
          subido = await guardarSubida(req, MAX_PDF_SUBIDO);
        } catch (error) {
          if (error.status === 413) {
            return res.status(413).json({ error: "El PDF pasa de 50 MB: copiá su texto y pegalo." });
          }
          throw error;
        }
        if (!subido.bytes) {
          await rm(subido.ruta, { force: true });
          return res.status(400).json({ error: "El PDF llegó vacío." });
        }
      }
      const marcar = (datos) => {
        for (const pendiente of iguales) {
          delete pendiente.mensaje;
          Object.assign(pendiente, datos);
        }
      };
      marcar({ estado: "procesando" });
      analizando.add(clave);
      res.status(202).json({ estado: "procesando" });
      try {
        let contenido = texto;
        if (esPDF) {
          contenido = (await extraerTextoPDF(subido.ruta)).texto.trim();
          if (contenido.length < MINIMO_AGREGADO) {
            throw new ErrorPDF(
              "El PDF no tiene texto que se pueda leer (puede ser un escaneo): copiá su texto y pegalo.",
            );
          }
        }
        const fuente = await investigador.agregarContenido(
          conversacion,
          { url, titulo: iguales[0].titulo, texto: contenido },
          { signal: new AbortController().signal, alEsperar: () => {} },
        );
        marcar(
          fuente
            ? { estado: "agregada", fuente: fuente.n }
            : {
                estado: "sin-aporte",
                mensaje: "El modelo no encontró en ese contenido información sobre el tema.",
              },
        );
      } catch (error) {
        if (!(error instanceof ErrorPDF)) console.error(error);
        marcar({
          estado: "error",
          mensaje:
            error instanceof ErrorPDF
              ? error.message
              : "No se pudo analizar el contenido. Probá de nuevo en un rato.",
        });
      } finally {
        analizando.delete(clave);
        if (subido) await rm(subido.ruta, { force: true });
        guardar(conversacion);
      }
    },
  );

  // Vuelve a redactar el informe sumando las fuentes agregadas a mano, sin repetir búsquedas.
  app.post("/api/conversaciones/:id/rehacer", exigirSesion, async (req, res) => {
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    if (!conversacion.informe || conversacion.ocupada) {
      return res.status(409).json({ error: "Esperá a que termine lo que está en curso." });
    }
    if ([...analizando].some((clave) => clave.startsWith(`${conversacion.id} `))) {
      return res.status(409).json({ error: "Esperá a que se terminen de analizar las fuentes agregadas." });
    }
    if (!paraRehacer(conversacion)) {
      return res.status(409).json({ error: "No hay fuentes nuevas para sumar al informe." });
    }
    lanzar(
      conversacion,
      req.persona,
      (flujo) => investigador.investigar(conversacion, flujo, { rehacer: true }),
      { esInvestigacion: true, retomada: true },
    );
    guardar(conversacion);
    res.status(202).json({ conversacion: conversacion.id });
  });

  app.post("/api/conversaciones/:id/cancelar", exigirSesion, async (req, res) => {
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    if (!conversacion.control) return res.status(409).json({ error: "No hay nada en curso." });
    conversacion.control.abort();
    res.json({});
  });

  app.delete("/api/conversaciones/:id", exigirSesion, async (req, res) => {
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    if (conversacion.ocupada) {
      return res.status(409).json({ error: "Detené la investigación antes de borrarla." });
    }
    clearTimeout(programados.get(conversacion.id));
    programados.delete(conversacion.id);
    await conversacion.guardando;
    await almacen.borrar(conversacion.id, conversacion.dueno);
    activas.delete(conversacion.id);
    pdfsGuardados.delete(conversacion.id);
    res.status(204).end();
  });

  app.get("/api/informe/:id", exigirSesion, async (req, res) => {
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    if (!conversacion.informe) {
      return res.status(409).json({ error: "El informe todavía no está terminado." });
    }
    const guardado = pdfsGuardados.get(conversacion.id);
    let pdf = guardado?.informe === conversacion.informe ? guardado.pdf : null;
    if (!pdf) {
      try {
        const { informe, fuentes } = numeracionContinua(conversacion);
        pdf = await generarPDF({ titulo: tituloDelPedido(conversacion.tema), markdown: informe, fuentes });
      } catch (error) {
        if (error instanceof ErrorPDF) return res.status(503).json({ error: error.message });
        throw error;
      }
      pdfsGuardados.delete(conversacion.id);
      pdfsGuardados.set(conversacion.id, { informe: conversacion.informe, pdf });
      if (pdfsGuardados.size > PDFS_GUARDADOS) pdfsGuardados.delete(pdfsGuardados.keys().next().value);
    }
    res
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${nombreDeArchivo(conversacion.tema)}"`,
      })
      .send(pdf);
  });

  // Cuántas búsquedas quedan (web en el mes, papers en el día), para saberlo antes de investigar.
  app.get("/api/estado", exigirSesion, async (req, res) => {
    res.json(saldos ? await saldos() : {});
  });

  app.get("/api/conversaciones/:id/informe", exigirSesion, async (req, res) => {
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    if (!conversacion.informe) {
      return res.status(409).json({ error: "El informe todavía no está terminado." });
    }
    const { informe, fuentes, intercambios, numeros } = numeracionContinua(conversacion);
    res.json({
      titulo: tituloDelPedido(conversacion.tema),
      tema: conversacion.tema,
      creada: conversacion.creada,
      archivo: nombreDeArchivo(conversacion.tema).replace(/\.pdf$/, ""),
      informe,
      fuentes: fuentes.map(({ n, url, titulo, tipo, fecha }) => ({
        n,
        url,
        titulo,
        ...(tipo && { tipo }),
        ...(fecha && { fecha }),
      })),
      intercambios,
      pendientes: pendientesDe(conversacion).map((pendiente) =>
        pendiente.estado === "agregada" ? { ...pendiente, fuente: numeros.get(pendiente.fuente) } : pendiente,
      ),
      paraRehacer: paraRehacer(conversacion),
      ocupada: Boolean(conversacion.ocupada),
      datos: datosDeInvestigacion(conversacion.eventos),
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const estado = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (estado === 500) console.error(error);
    res.status(estado).json({ error: estado === 500 ? "Error del servidor." : "Pedido inválido." });
  });

  return app;
}
