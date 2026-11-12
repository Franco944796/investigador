// Dibuja los bloques ```grafico del informe como SVG en texto, sin DOM: lo usan la página, el
// informe HTML y el servidor (PDF). Todo texto que viene del modelo pasa por `esc`.

export const PALETAS = {
  claro: {
    texto: "#1d2127",
    suave: "#5b6472",
    borde: "#dfe3e8",
    fondo: "#ffffff",
    vacio: "#eef0f3",
    series: ["#0b5cad", "#d9730d", "#2e8540", "#8f3fb0", "#c62828", "#00838f"],
  },
  oscuro: {
    texto: "#e7e9ee",
    suave: "#9aa2b1",
    borde: "#2a2f3a",
    fondo: "#161920",
    vacio: "#232833",
    series: ["#7cc4ff", "#ffb066", "#7fd6a4", "#d0a2f7", "#ff8f8f", "#5fd3dc"],
  },
};

const FUENTE = "Roboto, system-ui, sans-serif";
const ANCHO = 640;
const MAX_ELEMENTOS = 24;

const esc = (texto) =>
  String(texto ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const texto = (valor, maximo = 120) => (typeof valor === "string" ? valor.trim().slice(0, maximo) : "");
const numero = (valor) => (typeof valor === "number" && Number.isFinite(valor) ? valor : null);
const cita = (valor) => (Number.isInteger(valor) && valor > 0 ? valor : null);

// Ancho aproximado del texto: sin DOM no se puede medir, y alcanza para repartir el espacio.
const anchoDe = (cadena, tamano) => [...String(cadena)].length * tamano * 0.56;

function partirEnLineas(cadena, maximo) {
  const lineas = [];
  let actual = "";
  for (const palabra of String(cadena).split(/\s+/).filter(Boolean)) {
    if (actual && (actual + " " + palabra).length > maximo) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = actual ? `${actual} ${palabra}` : palabra;
    }
  }
  if (actual) lineas.push(actual);
  return lineas.length ? lineas : [""];
}

function formatear(valor) {
  const absoluto = Math.abs(valor);
  const decimales = absoluto >= 100 || Number.isInteger(valor) ? 0 : absoluto >= 10 ? 1 : 2;
  return valor.toLocaleString("es-AR", { maximumFractionDigits: decimales });
}

// Escala "linda": 0 y múltiplos de 1, 2 o 5 por potencia de 10.
function escala(minimo, maximo, marcas = 4) {
  const desde = Math.min(0, minimo);
  const rango = maximo - desde || Math.abs(maximo) || 1;
  const paso0 = rango / marcas;
  const potencia = 10 ** Math.floor(Math.log10(paso0));
  const paso = [1, 2, 5, 10].map((m) => m * potencia).find((p) => p >= paso0);
  const hasta = Math.ceil(maximo / paso) * paso;
  const inicio = Math.floor(desde / paso) * paso;
  const valores = [];
  for (let v = inicio; v <= hasta + paso / 2; v += paso) valores.push(Number(v.toPrecision(12)));
  return { inicio, hasta, valores };
}

const svg = (ancho, alto, cuerpo, etiqueta) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ancho} ${alto}" width="${ancho}" height="${alto}" font-family="${FUENTE}" role="img" aria-label="${esc(etiqueta)}">${cuerpo}</svg>`;

function barras(spec, p) {
  const datos = (Array.isArray(spec.datos) ? spec.datos : [])
    .map((d) => ({ etiqueta: texto(d?.etiqueta, 40), valor: numero(d?.valor), cita: cita(d?.cita) }))
    .filter((d) => d.etiqueta && d.valor !== null && d.valor >= 0)
    .slice(0, MAX_ELEMENTOS);
  if (datos.length < 2) return null;
  const unidad = texto(spec.unidad, 20);
  const etiquetas = Math.min(230, Math.max(...datos.map((d) => anchoDe(d.etiqueta, 13))) + 12);
  const maximo = Math.max(...datos.map((d) => d.valor)) || 1;
  const area = ANCHO - etiquetas - 90;
  const fila = 30;
  let cuerpo = "";
  datos.forEach((d, i) => {
    const y = 10 + i * fila;
    const largo = Math.max(2, (d.valor / maximo) * area);
    cuerpo +=
      `<text x="${etiquetas - 8}" y="${y + 15}" text-anchor="end" font-size="13" fill="${p.texto}">${esc(d.etiqueta)}</text>` +
      `<rect x="${etiquetas}" y="${y + 3}" width="${largo.toFixed(1)}" height="18" rx="3" fill="${p.series[0]}"><title>${esc(`${d.etiqueta}: ${formatear(d.valor)} ${unidad}`)}</title></rect>` +
      `<text x="${(etiquetas + largo + 6).toFixed(1)}" y="${y + 16}" font-size="12" fill="${p.suave}">${esc(`${formatear(d.valor)}${unidad ? ` ${unidad}` : ""}`)}</text>`;
  });
  return { svg: svg(ANCHO, datos.length * fila + 20, cuerpo, spec.titulo), citas: datos.map((d) => d.cita) };
}

