import {
  $,
  API,
  cabeceras,
  conEspera,
  descargar,
  guardarArchivo,
  guardarDato,
  hayToken,
  pedir,
  pintarMarkdown,
} from "./comun.js";
import { direccionCorta, tituloLegible } from "./direcciones.js";

const nombreDeFuente = (titulo, url) => (tituloLegible(titulo) ? titulo : direccionCorta(url));

const id = new URLSearchParams(location.search).get("id");
// La muestra pública (muestra.html) es una copia fija armada con scripts/muestra.js: se lee de un
// archivo al lado, sin sesión ni servidor.
const muestra = document.body.dataset.muestra;
const documento = $("#documento");
const indice = $("#indice");
const vista = $("#vista-cita");
const amplio = matchMedia("(min-width: 1100px)");
const NOMBRES_DE_IDIOMAS = new Intl.DisplayNames(["es"], { type: "language", fallback: "code" });

let fuentes = new Map();
let datosDelInforme = null;

const elemento = (etiqueta, propiedades = {}, ...hijos) => {
  const nodo = Object.assign(document.createElement(etiqueta), propiedades);
  nodo.append(...hijos);
  return nodo;
};

const enumerar = (lista) =>
  lista.length > 1 ? `${lista.slice(0, -1).join(", ")} y ${lista.at(-1)}` : (lista[0] ?? "");

