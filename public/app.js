import {
  $,
  API,
  cabeceras,
  descargar,
  guardarDato,
  guardarToken,
  hayToken,
  leerGuardado,
  olvidarSesion,
  pausa,
  pedir,
  pintarMarkdown,
} from "./comun.js";

const entrada = $("#entrada");
const app = $("#app");
const mensajes = $("#mensajes");
const vacio = $("#vacio");
const texto = $("#texto");
const botonEnviar = $("#enviar");

const estado = {
  conversacion: null,
  fuentes: new Map(),
  vista: null,
  ocupada: false,
  conInforme: false,
  enVivo: false,
  flujo: null,
};

const CAMPOS = ["Pregunta", "Contexto", "Aspectos", "Excluir", "Entrega", "Fuentes"];
const PLANTILLA = CAMPOS.map((campo) => `${campo}: `).join("\n");
const CAMPO_VACIO = new RegExp(`^\\s*(${CAMPOS.join("|")}):\\s*$`, "i");
const TERMINALES = new Set(["fin", "error", "cancelada"]);
// Solo para las guardadas cuando había varios tipos; las exhaustivas no se rotulan.
const PROFUNDIDADES = { normal: "Normal", profunda: "Profunda" };
const ESTADOS = {
  lista: "Lista",
  fallida: "Falló",
  cancelada: "Detenida",
  interrumpida: "Interrumpida",
};

const limpiarPedido = (valor) =>
  valor
    .split("\n")
    .filter((linea) => !CAMPO_VACIO.test(linea))
    .join("\n")
    .trim();



function mostrarUso(uso) {
  $("#uso").textContent = uso?.limite ? `${uso.usadas} de ${uso.limite} hoy` : "";
}

function mostrarAviso(mensaje) {
  const aviso = $("#aviso-redactor");
  aviso.textContent = mensaje;
  aviso.hidden = !mensaje;
}

function mostrarApp(sesion) {
  entrada.hidden = true;
  app.hidden = false;
  $("#nombre").textContent = sesion.nombre;
  mostrarUso(sesion.uso);
  irAlInicio();
}

// En escritorio el panel ocupa su lugar y se recuerda si quedó cerrado; en celular es un cajón
// que se abre encima y arranca siempre cerrado.
const escritorio = matchMedia("(min-width: 769px)");

function abrirPanel() {
  if (escritorio.matches) {
    app.classList.remove("panel-cerrado");
    guardarDato("panel", null);
  } else {
    app.classList.add("cajon-abierto");
    $("#cerrar-panel").focus();
  }
}

function cerrarPanel() {
  if (!escritorio.matches) return cerrarCajon();
  app.classList.add("panel-cerrado");
  guardarDato("panel", "cerrado");
}

function cerrarCajon() {
  app.classList.remove("cajon-abierto");
}

function marcarActiva() {
  for (const fila of $("#lista").children) {
    fila.classList.toggle("activa", fila.dataset.id === estado.conversacion);
  }
}

function mostrarEntrada() {
  estado.flujo?.abort();
  app.hidden = true;
  entrada.hidden = false;
  $("#codigo").focus();
}

function actualizarRedactor() {
  const enConversacion = Boolean(estado.conversacion);
  const cerrada = enConversacion && !estado.ocupada && !estado.conInforme;
  botonEnviar.textContent = estado.ocupada ? "Detener" : enConversacion ? "Preguntar" : "Investigar";
  botonEnviar.classList.toggle("principal", !estado.ocupada);
  botonEnviar.disabled = cerrada;
  texto.disabled = estado.ocupada || cerrada;
  texto.placeholder = estado.ocupada
    ? "Investigando… podés cerrar la página"
    : cerrada
      ? "Esta investigación no terminó: empezá una nueva"
      : enConversacion
        ? "Preguntá sobre el informe"
        : "Tema a investigar";
}

function ajustarAltura() {
  texto.style.height = "auto";
  texto.style.height = `${texto.scrollHeight + 2}px`;
}

const pegadoAlFondo = () =>
  mensajes.scrollHeight - mensajes.scrollTop - mensajes.clientHeight < 80;

function clonar(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}

function duracion(ms) {
  const minutos = Math.floor(ms / 60000);
  if (minutos < 1) return "menos de 1 min";
  if (minutos < 60) return `${minutos} min`;
  return `${Math.floor(minutos / 60)} h ${minutos % 60} min`;
}


function agregarPregunta(contenido) {
  const nodo = clonar("#plantilla-pregunta");
  nodo.textContent = contenido;
  mensajes.append(nodo);
}

