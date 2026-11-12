# ESTADO — investigador

## Objetivo

Página web de chat que hace investigaciones exhaustivas (pueden durar horas): busca en la web,
lee las fuentes y entrega un informe con citas, usando modelos abiertos gratuitos. Funciona sin
que la PC de Franco esté prendida, sin costo, con historial guardado por persona.

## Decisiones tomadas

- App propia en Node (sin paso de build): servidor Express + página en HTML/CSS/JS plano.
- Hosting: Render gratis, sin tarjeta. Se duerme a los 15 min sin pedidos entrantes; disco
  efímero. Mientras haya una investigación en curso, el servidor se visita solo cada 10 min
  (`RENDER_EXTERNAL_URL` + `/salud`). Render no menciona esto en su documentación (2026-11-11).
- Historial: Neon (Postgres gratis, 1 GB, sin tarjeta, no pausa ni borra por inactividad).
  Se guarda chat, fuentes, informe y eventos; se conserva hasta que la persona lo borra.
  Descartados: Turso (archiva a los 10 días; comprada por Supabase), MongoDB Atlas (pausa a los
  30 días), Supabase (pausa a la semana).
- Investigación en segundo plano: se puede cerrar la página; la página se reconecta y repite el
  progreso. Detener cancela en el servidor (también si está en cola).
- Profundidad elegible por pedido: Normal (~24 fuentes, ~11 búsquedas), Profunda (~50, ~24),
  Exhaustiva (~100, ~45). Tavily: 1.000 búsquedas/mes para todos.
- Modelos (orden): NVIDIA Nemotron 3 Ultra → Mistral Large 4 → GPT-OSS 20B (~2,5 min) → GLM 5.3
  Flash (~5 min) → OpenRouter Nemotron 3 Ultra `:free`. Límite por pedido 30 min. Kimi K2.6 (404
  para la cuenta) y DeepSeek V4.1 Flash (error 500 / sin respuesta) no sirven.
- Solo claves API de planes gratuitos oficiales.
- Búsqueda: Tavily (trae el texto de cada página) + DuckDuckGo de respaldo.
- Pedidos: guía con plantilla Pregunta / Contexto / Aspectos / Excluir / Entrega / Fuentes.
- Diseño: tema oscuro; adaptado a celular. PDF como única descarga.
- Acceso: código por persona; límite diario por persona (en memoria/archivo: se reinicia con el
  servidor, aceptado).
- Repositorio propio en GitHub (lo sube Franco); tarjeta en `Franco944796.github.io` → Render.

## Hecho (2026-11-11)

- App completa con historial, segundo plano, profundidades, plantilla, PDF, rotación de modelos.
- Claves de Tavily, OpenRouter y NVIDIA en `.env` (permisos 600, fuera de git).
- Prueba real a profundidad normal con NVIDIA (antes del segundo plano): 20 fuentes, ~7,7 min,
  respetó Excluir y Entrega.
- Recorrido en navegador con simulación: investigar, recargar a mitad, reabrir desde el
  historial, terminar, detener, borrar; escritorio y celular sin errores.
- 24 pruebas automáticas pasan (incluye Postgres real vía PGlite y reinicio del servidor).
- 2026-11-12: Neon conectado (`DATABASE_URL` en `.env`; base `neondb`, región us-east-1, Postgres
  18). Almacén probado contra Neon: guardar, actualizar, listar, interrumpidas, borrar por dueño.
  `conectarPostgres` pasa `sslmode=require` a `verify-full` (evita el aviso de `pg`) y activa
  channel binding si la cadena lo pide: la cadena de Neon se pega tal cual.

## En curso

- Investigación real Profunda contra Neon, luego reinicio y verificación de historial y PDF
  (script en el scratchpad de la sesión, no forma parte del proyecto).

## Pendiente

1. Terminar la prueba real Profunda + reinicio (ver En curso).
2. Franco: `git init`, commit y push a un repositorio nuevo de GitHub.
3. Franco: en Render, New → Blueprint → elegir el repositorio; cargar en el panel
   `CODIGOS_ACCESO`, `DATABASE_URL`, `TAVILY_CLAVE`, `LLM_1_CLAVE` (NVIDIA), `LLM_4_CLAVE`
   (OpenRouter). Nunca en `render.yaml`.
4. Verificar en Render: investigación larga sin que se duerma, reconexión, PDF, bloqueo por IP
   (`CONFIAR_EN_PROXY`), DuckDuckGo desde el servidor.
5. Tarjeta del proyecto en `Franco944796.github.io` con la URL de Render.

## Archivos clave y comandos

- `servidor.js`: arranque (almacén, perfiles, visita propia). `src/app.js`: rutas, segundo
  plano, cola, guardado. `src/almacen.js`: memoria / Postgres. `src/investigador.js`: etapas.
  `src/prompts.js`, `src/llm.js`, `src/busqueda.js`, `src/lector.js`, `src/pdf.js`,
  `src/acceso.js`, `src/config.js`. Página en `public/`. Publicación: `render.yaml`.
- API: `POST /api/investigar`, `GET /api/conversaciones`, `GET /api/conversaciones/:id/eventos`
  (repite todo y sigue en vivo), `POST …/:id/preguntas`, `POST …/:id/cancelar`,
  `DELETE …/:id`, `GET /api/informe/:id` (PDF), `GET /salud`.
- `npm start` → http://127.0.0.1:3210 (lee `.env`). `npm test` → pruebas.
- `node tests/simulacion.js` → página simulada en el puerto 3211 (código `codigo-de-prueba`).

## Problemas conocidos y sin verificar

- Sin verificar: todo el comportamiento en Render, una investigación Exhaustiva real (largo del informe:
  los proveedores pueden cortar la respuesta por límite de tokens de salida).
- Si Render reinicia el servicio en medio de una investigación, queda "interrumpida" (no se
  retoma; hay que empezarla de nuevo).
- Créditos gratuitos de NVIDIA: no se sabe si se agotan.
- OpenRouter gratis: 50 pedidos/día; es el último respaldo.
- Los modelos gratuitos a veces citan una fuente que no corresponde.
- DuckDuckGo suele bloquear pedidos desde servidores.
