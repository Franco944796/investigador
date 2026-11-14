import assert from "node:assert/strict";
import { test } from "node:test";
import { seleccionarPasajes, terminosDe } from "../src/pasajes.js";

test("términos: sin palabras vacías ni tildes, con siglas y pares de caracteres en chino", () => {
  assert.deepEqual([...terminosDe("El costo de la energía PV en 2026")], ["costo", "energia", "pv", "2026"]);
  assert.deepEqual([...terminosDe("光伏装机")], ["光伏", "伏装", "装机"]);
});

test("de una página larga quedan el comienzo y los pasajes que hablan de la búsqueda", () => {
  const relleno = (tema) =>
    Array.from({ length: 12 }, (_, i) => `Párrafo ${i} sobre ${tema}, sin nada más que decir aquí.`).join("\n");
  const dato = "El costo nivelado (LCOE) de la solar fotovoltaica cayó a 43 USD/MWh en 2025, un 12 % menos.";
  const pagina = [
    "Informe anual. Tabla de contenidos. Prólogo del director.",
    relleno("gobernanza"),
    relleno("agradecimientos"),
    dato,
    relleno("metodología"),
    relleno("anexos"),
  ].join("\n");
  assert.ok(pagina.length > 2500);

  const elegido = seleccionarPasajes(pagina, {
    terminos: terminosDe("solar LCOE costo"),
    secundarios: terminosDe("energía fotovoltaica"),
    maximo: 1600,
  });
  assert.ok(elegido.length <= 1600);
  assert.ok(elegido.startsWith("Informe anual. Tabla"), "conserva el comienzo");
  assert.ok(elegido.includes(dato), "trae el pasaje con el dato, que está lejos del comienzo");
  assert.ok(elegido.includes("[…]"), "marca los saltos");
  assert.ok(!elegido.includes("anexos"));
});

test("una página corta va entera y, si nada coincide, queda el comienzo", () => {
  const opciones = { terminos: terminosDe("xyz"), maximo: 50 };
  assert.equal(seleccionarPasajes("texto corto", opciones), "texto corto");
  const larga = "abc def ghi. ".repeat(30);
  assert.equal(seleccionarPasajes(larga, opciones), larga.slice(0, 50));
});
