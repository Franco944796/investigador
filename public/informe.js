import { $, descargar, guardarArchivo, hayToken, pedir, pintarMarkdown } from "./comun.js";

const id = new URLSearchParams(location.search).get("id");
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
    elemento(
      "details",
      { className: "pedido" },
      elemento("summary", { textContent: "Pedido original" }),
      elemento("pre", { textContent: datos.tema }),
    ),
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
    pintarMarkdown(cuerpo, respuesta, crearCita, { tema: "claro" });
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
        textContent: fuente.titulo || fuente.url,
        target: "_blank",
        rel: "noopener noreferrer",
      }),
      " ",
      elemento("span", { className: "sitio", textContent: sitioDe(fuente.url) }),
    );
    lista.append(item);
  }
  return elemento("section", {}, elemento("h2", { textContent: "Fuentes" }), lista);
}

function armarIndice() {
  const usados = new Set();
  const lista = indice.querySelector("ol");
  lista.replaceChildren();
  for (const titulo of documento.querySelectorAll("h2")) {
    const base =
      titulo.textContent
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "seccion";
    let id = base;
    for (let n = 2; usados.has(id); n++) id = `${base}-${n}`;
    usados.add(id);
    titulo.id = id;
    lista.append(elemento("li", {}, elemento("a", { href: `#${id}`, textContent: titulo.textContent })));
  }
  indice.hidden = !lista.children.length;
  indice.querySelector("details").open = amplio.matches;

  // Marca en el índice la última sección cuyo título ya pasó por arriba; se recalcula con cada
  // scroll, así también acierta cuando se salta de golpe a otra parte.
  const enlaces = new Map([...lista.querySelectorAll("a")].map((a) => [a.hash.slice(1), a]));
  const titulos = [...documento.querySelectorAll("h2")];
  const marcar = () => {
    let actual = titulos[0];
    for (const titulo of titulos) {
      if (titulo.getBoundingClientRect().top < 120) actual = titulo;
      else break;
    }
    // Al final de la página los últimos títulos no llegan arriba: se marca el último.
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) actual = titulos.at(-1);
    for (const [clave, enlace] of enlaces) {
      if (clave === actual?.id) enlace.setAttribute("aria-current", "true");
      else enlace.removeAttribute("aria-current");
    }
  };
  let pendiente = false;
  addEventListener(
    "scroll",
    () => {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(() => {
        pendiente = false;
        marcar();
      });
    },
    { passive: true },
  );
  marcar();
}

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
    elemento("p", { className: "titulo-fuente", textContent: `${fuente.n}. ${fuente.titulo || fuente.url}` }),
    elemento("span", { className: "sitio", textContent: sitioDe(fuente.url) }),
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
  pintarMarkdown(cuerpo, markdown, crearCita, { tema: "claro" });
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
  document.title = `${titulo} · Investigador`;
  armarIndice();
  $("#descargar-html").disabled = false;
  $("#descargar-pdf").disabled = false;
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
    const html = `<!doctype html>
<html lang="es">
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

$("#descargar-html").addEventListener("click", (evento) => descargarHTML(evento.currentTarget));
$("#descargar-pdf").addEventListener("click", async (evento) => {
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

if (!id) {
  fallar("Falta indicar qué investigación mostrar.", true);
} else if (!hayToken()) {
  fallar("Entrá al investigador con tu código para ver este informe.", true);
} else {
  try {
    armar(await pedir(`/api/conversaciones/${encodeURIComponent(id)}/informe`));
  } catch (error) {
    fallar(
      error.estado === 401 ? "Tu sesión venció: entrá de nuevo al investigador." : error.message,
      error.estado === 401,
    );
  }
}
