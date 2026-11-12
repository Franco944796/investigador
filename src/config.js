function entero(env, nombre, porDefecto) {
  const valor = Number.parseInt(env[nombre] ?? "", 10);
  return Number.isFinite(valor) ? valor : porDefecto;
}

const sinBarraFinal = (url) => url.replace(/\/+$/, "");

const MAX_PROVEEDORES = 9;

// LLM_1_…, LLM_2_… en orden de preferencia; los que no tienen clave se ignoran, así se pueden
// dejar cargadas las URLs y completar solo las claves que se tengan. Sin ninguno se usa el
// endpoint único (LLM_URL_BASE), si está definido.
function leerProveedores(env) {
  const proveedores = [];
  for (let numero = 1; numero <= MAX_PROVEEDORES; numero++) {
    if (!env[`LLM_${numero}_URL`] || !env[`LLM_${numero}_CLAVE`]) continue;
    // Varios modelos separados por coma: cada uno es un respaldo más con la misma clave.
    const modelos = (env[`LLM_${numero}_MODELO`] || "auto").split(",").map((m) => m.trim());
    for (const modelo of modelos.filter(Boolean)) {
      proveedores.push({
        urlBase: sinBarraFinal(env[`LLM_${numero}_URL`]),
        clave: env[`LLM_${numero}_CLAVE`],
        modelo,
      });
    }
  }
  if (proveedores.length || !env.LLM_URL_BASE) return proveedores;
  return [
    {
      urlBase: sinBarraFinal(env.LLM_URL_BASE),
      clave: env.LLM_CLAVE || "",
      modelo: env.LLM_MODELO || "auto",
    },
  ];
}

// Normal se ajusta por variables de entorno; las otras dos son fijas. Una ronda extra suma
// `consultasPorRonda` búsquedas: Exhaustiva gasta ~45 de las 1.000 mensuales de Tavily.
function leerProfundidades(env) {
  return {
    normal: {
      consultasIniciales: entero(env, "CONSULTAS_INICIALES", 5),
      resultadosPorConsulta: entero(env, "RESULTADOS_POR_CONSULTA", 4),
      rondasExtra: entero(env, "RONDAS_EXTRA", 2),
      consultasPorRonda: entero(env, "CONSULTAS_POR_RONDA", 3),
      maxFuentes: entero(env, "MAX_FUENTES", 24),
    },
    profunda: {
      consultasIniciales: 8,
      resultadosPorConsulta: 5,
      rondasExtra: 4,
      consultasPorRonda: 4,
      maxFuentes: 50,
    },
    // Hasta 25 + 9 × 8 = 97 búsquedas de Tavily (se cobra por búsqueda, no por resultado).
    exhaustiva: {
      consultasIniciales: 25,
      resultadosPorConsulta: 8,
      rondasExtra: 9,
      consultasPorRonda: 8,
      maxFuentes: 300,
      multilingue: true,
      informePorSecciones: true,
      irrelevantesSeguidas: 15,
    },
  };
}

export function leerConfig(env = process.env) {
  return {
    baseDeDatos: env.DATABASE_URL || "",
    // Render la define sola; sirve para que el servidor se visite y no se duerma mientras investiga.
    urlPublica: (env.URL_PUBLICA || env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, ""),
    // Sitios desde los que otra copia de la página puede usar la API (por ejemplo, GitHub Pages).
    origenesPermitidos: (env.ORIGENES_PERMITIDOS || "")
      .split(",")
      .map((origen) => origen.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean),
    profundidades: leerProfundidades(env),
    // PORT es el nombre que imponen los hostings (Render entre ellos).
    puerto: entero(env, "PUERTO", entero(env, "PORT", 3210)),
    host: env.HOST || "127.0.0.1",
    // Cantidad de proxies inversos delante del servidor (0 = ninguno).
    confiarEnProxy: entero(env, "CONFIAR_EN_PROXY", 0),
    proveedores: leerProveedores(env),
    limiteLLMMs: entero(env, "LLM_LIMITE_MINUTOS", 30) * 60 * 1000,
    tavilyClave: env.TAVILY_CLAVE || "",
    acceso: {
      codigos: env.CODIGOS_ACCESO || "",
      limiteDiario: entero(env, "LIMITE_DIARIO", 5),
      secreto: env.SECRETO_SESION || "",
      carpetaDatos: env.CARPETA_DATOS || "datos",
    },
    investigacion: {
      consultasIniciales: entero(env, "CONSULTAS_INICIALES", 5),
      resultadosPorConsulta: entero(env, "RESULTADOS_POR_CONSULTA", 4),
      rondasExtra: entero(env, "RONDAS_EXTRA", 2),
      consultasPorRonda: entero(env, "CONSULTAS_POR_RONDA", 3),
      maxFuentes: entero(env, "MAX_FUENTES", 24),
      fuentesPorSeguimiento: entero(env, "FUENTES_POR_SEGUIMIENTO", 6),
      caracteresPorFuente: entero(env, "CARACTERES_POR_FUENTE", 7000),
      tareasEnParalelo: entero(env, "TAREAS_EN_PARALELO", 3),
      simultaneas: entero(env, "INVESTIGACIONES_SIMULTANEAS", 2),
      seguimientosPorInforme: entero(env, "SEGUIMIENTOS_POR_INFORME", 20),
    },
  };
}