function lineas(spec, p) {
  const series = (Array.isArray(spec.series) ? spec.series : [])
    .map((s) => ({
      nombre: texto(s?.nombre, 40),
      puntos: (Array.isArray(s?.puntos) ? s.puntos : [])
        .map((punto) => ({ x: texto(String(punto?.x ?? ""), 16), y: numero(punto?.y), cita: cita(punto?.cita) }))
        .filter((punto) => punto.x && punto.y !== null),
    }))
    .filter((s) => s.puntos.length >= 2)
    .slice(0, p.series.length);
  if (!series.length) return null;
  const xs = [...new Set(series.flatMap((s) => s.puntos.map((punto) => punto.x)))].slice(0, 40);
  const ys = series.flatMap((s) => s.puntos.map((punto) => punto.y));
  const { inicio, hasta, valores } = escala(Math.min(...ys), Math.max(...ys));
  const unidad = texto(spec.unidad, 20);
  const leyenda = series.length > 1 ? 26 : 0;
  const [izq, der, arriba, abajo] = [56, 16, (unidad ? 26 : 12) + leyenda, 34];
  const alto = 300;
  const ancho = ANCHO - izq - der;
  const altoUtil = alto - arriba - abajo;
  const xDe = (x) => izq + (xs.length === 1 ? ancho / 2 : (xs.indexOf(x) / (xs.length - 1)) * ancho);
  const yDe = (y) => arriba + altoUtil - ((y - inicio) / (hasta - inicio || 1)) * altoUtil;
  let cuerpo = "";
  for (const v of valores) {
    const y = yDe(v).toFixed(1);
    cuerpo +=
      `<line x1="${izq}" x2="${ANCHO - der}" y1="${y}" y2="${y}" stroke="${p.borde}"/>` +
      `<text x="${izq - 6}" y="${Number(y) + 4}" text-anchor="end" font-size="11" fill="${p.suave}">${esc(formatear(v))}</text>`;
  }
  const cada = Math.ceil(xs.length / 10);
  xs.forEach((x, i) => {
    if (i % cada === 0 || i === xs.length - 1) {
      cuerpo += `<text x="${xDe(x).toFixed(1)}" y="${alto - abajo + 18}" text-anchor="middle" font-size="11" fill="${p.suave}">${esc(x)}</text>`;
    }
  });
  if (unidad) cuerpo += `<text x="4" y="${arriba - 12}" font-size="11" fill="${p.suave}">${esc(unidad)}</text>`;
  series.forEach((s, i) => {
    const color = p.series[i];
    const puntos = s.puntos.filter((punto) => xs.includes(punto.x));
    cuerpo += `<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${puntos.map((punto) => `${xDe(punto.x).toFixed(1)},${yDe(punto.y).toFixed(1)}`).join(" ")}"/>`;
    for (const punto of puntos) {
      cuerpo += `<circle cx="${xDe(punto.x).toFixed(1)}" cy="${yDe(punto.y).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(`${s.nombre ? `${s.nombre}, ` : ""}${punto.x}: ${formatear(punto.y)} ${unidad}`)}</title></circle>`;
    }
    if (leyenda) {
      const x = izq + i * 150;
      cuerpo +=
        `<rect x="${x}" y="4" width="12" height="12" rx="2" fill="${color}"/>` +
        `<text x="${x + 18}" y="14" font-size="12" fill="${p.texto}">${esc(s.nombre.slice(0, 20))}</text>`;
    }
  });
  return { svg: svg(ANCHO, alto, cuerpo, spec.titulo), citas: series.flatMap((s) => s.puntos.map((punto) => punto.cita)) };
}

