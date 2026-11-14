// Elige las partes de una página que hablan de lo que se busca, en vez de quedarse con el
// comienzo: en informes largos, los primeros miles de caracteres son la tapa y el índice.

const LARGO_PASAJE = 1100;
const COMIENZO = 700;
const SALTO = "\n[…]\n";
const VACIAS = new Set(
  (
    "de la el en y a los las del que por con para un una su al es se como mas o lo sus le ya no " +
    "si me mi te tu the of and to in a is for on that by with as at from an be are or this it its " +
    "was were we he do so if no vs " +
    "que como cual cuales entre sobre desde hasta este esta estos estas son fue han ha"
  ).split(" "),
);
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

const normalizar = (texto) =>
  texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// Palabras de 2 letras o más sin las vacías (siglas como PV o EV importan); en chino, japonés y
// coreano no hay espacios, así que se usan pares de caracteres seguidos.
export function terminosDe(texto) {
  const terminos = new Set();
  for (const palabra of normalizar(texto).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK.test(palabra)) {
      for (let i = 0; i < palabra.length - 1; i++) terminos.add(palabra.slice(i, i + 2));
    } else if (palabra.length >= 2 && !VACIAS.has(palabra)) {
      terminos.add(palabra);
    }
  }
  return terminos;
}

function partir(texto) {
  const pasajes = [];
  let actual = "";
  for (const parrafo of texto.split("\n")) {
    for (let inicio = 0; inicio < Math.max(parrafo.length, 1); inicio += LARGO_PASAJE) {
      const trozo = parrafo.slice(inicio, inicio + LARGO_PASAJE);
      if (actual && actual.length + trozo.length + 1 > LARGO_PASAJE) {
        pasajes.push(actual);
        actual = "";
      }
      actual = actual ? `${actual}\n${trozo}` : trozo;
    }
  }
  if (actual) pasajes.push(actual);
  return pasajes;
}

// `terminos` pesa doble: son los de la búsqueda que trajo la página; `secundarios`, los del tema.
export function seleccionarPasajes(texto, { terminos, secundarios = new Set(), maximo }) {
  if (texto.length <= maximo) return texto;
  const pasajes = partir(texto);
  const contenidos = pasajes.map((pasaje) => normalizar(pasaje));
  // Un término que aparece en casi todos los pasajes no distingue nada; uno raro, sí.
  const peso = (termino, base) => {
    const con = contenidos.filter((contenido) => contenido.includes(termino)).length;
    return con ? base * Math.log(1 + pasajes.length / con) : 0;
  };
  const pesos = new Map();
  for (const termino of secundarios) pesos.set(termino, peso(termino, 1));
  for (const termino of terminos) pesos.set(termino, peso(termino, 2));

  const puntajes = contenidos.map((contenido) => {
    let puntaje = 0;
    for (const [termino, valor] of pesos) if (valor && contenido.includes(termino)) puntaje += valor;
    // Un índice nombra todos los temas y está lleno de números de página, pero no dice nada.
    if (/(\. ){5,}|\.{6,}|(… ?){3,}/.test(contenido)) return puntaje * 0.15;
    // Los pasajes con cifras suelen traer los datos que el informe necesita.
    const cifras = (contenido.match(/\d[\d.,]*/g) ?? []).length;
    return puntaje * (1 + Math.min(cifras, 12) / 40);
  });
  if (!puntajes.some(Boolean)) return texto.slice(0, maximo);

  // El comienzo da contexto (título, fecha), pero no debe quitarle lugar al mejor pasaje.
  const comienzo = Math.min(COMIENZO, Math.floor(maximo / 5));
  const elegidos = new Set([0]);
  let usado = Math.min(pasajes[0].length, comienzo);
  const orden = puntajes
    .map((puntaje, indice) => ({ puntaje, indice }))
    .sort((a, b) => b.puntaje - a.puntaje);
  for (const { puntaje, indice } of orden) {
    if (!puntaje || indice === 0) continue;
    if (usado + pasajes[indice].length + SALTO.length > maximo) continue;
    elegidos.add(indice);
    usado += pasajes[indice].length + SALTO.length;
  }

  let salida = "";
  let anterior = -1;
  for (const indice of [...elegidos].sort((a, b) => a - b)) {
    if (indice === 0) {
      salida = pasajes[0].slice(0, comienzo);
      // Si el comienzo quedó recortado, lo que sigue ya no es contiguo.
      anterior = pasajes[0].length > comienzo ? -2 : 0;
      continue;
    }
    salida += (indice === anterior + 1 ? "\n" : SALTO) + pasajes[indice];
    anterior = indice;
  }
  return salida;
}
