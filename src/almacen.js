import pg from "pg";

// Cada registro guarda en `datos` todo lo que hace falta para reabrir la investigación:
// fuentes, consultas, URLs vistas, informe, intercambios y el registro de eventos que la página
// repite al reconectarse.
const resumen = ({ id, dueno, tema, profundidad, estado, etapa, creada, actualizada }) => ({
  id,
  dueno,
  tema,
  profundidad,
  estado,
  etapa,
  creada,
  actualizada,
});

export function crearAlmacenMemoria() {
  const registros = new Map();
  return {
    tipo: "memoria",
    async preparar() {},
    async guardar(registro) {
      registros.set(registro.id, structuredClone(registro));
    },
    async obtener(id) {
      const registro = registros.get(id);
      return registro ? structuredClone(registro) : null;
    },
    async listar(dueno) {
      return [...registros.values()]
        .filter((registro) => registro.dueno === dueno)
        .sort((a, b) => b.creada - a.creada)
        .map(resumen);
    },
    async borrar(id, dueno) {
      if (registros.get(id)?.dueno === dueno) registros.delete(id);
    },
  };
}

// Postgres devuelve bigint como texto (pg) o como BigInt (PGlite).
const fila = (datos) => ({ ...datos, creada: Number(datos.creada), actualizada: Number(datos.actualizada) });

export function crearAlmacenSQL(consulta) {
  return {
    tipo: "postgres",
    async preparar() {
      await consulta(`CREATE TABLE IF NOT EXISTS investigaciones (
        id text PRIMARY KEY,
        dueno text NOT NULL,
        tema text NOT NULL,
        profundidad text NOT NULL,
        estado text NOT NULL,
        etapa text NOT NULL DEFAULT '',
        creada bigint NOT NULL,
        actualizada bigint NOT NULL,
        datos jsonb NOT NULL
      )`);
      await consulta(
        "CREATE INDEX IF NOT EXISTS investigaciones_por_dueno ON investigaciones (dueno, creada DESC)",
      );
      // Lo que figuraba en curso murió con el proceso anterior.
      await consulta("UPDATE investigaciones SET estado = 'interrumpida' WHERE estado = 'en-curso'");
    },
    async guardar(registro) {
      await consulta(
        `INSERT INTO investigaciones
           (id, dueno, tema, profundidad, estado, etapa, creada, actualizada, datos)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           estado = EXCLUDED.estado,
           etapa = EXCLUDED.etapa,
           actualizada = EXCLUDED.actualizada,
           datos = EXCLUDED.datos`,
        [
          registro.id,
          registro.dueno,
          registro.tema,
          registro.profundidad,
          registro.estado,
          registro.etapa,
          registro.creada,
          registro.actualizada,
          JSON.stringify(registro.datos),
        ],
      );
    },
    async obtener(id) {
      const [encontrada] = await consulta("SELECT * FROM investigaciones WHERE id = $1", [id]);
      return encontrada ? fila(encontrada) : null;
    },
    async listar(dueno) {
      const filas = await consulta(
        `SELECT id, dueno, tema, profundidad, estado, etapa, creada, actualizada
         FROM investigaciones WHERE dueno = $1 ORDER BY creada DESC LIMIT 200`,
        [dueno],
      );
      return filas.map(fila);
    },
    async borrar(id, dueno) {
      await consulta("DELETE FROM investigaciones WHERE id = $1 AND dueno = $2", [id, dueno]);
    },
  };
}

export function conectarPostgres(url) {
  const direccion = new URL(url);
  // pg ya trata "require" como "verify-full", pero avisa en cada arranque; y no lee channel_binding
  // de la cadena, así que se pasa aparte. Así la cadena de Neon se puede pegar tal cual.
  if (direccion.searchParams.get("sslmode") === "require") direccion.searchParams.set("sslmode", "verify-full");
  const enableChannelBinding = direccion.searchParams.get("channel_binding") === "require";
  // Conexiones cortas: Neon apaga la base a los 5 minutos sin uso y corta las que quedan abiertas.
  const pool = new pg.Pool({
    connectionString: direccion.href,
    enableChannelBinding,
    max: 3,
    idleTimeoutMillis: 10000,
  });
  pool.on("error", (error) => console.error(`Base de datos: ${error.message}`));
  return async (texto, parametros) => (await pool.query(texto, parametros)).rows;
}
