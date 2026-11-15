// Las fórmulas se sacan del Markdown antes de pasarlo a marked: si no, toma "_" y "*" como cursivas
// y "\\" como escapes. Quedan marcas con el número de cada una, que después se reemplazan por la
// fórmula dibujada (KaTeX en la página, MathJax o texto en el PDF). La marca es solo letras y
// números para que marked no la toque.
export const MARCA = /XFORMULAX(\d+)XFORMULAX/;
export const PARTIR = /XFORMULAX(\d+)XFORMULAX/g;
export const marcaDe = (indice) => `XFORMULAX${indice}XFORMULAX`;

// En línea, "$" también es moneda: la fórmula no puede empezar ni terminar con espacio ni seguir
// con un número ("de $20 a $30" no es fórmula), y si solo tiene cifras se deja como está.
const PATRON =
  /(`+)[\s\S]*?\1|\\\$|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=[^\s$])((?:[^$\n\\]|\\.)*?[^\s$\\])\$(?!\d)/g;
const CERCO = /^ {0,3}(`{3,}|~{3,})/;
const SOLO_CIFRAS = /^[\d\s.,%+-]*$/;

function separarTexto(texto, formulas) {
  return texto.replace(PATRON, (todo, codigo, doble, corchetes, parentesis, simple) => {
    if (codigo !== undefined || todo === "\\$") return todo;
    const tex = doble ?? corchetes ?? parentesis ?? simple;
    if (simple !== undefined && SOLO_CIFRAS.test(simple)) return todo;
    formulas.push({ tex: tex.trim(), display: doble !== undefined || corchetes !== undefined });
    return marcaDe(formulas.length - 1);
  });
}

export function separarFormulas(markdown) {
  const formulas = [];
  // Cada línea va a un tramo de código o de texto; unir los tramos con "\n" recompone el original.
  const tramos = [];
  let cerco = null;
  for (const linea of markdown.split("\n")) {
    const apertura = linea.match(CERCO)?.[1];
    const esCodigo = Boolean(cerco || apertura);
    if (cerco) {
      if (apertura && apertura[0] === cerco[0] && apertura.length >= cerco.length) cerco = null;
    } else if (apertura) {
      cerco = apertura;
    }
    const ultimo = tramos.at(-1);
    if (ultimo?.esCodigo === esCodigo) ultimo.lineas.push(linea);
    else tramos.push({ esCodigo, lineas: [linea] });
  }
  const texto = tramos
    .map(({ esCodigo, lineas }) => (esCodigo ? lineas.join("\n") : separarTexto(lineas.join("\n"), formulas)))
    .join("\n");
  return { texto, formulas };
}

