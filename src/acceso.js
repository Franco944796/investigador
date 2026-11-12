import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DURACION_SESION_MS = 30 * 24 * 60 * 60 * 1000;
const INTENTOS_MAXIMOS = 8;
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;
const LARGO_MINIMO_CODIGO = 8;

const huellaDe = (texto) => createHash("sha256").update(texto).digest();
const hoy = () => new Date().toLocaleDateString("sv-SE");

export function parsearCodigos(texto, limitePorDefecto) {
  const personas = texto
    .split(",")
    .map((parte) => parte.trim())
    .filter(Boolean)
    .map((parte) => {
      const [nombre, codigo, limite] = parte.split(":").map((campo) => campo.trim());
      const limiteDiario = limite === undefined ? limitePorDefecto : Number.parseInt(limite, 10);
      if (!nombre || !codigo || !Number.isInteger(limiteDiario) || limiteDiario < 0) {
        throw new Error(`Código de acceso mal formado: "${parte}"`);
      }
      if (codigo.length < LARGO_MINIMO_CODIGO) {
        throw new Error(`El código de "${nombre}" tiene menos de ${LARGO_MINIMO_CODIGO} caracteres.`);
      }
      return { nombre, limite: limiteDiario, huella: huellaDe(codigo) };
    });
  if (new Set(personas.map((persona) => persona.nombre)).size !== personas.length) {
    throw new Error("Hay nombres repetidos en CODIGOS_ACCESO.");
  }
  return personas;
}

export class Acceso {
  #personas;
  #secreto;
  #archivoUso;
  #uso;
  #intentos = new Map();

  constructor({ codigos, limiteDiario, secreto, archivoUso }) {
    this.#personas = parsearCodigos(codigos, limiteDiario);
    if (!this.#personas.length) {
      throw new Error("Falta CODIGOS_ACCESO: sin códigos nadie puede entrar (ver .env.example).");
    }
    this.#secreto = secreto;
    this.#archivoUso = archivoUso;
    this.#uso = this.#leerUso();
  }

  entrar(codigo, ip) {
    const ahora = Date.now();
    const registro = this.#intentos.get(ip);
    if (registro && registro.hasta > ahora && registro.fallos >= INTENTOS_MAXIMOS) {
      return { bloqueado: true };
    }

    const huella = huellaDe(String(codigo ?? ""));
    // Se recorren todas sin cortar en la primera coincidencia para no filtrar por tiempo cuál fue.
    let persona = null;
    for (const candidata of this.#personas) {
      if (timingSafeEqual(huella, candidata.huella)) persona = candidata;
    }

    if (!persona) {
      const vigente = registro && registro.hasta > ahora;
      this.#intentos.set(ip, {
        fallos: vigente ? registro.fallos + 1 : 1,
        hasta: vigente ? registro.hasta : ahora + VENTANA_INTENTOS_MS,
      });
      return {};
    }

    this.#intentos.delete(ip);
    const expira = ahora + DURACION_SESION_MS;
    const nombre = Buffer.from(persona.nombre).toString("base64url");
    return { persona, token: `${nombre}.${expira}.${this.#firmar(persona, expira)}` };
  }

  verificar(token) {
    const [nombre, expira, firma] = String(token ?? "").split(".");
    if (!nombre || !firma || !(Number(expira) > Date.now())) return null;
    const buscada = Buffer.from(nombre, "base64url").toString();
    const persona = this.#personas.find((candidata) => candidata.nombre === buscada);
    if (!persona) return null;
    const esperada = Buffer.from(this.#firmar(persona, expira));
    const recibida = Buffer.from(firma);
    return esperada.length === recibida.length && timingSafeEqual(esperada, recibida) ? persona : null;
  }

  // La huella del código entra en la firma: cambiar el código de alguien invalida sus sesiones.
  #firmar(persona, expira) {
    return createHmac("sha256", this.#secreto)
      .update(`${persona.nombre}|${expira}|${persona.huella.toString("hex")}`)
      .digest("base64url");
  }

  uso(persona) {
    return { usadas: this.#usoDeHoy().conteo[persona.nombre] ?? 0, limite: persona.limite };
  }

  puedeInvestigar(persona) {
    const { usadas, limite } = this.uso(persona);
    return limite === 0 || usadas < limite;
  }

  registrarUso(persona, cantidad = 1) {
    const uso = this.#usoDeHoy();
    uso.conteo[persona.nombre] = Math.max(0, (uso.conteo[persona.nombre] ?? 0) + cantidad);
    mkdirSync(dirname(this.#archivoUso), { recursive: true });
    writeFileSync(this.#archivoUso, JSON.stringify(uso, null, 2));
  }

  #usoDeHoy() {
    if (this.#uso.fecha !== hoy()) this.#uso = { fecha: hoy(), conteo: {} };
    return this.#uso;
  }

  #leerUso() {
    try {
      const guardado = JSON.parse(readFileSync(this.#archivoUso, "utf8"));
      if (guardado.fecha === hoy() && typeof guardado.conteo === "object") return guardado;
    } catch {
      // Sin archivo o ilegible: se arranca con el conteo del día en cero.
    }
    return { fecha: hoy(), conteo: {} };
  }
}