const ETIQUETAS = { academico: "Papers", libros: "Libros", sitios: "En sitio" };
const ESTADOS_DE_FUENTE = { leyendo: "Leyendo", lista: "Leída", descartada: "Omitida" };

const elemento = (etiqueta, propiedades = {}, ...hijos) => {
  const nodo = Object.assign(document.createElement(etiqueta), propiedades);
  nodo.append(...hijos);
  return nodo;
};

const tituloDe = (texto) =>
  (texto.match(/^\s*Pregunta:[ \t]*(\S.*)$/im)?.[1] ?? texto.split("\n")[0]).slice(0, 140);

function agregarRespuesta(pregunta = "") {
  const nodo = clonar("#plantilla-respuesta");
  const progreso = nodo.querySelector(".progreso");
  const etapa = nodo.querySelector(".etapa");
  const contador = nodo.querySelector(".contador");
  const arbol = nodo.querySelector(".arbol");
  const ramas = nodo.querySelector(".ramas");
  nodo.querySelector(".raiz").textContent = tituloDe(pregunta) || "Investigación";
  const hojasDe = new Map();
  let sueltas = null;
  let subpreguntas = 0;
  const informe = nodo.querySelector(".informe");
  const aviso = nodo.querySelector(".aviso");
  const segundoPlano = nodo.querySelector(".segundo-plano");
  const filas = new Map();
  let markdown = "";
  let pintadoPendiente = false;
  let busquedas = 0;
  let leidas = 0;
  let inicio = null;
  let final = null;
  let terminada = false;
  const reloj = setInterval(() => contar(), 30000);

  mensajes.append(nodo);
  mensajes.scrollTop = mensajes.scrollHeight;

  const conScroll = (cambio) => {
    const seguir = pegadoAlFondo();
    cambio();
    if (seguir) mensajes.scrollTop = mensajes.scrollHeight;
  };

  function contar() {
    const partes = [];
    if (leidas) partes.push(`${leidas} ${leidas === 1 ? "fuente" : "fuentes"}`);
    if (busquedas) partes.push(`${busquedas} ${busquedas === 1 ? "búsqueda" : "búsquedas"}`);
    if (inicio) partes.push(duracion((final ?? Date.now()) - inicio));
    contador.textContent = partes.join(" · ");
  }

  // Sigue a lo último que aparece solo si quien lee ya estaba al final del árbol.
  function enArbol(cambio) {
    const seguir = arbol.scrollHeight - arbol.scrollTop - arbol.clientHeight < 40;
    const resultado = cambio();
    if (seguir) arbol.scrollTop = arbol.scrollHeight;
    return resultado;
  }

  function agregarRama({ id, texto, idioma, destino, etiqueta: propia }) {
    return enArbol(() => {
      const etiqueta = propia ?? `${ETIQUETAS[destino] ?? "Busca"}${idioma ? ` ${idioma}` : ""}`;
      const hojas = elemento("ol", { className: "hojas" });
      const rama = elemento(
        "li",
        { className: "rama" },
        elemento(
          "div",
          { className: "consulta-nodo", title: texto },
          elemento("span", { className: "etiqueta", textContent: etiqueta }),
          elemento("span", { textContent: texto, ...(idioma && { lang: idioma }) }),
        ),
        hojas,
      );
      if (destino) rama.dataset.destino = destino;
      ramas.append(rama);
      if (id) hojasDe.set(id, hojas);
      if (!propia) sueltas = null;
      return hojas;
    });
  }

  function agregarNota(etiqueta, contenido) {
    enArbol(() =>
      ramas.append(
        elemento(
          "li",
          { className: "rama nota" },
          elemento(
            "div",
            { className: "aviso-nodo" },
            elemento("span", { className: "etiqueta", textContent: etiqueta }),
            contenido,
          ),
        ),
      ),
    );
  }

  // Las subpreguntas que el plan se propone responder; las rondas pueden sumar alguna.
  function agregarAspectos({ lista, nuevos }) {
    const numerada = elemento(
      "ol",
      { className: "subpreguntas", start: subpreguntas + 1 },
      ...lista.map((texto) => elemento("li", { textContent: texto })),
    );
    subpreguntas += lista.length;
    agregarNota(nuevos ? "Subpreguntas nuevas" : "Subpreguntas a responder", numerada);
  }

  // Las investigaciones guardadas antes de numerar las búsquedas no dicen de cuál salió cada
  // fuente: van juntas en una rama aparte para no atribuirlas mal.
  function pintarFuente({ id, url, titulo, estado: situacion, n, motivo, consulta, tipo, fecha }) {
    let hoja = filas.get(id);
    if (!hoja) {
      const destino =
        hojasDe.get(consulta) ??
        (sueltas ??= agregarRama({ texto: "Fuentes de estas búsquedas", etiqueta: "Fuentes" }));
      hoja = enArbol(() => {
        const nueva = elemento(
          "li",
          { className: "hoja" },
          elemento(
            "a",
            { target: "_blank", rel: "noopener noreferrer" },
            elemento("span", { className: "punto" }),
            elemento("span", { className: "estado-fuente" }),
            elemento("span", { className: "titulo-fuente" }),
          ),
        );
        destino.append(nueva);
        return nueva;
      });
      filas.set(id, hoja);
    }
    const enlace = hoja.querySelector("a");
    if (url) enlace.href = url;
    if (titulo || url) {
      const nombre = titulo || new URL(url).hostname;
      hoja.querySelector(".titulo-fuente").textContent = nombre;
      enlace.title = url ? `${nombre}\n${url}` : nombre;
    }
    hoja.dataset.estado = situacion;
    hoja.querySelector(".estado-fuente").textContent = ESTADOS_DE_FUENTE[situacion] ?? "";
    if (situacion === "lista") {
      estado.fuentes.set(n, url);
      leidas++;
      contar();
    }
    const detalle = situacion === "descartada" ? motivo : [tipo, fecha].filter(Boolean).join(" · ");
    if (detalle && situacion !== "leyendo" && !hoja.querySelector(".motivo")) {
      hoja.append(elemento("span", { className: "motivo", textContent: detalle }));
    }
  }

  function cerrar(situacion, titulo, hora) {
    terminada = true;
    clearInterval(reloj);
    final = hora ?? final;
    contar();
    segundoPlano.hidden = true;
    progreso.dataset.estado = situacion;
    etapa.textContent = titulo;
    if (situacion === "lista") progreso.open = false;
  }

  const vista = {
    get terminada() {
      return terminada;
    },
    recibir({ tipo, datos }) {
      conScroll(() => {
        if (tipo === "inicio") {
          inicio = datos.hora;
          segundoPlano.hidden = false;
          contar();
        }
        if (tipo === "etapa") etapa.textContent = datos.texto;
        if (tipo === "espera") etapa.textContent = `Esperando cupo del proveedor (${datos.segundos} s)`;
        if (tipo === "aviso") agregarNota("Aviso", datos.texto);
        if (tipo === "aspectos" && Array.isArray(datos.lista)) agregarAspectos(datos);
        if (tipo === "consulta") {
          agregarRama(datos);
          busquedas++;
          contar();
        }
        if (tipo === "fuente") pintarFuente(datos);
        if (tipo === "texto") {
          markdown += datos.delta;
          if (pintadoPendiente) return;
          pintadoPendiente = true;
          requestAnimationFrame(() => {
            pintadoPendiente = false;
            conScroll(() => pintarMarkdown(informe, markdown, citaDeFuente));
          });
        }
        if (tipo === "error") vista.fallar(datos.mensaje, datos.hora);
        if (tipo === "cancelada") cerrar("detenida", "Detenida", datos.hora);
        if (tipo === "fin") {
          cerrar("lista", datos.pdf ? "Investigación terminada" : "Respuesta lista", datos.hora);
          if (datos.pdf) {
            const descarga = nodo.querySelector(".descarga");
            const id = estado.conversacion;
            nodo.querySelector(".ver-informe").href = `informe.html?id=${encodeURIComponent(id)}`;
            descarga.onclick = () => descargarPDF(id, descarga, aviso);
            nodo.querySelector(".acciones").hidden = false;
          }
          mostrarUso(datos.uso);
        }
      });
    },
    fallar(mensaje, hora) {
      cerrar("fallida", "No se pudo completar", hora);
      aviso.textContent = mensaje;
      aviso.hidden = false;
    },
  };
  return vista;
}

