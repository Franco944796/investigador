import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { crearConversacion, ErrorInvestigacion } from "./investigador.js";
import { ErrorLLM } from "./llm.js";
import { nombreDeArchivo, tituloDelPedido } from "./pdf.js";
import { VENDOR } from "./vendor.js";

const LATIDO_MS = 15000;
const MAX_TEXTO = 2000;
const GUARDADO_MS = 30000;
const RETENER_EN_MEMORIA_MS = 10 * 60 * 1000;
const ESTADO_FINAL = { completa: "lista", fallida: "fallida", cancelada: "cancelada" };

const ruta = (relativa) => fileURLToPath(new URL(relativa, import.meta.url));

const POLITICA_DE_CONTENIDO = [
  "default-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Token en una cabecera y no en una cookie: la página también se publica en GitHub Pages, otro
// sitio, y Safari bloquea las cookies entre sitios distintos.
const leerToken = (req) => req.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? null;

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
    },
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

export function crearApp({ config, acceso, investigadores, almacen, generarPDF }) {
  const opciones = config.investigacion;
  const activas = new Map();
  const cargando = new Map();
  const programados = new Map();
  const conTurno = crearCola(opciones.simultaneas);

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

  function lanzar(conversacion, persona, tarea, { esInvestigacion }) {
    const control = new AbortController();
    const flujo = {
      signal: control.signal,
      emitir: (tipo, datos) => registrar(conversacion, tipo, datos),
    };
    Object.assign(conversacion, { control, ocupada: true });
    if (esInvestigacion) conversacion.estado = "en-curso";
    flujo.emitir("inicio", { hora: Date.now() });

    return (async () => {
      let resultado = "completa";
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
        if (resultado === "fallida") {
          console.error(error);
          flujo.emitir("error", { mensaje: mensajeDeError(error), hora: Date.now() });
        } else {
          flujo.emitir("cancelada", { hora: Date.now() });
        }
      }
      Object.assign(conversacion, { control: null, ocupada: false });
      if (esInvestigacion) {
        conversacion.estado = ESTADO_FINAL[resultado];
        // Lo cancelado no se devuelve: cortar a mitad de camino ya gastó cuota de los proveedores.
        if (resultado === "fallida") acceso.registrarUso(persona, -1);
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
  app.use(express.json({ limit: "20kb" }));
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
    const { persona, token, bloqueado } = acceso.entrar(req.body?.codigo, req.ip);
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
    const profundidad = req.body?.profundidad ?? "normal";
    if (!Object.hasOwn(investigadores, profundidad)) {
      return res.status(400).json({ error: "Profundidad desconocida." });
    }
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
      (flujo) => investigadores[profundidad].investigar(conversacion, flujo),
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
    for (const { tipo, datos } of conversacion.eventos) enviar(tipo, datos);
    // Marca el fin de la repetición; si no está ocupada y el último turno no terminó, el
    // servidor se reinició a mitad de camino.
    enviar("listo", { ocupada: conversacion.ocupada });
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
    const investigador = investigadores[conversacion.profundidad] ?? investigadores.normal;
    registrar(conversacion, "pregunta", { texto: pregunta });
    lanzar(
      conversacion,
      req.persona,
      (flujo) => investigador.seguir(conversacion, pregunta, flujo),
      { esInvestigacion: false },
    );
    res.status(202).json({});
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
    res.status(204).end();
  });

  app.get("/api/informe/:id", exigirSesion, async (req, res) => {
    const conversacion = await cargar(req, res, req.params.id);
    if (!conversacion) return;
    if (!conversacion.informe) {
      return res.status(409).json({ error: "El informe todavía no está terminado." });
    }
    const pdf = await generarPDF({
      titulo: tituloDelPedido(conversacion.tema),
      markdown: conversacion.informe,
      fuentes: conversacion.fuentes,
    });
    res
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${nombreDeArchivo(conversacion.tema)}"`,
      })
      .send(pdf);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const estado = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (estado === 500) console.error(error);
    res.status(estado).json({ error: estado === 500 ? "Error del servidor." : "Pedido inválido." });
  });

  return app;
}
