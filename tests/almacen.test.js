import assert from "node:assert/strict";
import { test } from "node:test";
import { crearAlmacenMemoria } from "../src/almacen.js";
import { crearAlmacenPGlite } from "./ayuda.js";

const registro = (id, dueno, creada, estado = "lista") => ({
  id,
  dueno,
  tema: `Tema ${id}`,
  profundidad: "normal",
  estado,
  etapa: "Redactando el informe",
  creada,
  actualizada: creada + 10,
  datos: {
    fuentes: [{ n: 1, url: "https://a.test", titulo: "Ñandú «comillas»", notas: "x" }],
    vistas: ["https://a.test"],
    eventos: [{ tipo: "texto", datos: { delta: "# Informe [1]" } }],
  },
});

for (const [nombre, crear] of [
  ["memoria", async () => crearAlmacenMemoria()],
  ["postgres", crearAlmacenPGlite],
]) {
  test(`almacén ${nombre}: guarda, actualiza, lista por dueño, borra y marca lo interrumpido`, async () => {
    const almacen = await crear();
    await almacen.preparar();
    await almacen.guardar(registro("a", "ana", 1000));
    await almacen.guardar(registro("b", "ana", 2000, "en-curso"));
    await almacen.guardar(registro("c", "beto", 3000));

    assert.deepEqual(await almacen.obtener("a"), registro("a", "ana", 1000));
    assert.equal(await almacen.obtener("z"), null);

    const cambiado = { ...registro("a", "ana", 1000), estado: "fallida", actualizada: 5000 };
    await almacen.guardar(cambiado);
    assert.equal((await almacen.obtener("a")).estado, "fallida");

    const lista = await almacen.listar("ana");
    assert.deepEqual(
      lista.map(({ id, estado }) => [id, estado]),
      [
        ["b", "en-curso"],
        ["a", "fallida"],
      ],
    );
    assert.equal(lista[0].datos, undefined, "la lista no trae el contenido");

    await almacen.borrar("c", "ana");
    assert.ok(await almacen.obtener("c"), "no se borra lo de otra persona");
    await almacen.borrar("c", "beto");
    assert.equal(await almacen.obtener("c"), null);

    if (nombre === "postgres") {
      await almacen.preparar();
      assert.equal((await almacen.obtener("b")).estado, "interrumpida");
    }
  });
}
