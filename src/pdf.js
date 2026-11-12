import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { marked } from "marked";
import pdfmake from "pdfmake";

const AZUL = "#1a56b0";
const ANCHO_UTIL = 483;

const fuente = (archivo) =>
  fileURLToPath(new URL(`../node_modules/pdfmake/fonts/Roboto/${archivo}`, import.meta.url));

pdfmake.setFonts({
  Roboto: {
    normal: fuente("Roboto-Regular.ttf"),
    bold: fuente("Roboto-Medium.ttf"),
    italics: fuente("Roboto-Italic.ttf"),
    bolditalics: fuente("Roboto-MediumItalic.ttf"),
  },
});
// Roboto no trae flechas, tildes de verificación ni emojis, y el PDF los dibujaría como
// recuadros vacíos. Las cuatro variantes cubren los mismos caracteres.
const ROBOTO = fontkit.openSync(fuente("Roboto-Regular.ttf"));
const SUSTITUTOS = {
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "⇒": "=>",
  "⇐": "<=",
  "⇔": "<=>",
  "↑": "^",
  "✓": "√",
  "✔": "√",
  "✅": "√",
  "✗": "×",
  "✘": "×",
  "❌": "×",
  "⚠": "(!)",
  "★": "*",
  "☆": "*",
};

// Saltos de línea y tabulaciones no tienen glifo, pero sin ellos el Markdown queda en una sola línea.
const SIN_GLIFO_PERO_NECESARIOS = new Set(["\n", "\r", "\t"]);

export function aptoParaPDF(texto) {
  return [...texto]
    .map((caracter) => {
      if (SIN_GLIFO_PERO_NECESARIOS.has(caracter)) return caracter;
      if (ROBOTO.hasGlyphForCodePoint(caracter.codePointAt(0))) return caracter;
      return SUSTITUTOS[caracter] ?? (/\s/.test(caracter) ? " " : "");
    })
    .join("");
}

// El informe lo escribe un modelo: el PDF no debe poder leer archivos ni URLs por su cuenta.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((ruta) => ruta.endsWith(".ttf"));

const ENTIDADES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const decodificar = (texto) =>
  texto.replace(/&(?:amp|lt|gt|quot|#39);/g, (entidad) => ENTIDADES[entidad]);

function conCitas(texto, estilo, urls) {
  if (estilo.link) return [{ ...estilo, text: texto }];
  // Citas pegadas ("[5][18][22]") serían una sola palabra que pdfmake no puede cortar, y en
  // tablas angostas empujan la columna fuera de la hoja.
  return texto
    .replace(/\](?=\[\d+\])/g, "] ")
    .split(/(\[\d+\])/)
    .filter(Boolean)
    .map((parte) => {
      const url = urls.get(Number(parte.match(/^\[(\d+)\]$/)?.[1]));
      return url ? { ...estilo, text: parte, link: url, color: AZUL } : { ...estilo, text: parte };
    });
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
        return [{ ...estilo, text: decodificar(token.text), background: "#eeeeee" }];
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

function bloques(tokens, urls) {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case "heading":
        return [{ text: tramos(token.tokens, {}, urls), style: `h${Math.min(token.depth, 3)}` }];
      case "paragraph":
        return [{ text: tramos(token.tokens, {}, urls), margin: [0, 0, 0, 8] }];
      case "text":
        return [{ text: tramos(token.tokens ?? [token], {}, urls) }];
      case "list": {
        const items = token.items.map((item) => ({ stack: bloques(item.tokens, urls) }));
        const margin = [0, 0, 0, 8];
        return [token.ordered ? { ol: items, start: Number(token.start) || 1, margin } : { ul: items, margin }];
      }
      case "blockquote":
        return [{ stack: bloques(token.tokens, urls), style: "cita" }];
      case "code":
        return [
          {
            table: { widths: ["*"], body: [[{ text: token.text, style: "codigo" }]] },
            layout: "noBorders",
            margin: [0, 2, 0, 10],
          },
        ];
      case "table": {
        const fila = (celdas, extra) =>
          celdas.map((celda) => ({ text: tramos(celda.tokens, {}, urls), ...extra }));
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

export function generarPDF({ titulo, markdown, fuentes }) {
  const urls = new Map(fuentes.map((fuente) => [fuente.n, fuente.url]));
  const fecha = new Date().toLocaleDateString("es-AR");
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
      content: bloques(marked.lexer(aptoParaPDF(markdown)), urls),
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