function citaDeFuente(n) {
  const url = estado.fuentes.get(n);
  if (!url) return null;
  return Object.assign(document.createElement("a"), {
    className: "cita",
    href: url,
    textContent: String(n),
    target: "_blank",
    rel: "noopener noreferrer",
  });
}

async function descargarPDF(id, boton, aviso) {
  boton.disabled = true;
  aviso.hidden = true;
  try {
    await descargar(`/api/informe/${id}`, "informe.pdf");
  } catch (fallo) {
    aviso.textContent = fallo.message;
    aviso.hidden = false;
  } finally {
    boton.disabled = false;
  }
}

async function* leerFlujo(respuesta) {
  const lector = respuesta.body.pipeThrough(new TextDecoderStream()).getReader();
  let pendiente = "";
  for (;;) {
    const { value, done } = await lector.read();
    if (done) return;
    pendiente += value;
    const bloques = pendiente.split("\n\n");
    pendiente = bloques.pop();
    for (const bloque of bloques) {
      const tipo = bloque.match(/^event: (.+)$/m)?.[1];
      const datos = bloque.match(/^data: (.+)$/m)?.[1];
      if (tipo && datos) yield { tipo, datos: JSON.parse(datos) };
    }
  }
}

function limpiarMensajes() {
  for (const mensaje of mensajes.querySelectorAll(".mensaje")) mensaje.remove();
  estado.fuentes.clear();
  estado.vista = null;
  estado.ocupada = false;
  estado.conInforme = false;
  estado.enVivo = false;
}