function sitioDe(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const datosDeFuente = (fuente) =>
  [sitioDe(fuente.url), fuente.tipo, fuente.fecha].filter(Boolean).join(" · ");

function duracion(desde, hasta) {
  if (!desde || !hasta) return "";
  const minutos = Math.round((hasta - desde) / 60000);
  if (minutos < 1) return "menos de 1 min";
  const horas = Math.floor(minutos / 60);
  return horas ? `${horas} h ${minutos % 60} min` : `${minutos} min`;
}

function fallar(mensaje, conEnlace) {
  documento.replaceChildren(
    elemento("p", { className: "estado", textContent: mensaje }),
    ...(conEnlace ? [elemento("a", { href: "./", textContent: "Ir al investigador" })] : []),
  );
}

function crearCita(n) {
  if (!fuentes.has(n)) return null;
  const cita = elemento("a", { className: "cita", href: `#fuente-${n}`, textContent: String(n) });
  cita.dataset.n = n;
  return cita;
}

function portada(datos, titulo) {
  const { busquedas, idiomas, leidas, descartadas, inicio, fin } = datos.datos;
  const filas = [
    ["Fecha", new Date(datos.creada).toLocaleDateString("es-AR", { dateStyle: "long" })],
    ["Duración", duracion(inicio, fin)],
    ["Búsquedas", busquedas ? String(busquedas) : ""],
    ["Fuentes leídas", leidas ? `${leidas}${descartadas ? ` (${descartadas} descartadas)` : ""}` : ""],
    ["Idiomas", enumerar(idiomas.map((codigo) => NOMBRES_DE_IDIOMAS.of(codigo)))],
  ].filter(([, valor]) => valor);
  return elemento(
    "header",
    { className: "portada" },
    elemento("p", { className: "sobretitulo", textContent: "Informe de investigación" }),
    elemento("h1", { textContent: titulo }),
    elemento(
      "dl",
      { className: "datos" },
      ...filas.map(([nombre, valor]) =>
        elemento("div", {}, elemento("dt", { textContent: nombre }), elemento("dd", { textContent: valor })),
      ),
    ),
    ...(datos.tema
      ? [
          elemento(
            "details",
            { className: "pedido" },
            elemento("summary", { textContent: "Pedido original" }),
            elemento("pre", { textContent: datos.tema }),
          ),
        ]
      : []),
  );
}

function seguimiento(intercambios) {
  if (!intercambios.length) return null;
  const seccion = elemento(
    "section",
    { className: "seguimiento" },
    elemento("h2", { textContent: "Preguntas de seguimiento" }),
  );
  for (const { pregunta, respuesta } of intercambios) {
    const cuerpo = elemento("div", { className: "respuesta" });
    pintarMarkdown(cuerpo, respuesta, crearCita, { tema: "ambos" });
    seccion.append(
      elemento(
        "div",
        { className: "pregunta" },
        elemento("strong", { textContent: "Pregunta" }),
        pregunta,
      ),
      cuerpo,
    );
  }
  return seccion;
}

function listaDeFuentes(citadas) {
  const usadas = [...fuentes.values()].filter((fuente) => citadas.has(fuente.n));
  const lista = elemento("ol", { className: "lista-fuentes" });
  for (const fuente of usadas.length ? usadas : [...fuentes.values()]) {
    const item = elemento(
      "li",
      { id: `fuente-${fuente.n}`, value: fuente.n },
      elemento("a", {
        href: fuente.url,
        textContent: nombreDeFuente(fuente.titulo, fuente.url),
        target: "_blank",
        rel: "noopener noreferrer",
      }),
      " ",
      elemento("span", { className: "sitio", textContent: datosDeFuente(fuente) }),
    );
    lista.append(item);
  }
  return elemento("section", {}, elemento("h2", { textContent: "Fuentes" }), lista);
}

// Páginas que aparecieron en las búsquedas pero no se pudieron leer. Si la persona tiene acceso,
// puede agregar su contenido (texto o PDF) y rehacer el informe con lo agregado. Los botones y
// formularios llevan .solo-pagina: no van en el HTML descargado ni al imprimir.
const SIN_ACCESO = "sin acceso al contenido";
const MAX_PDF = 50 * 1024 * 1024;
const rutaDe = (final) => `/api/conversaciones/${encodeURIComponent(id)}${final}`;
let seccionPendientes = null;
let consulta = null;

const cantidad = (n, una, varias) => `${n} ${n === 1 ? una : varias}`;

function estadoDePendiente({ estado, fuente, mensaje }) {
  if (estado === "procesando") return { texto: "Analizando el contenido…" };
  if (estado === "agregada") return { texto: `Agregada como fuente ${fuente}.` };
  if (mensaje) return { texto: mensaje, error: true };
  return null;
}

async function enviarContenido(url, texto, archivo) {
  if (archivo) {
    if (archivo.size > MAX_PDF) throw new Error("El PDF pasa de 50 MB: copiá su texto y pegalo.");
    const respuesta = await conEspera(
      () =>
        fetch(`${API}${rutaDe("/pendientes")}?url=${encodeURIComponent(url)}`, {
          method: "POST",
          headers: cabeceras({ "Content-Type": "application/pdf" }),
          body: archivo,
        }),
      false,
    );
    if (!respuesta.ok) {
      const { error } = await respuesta.json().catch(() => ({}));
      throw new Error(error || "No se pudo enviar el PDF.");
    }
    return;
  }
  await pedir(rutaDe("/pendientes"), { metodo: "POST", cuerpo: { url, texto } });
}

function formularioDeContenido(url, alCancelar) {
  const texto = elemento("textarea", {
    rows: 6,
    placeholder: "Pegá acá el texto de la fuente (por ejemplo, el capítulo o el artículo completo)…",
  });
  const archivo = elemento("input", { type: "file", accept: ".pdf,application/pdf" });
  const error = elemento("p", { className: "error-pendiente", hidden: true });
  const agregar = elemento("button", { type: "submit", className: "boton principal", textContent: "Agregar" });
  const cancelar = elemento("button", { type: "button", className: "boton", textContent: "Cancelar" });
  const formulario = elemento(
    "form",
    { className: "agregar-contenido solo-pagina" },
    texto,
    elemento("label", {}, "o subí su PDF (hasta 50 MB): ", archivo),
    error,
    elemento("div", { className: "botones-pendiente" }, agregar, cancelar),
  );
  cancelar.addEventListener("click", alCancelar);
  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    error.hidden = true;
    agregar.disabled = true;
    try {
      await enviarContenido(url, texto.value.trim(), archivo.files[0]);
      await actualizar();
    } catch (fallo) {
      error.textContent = fallo.message;
      error.hidden = false;
      agregar.disabled = false;
    }
  });
  return formulario;
}

