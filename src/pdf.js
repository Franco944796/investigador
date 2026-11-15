import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { marked } from "marked";
import pdfmake from "pdfmake";
import { PARTIR, latexATexto, separarFormulas } from "../public/formulas.js";
import { dibujarGrafico, imagenDe, tipoDeGrafico } from "../public/graficos.js";
import { descargarImagen } from "./lector.js";

const AZUL = "#1a56b0";
const ANCHO_UTIL = 483;

const fuente = (archivo) =>
  fileURLToPath(new URL(`../node_modules/pdfmake/fonts/Roboto/${archivo}`, import.meta.url));
const dejavu = (archivo) =>
  fileURLToPath(new URL(`../node_modules/dejavu-fonts-ttf/ttf/${archivo}`, import.meta.url));

pdfmake.setFonts({
  Roboto: {
    normal: fuente("Roboto-Regular.ttf"),
    bold: fuente("Roboto-Medium.ttf"),
    italics: fuente("Roboto-Italic.ttf"),
    bolditalics: fuente("Roboto-MediumItalic.ttf"),
  },
  DejaVu: {
    normal: dejavu("DejaVuSans.ttf"),
    bold: dejavu("DejaVuSans-Bold.ttf"),
    italics: dejavu("DejaVuSans-Oblique.ttf"),
    bolditalics: dejavu("DejaVuSans-BoldOblique.ttf"),
  },
});
// Roboto no trae flechas, símbolos matemáticos (ṁ, ∝, ∇, ⋅) ni tildes de verificación: esos
// caracteres van con DejaVu Sans. Lo que ninguna tiene (emojis, chino) se sustituye o se quita;
// el PDF los dibujaría como recuadros vacíos. Las cuatro variantes cubren los mismos caracteres.
const ROBOTO = fontkit.openSync(fuente("Roboto-Regular.ttf"));
const DEJAVU = fontkit.openSync(dejavu("DejaVuSans.ttf"));
const SUSTITUTOS = {
  "✅": "✓",
  "✔": "✓",
  "❌": "✗",
  "⭐": "★",
};

// Saltos de línea y tabulaciones no tienen glifo, pero sin ellos el Markdown queda en una sola línea.
const SIN_GLIFO_PERO_NECESARIOS = new Set(["\n", "\r", "\t"]);

const enRoboto = new Map();
const robotoLoTiene = (caracter) => {
  if (!enRoboto.has(caracter)) enRoboto.set(caracter, ROBOTO.hasGlyphForCodePoint(caracter.codePointAt(0)));
  return enRoboto.get(caracter);
};
const tieneGlifo = (caracter) =>
  robotoLoTiene(caracter) || DEJAVU.hasGlyphForCodePoint(caracter.codePointAt(0));

// Parte el texto en tramos Roboto/DejaVu. Va por grupos (letra + acentos combinantes) para que el
// punto de "ṁ" no quede en otra fuente que su letra.
function porFuente(texto, estilo) {
  const tramos = [];
  for (const grupo of texto.match(/\P{M}\p{M}*|\p{M}+/gu) ?? []) {
    const fuenteDelGrupo = /^\s$/u.test(grupo) || [...grupo].every(robotoLoTiene) ? null : "DejaVu";
    const ultimo = tramos.at(-1);
    if (ultimo && (ultimo.font ?? null) === fuenteDelGrupo) ultimo.text += grupo;
    else tramos.push(fuenteDelGrupo ? { ...estilo, text: grupo, font: fuenteDelGrupo } : { ...estilo, text: grupo });
  }
  return tramos;
}

export function aptoParaPDF(texto) {
  let quitados = false;
  const apto = [...texto]
    .map((caracter) => {
      if (SIN_GLIFO_PERO_NECESARIOS.has(caracter)) return caracter;
      if (tieneGlifo(caracter)) return caracter;
      const sustituto = SUSTITUTOS[caracter] ?? (/\s/.test(caracter) ? " " : "");
      if (!sustituto) quitados = true;
      return sustituto;
    })
    .join("");
  // Al quitar nombres en chino o japonés quedan restos como "Qingtao (, China)" o "()".
  return quitados
    ? apto
        .replace(/\(\s*[,;:·]\s*/g, "(")
        .replace(/\s*[,;:·]\s*\)/g, ")")
        .replace(/ ?\(\s*\)/g, "")
    : apto;
}

// El informe lo escribe un modelo: el PDF no debe poder leer archivos ni URLs por su cuenta.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((ruta) => ruta.endsWith(".ttf"));

