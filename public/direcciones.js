// Compartido por la página y el PDF.

// Un título sirve si tiene alguna palabra de 3 letras o más: en el PDF, los títulos en chino o
// japonés quedan vacíos o en restos como «2026180-240GW --» (Roboto y DejaVu no tienen esos
// caracteres).
export const tituloLegible = (titulo) => /\p{L}{3,}/u.test(titulo ?? "");

// Sitio y ruta, sin «www.», sin parámetros y cortada si es larga: para mostrar en lugar de un
// título que no se puede leer. El enlace sigue apuntando a la dirección completa.
export function direccionCorta(url, maximo = 60) {
  let texto;
  try {
    const direccion = new URL(url);
    let ruta = direccion.pathname.replace(/\/$/, "");
    try {
      ruta = decodeURI(ruta);
    } catch {}
    texto = direccion.hostname.replace(/^www\./, "") + ruta;
  } catch {
    texto = String(url);
  }
  return texto.length > maximo ? `${texto.slice(0, maximo - 1)}…` : texto;
}
