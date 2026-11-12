// Genera public/mapa.json (contornos de países ya proyectados a SVG) a partir de world-atlas.
// Se corre a mano solo si cambia el mapa: node scripts/mapa.js
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import countries from "i18n-iso-countries";
import { feature } from "topojson-client";

const requerir = createRequire(import.meta.url);
countries.registerLocale(requerir("i18n-iso-countries/langs/es.json"));
const mundo = JSON.parse(readFileSync(requerir.resolve("world-atlas/countries-110m.json"), "utf8"));

// Equirectangular sin la Antártida (latitudes 84 a -56): alcanza para colorear países.
const [NORTE, SUR] = [84, -56];
const ANCHO = 640;
const ALTO = Math.round((ANCHO * (NORTE - SUR)) / 360);
const punto = ([lon, lat]) =>
  `${(((lon + 180) / 360) * ANCHO).toFixed(1)} ${(((NORTE - lat) / (NORTE - SUR)) * ALTO).toFixed(1)}`;
const anillo = (coordenadas) => `M${coordenadas.map(punto).join("L")}Z`;

const paises = {};
for (const pais of feature(mundo, mundo.objects.countries).features) {
  const codigo = countries.numericToAlpha3(pais.id);
  if (!codigo) continue;
  const poligonos = pais.geometry.type === "Polygon" ? [pais.geometry.coordinates] : pais.geometry.coordinates;
  paises[codigo] = {
    nombre: countries.getName(codigo, "es") ?? pais.properties.name,
    d: poligonos.flatMap((poligono) => poligono.map(anillo)).join(""),
  };
}
const salida = fileURLToPath(new URL("../public/mapa.json", import.meta.url));
writeFileSync(salida, `${JSON.stringify({ tamano: [ANCHO, ALTO], paises }, null, 2)}\n`);
console.log(`mapa.json: ${Object.keys(paises).length} países, ${ANCHO}×${ALTO}`);