const ENTIDADES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decodificar = (texto) =>
  texto.replace(/&(?:amp|lt|gt|quot|#39);/g, (entidad) => ENTIDADES[entidad]);

// Las fórmulas del informe que se está armando: bloques() es síncrona y generarPDF la fija justo
// antes de llamarla.
let formulas = [];

const formulaEnLinea = (tex, estilo) =>
  latexATexto(tex).flatMap(({ text, sub, sup }) =>
    porFuente(aptoParaPDF(text), { ...estilo, ...(sub && { sub: true }), ...(sup && { sup: true }) }),
  );

function conCitas(texto, estilo, urls) {
  return texto.split(PARTIR).flatMap((parte, indice) => {
    if (indice % 2) {
      const formula = formulas[Number(parte)];
      if (!formula) return [];
      // Las destacadas se dibujan aparte (ver conFormulas); queda una marca en su lugar.
      return formula.display ? [{ ...estilo, formula: formula.tex }] : formulaEnLinea(formula.tex, estilo);
    }
    if (estilo.link) return porFuente(parte, estilo);
    // Citas pegadas ("[5][18][22]") serían una sola palabra que pdfmake no puede cortar, y en
    // tablas angostas empujan la columna fuera de la hoja.
    return parte
      .replace(/\](?=\[\d+\])/g, "] ")
      .split(/(\[\d+\])/)
      .filter(Boolean)
      .flatMap((trozo) => {
        const url = urls.get(Number(trozo.match(/^\[(\d+)\]$/)?.[1]));
        return url ? [{ ...estilo, text: trozo, link: url, color: AZUL }] : porFuente(trozo, estilo);
      });
  });
}

// En títulos y celdas una fórmula destacada no puede ir aparte: va como texto.
const enLinea = (tramos) =>
  tramos.flatMap(({ formula, ...estilo }) => (formula === undefined ? [estilo] : formulaEnLinea(formula, estilo)));

let mathjax = null;
function cargarMathJax() {
  if (mathjax) return mathjax;
  // mathjax-full es CommonJS y pesa: se carga recién con la primera fórmula destacada.
  const requerir = createRequire(import.meta.url);
  const { mathjax: nucleo } = requerir("mathjax-full/js/mathjax.js");
  const { TeX } = requerir("mathjax-full/js/input/tex.js");
  const { SVG } = requerir("mathjax-full/js/output/svg.js");
  const { liteAdaptor } = requerir("mathjax-full/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = requerir("mathjax-full/js/handlers/html.js");
  requerir("mathjax-full/js/input/tex/base/BaseConfiguration.js");
  requerir("mathjax-full/js/input/tex/ams/AmsConfiguration.js");
  requerir("mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js");
  const adaptador = liteAdaptor();
  RegisterHTMLHandler(adaptador);
  const documento = nucleo.document("", {
    InputJax: new TeX({ packages: ["base", "ams", "noundefined"] }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  mathjax = (tex) => adaptador.innerHTML(documento.convert(tex, { display: true }));
  return mathjax;
}

const TAMANO_FORMULA = 12;

// MathJax mide en milésimas de "em"; pdfmake necesita puntos y no entiende currentColor ni el
// estilo de alineación vertical.
function formulaDestacada(tex) {
  try {
    const svg = cargarMathJax()(tex);
    const caja = svg.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/);
    if (!caja || /data-mjx-error|<merror/.test(svg)) throw new Error("fórmula con errores");
    const escala = Math.min(1, ANCHO_UTIL / ((Number(caja[1]) / 1000) * TAMANO_FORMULA));
    const [ancho, alto] = [caja[1], caja[2]].map((medida) => (Number(medida) / 1000) * TAMANO_FORMULA * escala);
    const limpio = svg
      .replace(/currentColor/g, "#000000")
      .replace(/ style="[^"]*"/, "")
      .replace(/ width="[^"]+" height="[^"]+"/, ` width="${ancho.toFixed(2)}" height="${alto.toFixed(2)}"`);
    return { svg: limpio, width: ancho, height: alto, alignment: "center", margin: [0, 4, 0, 10] };
  } catch {
    return { text: formulaEnLinea(tex, {}), alignment: "center", margin: [0, 4, 0, 10] };
  }
}

// Un párrafo con fórmulas destacadas se parte: texto, fórmula dibujada, texto.
function conFormulas(tramos, extra) {
  if (!tramos.some((tramo) => tramo.formula !== undefined)) return [{ text: tramos, ...extra }];
  const salida = [];
  let texto = [];
  const cerrarTexto = () => {
    while (texto.length && !texto.at(-1).text?.trim()) texto.pop();
    if (texto.length) salida.push({ text: texto, ...extra });
    texto = [];
  };
  for (const tramo of tramos) {
    if (tramo.formula === undefined) {
      if (texto.length || tramo.text?.trim()) texto.push(tramo);
    } else {
      cerrarTexto();
      salida.push(formulaDestacada(tramo.formula));
    }
  }
  cerrarTexto();
  return salida;
}

function tramos(tokens, estilo, urls) {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case "strong":
        return tramos(token.tokens, { ...estilo, bold: true }, urls);
      case "em":
        return tramos(token.tokens, { ...estilo, italics: true }, urls);
      case "del":
        return tramos(token.tokens, { ...estilo, decoration: "lineThrough" }, urls);
      case "link":
        return /^https?:\/\//.test(token.href)
          ? tramos(token.tokens, { ...estilo, link: token.href, color: AZUL }, urls)
          : tramos(token.tokens, estilo, urls);
      case "codespan":
        return porFuente(decodificar(token.text), { ...estilo, background: "#eeeeee" });
      case "br":
        return [{ text: "\n" }];
      case "image":
        return [{ ...estilo, text: token.text }];
      case "html":
        return [];
      default:
        return token.tokens
          ? tramos(token.tokens, estilo, urls)
          : conCitas(decodificar(token.text ?? token.raw ?? ""), estilo, urls);
    }
  });
}

// Igual que "lightHorizontalLines" de pdfmake, pero con el relleno lateral elegido (el original
// usa 8 puntos por lado, demasiado para tablas anchas).
const lineasHorizontales = (relleno) => ({
  hLineWidth: (i, nodo) => {
    if (i === 0 || i === nodo.table.body.length) return 0;
    return i === nodo.table.headerRows ? 2 : 1;
  },
  vLineWidth: () => 0,
  hLineColor: (i) => (i === 1 ? "black" : "#aaaaaa"),
  paddingLeft: (i) => (i === 0 ? 0 : relleno),
  paddingRight: (i, nodo) => (i === nodo.table.widths.length - 1 ? 0 : relleno),
});

function bloques(tokens, urls, imagenes = new Map()) {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case "heading":
        return [{ text: enLinea(tramos(token.tokens, {}, urls)), style: `h${Math.min(token.depth, 3)}` }];
      case "paragraph":
        return conFormulas(tramos(token.tokens, {}, urls), { margin: [0, 0, 0, 8] });
      case "text":
        return conFormulas(tramos(token.tokens ?? [token], {}, urls), {});
      case "list": {
        const items = token.items.map((item) => ({ stack: bloques(item.tokens, urls, imagenes) }));
        const margin = [0, 0, 0, 8];
        return [token.ordered ? { ol: items, start: Number(token.start) || 1, margin } : { ul: items, margin }];
      }
      case "blockquote":
        return [{ stack: bloques(token.tokens, urls, imagenes), style: "cita" }];
      case "code":
        if (token.lang === "grafico") return bloqueDeGrafico(token.text, urls, imagenes);
        return [
          {
            table: { widths: ["*"], body: [[{ text: porFuente(token.text, {}), style: "codigo" }]] },
            layout: "noBorders",
            margin: [0, 2, 0, 10],
          },
        ];
      case "table": {
        const fila = (celdas, extra) =>
          celdas.map((celda) => ({ text: enLinea(tramos(celda.tokens, {}, urls)), ...extra }));
        const columnas = token.header.length;
        return [
          {
            table: {
              headerRows: 1,
              // Con "*" pdfmake da a todas las columnas el ancho de la palabra más larga de la
              // tabla; con muchas columnas eso se sale de la hoja. "auto" reparte según el contenido.
              widths: token.header.map(() => (columnas >= 5 ? "auto" : "*")),
              body: [
                fila(token.header, { bold: true, fillColor: "#eeeeee" }),
                ...token.rows.map((celdas) => fila(celdas)),
              ],
            },
            layout: lineasHorizontales(columnas >= 5 ? 3 : 6),
            // pdfmake no corta palabras: con muchas columnas, letra más chica para que entren.
            fontSize: columnas >= 7 ? 7.5 : columnas >= 5 ? 8.5 : 9,
            margin: [0, 2, 0, 10],
          },
        ];
      }
      case "hr":
        return [
          {
            canvas: [
              { type: "line", x1: 0, y1: 0, x2: ANCHO_UTIL, y2: 0, lineWidth: 0.5, lineColor: "#bbbbbb" },
            ],
            margin: [0, 6, 0, 10],
          },
        ];
      default:
        return [];
    }
  });
}

