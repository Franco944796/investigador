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

// El título del informe va en la portada: se saca del cuerpo para no repetirlo.
export function separarTitulo(markdown) {
  const encontrado = markdown.match(/^\s*# (.+)\n/);
  return encontrado
    ? { titulo: encontrado[1].trim(), cuerpo: markdown.slice(encontrado[0].length) }
    : { titulo: null, cuerpo: markdown };
}

// Los informes de antes terminaban con la lista de fuentes para revisar a mano; ahora esa lista
// está solo en «Ver informe» y el PDF no la lleva.
export const sinPendientes = (markdown) => markdown.split("\n## Fuentes para revisar a mano\n")[0];