function procesar({ tipo, datos }) {
  if (tipo === "pregunta") {
    agregarPregunta(datos.texto);
    estado.vista = agregarRespuesta(datos.texto);
    estado.ocupada = true;
  } else if (tipo === "listo") {
    estado.enVivo = true;
    // Si el servidor no la tiene en curso pero el último turno no terminó, se reinició a mitad.
    estado.ocupada = datos.ocupada;
    if (!datos.ocupada && estado.vista && !estado.vista.terminada) {
      estado.vista.fallar("Se interrumpió porque el servidor se reinició. Podés empezarla de nuevo.");
    }
    mensajes.scrollTop = mensajes.scrollHeight;
  } else {
    estado.vista?.recibir({ tipo, datos });
    if (TERMINALES.has(tipo)) {
      estado.ocupada = false;
      // Solo los finales en vivo cambian el estado en la lista; los repetidos al conectar, no.
      if (estado.enVivo) cargarHistorial();
    }
    if (tipo === "fin" && datos.pdf) estado.conInforme = true;
  }
  actualizarRedactor();
}

// Al reconectarse (corte de red, celular bloqueado) el servidor repite todo desde el principio,
// así que la vista se rearma de cero en cada conexión.
async function escuchar(id, control) {
  for (let intento = 0; !control.signal.aborted; intento++) {
    try {
      const respuesta = await fetch(`${API}/api/conversaciones/${id}/eventos`, {
        headers: cabeceras(),
        signal: control.signal,
      });
      if (respuesta.status === 401) {
        olvidarSesion();
        return mostrarEntrada();
      }
      if (respuesta.status === 404) {
        irAlInicio();
        return mostrarAviso("Esa investigación ya no existe.");
      }
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      limpiarMensajes();
      for await (const evento of leerFlujo(respuesta)) {
        procesar(evento);
        intento = 0;
      }
    } catch {
      if (control.signal.aborted) return;
    }
    await pausa(Math.min(30000, 1000 * 2 ** intento), control.signal);
  }
}

function abrirConversacion(id) {
  estado.flujo?.abort();
  limpiarMensajes();
  mostrarAviso("");
  estado.conversacion = id;
  vacio.hidden = true;
  marcarActiva();
  estado.flujo = new AbortController();
  escuchar(id, estado.flujo);
  actualizarRedactor();
}

function irAlInicio() {
  estado.flujo?.abort();
  estado.flujo = null;
  estado.conversacion = null;
  limpiarMensajes();
  vacio.hidden = false;
  mensajes.scrollTop = 0;
  marcarActiva();
  actualizarRedactor();
  cargarHistorial();
  texto.focus();
}