function itemPendiente(pendiente, ocupada) {
  const { url, titulo, motivo } = pendiente;
  const item = elemento(
    "li",
    {},
    elemento("a", { href: url, textContent: nombreDeFuente(titulo, url), target: "_blank", rel: "noopener noreferrer" }),
    " ",
    elemento("span", { className: "sitio", textContent: `${sitioDe(url)} · ${motivo}` }),
  );
  const estado = estadoDePendiente(pendiente);
  if (estado) {
    item.append(
      elemento("span", {
        className: `estado-pendiente solo-pagina${estado.error ? " error-pendiente" : ""}`,
        textContent: estado.texto,
      }),
    );
  }
  if (!ocupada && !["procesando", "agregada"].includes(pendiente.estado)) {
    const abrir = elemento("button", {
      type: "button",
      className: "boton chico solo-pagina",
      textContent: "Agregar contenido",
    });
    abrir.addEventListener("click", () => {
      const formulario = formularioDeContenido(url, () => {
        formulario.remove();
        abrir.hidden = false;
      });
      abrir.hidden = true;
      item.append(formulario);
      formulario.querySelector("textarea").focus();
    });
    item.append(abrir);
  }
  return item;
}

function barraDeRehacer({ ocupada, paraRehacer }) {
  if (ocupada) {
    return elemento("p", {
      className: "rehaciendo solo-pagina",
      textContent: "Se está rehaciendo el informe con las fuentes agregadas. Esta página se actualiza sola; podés cerrarla y volver más tarde.",
    });
  }
  if (!paraRehacer) return null;
  const boton = elemento("button", {
    type: "button",
    className: "boton principal",
    textContent: `Rehacer informe con ${cantidad(paraRehacer, "fuente agregada", "fuentes agregadas")}`,
  });
  const error = elemento("p", { className: "error-pendiente", hidden: true });
  boton.addEventListener("click", async () => {
    boton.disabled = true;
    error.hidden = true;
    try {
      await pedir(rutaDe("/rehacer"), { metodo: "POST" });
      await actualizar();
    } catch (fallo) {
      error.textContent = fallo.message;
      error.hidden = false;
      boton.disabled = false;
    }
  });
  return elemento("div", { className: "rehacer solo-pagina" }, boton, error);
}

function listaDePendientes(datos) {
  const unicas = [...new Map(datos.pendientes.map((pendiente) => [pendiente.url, pendiente])).values()];
  const ordenadas = [
    ...unicas.filter((pendiente) => pendiente.motivo === SIN_ACCESO),
    ...unicas.filter((pendiente) => pendiente.motivo !== SIN_ACCESO),
  ];
  const lista = elemento("ul", { className: "lista-fuentes pendientes" });
  for (const pendiente of ordenadas) lista.append(itemPendiente(pendiente, datos.ocupada));
  const barra = barraDeRehacer(datos);
  return elemento(
    "section",
    { className: "seccion-pendientes" },
    elemento("h2", { textContent: "Fuentes para revisar a mano" }),
    elemento("p", {
      textContent:
        "Estas páginas aparecieron en las búsquedas pero no se pudieron leer, así que el informe no las usa. Si tenés acceso a alguna, podés agregar su contenido y rehacer el informe con lo agregado.",
    }),
    ...(barra ? [barra] : []),
    lista,
  );
}

// Mientras se analiza contenido agregado o se rehace el informe, se consulta cada pocos segundos.
function seguirConsultando(datos) {
  clearTimeout(consulta);
  const enCurso = datos.ocupada || datos.pendientes?.some((pendiente) => pendiente.estado === "procesando");
  if (enCurso) consulta = setTimeout(() => actualizar().catch(() => seguirConsultando(datos)), 4000);
}

async function actualizar() {
  const datos = await pedir(rutaDe("/informe"));
  if (datos.informe !== datosDelInforme?.informe) {
    armar(datos);
    mostrarAviso("");
    return;
  }
  datosDelInforme = datos;
  if (seccionPendientes && datos.pendientes?.length) {
    const nueva = listaDePendientes(datos);
    seccionPendientes.replaceWith(nueva);
    seccionPendientes = nueva;
    armarIndice();
  }
  seguirConsultando(datos);
}

