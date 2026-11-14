// Se carga antes que el estilo para que el informe no parpadee en claro: elige el tema guardado
// o, la primera vez, el del sistema. La clave es la misma que usa informe.js al guardarlo.
(() => {
  let guardado = null;
  try {
    guardado = localStorage.getItem("investigador-tema-informe");
  } catch {}
  const oscuro = guardado ? guardado === "oscuro" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.tema = oscuro ? "oscuro" : "claro";
})();