function describir(item) {
  const fecha = new Date(item.creada).toLocaleString("es-AR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const situacion =
    item.estado === "en-curso"
      ? `En curso${item.etapa ? ` · ${item.etapa}` : ""}`
      : (ESTADOS[item.estado] ?? item.estado);
  return [situacion, PROFUNDIDADES[item.profundidad], fecha].filter(Boolean).join(" · ");
}

async function cargarHistorial() {
  let items;
  try {
    items = await pedir("/api/conversaciones");
  } catch (error) {
    if (error.estado === 401) mostrarEntrada();
    return;
  }
  const lista = $("#lista");
  lista.replaceChildren(
    ...items.map((item) => {
      const fila = clonar("#plantilla-item");
      fila.dataset.id = item.id;
      fila.dataset.estado = item.estado;
      fila.querySelector(".item-titulo").textContent = item.titulo;
      fila.querySelector(".item-meta").textContent = describir(item);
      fila.querySelector(".abrir").title = item.titulo;
      fila.querySelector(".abrir").addEventListener("click", () => {
        cerrarCajon();
        abrirConversacion(item.id);
      });
      const borrar = fila.querySelector(".borrar");
      borrar.hidden = item.estado === "en-curso";
      borrar.addEventListener("click", async () => {
        if (!confirm("¿Borrar esta investigación? No se puede deshacer.")) return;
        try {
          await pedir(`/api/conversaciones/${item.id}`, { metodo: "DELETE" });
          if (item.id === estado.conversacion) irAlInicio();
        } catch (error) {
          mostrarAviso(error.message);
        }
        cargarHistorial();
      });
      return fila;
    }),
  );
  $("#lista-vacia").hidden = items.length > 0;
  marcarActiva();
}

setInterval(() => {
  if (!app.hidden) cargarHistorial();
}, 30000);

$("#formulario-entrada").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const error = $("#error-entrada");
  error.hidden = true;
  try {
    const sesion = await pedir("/api/entrar", {
      metodo: "POST",
      cuerpo: { codigo: $("#codigo").value },
    });
    guardarToken(sesion.token);
    mostrarApp(sesion);
    $("#codigo").value = "";
  } catch (fallo) {
    error.textContent = fallo.message;
    error.hidden = false;
  }
});

$("#redactor").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  mostrarAviso("");
  if (estado.ocupada) {
    if (!confirm("¿Detener la investigación? Lo avanzado hasta ahora se pierde.")) return;
    try {
      await pedir(`/api/conversaciones/${estado.conversacion}/cancelar`, { metodo: "POST" });
    } catch (error) {
      mostrarAviso(error.message);
    }
    return;
  }

  const contenido = limpiarPedido(texto.value);
  if (contenido.length < 3) return;
  botonEnviar.disabled = true;
  try {
    if (estado.conversacion) {
      await pedir(`/api/conversaciones/${estado.conversacion}/preguntas`, {
        metodo: "POST",
        cuerpo: { pregunta: contenido },
      });
      estado.ocupada = true;
    } else {
      const { conversacion, uso } = await pedir("/api/investigar", {
        metodo: "POST",
        cuerpo: { tema: contenido },
      });
      mostrarUso(uso);
      abrirConversacion(conversacion);
      cargarHistorial();
    }
    texto.value = "";
    ajustarAltura();
  } catch (error) {
    if (error.estado === 401) return mostrarEntrada();
    mostrarAviso(error.message);
  } finally {
    botonEnviar.disabled = false;
    actualizarRedactor();
  }
});

texto.addEventListener("input", ajustarAltura);

// En pantallas táctiles Enter hace salto de línea: no hay Shift cómodo para eso. Con varias
// líneas (la plantilla) también, para no mandar un pedido a medio completar: cada investigación
// descuenta del límite diario.
const tactil = matchMedia("(pointer: coarse)");
texto.addEventListener("keydown", (evento) => {
  if (evento.key !== "Enter" || evento.shiftKey || evento.isComposing) return;
  const forzado = evento.ctrlKey || evento.metaKey;
  if (!forzado && (tactil.matches || texto.value.includes("\n"))) return;
  evento.preventDefault();
  $("#redactor").requestSubmit();
});

$("#plantilla").addEventListener("click", () => {
  if (!texto.value.includes("\nContexto:")) {
    texto.value = PLANTILLA.replace("Pregunta: ", `Pregunta: ${texto.value.trim()}`);
  }
  ajustarAltura();
  texto.focus();
  const finDePregunta = texto.value.indexOf("\n");
  texto.setSelectionRange(finDePregunta, finDePregunta);
});

if (leerGuardado("panel") === "cerrado") app.classList.add("panel-cerrado");
for (const boton of document.querySelectorAll(".accion-abrir")) {
  boton.addEventListener("click", abrirPanel);
}
for (const boton of document.querySelectorAll(".accion-nueva")) {
  boton.addEventListener("click", () => {
    cerrarCajon();
    irAlInicio();
  });
}
$("#cerrar-panel").addEventListener("click", cerrarPanel);
$("#velo").addEventListener("click", cerrarCajon);
escritorio.addEventListener("change", cerrarCajon);
document.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape") cerrarCajon();
});

$("#salir").addEventListener("click", () => {
  estado.flujo?.abort();
  olvidarSesion();
  location.reload();
});

if (!hayToken()) {
  mostrarEntrada();
} else {
  try {
    mostrarApp(await pedir("/api/sesion"));
  } catch (fallo) {
    mostrarEntrada();
    if (fallo.estado !== 401) {
      $("#error-entrada").textContent = fallo.message;
      $("#error-entrada").hidden = false;
    }
  }
}
