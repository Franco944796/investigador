import { dibujarGrafico, imagenDe, tipoDeGrafico } from "./graficos.js";

const { marked, DOMPurify } = globalThis;

export const $ = (selector) => document.querySelector(selector);

// Vacío cuando la página la sirve el mismo servidor; scripts/pagina.js pone la dirección de Render
// en las copias que se publican en GitHub Pages.
export const API = $('meta[name="api"]').content;

export const pausa = (ms, signal) =>
  new Promise((listo) => {
    const reloj = setTimeout(listo, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(reloj);
      listo();
    });
  });

// En GitHub Pages el almacenamiento lo comparten todos los proyectos del sitio: las claves llevan
// prefijo. Si el navegador lo bloquea, la sesión dura hasta recargar.
export function leerGuardado(clave) {
  try {
    return localStorage.getItem(`investigador-${clave}`);
  } catch {
    return null;
  }
}

export function guardarDato(clave, valor) {
  try {
    if (valor === null) localStorage.removeItem(`investigador-${clave}`);
    else localStorage.setItem(`investigador-${clave}`, valor);
  } catch {}
}

let token = leerGuardado("token");

export const hayToken = () => Boolean(token);

export function guardarToken(nuevo) {
  token = nuevo;
  guardarDato("token", nuevo);
}

export function olvidarSesion() {
  guardarToken(null);
}

export const cabeceras = (extra = {}) =>
  token ? { ...extra, Authorization: `Bearer ${token}` } : extra;

// Render apaga el servidor gratuito tras 15 min sin uso y tarda hasta un minuto en despertar.
// Solo se reintentan las lecturas: repetir un POST podría lanzar dos veces la misma investigación.
let pedidosLentos = 0;

export async function conEspera(hacer, reintentar) {
  let lento = false;
  const reloj = setTimeout(() => {
    lento = true;
    $("#conexion").hidden = ++pedidosLentos === 0;
  }, 3000);
  try {
    for (let intento = 1; ; intento++) {
      try {
        const respuesta = await hacer();
        const caido = [502, 503, 504].includes(respuesta.status);
        if (!reintentar || !caido || intento >= 40) return respuesta;
      } catch {
        if (!reintentar || intento >= 40) {
          throw new Error("No se pudo conectar con el servidor. Probá de nuevo en un momento.");
        }
      }
      await pausa(3000);
    }
  } finally {
    clearTimeout(reloj);
    if (lento) $("#conexion").hidden = --pedidosLentos === 0;
  }
}

export async function pedir(ruta, { metodo = "GET", cuerpo } = {}) {
  const opciones = {
    method: metodo,
    headers: cabeceras(cuerpo === undefined ? {} : { "Content-Type": "application/json" }),
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  };
  const respuesta = await conEspera(() => fetch(API + ruta, opciones), metodo === "GET");
  if (respuesta.status === 401) olvidarSesion();
  const datos = respuesta.status === 204 ? {} : await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    throw Object.assign(new Error(datos.error || "No se pudo completar el pedido."), {
      estado: respuesta.status,
    });
  }
  return datos;
}

