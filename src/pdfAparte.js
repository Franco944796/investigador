import { fork } from "node:child_process";

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
  const enProceso = (pedido) =>
    new Promise((resolver, rechazar) => {
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
      const reloj = setTimeout(
        () => terminar(new ErrorPDF("Armar el PDF tardó demasiado. Probá de nuevo en un rato.")),
        limiteMs,
      );
      let errores = "";
      hijo.stderr.on("data", (trozo) => (errores = (errores + trozo).slice(-2000)));
      hijo.on("message", (mensaje) =>
        mensaje.error
          ? terminar(new ErrorPDF(`No se pudo armar el PDF: ${mensaje.error}`))
          : terminar(null, Buffer.from(mensaje.pdf)),
      );
      hijo.on("exit", (codigo) => {
        if (terminado) return;
        const sinMemoria = /heap out of memory|Reached heap limit/.test(errores);
        if (!sinMemoria)
          console.error(`El proceso del PDF terminó con código ${codigo}: ${errores}`);
        terminar(
          new ErrorPDF(
            sinMemoria
              ? "El informe es demasiado grande para armar el PDF con la memoria del servidor. Podés descargarlo en HTML desde «Ver informe»."
              : "No se pudo armar el PDF. Probá de nuevo en un rato.",
          ),
        );
      });
      hijo.send(pedido);
    });
  const armar = async (datos) => {
    const partes = partesDelInforme(datos.markdown, maxPorParte);
    if (partes.length === 1) return enProceso({ armar: datos });
    const pdfs = [];
    for (const markdown of partes) {
      pdfs.push(await enProceso({ armar: { ...datos, markdown, conPie: false } }));
    }
    return enProceso({ unir: { partes: pdfs, titulo: datos.titulo } });
  };
  return (datos) => {
    const resultado = fila.then(() => armar(datos));
    fila = resultado.catch(() => {});
    return resultado;
  };
}