function lineaDeTiempo(spec, p) {
  const eventos = (Array.isArray(spec.eventos) ? spec.eventos : [])
    .map((e) => ({ fecha: texto(e?.fecha, 20), texto: texto(e?.texto, 160), cita: cita(e?.cita) }))
    .filter((e) => e.fecha && e.texto)
    .slice(0, MAX_ELEMENTOS);
  if (eventos.length < 2) return null;
  const columna = 118;
  let y = 12;
  let cuerpo = "";
  for (const e of eventos) {
    const renglones = partirEnLineas(e.texto, 62).slice(0, 3);
    cuerpo +=
      `<text x="${columna - 18}" y="${y + 14}" text-anchor="end" font-size="13" font-weight="bold" fill="${p.texto}">${esc(e.fecha)}</text>` +
      `<circle cx="${columna}" cy="${y + 9}" r="5" fill="${p.series[0]}"/>` +
      renglones
        .map((r, i) => `<text x="${columna + 16}" y="${y + 14 + i * 17}" font-size="13" fill="${p.texto}">${esc(r)}</text>`)
        .join("");
    y += Math.max(30, renglones.length * 17 + 14);
  }
  const linea = `<line x1="${columna}" x2="${columna}" y1="14" y2="${y - 20}" stroke="${p.borde}" stroke-width="2"/>`;
  return { svg: svg(ANCHO, y, linea + cuerpo, spec.titulo), citas: eventos.map((e) => e.cita) };
}

function caja(x, y, ancho, renglones, p, destacada) {
  const alto = renglones.length * 17 + 16;
  return {
    alto,
    svg:
      `<rect x="${x}" y="${y}" width="${ancho}" height="${alto}" rx="8" fill="${destacada ? p.series[0] : p.fondo}" stroke="${destacada ? p.series[0] : p.borde}" stroke-width="1.5"/>` +
      renglones
        .map(
          (r, i) =>
            `<text x="${x + ancho / 2}" y="${y + 21 + i * 17}" text-anchor="middle" font-size="13" fill="${destacada ? p.fondo : p.texto}">${esc(r)}</text>`,
        )
        .join(""),
  };
}

const flecha = (x1, y1, x2, y2, p) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2 - 6}" stroke="${p.suave}" stroke-width="1.5"/>` +
  `<path d="M${x2 - 5} ${y2 - 8} L${x2} ${y2} L${x2 + 5} ${y2 - 8} Z" fill="${p.suave}"/>`;

function diagrama(spec, p) {
  const pasos = (Array.isArray(spec.pasos) ? spec.pasos : [])
    .map((paso) => ({ texto: texto(typeof paso === "string" ? paso : paso?.texto, 140), cita: cita(paso?.cita) }))
    .filter((paso) => paso.texto)
    .slice(0, MAX_ELEMENTOS);
  if (spec.forma === "partes") {
    const centro = texto(spec.centro, 80);
    if (!centro || pasos.length < 2) return null;
    const columnas = pasos.length <= 4 ? 2 : 3;
    const anchoCaja = (ANCHO - 20 - (columnas - 1) * 16) / columnas;
    const principal = caja(ANCHO / 2 - 150, 8, 300, partirEnLineas(centro, 34).slice(0, 3), p, true);
    let cuerpo = principal.svg;
    const base = principal.alto + 8;
    let y = base + 40;
    let altoFila = 0;
    pasos.forEach((paso, i) => {
      const columna = i % columnas;
      if (columna === 0 && i) {
        y += altoFila + 16;
        altoFila = 0;
      }
      const x = 10 + columna * (anchoCaja + 16);
      const parte = caja(x, y, anchoCaja, partirEnLineas(paso.texto, Math.floor(anchoCaja / 7.5)).slice(0, 4), p);
      altoFila = Math.max(altoFila, parte.alto);
      cuerpo = `<line x1="${ANCHO / 2}" y1="${base}" x2="${x + anchoCaja / 2}" y2="${y}" stroke="${p.borde}" stroke-width="1.5"/>` + cuerpo + parte.svg;
    });
    return { svg: svg(ANCHO, y + altoFila + 10, cuerpo, spec.titulo), citas: pasos.map((paso) => paso.cita) };
  }
  if (pasos.length < 2) return null;
  const anchoCaja = 440;
  const x = (ANCHO - anchoCaja) / 2;
  let y = 8;
  let cuerpo = "";
  pasos.forEach((paso, i) => {
    const bloque = caja(x, y, anchoCaja, partirEnLineas(`${i + 1}. ${paso.texto}`, 56).slice(0, 3), p);
    cuerpo += bloque.svg;
    y += bloque.alto;
    if (i < pasos.length - 1) {
      cuerpo += flecha(ANCHO / 2, y, ANCHO / 2, y + 26, p);
      y += 26;
    }
  });
  return { svg: svg(ANCHO, y + 10, cuerpo, spec.titulo), citas: pasos.map((paso) => paso.cita) };
}

