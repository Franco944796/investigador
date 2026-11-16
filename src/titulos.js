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

export const textoDelPie = (fecha, pagina, total) => `Generado el ${fecha} · ${pagina} / ${total}`;
export const fechaDelPie = () => new Date().toLocaleDateString("es-AR");