let geografia = null;
const mapa = () =>
  (geografia ??= JSON.parse(readFileSync(new URL("../public/mapa.json", import.meta.url), "utf8")));

function codigosDeGrafico(tokens, lista = []) {
  for (const token of tokens ?? []) {
    if (token.type === "code" && token.lang === "grafico") lista.push(token.text);
    codigosDeGrafico(token.tokens, lista);
    codigosDeGrafico(token.items, lista);
  }
  return lista;
}

const sitioDe = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function pieDeGrafico(titulo, citas, urls, detalle = []) {
  const enlaces = citas.flatMap((n) => [{ text: `[${n}]`, link: urls.get(n), color: AZUL }, " "]);
  return {
    text: [
      { text: titulo, bold: true },
      ...(detalle.length ? [` — ${detalle.join("; ")}`] : []),
      ...(enlaces.length ? [" — Fuentes: ", ...enlaces] : []),
    ],
    fontSize: 8.5,
    color: "#555555",
    margin: [0, 3, 0, 12],
  };
}

// Las imágenes de las fuentes se bajan antes de armar el PDF; si no se puede (derechos, bloqueo,
// formato), queda el aviso con el enlace para verla en su sitio.
function bloqueDeGrafico(texto, urls, imagenes) {
  const imagen = imagenDe(texto);
  if (imagen) {
    const datos = imagenes.get(imagen.url);
    const pie = pieDeGrafico(imagen.pie || "Imagen", imagen.cita ? [imagen.cita] : [], urls, [
      `imagen de ${sitioDe(imagen.url)}`,
    ]);
    if (datos) return [{ image: datos, fit: [ANCHO_UTIL, 330], alignment: "center", margin: [0, 6, 0, 0] }, pie];
    return [
      {
        text: [
          "Imagen no disponible en el PDF (por derechos de autor o porque el sitio no permite mostrarla): ",
          { text: `verla en ${sitioDe(imagen.url)}`, link: imagen.url, color: AZUL },
        ],
        italics: true,
        fontSize: 9,
        margin: [0, 6, 0, 0],
      },
      pie,
    ];
  }
  const grafico = dibujarGrafico(texto, {
    tema: "claro",
    geografia: tipoDeGrafico(texto) === "mapa" ? mapa() : null,
  });
  if (!grafico) return [];
  return [
    { svg: grafico.svg, width: ANCHO_UTIL, margin: [0, 8, 0, 0] },
    pieDeGrafico(grafico.titulo, grafico.citas, urls, grafico.detalle),
  ];
}

