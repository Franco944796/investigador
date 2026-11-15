import assert from "node:assert/strict";
import { test } from "node:test";
import { latexATexto, separarFormulas } from "../public/formulas.js";
import { generarPDF } from "../src/pdf.js";

test("fórmulas: se separan del Markdown sin tocar precios ni código", () => {
  const markdown = [
    "El empuje es $$F = \\dot{m} v_e$$ y $\\eta_t = 0.8$ o \\(x^2\\).",
    "",
    "Cuesta de $20 a $30, o $5$, y \\$ suelto.",
    "",
    "```grafico",
    '{"pie": "$x$"}',
    "```",
    "",
    "Con `$a$` y",
    "\\[ \\frac{1}{2} \\rho v^2 \\]",
  ].join("\n");
  const { texto, formulas } = separarFormulas(markdown);
  assert.deepEqual(formulas, [
    { tex: "F = \\dot{m} v_e", display: true },
    { tex: "\\eta_t = 0.8", display: false },
    { tex: "x^2", display: false },
    { tex: "\\frac{1}{2} \\rho v^2", display: true },
  ]);
  assert.equal(
    texto,
    [
      "El empuje es XFORMULAX0XFORMULAX y XFORMULAX1XFORMULAX o XFORMULAX2XFORMULAX.",
      "",
      "Cuesta de $20 a $30, o $5$, y \\$ suelto.",
      "",
      "```grafico",
      '{"pie": "$x$"}',
      "```",
      "",
      "Con `$a$` y",
      "XFORMULAX3XFORMULAX",
    ].join("\n"),
  );
  assert.deepEqual(separarFormulas("sin fórmulas\n").formulas, []);
});

test("fórmulas: LaTeX a texto con subíndices y superíndices", () => {
  assert.deepEqual(latexATexto("F = \\dot{m} v_e + (p_e - p_0) A_e"), [
    { text: "F = ṁ v" },
    { text: "e", sub: true },
    { text: " + (p" },
    { text: "e", sub: true },
    { text: " - p" },
    { text: "0", sub: true },
    { text: ") A" },
    { text: "e", sub: true },
  ]);
  const plano = (tex) => latexATexto(tex).map((tramo) => tramo.text).join("|");
  assert.equal(plano("\\frac{p_e}{p_0}"), "p|e|/p|0");
  assert.equal(plano("\\frac{a+b}{2}"), "(a+b)/2");
  assert.equal(plano("\\sqrt{2 g h} \\cdot \\sin\\theta"), "√(2 g h) · sin θ");
  assert.equal(plano("\\Delta p\\cdot A \\approx 25\\,\\text{N}"), "Δ p · A ≈ 25 N");
  assert.equal(plano("\\left( \\frac{1}{2} \\right)^{\\gamma-1}"), "(1/2)|γ-1");
  assert.equal(plano("\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}"), "a = b; c = d");
  assert.equal(plano("\\mathrm{Re} = \\rho v L / \\mu"), "Re = ρ v L / μ");
});

test("PDF con fórmulas en línea, destacadas, en tablas y con errores: no falla y usa DejaVu", async () => {
  const markdown = [
    "# Empuje",
    "",
    "El caudal $\\dot{m}$ y el empuje:",
    "",
    "$$F = \\dot{m} v_e + (p_e - p_0) A_e$$",
    "",
    "Texto antes $$\\frac{1}{2}\\rho v^2$$ y después [1].",
    "",
    "| Magnitud | Fórmula |",
    "|---|---|",
    "| Empuje | $$F = \\dot{m} v_e$$ |",
    "",
    "- Rota: $$x^{2$$",
    "",
    "## Sobre $\\Delta p$",
  ].join("\n");
  const pdf = await generarPDF({ titulo: "T", markdown, fuentes: [{ n: 1, url: "https://a.test" }] });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(pdf.toString("latin1"), /DejaVuSans/);
});
