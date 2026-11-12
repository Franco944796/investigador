const { marked, DOMPurify } = globalThis;
const $ = (selector) => document.querySelector(selector);

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
  flujo: null,
};

const CAMPOS = ["Pregunta", "Contexto", "Aspectos", "Excluir", "Entrega", "Fuentes"];
const PLANTILLA = CAMPOS.map((campo) => `${campo}: `).join("\n");
const CAMPO_VACIO = new RegExp(`^\\s*(${CAMPOS.join("|")}):\\s*$`, "i");
const TERMINALES = new Set(["fin", "error", "cancelada"]);
const PROFUNDIDADES = { normal: "Normal", profunda: "Profunda", exhaustiva: "Exhaustiva" };
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

const pausa = (ms, signal) =>
  new Promise((listo) => {
    const reloj = setTimeout(listo, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(reloj);
      listo();
    });
  });

// Preferencia de cada visitante; si el navegador bloquea el almacenamiento, se usa Normal.
function leerPreferencia() {
  try {
    return localStorage.getItem("profundidad") ?? "normal";
  } catch {
    return "normal";
  }
}

function guardarPreferencia(valor) {
  try {
    localStorage.setItem("profundidad", valor);
  } catch {
    // Sin almacenamiento solo se pierde el recuerdo de la elección.
  }
}

async function pedir(ruta, { metodo = "GET", cuerpo } = {}) {
  const respuesta = await fetch(ruta, {
    method: metodo,
    headers: cuerpo === undefined ? {} : { "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const datos = respuesta.status === 204 ? {} : await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    throw Object.assign(new Error(datos.error || "No se pudo completar el pedido."), {
      estado: respuesta.status,
    });
  }
  return datos;
}

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
  mostrarUso(sesion.uso);
  irAlInicio();
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
  $("#profundidades").hidden = enConversacion;
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

function enlazarCitas(contenedor) {
  const recorrido = document.createTreeWalker(contenedor, NodeFilter.SHOW_TEXT);
  const nodos = [];
  while (recorrido.nextNode()) {
    const nodo = recorrido.currentNode;
    if (/\[\d+\]/.test(nodo.data) && !nodo.parentElement.closest("a, code, pre")) nodos.push(nodo);
  }
  for (const nodo of nodos) {
    const partes = nodo.data.split(/\[(\d+)\]/);
    const fragmento = document.createDocumentFragment();
    partes.forEach((parte, indice) => {
      const url = indice % 2 ? estado.fuentes.get(Number(parte)) : null;
      if (!url) {
        fragmento.append(indice % 2 ? `[${parte}]` : parte);
        return;
      }
      const cita = document.createElement("a");
      cita.className = "cita";
      cita.href = url;
      cita.textContent = parte;
      fragmento.append(cita);
    });
    nodo.replaceWith(fragmento);
  }
}

function pintarMarkdown(contenedor, markdown) {
  contenedor.innerHTML = DOMPurify.sanitize(marked.parse(markdown), {
    FORBID_TAGS: ["img", "style", "form", "input", "button"],
  });
  for (const tabla of contenedor.querySelectorAll("table")) {
    const envoltura = document.createElement("div");
    envoltura.className = "tabla";
    tabla.replaceWith(envoltura);
    envoltura.append(tabla);
  }
  enlazarCitas(contenedor);
  for (const enlace of contenedor.querySelectorAll("a")) {
    enlace.target = "_blank";
    enlace.rel = "noopener noreferrer";
  }
}

function agregarPregunta(contenido) {
  const nodo = clonar("#plantilla-pregunta");
  nodo.textContent = contenido;
  mensajes.append(nodo);
}