const idDe = (texto) =>
  texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "seccion";

// Cada sección del índice se abre sola mientras se la lee; lo que la persona abre o cierra a mano
// queda así hasta que lo vuelva a tocar.
const plegadoAMano = new Map();
let marcarIndice = () => {};

function armarIndice() {
  const usados = new Set();
  const lista = indice.querySelector("ol");
  lista.replaceChildren();
  const secciones = [];
  for (const titulo of documento.querySelectorAll("h2, h3")) {
    const base = idDe(titulo.textContent);
    let id = base;
    for (let n = 2; usados.has(id); n++) id = `${base}-${n}`;
    usados.add(id);
    titulo.id = id;
    const enlace = elemento("a", { href: `#${id}`, textContent: titulo.textContent });
    if (titulo.tagName === "H2") {
      const item = elemento("li", {}, elemento("div", { className: "fila" }, enlace));
      secciones.push({ titulo, enlace, item, sub: null, hijos: [] });
      lista.append(item);
    } else if (secciones.length) {
      const seccion = secciones.at(-1);
      if (!seccion.sub) {
        seccion.sub = elemento("ol", { className: "sub", id: `sub-${seccion.titulo.id}` });
        const boton = elemento("button", {
          type: "button",
          className: "plegar",
          ariaLabel: `Subsecciones de ${seccion.titulo.textContent}`,
        });
        boton.setAttribute("aria-controls", seccion.sub.id);
        boton.addEventListener("click", () => {
          plegadoAMano.set(seccion.titulo.id, boton.getAttribute("aria-expanded") !== "true");
          marcarIndice();
        });
        seccion.boton = boton;
        seccion.item.querySelector(".fila").append(boton);
        seccion.item.append(seccion.sub);
      }
      seccion.sub.append(elemento("li", {}, enlace));
      seccion.hijos.push({ titulo, enlace });
    }
  }
  indice.hidden = !lista.children.length;
  indice.querySelector("details").open = amplio.matches;

  // Marca en el índice la última sección (y subsección) cuyo título ya pasó por arriba; se
  // recalcula con cada scroll, así también acierta cuando se salta de golpe a otra parte.
  let anterior = null;
  marcarIndice = () => {
    const titulos = secciones.flatMap((seccion) => [seccion, ...seccion.hijos]);
    let actual = titulos[0];
    for (const titulo of titulos) {
      if (titulo.titulo.getBoundingClientRect().top < 120) actual = titulo;
      else break;
    }
    // Al final de la página los últimos títulos no llegan arriba: se marca el último.
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) actual = titulos.at(-1);
    for (const seccion of secciones) {
      const contiene = seccion === actual || seccion.hijos.includes(actual);
      if (contiene) seccion.enlace.setAttribute("aria-current", "true");
      else seccion.enlace.removeAttribute("aria-current");
      for (const hijo of seccion.hijos) {
        if (hijo === actual) hijo.enlace.setAttribute("aria-current", "true");
        else hijo.enlace.removeAttribute("aria-current");
      }
      if (!seccion.sub) continue;
      const abierta = plegadoAMano.get(seccion.titulo.id) ?? contiene;
      seccion.sub.hidden = !abierta;
      seccion.boton.setAttribute("aria-expanded", String(abierta));
    }
    // El índice fijo tiene su propio scroll: se lo mueve para que lo marcado quede a la vista.
    if (actual && actual !== anterior && amplio.matches) {
      const caja = indice.getBoundingClientRect();
      const visible = actual.enlace.checkVisibility()
        ? actual.enlace
        : secciones.find((seccion) => seccion.hijos.includes(actual)).enlace;
      const marca = visible.getBoundingClientRect();
      if (marca.top < caja.top + 48) indice.scrollTop -= caja.top + 48 - marca.top;
      else if (marca.bottom > caja.bottom - 8) indice.scrollTop += marca.bottom - caja.bottom + 8;
    }
    anterior = actual;
  };
  marcarIndice();
}