export async function generarPDF({ titulo, markdown, fuentes }) {
  const urls = new Map(fuentes.map((fuente) => [fuente.n, fuente.url]));
  const separado = separarFormulas(markdown);
  const tokens = marked.lexer(aptoParaPDF(separado.texto));
  const direcciones = codigosDeGrafico(tokens).map((texto) => imagenDe(texto)?.url).filter(Boolean);
  const imagenes = new Map(
    await Promise.all(
      [...new Set(direcciones)].map(async (url) => [
        url,
        await descargarImagen(url, { signal: AbortSignal.timeout(15000) }).catch(() => null),
      ]),
    ),
  );
  const fecha = new Date().toLocaleDateString("es-AR");
  formulas = separado.formulas;
  const contenido = bloques(tokens, urls, imagenes);
  return pdfmake
    .createPdf({
      info: { title: titulo },
      pageSize: "A4",
      pageMargins: [56, 56, 56, 64],
      defaultStyle: { font: "Roboto", fontSize: 10.5, lineHeight: 1.3 },
      footer: (pagina, total) => ({
        text: `Generado el ${fecha} · ${pagina} / ${total}`,
        alignment: "center",
        fontSize: 8,
        color: "#777777",
        margin: [0, 24, 0, 0],
      }),
      content: contenido,
      styles: {
        h1: { fontSize: 20, bold: true, lineHeight: 1.15, margin: [0, 0, 0, 12] },
        h2: { fontSize: 14, bold: true, margin: [0, 12, 0, 6] },
        h3: { fontSize: 11.5, bold: true, margin: [0, 8, 0, 4] },
        cita: { italics: true, color: "#555555", margin: [14, 0, 0, 8] },
        codigo: { fontSize: 9, fillColor: "#f2f2f2", preserveLeadingSpaces: true },
      },
    })
    .getBuffer();
}

// Con la plantilla de la página, el pedido empieza con "Pregunta: …": esa línea es el título.
export function tituloDelPedido(tema) {
  return tema.match(/^\s*Pregunta:[ \t]*(\S.*)$/im)?.[1].trim() ?? tema;
}

export function nombreDeArchivo(tema) {
  const base = tituloDelPedido(tema)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "informe"}.pdf`;
}