function agregarRespuesta() {
  const nodo = clonar("#plantilla-respuesta");
  const progreso = nodo.querySelector(".progreso");
  const etapa = nodo.querySelector(".etapa");
  const contador = nodo.querySelector(".contador");
  const pasos = nodo.querySelector(".pasos");
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

  function agregarPaso(clase, contenido) {
    const fila = document.createElement("li");
    fila.className = `paso ${clase}`;
    const detalle = document.createElement("span");
    detalle.className = "detalle";
    detalle.append(contenido);
    fila.append(detalle);
    pasos.append(fila);
    pasos.scrollTop = pasos.scrollHeight;
    return fila;
  }

  function pintarFuente({ id, url, titulo, estado: situacion, n, motivo }) {
    let fila = filas.get(id);
    if (!fila) {
      const enlace = document.createElement("a");
      enlace.target = "_blank";
      enlace.rel = "noopener noreferrer";
      fila = agregarPaso("fuente", enlace);
      filas.set(id, fila);
    }
    const enlace = fila.querySelector("a");
    if (url) enlace.href = url;
    if (titulo || url) enlace.textContent = titulo || new URL(url).hostname;
    fila.dataset.estado = situacion;
    if (situacion === "lista") {
      estado.fuentes.set(n, url);
      leidas++;
      contar();
    }
    if (situacion === "descartada" && motivo) {
      const nota = document.createElement("span");
      nota.className = "motivo";
      nota.textContent = ` (${motivo})`;
      fila.querySelector(".detalle").append(nota);
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
        if (tipo === "consulta") {
          agregarPaso("consulta", datos.texto);
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
            conScroll(() => pintarMarkdown(informe, markdown));
          });
        }
        if (tipo === "error") vista.fallar(datos.mensaje, datos.hora);
        if (tipo === "cancelada") cerrar("detenida", "Detenida", datos.hora);
        if (tipo === "fin") {
          cerrar("lista", datos.pdf ? "Investigación terminada" : "Respuesta lista", datos.hora);
          if (datos.pdf) {
            const descarga = nodo.querySelector(".descarga");
            descarga.href = `/api/informe/${estado.conversacion}`;
            descarga.download = "";
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
}

function procesar({ tipo, datos }) {
  if (tipo === "pregunta") {
    agregarPregunta(datos.texto);
    estado.vista = agregarRespuesta();
    estado.ocupada = true;
  } else if (tipo === "listo") {
    // Si el servidor no la tiene en curso pero el último turno no terminó, se reinició a mitad.
    estado.ocupada = datos.ocupada;
    if (!datos.ocupada && estado.vista && !estado.vista.terminada) {
      estado.vista.fallar("Se interrumpió porque el servidor se reinició. Podés empezarla de nuevo.");
    }
    mensajes.scrollTop = mensajes.scrollHeight;
  } else {
    estado.vista?.recibir({ tipo, datos });
    if (TERMINALES.has(tipo)) estado.ocupada = false;
    if (tipo === "fin" && datos.pdf) estado.conInforme = true;
  }
  actualizarRedactor();
}

// Al reconectarse (corte de red, celular bloqueado) el servidor repite todo desde el principio,
// así que la vista se rearma de cero en cada conexión.
async function escuchar(id, control) {
  for (let intento = 0; !control.signal.aborted; intento++) {
    try {
      const respuesta = await fetch(`/api/conversaciones/${id}/eventos`, { signal: control.signal });
      if (respuesta.status === 401) return mostrarEntrada();
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
  return [situacion, PROFUNDIDADES[item.profundidad] ?? item.profundidad, fecha].join(" · ");
}

async function cargarHistorial() {
  let items;
  try {
    items = await pedir("/api/conversaciones");
  } catch (error) {
    if (error.estado === 401) mostrarEntrada();
    return;
  }
  if (estado.conversacion) return;
  const lista = $("#lista");
  lista.replaceChildren(
    ...items.map((item) => {
      const fila = clonar("#plantilla-item");
      fila.dataset.estado = item.estado;
      fila.querySelector(".item-titulo").textContent = item.titulo;
      fila.querySelector(".item-meta").textContent = describir(item);
      fila.querySelector(".abrir").addEventListener("click", () => abrirConversacion(item.id));
      const borrar = fila.querySelector(".borrar");
      borrar.hidden = item.estado === "en-curso";
      borrar.addEventListener("click", async () => {
        if (!confirm("¿Borrar esta investigación? No se puede deshacer.")) return;
        try {
          await pedir(`/api/conversaciones/${item.id}`, { metodo: "DELETE" });
        } catch (error) {
          mostrarAviso(error.message);
        }
        cargarHistorial();
      });
      return fila;
    }),
  );
  $("#historial").hidden = !items.length;
}

setInterval(() => {
  if (!app.hidden && !estado.conversacion) cargarHistorial();
}, 30000);

$("#formulario-entrada").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const error = $("#error-entrada");
  error.hidden = true;
  try {
    mostrarApp(await pedir("/api/entrar", { metodo: "POST", cuerpo: { codigo: $("#codigo").value } }));
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
      const profundidad = $('input[name="profundidad"]:checked').value;
      const { conversacion, uso } = await pedir("/api/investigar", {
        metodo: "POST",
        cuerpo: { tema: contenido, profundidad },
      });
      mostrarUso(uso);
      abrirConversacion(conversacion);
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

const elegida = document.querySelector(`input[name="profundidad"][value="${leerPreferencia()}"]`);
if (elegida) elegida.checked = true;
$("#profundidades").addEventListener("change", (evento) => guardarPreferencia(evento.target.value));

$("#nueva").addEventListener("click", irAlInicio);

$("#salir").addEventListener("click", async () => {
  estado.flujo?.abort();
  await pedir("/api/salir", { metodo: "POST", cuerpo: {} }).catch(() => {});
  location.reload();
});

try {
  mostrarApp(await pedir("/api/sesion"));
} catch {
  mostrarEntrada();
}
