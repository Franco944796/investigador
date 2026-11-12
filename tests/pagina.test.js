import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { armarPagina } from "../scripts/pagina.js";
import { VENDOR } from "../src/vendor.js";

const API = "https://investigador.onrender.com";

test("la copia para GitHub Pages apunta a la API, limita conexiones y trae las librerías", () => {
  const destino = join(mkdtempSync(join(tmpdir(), "pagina-")), "sitio");
  assert.equal(armarPagina(destino, `${API}/`), API);

  const html = readFileSync(join(destino, "index.html"), "utf8");
  assert.ok(html.includes(`<meta name="api" content="${API}" />`));
  const politica = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(politica.includes(`connect-src 'self' ${API};`));
  assert.ok(!html.includes('<meta name="api" content="" />'));
  for (const [nombre, archivo] of Object.entries(VENDOR)) {
    assert.deepEqual(readFileSync(join(destino, "vendor", nombre)), readFileSync(archivo));
  }
  assert.ok(readFileSync(join(destino, "app.js"), "utf8").includes('meta[name="api"]'));
});
