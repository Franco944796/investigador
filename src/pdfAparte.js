import { fork } from "node:child_process";
import { separarTitulo, sinPendientes } from "./titulos.js";

export class ErrorPDF extends Error {}

// Corta el Markdown en partes de hasta `maximo` caracteres, siempre antes de un título "## ", para
// que ninguna sección (ni sus gráficos o tablas) quede repartida entre dos partes.
export function partesDelInforme(markdown, maximo) {
  if (markdown.length <= maximo) return [markdown];
  const partes = [""];
  for (const bloque of markdown.split(/\n(?=## )/)) {
    if (partes.at(-1) && partes.at(-1).length + bloque.length > maximo) partes.push("");
    partes[partes.length - 1] += (partes.at(-1) ? "\n" : "") + bloque;
  }
  return partes;
}

// El PDF de un informe con mil fuentes llega a ~450 MB y Render gratis tiene 512 MB para todo:
// armado en el mismo proceso, un pico de memoria reiniciaba el servidor y cortaba las
// investigaciones en curso. En un proceso aparte con tope de memoria, solo falla ese PDF.
// Un informe largo se arma en partes de hasta `maxPorParte` caracteres (cada una en su proceso)
// que después se unen. Se arman de a uno para que dos descargas no sumen sus picos.
export function crearGeneradorAparte({
  memoriaMB = 160,
  limiteMs = 5 * 60 * 1000,
  maxPorParte = 250000,
} = {}) {
  let fila = Promise.resolve();
  const MENSAJES = {
    armar: {
      lento: "Armar el PDF tardó demasiado. Probá de nuevo en un rato.",
      fallo: (detalle) => `No se pudo armar el PDF: ${detalle}`,
      memoria:
        "El informe es demasiado grande para armar el PDF con la memoria del servidor. Podés descargarlo en HTML desde «Ver informe».",
      otro: "No se pudo armar el PDF. Probá de nuevo en un rato.",
    },
    leer: {
      lento: "Leer el PDF tardó demasiado: copiá su texto y pegalo.",
      fallo: (detalle) => `No se pudo leer el PDF (${detalle}): copiá su texto y pegalo.`,
      memoria:
        "El PDF es demasiado grande para leerlo con la memoria del servidor: copiá su texto y pegalo.",
      otro: "No se pudo leer el PDF: copiá su texto y pegalo.",
    },
  };
  const enProceso = (pedido) =>
    new Promise((resolver, rechazar) => {
      const mensajes = MENSAJES[pedido.tarea === "texto" ? "leer" : "armar"];
      const hijo = fork(new URL("./pdfProceso.js", import.meta.url), [], {
        execArgv: [`--max-old-space-size=${memoriaMB}`],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let terminado = false;
      const terminar = (error, pdf) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(reloj);
        hijo.kill();
        if (error) rechazar(error);
        else resolver(pdf);
      };
      const reloj = setTimeout(() => terminar(new ErrorPDF(mensajes.lento)), limiteMs);
      let errores = "";
      hijo.stderr.on("data", (trozo) => (errores = (errores + trozo).slice(-2000)));
      hijo.on("message", (mensaje) =>
        mensaje.error
          ? terminar(new ErrorPDF(mensajes.fallo(mensaje.error)))
          : terminar(null, mensaje.resultado),
      );
      hijo.on("exit", (codigo) => {
        if (terminado) return;
        const sinMemoria = /heap out of memory|Reached heap limit/.test(errores);
        if (!sinMemoria)
          console.error(`El proceso del PDF terminó con código ${codigo}: ${errores}`);
        terminar(new ErrorPDF(sinMemoria ? mensajes.memoria : mensajes.otro));
      });
      hijo.send(pedido);
    });
  // Por partes: cada una dice en qué página (de ella) cae cada título; sumando las páginas de las
  // anteriores queda la página en el cuerpo entero, que es lo que muestra el índice.
  const armar = async (datos) => {
    const separado = separarTitulo(sinPendientes(datos.markdown));
    const partes = partesDelInforme(separado.cuerpo, maxPorParte);
    if (partes.length === 1) {
      return Buffer.from(await enProceso({ tarea: "armar", datos }));
    }
    const pdfs = [];
    const titulos = [];
    let previas = 0;
    for (const markdown of partes) {
      const parte = await enProceso({
        tarea: "cuerpo",
        datos: { markdown, fuentes: datos.fuentes },
      });
      pdfs.push(parte.pdf);
      titulos.push(
        ...parte.titulos.map((titulo) => ({ ...titulo, pagina: titulo.pagina + previas })),
      );
      previas += parte.paginas;
    }
    const portada = await enProceso({
      tarea: "portada",
      datos: { titulo: separado.titulo ?? datos.titulo, titulos },
    });
    const unido = await enProceso({
      tarea: "unir",
      datos: { partes: [portada, ...pdfs], titulo: datos.titulo },
    });
    return Buffer.from(unido);
  };
  const enFila = (tarea) => {
    const resultado = fila.then(tarea);
    fila = resultado.catch(() => {});
    return resultado;
  };
  const generar = (datos) => enFila(() => armar(datos));
  // Usa la misma fila que los PDF: leer uno grande también pide memoria.
  generar.extraerTexto = (bytes) => enFila(() => enProceso({ tarea: "texto", datos: { bytes } }));
  return generar;
}