export function guardarArchivo(contenido, nombre) {
  const url = URL.createObjectURL(contenido);
  const enlace = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// La descarga necesita el token en la cabecera, así que no alcanza con un enlace al archivo.
export async function descargar(ruta, porDefecto) {
  const respuesta = await conEspera(() => fetch(API + ruta, { headers: cabeceras() }), true);
  if (!respuesta.ok) {
    const { error } = await respuesta.json().catch(() => ({}));
    throw new Error(error || "No se pudo descargar el archivo.");
  }
  const disposicion = respuesta.headers.get("Content-Disposition") ?? "";
  guardarArchivo(await respuesta.blob(), disposicion.match(/filename="([^"]+)"/)?.[1] ?? porDefecto);
}

// `crearCita(n)` devuelve el elemento que reemplaza a "[n]", o null para dejarlo como texto.
function enlazarCitas(contenedor, crearCita) {
  const recorrido = document.createTreeWalker(contenedor, NodeFilter.SHOW_TEXT);
  const nodos = [];
  while (recorrido.nextNode()) {
    const nodo = recorrido.currentNode;
    if (/\[\d+\]/.test(nodo.data) && !nodo.parentElement.closest("a, code, pre")) nodos.push(nodo);
  }
  for (const nodo of nodos) {
    const fragmento = document.createDocumentFragment();
    nodo.data.split(/\[(\d+)\]/).forEach((parte, indice) => {
      const cita = indice % 2 ? crearCita(Number(parte)) : null;
      fragmento.append(cita ?? (indice % 2 ? `[${parte}]` : parte));
    });
    nodo.replaceWith(fragmento);
  }
}

let geografia = null;
const cargarGeografia = () => (geografia ??= fetch("mapa.json").then((r) => r.json()));

const sitioDe = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function pie(titulo, citas, detalle = []) {
  const leyenda = document.createElement("figcaption");
  leyenda.append(Object.assign(document.createElement("strong"), { textContent: titulo }));
  if (detalle.length) leyenda.append(` — ${detalle.join("; ")}`);
  if (citas.length) leyenda.append(` — Fuentes: ${citas.map((n) => `[${n}]`).join(" ")}`);
  return leyenda;
}

// Con tema "ambos" el gráfico se dibuja en claro y en oscuro, y el estilo muestra uno: así el
// informe cambia de tema sin redibujar y el archivo descargado (sin scripts) también puede.
function figuraDeGrafico(codigo, tema, geo) {
  const temas = tema === "ambos" ? ["claro", "oscuro"] : [tema];
  const dibujos = temas.map((uno) => dibujarGrafico(codigo, { tema: uno, geografia: geo }));
  const [grafico] = dibujos;
  if (!grafico) return null;
  const figura = Object.assign(document.createElement("figure"), { className: "grafico" });
  // El SVG lo arma graficos.js escapando todo el texto que viene del modelo.
  figura.innerHTML =
    tema === "ambos"
      ? dibujos.map((dibujo, i) => `<div class="tema-${temas[i]}">${dibujo.svg}</div>`).join("")
      : grafico.svg;
  figura.append(pie(grafico.titulo, grafico.citas, grafico.detalle));
  return figura;
}

// Imagen de una fuente: si el sitio no deja mostrarla (derechos, bloqueo), queda el aviso con el
// enlace para verla allá.
function figuraDeImagen({ url, pie: texto, cita }) {
  const figura = Object.assign(document.createElement("figure"), { className: "grafico imagen" });
  const enlace = () =>
    Object.assign(document.createElement("a"), {
      href: url,
      textContent: `verla en ${sitioDe(url)}`,
      target: "_blank",
      rel: "noopener noreferrer",
    });
  const imagen = Object.assign(document.createElement("img"), {
    src: url,
    alt: texto,
    loading: "lazy",
    referrerPolicy: "no-referrer",
  });
  imagen.addEventListener("error", () => {
    const aviso = Object.assign(document.createElement("p"), {
      className: "imagen-no-disponible",
      textContent: "Imagen no disponible aquí (por derechos de autor o porque el sitio no permite mostrarla): ",
    });
    aviso.append(enlace());
    imagen.replaceWith(aviso);
  });
  figura.append(imagen, pie(texto || "Imagen", cita ? [cita] : [], [`imagen de ${sitioDe(url)}`]));
  return figura;
}

// Reemplaza los bloques ```grafico por figuras. Un bloque roto o a medio llegar no se muestra.
function pintarGraficos(contenedor, tema, crearCita) {
  for (const codigo of contenedor.querySelectorAll("pre > code.language-grafico")) {
    const bloque = codigo.parentElement;
    const texto = codigo.textContent;
    const imagen = imagenDe(texto);
    if (imagen) {
      bloque.replaceWith(figuraDeImagen(imagen));
    } else if (tipoDeGrafico(texto) === "mapa") {
      const lugar = Object.assign(document.createElement("figure"), { className: "grafico" });
      bloque.replaceWith(lugar);
      cargarGeografia()
        .then((geo) => {
          const figura = figuraDeGrafico(texto, tema, geo);
          if (!figura) return lugar.remove();
          enlazarCitas(figura, crearCita);
          lugar.replaceWith(figura);
        })
        .catch(() => lugar.remove());
    } else {
      const figura = figuraDeGrafico(texto, tema, null);
      if (figura) bloque.replaceWith(figura);
      else bloque.remove();
    }
  }
}

export function pintarMarkdown(contenedor, markdown, crearCita, { tema = "oscuro" } = {}) {
  contenedor.innerHTML = DOMPurify.sanitize(marked.parse(markdown), {
    FORBID_TAGS: ["img", "style", "form", "input", "button"],
  });
  pintarGraficos(contenedor, tema, crearCita);
  for (const tabla of contenedor.querySelectorAll("table")) {
    const envoltura = document.createElement("div");
    envoltura.className = "tabla";
    tabla.replaceWith(envoltura);
    envoltura.append(tabla);
  }
  for (const enlace of contenedor.querySelectorAll("a")) {
    enlace.target = "_blank";
    enlace.rel = "noopener noreferrer";
  }
  enlazarCitas(contenedor, crearCita);
}