const SIMBOLOS = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ",
  Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘",
  bullet: "•", approx: "≈", sim: "∼", simeq: "≃", equiv: "≡", cong: "≅", neq: "≠", ne: "≠",
  leq: "≤", le: "≤", leqslant: "≤", geq: "≥", ge: "≥", geqslant: "≥", ll: "≪", gg: "≫",
  propto: "∝", infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫",
  iint: "∬", oint: "∮", to: "→", rightarrow: "→", leftarrow: "←", gets: "←",
  leftrightarrow: "↔", Rightarrow: "⇒", implies: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  iff: "⇔", longrightarrow: "→", mapsto: "↦", uparrow: "↑", downarrow: "↓", degree: "°",
  prime: "′", ldots: "…", cdots: "⋯", dots: "…", in: "∈", notin: "∉", subset: "⊂",
  subseteq: "⊆", cup: "∪", cap: "∩", forall: "∀", exists: "∃", emptyset: "∅", hbar: "ħ",
  ell: "ℓ", angle: "∠", perp: "⊥", parallel: "∥", langle: "⟨", rangle: "⟩", vert: "|",
  lvert: "|", rvert: "|", mid: "|", Vert: "‖", lVert: "‖", rVert: "‖", "|": "‖",
  lbrace: "{", rbrace: "}", "{": "{", "}": "}", "%": "%", $: "$", "&": "&", "#": "#", _: "_",
  ",": " ", ";": " ", ":": " ", " ": " ", "!": "", quad: " ", qquad: "  ", "\\": "; ",
};
const OPERADORES = new Set([
  "cdot", "times", "div", "pm", "mp", "approx", "sim", "simeq", "equiv", "cong", "neq", "ne",
  "leq", "le", "leqslant", "geq", "ge", "geqslant", "ll", "gg", "propto", "to", "rightarrow",
  "leftarrow", "gets", "leftrightarrow", "Rightarrow", "implies", "Leftarrow", "Leftrightarrow",
  "iff", "longrightarrow", "mapsto", "in", "notin", "subset", "subseteq",
]);
const ACENTOS = {
  dot: "̇", ddot: "̈", hat: "̂", widehat: "̂", bar: "̄",
  overline: "̅", vec: "⃗", tilde: "̃", widetilde: "̃",
};
const CON_TEXTO = new Set([
  "text", "textrm", "textit", "textbf", "textnormal", "mathrm", "mathit", "mathbf", "mathsf",
  "mathtt", "mathcal", "mathbb", "mathscr", "boldsymbol", "bm", "operatorname", "mbox", "emph",
]);
const IGNORADOS = new Set([
  "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl",
  "biggr", "middle", "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits",
  "nonumber", "notag", "mathstrut", "quad",
]);
const DELIMITADORES = new Set(["left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "middle"]);

function tokenizar(tex) {
  const lista = [];
  for (let i = 0; i < tex.length; ) {
    if (tex[i] === "\\") {
      const [todo, nombre] = /^\\([a-zA-Z]+|[\s\S]?)/.exec(tex.slice(i));
      lista.push({ comando: nombre });
      i += todo.length;
    } else if (/\s/.test(tex[i])) {
      while (/\s/.test(tex[i] ?? "")) i++;
      lista.push({ espacio: true });
    } else {
      lista.push({ caracter: tex[i] });
      i++;
    }
  }
  return lista;
}

const plano = (tramos) => tramos.map((tramo) => tramo.text).join("");
// Un símbolo con sus índices ("pₑ", "x²") o un número no necesitan paréntesis en a/b.
const simple = (tramos) =>
  /^[\p{L}\p{N}][\p{M}]*$|^\p{N}+([.,]\p{N}+)?$/u.test(
    plano(tramos.filter((tramo) => !tramo.sub && !tramo.sup)).trim(),
  );
const entreParentesis = (tramos) =>
  simple(tramos) ? tramos : [{ text: "(" }, ...tramos, { text: ")" }];

function analizar(tokens) {
  let i = 0;
  const saltarEspacios = () => {
    while (tokens[i]?.espacio) i++;
  };
  const argumento = () => {
    saltarEspacios();
    const token = tokens[i];
    if (!token) return [];
    if (token.caracter === "{") {
      i++;
      return lista("}");
    }
    return uno();
  };
  const opcional = () => {
    saltarEspacios();
    if (tokens[i]?.caracter !== "[") return null;
    i++;
    return lista("]");
  };
  const escrito = (marca) => {
    const contenido = plano(argumento()).trim();
    return contenido ? [{ text: contenido, [marca]: true }] : [];
  };

  function uno() {
    const token = tokens[i++];
    if (token.espacio) return [{ text: " " }];
    if (token.caracter !== undefined) {
      const c = token.caracter;
      if (c === "{") return lista("}");
      if (c === "^") return escrito("sup");
      if (c === "_") return escrito("sub");
      if (c === "'") return [{ text: "′" }];
      if (c === "~") return [{ text: " " }];
      if (c === "&") return [{ text: " " }];
      return [{ text: c }];
    }
    const nombre = token.comando;
    if (nombre === "frac" || nombre === "dfrac" || nombre === "tfrac" || nombre === "cfrac") {
      const arriba = argumento();
      const abajo = argumento();
      return [...entreParentesis(arriba), { text: "/" }, ...entreParentesis(abajo)];
    }
    if (nombre === "binom") {
      const n = argumento();
      const k = argumento();
      return [{ text: "C(" }, ...n, { text: ", " }, ...k, { text: ")" }];
    }
    if (nombre === "sqrt") {
      const indice = opcional();
      const radicando = argumento();
      const raiz = indice ? [{ text: plano(indice), sup: true }] : [];
      return [...raiz, { text: "√" }, ...entreParentesis(radicando)];
    }
    if (ACENTOS[nombre]) {
      const marca = ACENTOS[nombre];
      return argumento().map((tramo) => ({
        ...tramo,
        text: tramo.text.replace(/\S/gu, (c) => c + marca).normalize("NFC"),
      }));
    }
    if (CON_TEXTO.has(nombre)) return argumento();
    if (nombre === "begin" || nombre === "end") {
      argumento();
      return [];
    }
    if (nombre === "tag") return [{ text: " (" }, ...argumento(), { text: ")" }];
    if (DELIMITADORES.has(nombre)) {
      saltarEspacios();
      if (tokens[i]?.caracter === ".") i++;
      return [];
    }
    if (IGNORADOS.has(nombre) && !(nombre in SIMBOLOS)) return [];
    if (OPERADORES.has(nombre)) return [{ text: ` ${SIMBOLOS[nombre]} ` }];
    if (nombre in SIMBOLOS) return [{ text: SIMBOLOS[nombre] }];
    // sin, cos, log, exp, lim, max… y cualquier otro comando: su nombre, separado de lo que sigue.
    const siguiente = tokens[i];
    const pegado = siguiente?.comando !== undefined || /^[\p{L}\p{N}]$/u.test(siguiente?.caracter ?? "");
    return [{ text: pegado ? `${nombre} ` : nombre }];
  }

  function lista(cierre) {
    const tramos = [];
    while (i < tokens.length) {
      if (cierre && tokens[i].caracter === cierre) {
        i++;
        break;
      }
      tramos.push(...uno());
    }
    return tramos;
  }

  return lista(null);
}

// Para donde no se puede dibujar la fórmula (PDF en línea, tablas, títulos): texto con subíndices y
// superíndices. Devuelve tramos { text, sub?, sup? } con los vecinos iguales ya unidos.
export function latexATexto(tex) {
  const unidos = [];
  for (const tramo of analizar(tokenizar(tex))) {
    const anterior = unidos.at(-1);
    if (anterior && Boolean(anterior.sub) === Boolean(tramo.sub) && Boolean(anterior.sup) === Boolean(tramo.sup)) {
      anterior.text += tramo.text;
    } else {
      unidos.push({ ...tramo });
    }
  }
  for (const tramo of unidos) tramo.text = tramo.text.replace(/ {2,}/g, " ").replace(/\( /g, "(").replace(/ ([);])/g, "$1");
  if (unidos.length) {
    unidos[0].text = unidos[0].text.trimStart();
    unidos.at(-1).text = unidos.at(-1).text.replace(/[\s;]+$/, "");
  }
  return unidos.filter((tramo) => tramo.text);
}
