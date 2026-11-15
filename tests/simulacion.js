// Levanta la página con modelo, buscador y lector simulados: sirve para revisar la interfaz
// sin gastar cuotas reales. Uso: node tests/simulacion.js  (código: codigo-de-prueba)
import { crearAlmacenMemoria } from "../src/almacen.js";
import { crearApp } from "../src/app.js";
import { leerConfig } from "../src/config.js";
import { crearInvestigador } from "../src/investigador.js";
import { crearLLM } from "../src/llm.js";
import { generarPDF } from "../src/pdf.js";
import { crearAcceso } from "./ayuda.js";
import { buscarSimulado, crearLectorSimulado, iniciarLLMSimulado } from "./simulados.js";

const demoraMs = Number(process.env.DEMORA_MS ?? 600);
const llmSimulado = await iniciarLLMSimulado({ demoraMs });
const config = leerConfig({
  PUERTO: process.env.PUERTO ?? "3211",
  CONSULTAS_INICIALES: process.env.CONSULTAS_INICIALES ?? "2",
  // El mínimo real (60 búsquedas) haría durar minutos cada prueba.
  MIN_BUSQUEDAS: process.env.MIN_BUSQUEDAS ?? "4",
  ORIGENES_PERMITIDOS: process.env.ORIGENES_PERMITIDOS,
});
const llm = crearLLM([{ urlBase: llmSimulado.urlBase, clave: "", modelo: "auto" }], { esperas: [300] });
const investigador = crearInvestigador({
  llm,
  // Un resultado de más con muro de pago, para ver el estado «Sin acceso» y la lista del final.
  buscar: async (consulta, opciones) => {
    const encontrado = await buscarSimulado(consulta, opciones);
    const muro = { titulo: `Libro con muro sobre ${consulta}`, url: `https://editorial.test/${encodeURIComponent(consulta)}/muro` };
    return { ...encontrado, resultados: [...encontrado.resultados, muro] };
  },
  leerPagina: crearLectorSimulado({ demoraMs }),
  opciones: config.investigacion,
});
const almacen = crearAlmacenMemoria();

const saldos = async () => ({
  web: { usadas: 206, limite: 1000 },
  papers: { busquedas: 987, renuevaEnSegundos: 18000 },
});

crearApp({
  config,
  acceso: crearAcceso("prueba:codigo-de-prueba:5"),
  investigador,
  almacen,
  generarPDF,
  saldos,
})
  .listen(config.puerto, "127.0.0.1", () => {
    console.log(`Simulación en http://127.0.0.1:${config.puerto} (código: codigo-de-prueba)`);
  });