let marcaPendiente = false;
addEventListener(
  "scroll",
  () => {
    if (marcaPendiente) return;
    marcaPendiente = true;
    requestAnimationFrame(() => {
      marcaPendiente = false;
      marcarIndice();
    });
  },
  { passive: true },
);

// Vista previa de cada cita: con mouse aparece al pasar por encima y el clic lleva a la lista;
// en pantallas táctiles el primer toque la muestra.
let citaActiva = null;
let cierre = null;

function mostrarVista(cita) {
  clearTimeout(cierre);
  const fuente = fuentes.get(Number(cita.dataset.n));
  if (!fuente) return;
  citaActiva = cita;
  vista.replaceChildren(
    elemento("p", { className: "titulo-fuente", textContent: `${fuente.n}. ${nombreDeFuente(fuente.titulo, fuente.url)}` }),
    elemento("span", { className: "sitio", textContent: datosDeFuente(fuente) }),
    elemento(
      "div",
      { className: "enlaces" },
      elemento("a", {
        href: fuente.url,
        target: "_blank",
        rel: "noopener noreferrer",
        textContent: "Abrir la fuente ↗",
      }),
      elemento("a", { href: `#fuente-${fuente.n}`, textContent: "Ver en la lista" }),
    ),
  );
  vista.hidden = false;
  const caja = cita.getBoundingClientRect();
  const ancho = vista.offsetWidth;
  const izquierda = Math.min(
    Math.max(12, caja.left + caja.width / 2 - ancho / 2),
    document.documentElement.clientWidth - ancho - 12,
  );
  vista.style.left = `${izquierda + scrollX}px`;
  vista.style.top = `${caja.bottom + scrollY + 6}px`;
}

function ocultarVista(demora = 0) {
  clearTimeout(cierre);
  cierre = setTimeout(() => {
    vista.hidden = true;
    citaActiva = null;
  }, demora);
}

const tactil = matchMedia("(hover: none)");
documento.addEventListener("mouseover", (evento) => {
  const cita = evento.target.closest("a.cita");
  if (cita && !tactil.matches) mostrarVista(cita);
});
documento.addEventListener("mouseout", (evento) => {
  if (evento.target.closest("a.cita") && !tactil.matches) ocultarVista(250);
});
documento.addEventListener("focusin", (evento) => {
  const cita = evento.target.closest("a.cita");
  if (cita) mostrarVista(cita);
});
documento.addEventListener("click", (evento) => {
  const cita = evento.target.closest("a.cita");
  if (!cita || !tactil.matches || citaActiva === cita) return;
  evento.preventDefault();
  mostrarVista(cita);
});
vista.addEventListener("mouseenter", () => clearTimeout(cierre));
vista.addEventListener("mouseleave", () => ocultarVista(250));
vista.addEventListener("click", (evento) => {
  if (evento.target.closest("a")) ocultarVista();
});
document.addEventListener("click", (evento) => {
  if (!vista.hidden && !evento.target.closest("a.cita, .vista-cita")) ocultarVista();
});
document.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape") ocultarVista();
});
amplio.addEventListener("change", () => {
  indice.querySelector("details").open = amplio.matches;
});

