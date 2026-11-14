import { createServer } from "node:http";
import { setTimeout as esperar } from "node:timers/promises";

const INFORME = `<think>plan interno que no debe verse</think># Informe de prueba

Resumen breve del tema con una cita [1].

## Comparación

| Opción | Dato |
| --- | --- |
| A | 10 [1] |
| B | 20 [2] |

## Conclusiones

- Punto **importante** [2].
- Lo que no se pudo confirmar.
`;

const SEGUIMIENTO = "Según el informe, la opción B duplica a la A [2].";

const PLAN_MULTILINGUE = {
  aspectos: ["¿Qué opciones hay?", "¿Cuánto rinde cada una?"],
  idiomas: [
    { codigo: "es", nombre: "español" },
    { codigo: "en", nombre: "inglés" },
    { codigo: "zh", nombre: "chino" },
  ],
  consultas: [
    { idioma: "es", texto: "primera consulta" },
    { idioma: "en", texto: "second query" },
    { idioma: "zh", texto: "第三 查询" },
    { idioma: "ja", texto: "全固体電池 量産 トヨタ 2027年 計画 発表" },
    { idioma: "ko", texto: "전고체 배터리 삼성SDI 양산 일정 발표" },
  ],
};

const INDICE = {
  titulo: "Informe de prueba",
  secciones: [{ titulo: "Comparación", enfoque: "datos de cada opción", fuentes: [1, 2] }],
};

function responder(cuerpo, estado) {
  const ultimo = cuerpo.messages.at(-1).content;
  if (ultimo.includes('"idiomas"')) return JSON.stringify(PLAN_MULTILINGUE);
  if (ultimo.includes('"secciones"')) return JSON.stringify(INDICE);
  if (ultimo.includes("Te toca la sección")) {
    const grafico = {
      tipo: "barras",
      titulo: "Dato por opción",
      unidad: "u",
      datos: [
        { etiqueta: "A", valor: 10, cita: 1 },
        { etiqueta: "B", valor: 20, cita: 2 },
        { etiqueta: "C", valor: 15, cita: 2 },
      ],
    };
    const imagen = { tipo: "imagen", url: "https://ejemplo.invalid/plano.png", pie: "Plano de la celda", cita: 2 };
    const mapa = {
      tipo: "mapa",
      titulo: "Dato por país",
      unidad: "u",
      datos: [
        { pais: "ARG", valor: 10, cita: 1 },
        { pais: "CHN", valor: 20, cita: 2 },
        { pais: "DEU", valor: 15, cita: 2 },
      ],
    };
    return `## Comparación\n\n| Opción | Dato |\n| --- | --- |\n| A | 10 [1] |\n| B | 20 [2] |\n\n\`\`\`grafico\n${JSON.stringify(grafico)}\n\`\`\`\n\n\`\`\`grafico\n${JSON.stringify(mapa)}\n\`\`\`\n\n\`\`\`grafico\n${JSON.stringify(imagen)}\n\`\`\``;
  }
  if (ultimo.includes("comienzo del informe")) return "# Informe de prueba\n\n## Resumen\n\nResumen breve [1].";
  if (ultimo.includes("cierre del informe")) return "## Conclusiones\n\n- Punto **importante** [2].";
  if (ultimo.includes('{"consultas": [')) {
    return '```json\n{"consultas": ["primera consulta", "segunda consulta"]}\n```';
  }
  if (ultimo.includes("IRRELEVANTE")) {
    return ultimo.includes("/irrelevante")
      ? "IRRELEVANTE"
      : "Fecha: 2025-03\nTipo: oficial\nAspectos: 2\nNotas: la página aporta el dato 10 y el dato 20.";
  }
  if (ultimo.includes('"completo"')) {
    estado.revisiones++;
    return estado.revisiones === 1
      ? '{"completo": false, "consultas": ["consulta extra"]}'
      : '{"completo": true, "consultas": []}';
  }
  if (ultimo.includes('"buscar"')) return '{"buscar": true, "consultas": ["consulta de seguimiento"]}';
  return "";
}

// Endpoint compatible con OpenAI. Por defecto el primer pedido responde 429 para ejercitar
// los reintentos.
export async function iniciarLLMSimulado({ demoraMs = 0, fallaPrimero = true, sinCupo = false } = {}) {
  const estado = { pedidos: 0, revisiones: 0 };
  const servidor = createServer(async (req, res) => {
    let crudo = "";
    for await (const trozo of req) crudo += trozo;
    const cuerpo = JSON.parse(crudo);
    estado.pedidos++;
    if (sinCupo || (fallaPrimero && estado.pedidos === 1)) {
      res.writeHead(429, { "Content-Type": "application/json" }).end('{"error": "límite"}');
      return;
    }
    await esperar(demoraMs);

    if (!cuerpo.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: responder(cuerpo, estado) } }] }));
      return;
    }

    const esSeguimiento = cuerpo.messages[0].content.includes("preguntas de seguimiento");
    const texto = esSeguimiento ? SEGUIMIENTO : INFORME;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let inicio = 0; inicio < texto.length; inicio += 5) {
      const delta = { choices: [{ delta: { content: texto.slice(inicio, inicio + 5) } }] };
      res.write(`data: ${JSON.stringify(delta)}\n\n`);
      if (demoraMs) await esperar(demoraMs / 20);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((listo) => servidor.listen(0, "127.0.0.1", listo));
  return {
    estado,
    urlBase: `http://127.0.0.1:${servidor.address().port}/v1`,
    cerrar: () => servidor.close(),
  };
}

const ruta = (consulta) => encodeURIComponent(consulta.replaceAll(" ", "-"));

export async function buscarSimulado(consulta, { cantidad }) {
  const resultados = [
    { titulo: `Guía sobre ${consulta}`, url: `https://ejemplo.test/${ruta(consulta)}/guia` },
    { titulo: `Sitio caído sobre ${consulta}`, url: `https://ejemplo.test/${ruta(consulta)}/caida` },
    { titulo: `Página ajena a ${consulta}`, url: `https://ejemplo.test/${ruta(consulta)}/irrelevante` },
    { titulo: `Datos de ${consulta}`, url: `https://ejemplo.test/${ruta(consulta)}/datos?utm_source=x` },
  ];
  return { motor: "simulado", resultados: resultados.slice(0, cantidad) };
}

export function crearLectorSimulado({ demoraMs = 0 } = {}) {
  return async function leerPaginaSimulada(url) {
    await esperar(demoraMs);
    if (url.endsWith("/caida")) throw new Error("respondió 403");
    return { titulo: `Título de ${new URL(url).pathname}`, texto: `Contenido de ${url}` };
  };
}