function mezclar(desde, hasta, t) {
  const a = desde.match(/\w\w/g).map((h) => parseInt(h, 16));
  const b = hasta.match(/\w\w/g).map((h) => parseInt(h, 16));
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

function mapa(spec, p, geografia) {
  if (!geografia) return null;
  const datos = (Array.isArray(spec.datos) ? spec.datos : [])
    .map((d) => ({ pais: texto(d?.pais, 3).toUpperCase(), valor: numero(d?.valor), cita: cita(d?.cita) }))
    .filter((d) => geografia.paises[d.pais] && d.valor !== null);
  if (!datos.length) return null;
  const unidad = texto(spec.unidad, 20);
  const valores = datos.map((d) => d.valor);
  const [minimo, maximo] = [Math.min(...valores), Math.max(...valores)];
  // En fondo oscuro el extremo bajo necesita más color para no confundirse con el fondo.
  const claro = mezclar(p.fondo, p.series[0], p === PALETAS.oscuro ? 0.35 : 0.18);
  const color = (v) => mezclar(claro, p.series[0], maximo === minimo ? 1 : (v - minimo) / (maximo - minimo));
  const porPais = new Map(datos.map((d) => [d.pais, d]));
  const [ancho, alto] = geografia.tamano;
  let cuerpo = "";
  for (const [codigo, { nombre, d }] of Object.entries(geografia.paises)) {
    const dato = porPais.get(codigo);
    const relleno = dato ? color(dato.valor) : p.vacio;
    const titulo = dato ? `${nombre}: ${formatear(dato.valor)} ${unidad}` : nombre;
    cuerpo += `<path d="${d}" fill="${relleno}" stroke="${p.fondo}" stroke-width="0.5"><title>${esc(titulo)}</title></path>`;
  }
  const leyenda =
    `<defs><linearGradient id="escala-mapa"><stop offset="0" stop-color="${claro}"/><stop offset="1" stop-color="${p.series[0]}"/></linearGradient></defs>` +
    `<rect x="10" y="${alto + 12}" width="160" height="10" rx="2" fill="url(#escala-mapa)"/>` +
    `<text x="10" y="${alto + 38}" font-size="11" fill="${p.suave}">${esc(formatear(minimo))}</text>` +
    `<text x="170" y="${alto + 38}" text-anchor="end" font-size="11" fill="${p.suave}">${esc(formatear(maximo))}</text>` +
    `<text x="180" y="${alto + 22}" font-size="11" fill="${p.suave}">${esc(unidad)}</text>`;
  // Los valores más altos van también en el pie: en el PDF no hay cartel al pasar el mouse.
  const ordenados = [...datos].sort((a, b) => b.valor - a.valor).slice(0, 6);
  return {
    svg: svg(ancho, alto + 46, cuerpo + leyenda, spec.titulo),
    citas: datos.map((d) => d.cita),
    detalle: ordenados.map((d) => `${geografia.paises[d.pais].nombre}: ${formatear(d.valor)}${unidad ? ` ${unidad}` : ""}`),
  };
}

const DIBUJANTES = { barras, lineas, "linea-de-tiempo": lineaDeTiempo, diagrama, mapa };

// Devuelve { svg, titulo, citas, detalle? } o null si el bloque no sirve (JSON roto, pocos datos).
export function dibujarGrafico(fuente, { tema = "claro", geografia = null } = {}) {
  let spec;
  try {
    spec = typeof fuente === "string" ? JSON.parse(fuente) : fuente;
  } catch {
    return null;
  }
  const dibujante = DIBUJANTES[spec?.tipo];
  if (!dibujante) return null;
  const resultado = dibujante(spec, PALETAS[tema] ?? PALETAS.claro, geografia);
  if (!resultado) return null;
  return {
    ...resultado,
    titulo: texto(spec.titulo, 140),
    citas: [...new Set(resultado.citas.filter(Boolean))].sort((a, b) => a - b),
  };
}

export const tipoDeGrafico = (fuente) => {
  try {
    return JSON.parse(fuente)?.tipo ?? null;
  } catch {
    return null;
  }
};

// Imágenes de las fuentes: solo se aceptan direcciones http(s) que aparecen en las notas.
export function imagenDe(fuente) {
  let spec;
  try {
    spec = JSON.parse(fuente);
  } catch {
    return null;
  }
  if (spec?.tipo !== "imagen" || typeof spec.url !== "string" || !/^https?:\/\//.test(spec.url)) return null;
  return { url: spec.url, pie: texto(spec.pie, 200), cita: cita(spec.cita) };
}