function armar(datos) {
  datosDelInforme = datos;
  fuentes = new Map(datos.fuentes.map((fuente) => [fuente.n, fuente]));
  const corte = datos.informe.lastIndexOf("\n## Fuentes\n");
  let markdown = corte >= 0 ? datos.informe.slice(0, corte) : datos.informe;
  const encabezado = markdown.match(/^#\s+(.+)$/m);
  const titulo = encabezado ? encabezado[1].trim() : datos.titulo;
  if (encabezado) markdown = markdown.replace(encabezado[0], "");

  const cuerpo = elemento("section", { className: "cuerpo" });
  pintarMarkdown(cuerpo, markdown, crearCita, { tema: "ambos" });
  const preguntas = seguimiento(datos.intercambios);
  const citadas = new Set(
    [markdown, ...datos.intercambios.map((intercambio) => intercambio.respuesta)]
      .join("\n")
      .match(/\[\d+\]|"cita"\s*:\s*\d+/g)
      ?.map((cita) => Number(cita.match(/\d+/)[0])) ?? [],
  );
  documento.replaceChildren(
    portada(datos, titulo),
    cuerpo,
    ...(preguntas ? [preguntas] : []),
    listaDeFuentes(citadas),
  );
  seccionPendientes = datos.pendientes?.length ? listaDePendientes(datos) : null;
  if (seccionPendientes) documento.append(seccionPendientes);
  document.title = `${titulo} · Investigador`;
  armarIndice();
  seguirConsultando(datos);
  for (const boton of document.querySelectorAll("#descargar-html, #descargar-pdf")) {
    boton.disabled = false;
  }
}

function mostrarAviso(mensaje) {
  $("#aviso").textContent = mensaje;
  $("#aviso").hidden = !mensaje;
}

// El archivo descargado no lleva scripts: las citas quedan como enlaces a la lista, con el título
// de la fuente en el cartel nativo del navegador.
async function descargarHTML(boton) {
  boton.disabled = true;
  mostrarAviso("");
  try {
    const estilos = await (await fetch("informe.css")).text();
    const hoja = $(".hoja").cloneNode(true);
    hoja.querySelector("details")?.setAttribute("open", "");
    for (const cita of hoja.querySelectorAll("a.cita")) {
      const fuente = fuentes.get(Number(cita.dataset.n));
      if (fuente) cita.title = `${fuente.n}. ${fuente.titulo} — ${sitioDe(fuente.url)}`;
    }
    for (const nodo of hoja.querySelectorAll("[aria-current]")) nodo.removeAttribute("aria-current");
    for (const boton of hoja.querySelectorAll(".plegar")) boton.remove();
    for (const sub of hoja.querySelectorAll(".indice .sub")) sub.hidden = false;
    for (const nodo of hoja.querySelectorAll(".solo-pagina")) nodo.remove();
    const html = `<!doctype html>
<html lang="es" data-tema="${document.documentElement.dataset.tema}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${document.title.replace(/[<&]/g, "")}</title>
<style>
${estilos}
</style>
</head>
<body>
${hoja.outerHTML}
</body>
</html>
`;
    guardarArchivo(new Blob([html], { type: "text/html" }), `${datosDelInforme.archivo}.html`);
  } catch (error) {
    mostrarAviso(`No se pudo armar el archivo: ${error.message}`);
  } finally {
    boton.disabled = false;
  }
}

$("#descargar-html")?.addEventListener("click", (evento) => descargarHTML(evento.currentTarget));
// El tema inicial lo pone tema.js antes de pintar; acá se cambia y se recuerda.
const raiz = document.documentElement;
const rotularTema = () => {
  $("#tema").textContent = raiz.dataset.tema === "oscuro" ? "Modo claro" : "Modo oscuro";
};
$("#tema").addEventListener("click", () => {
  raiz.dataset.tema = raiz.dataset.tema === "oscuro" ? "claro" : "oscuro";
  guardarDato("tema-informe", raiz.dataset.tema);
  rotularTema();
});
rotularTema();

$("#descargar-pdf").addEventListener("click", async (evento) => {
  if (muestra) return;
  const boton = evento.currentTarget;
  boton.disabled = true;
  mostrarAviso("");
  try {
    await descargar(`/api/informe/${encodeURIComponent(id)}`, `${datosDelInforme.archivo}.pdf`);
  } catch (error) {
    mostrarAviso(error.message);
  } finally {
    boton.disabled = false;
  }
});

if (muestra) {
  try {
    const respuesta = await fetch(muestra);
    if (!respuesta.ok) throw new Error(respuesta.statusText);
    armar(await respuesta.json());
  } catch {
    fallar("No se pudo cargar el informe de ejemplo.", true);
  }
} else if (!id) {
  fallar("Falta indicar qué investigación mostrar.", true);
} else if (!hayToken()) {
  fallar("Entrá al investigador con tu código para ver este informe.", true);
} else {
  try {
    armar(await pedir(rutaDe("/informe")));
  } catch (error) {
    fallar(
      error.estado === 401 ? "Tu sesión venció: entrá de nuevo al investigador." : error.message,
      error.estado === 401,
    );
  }
}
