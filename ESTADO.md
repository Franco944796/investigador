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
- Profundidad elegible por pedido: Normal (~24 fuentes, ~11 búsquedas), Profunda (~40 leídas de
  tope 50, ~24; etiqueta «~40 fuentes · 15–60 min»),
  Exhaustiva (hasta 300, ~97; ver abajo). Tavily: 1.000 búsquedas/mes para todos; Franco acepta
  que una Exhaustiva gaste ~100 (la calidad importa más que la cantidad de investigaciones).
- Modelos (orden): NVIDIA Nemotron 3 Ultra → Mistral Large 4 → GPT-OSS 20B (~2,5 min) → GLM 5.3
  Flash (~5 min) → OpenRouter Nemotron 3 Ultra `:free`. Límite por pedido 30 min. Kimi K2.6 (404
  para la cuenta) y DeepSeek V4.1 Flash (error 500 / sin respuesta) no sirven.
- Solo claves API de planes gratuitos oficiales.
- Búsqueda: Tavily (trae el texto de cada página) + DuckDuckGo de respaldo.
- Pedidos: guía con plantilla Pregunta / Contexto / Aspectos / Excluir / Entrega / Fuentes.
- Diseño: tema oscuro; adaptado a celular. PDF como única descarga.
- Acceso: código por persona; límite diario por persona (en memoria/archivo: se reinicia con el
  servidor, aceptado).
- Repositorio: https://github.com/Franco944796/investigador (público; commits y push los hace
  Franco). Servicio en Render: https://investigador.onrender.com (Blueprint creado 2026-11-12).
- La página se publica en GitHub Pages desde este repo (https://franco944796.github.io/investigador/)
  y le habla a la API de Render por detrás. La de Render sigue funcionando igual.
  - Sesión por token (`Authorization: Bearer`) guardado en localStorage con prefijo
    `investigador-`; sin cookie (Safari bloquea cookies entre sitios).
  - Render permite el origen de Pages con `ORIGENES_PERMITIDOS` (CORS, en `render.yaml`).
  - `.github/workflows/pagina.yml` arma la copia con `scripts/pagina.js` (pone la dirección de la
    API y una CSP en la página) y la publica en cada push a main.
- Panel lateral de investigaciones (pedido 2026-11-12), como el de Claude:
  - Escritorio: abierto al entrar, corre el chat; cerrado queda una franja con abrir y nueva.
    Recuerda abierto/cerrado (localStorage).
  - Celular: cerrado; ☰ lo abre encima con fondo oscurecido; se cierra al elegir, tocar afuera o ✕.
  - Contenido: «Nueva investigación» arriba, lista (estado, fecha, Borrar), abajo uso del día y
    «Salir». La lista sale del inicio (queda guía + cuadro para escribir).
- Cuadro de escritura con borde celeste (acento) y resplandor, más intenso al escribir (como el
  chat de Claude Code).
- Exhaustiva (pedido 2026-11-12):
  - Busca en español, inglés y chino + hasta 2 idiomas que el modelo elija según el tema; consultas
    traducidas con la terminología de cada idioma. Si el pedido limita idiomas o países, se respeta.
    Notas e informe en el idioma del pedido.
  - Hasta ~100 búsquedas: 25 iniciales repartidas entre idiomas + hasta 9 rondas de 8; 8
    resultados por búsqueda; tope 300 fuentes. Si 15 fuentes seguidas no aportan al tema, deja de
    buscar y redacta (las que no se pudieron leer no cuentan); avisa en el progreso.
  - Informe por secciones: índice (con resumen corto de cada fuente) → cada sección con las notas
    de sus fuentes → resumen y conclusiones. Normal y Profunda siguen con informe en una respuesta.
- Tarjeta en el portafolio: Principales, badge «En desarrollo», enlace a la página de Pages.
  `ESTADO.md` del portafolio quedó borrado a propósito: no restaurarlo.

## Hecho (2026-11-11)

- App completa con historial, segundo plano, profundidades, plantilla, PDF, rotación de modelos.
- Claves de Tavily, OpenRouter y NVIDIA en `.env` (permisos 600, fuera de git).
- Prueba real a profundidad normal con NVIDIA (antes del segundo plano): 20 fuentes, ~7,7 min,
  respetó Excluir y Entrega.
- Recorrido en navegador con simulación: investigar, recargar a mitad, reabrir desde el
  historial, terminar, detener, borrar; escritorio y celular sin errores.
- 2026-11-12: Neon conectado (`DATABASE_URL` en `.env`; base `neondb`, región us-east-1, Postgres
  18). Almacén probado contra Neon: guardar, actualizar, listar, interrumpidas, borrar por dueño.
  `conectarPostgres` pasa `sslmode=require` a `verify-full` (evita el aviso de `pg`) y activa
  channel binding si la cadena lo pide: la cadena de Neon se pega tal cual.
- 2026-11-12: prueba real Profunda con Neon: 15,3 min, 23 búsquedas, 37 fuentes leídas y 18
  descartadas, sin esperas ni errores; informe de 18.700 caracteres con tabla, recomendación y
  fuentes. Tras reiniciar el servidor: sigue en el historial, mismo texto y mismo PDF.
- 2026-11-12: PDF arreglado: `aptoParaPDF` borraba los saltos de línea (Roboto no tiene glifo
  para "\n") y todo el informe salía como un solo título; tablas de 5+ columnas se salían de la
  hoja (ancho "auto", letra y relleno más chicos, citas pegadas separadas). Verificado con el
  informe real: ninguna palabra fuera del margen.
- 2026-11-12: panel lateral, borde con luz y Exhaustiva (idiomas, 300 fuentes, corte por
  irrelevantes, informe por secciones). Recorridos en navegador con simulación (escritorio,
  celular, cajón, foco, Escape, Exhaustiva completa) sin errores. 30 pruebas automáticas pasan.
- 2026-11-12: página para GitHub Pages (token, CORS, workflow, aviso «Despertando el servidor»
  con reintento de lecturas, PDF descargado con el token). Probado en navegador desde otro
  origen: entrar, investigar, PDF con nombre, recargar sin perder sesión, servidor caído y
  vuelta, salir; sin errores. Tarjeta agregada al portafolio (+ arreglo del badge cortado en
  celular, solo ≤480 px).

## En curso

- Esperando que Franco haga push del investigador (PDF, panel, borde, Exhaustiva) y del
  portafolio, con Pages activado (Settings → Pages → Source: GitHub Actions).

## Pendiente

1. Franco: activar Pages en el repo (si falta); push del investigador y del portafolio.
2. Comprobar que Render tomó `ORIGENES_PERMITIDOS` (Environment) y que el workflow publicó.
3. Verificar desde https://franco944796.github.io/investigador/: entrar, investigación larga sin
   que Render se duerma, reconexión, PDF, despertar tras 15 min, bloqueo por IP
   (`CONFIAR_EN_PROXY`), DuckDuckGo desde el servidor.
4. Una Exhaustiva real (~100 búsquedas de Tavily, horas): idiomas elegidos, calidad de las
   consultas traducidas, lectura de sitios en chino, informe por secciones y su PDF.
5. Último paso: revisión completa del proyecto con el modelo Fable 5.2 (subagente) para ver qué
   se puede mejorar.

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
  Con `ORIGENES_PERMITIDOS=http://127.0.0.1:8090` y `npm run pagina -- <carpeta>/investigador
  http://127.0.0.1:3211` servida en el 8090 se prueba la copia de Pages.
- `src/vendor.js`: librerías de la página (las usan el servidor y `scripts/pagina.js`).

## Problemas conocidos y sin verificar

- Sin verificar: todo el comportamiento en Render; una Exhaustiva real (calidad de las consultas
  en otros idiomas, sitios chinos que bloqueen la lectura, largo de cada sección).
- Exhaustiva: el informe se muestra entero al terminar (el resumen va arriba pero se escribe
  último); durante la redacción el progreso dice «sección k de N».
- Preguntas de seguimiento: el modelo recibe hasta 90.000 caracteres de informe + notas; en una
  Exhaustiva larga no ve todo.
- DuckDuckGo (respaldo) no usa región por idioma.
- Si Render reinicia el servicio en medio de una investigación, queda "interrumpida" (no se
  retoma; hay que empezarla de nuevo).
- Créditos gratuitos de NVIDIA: no se sabe si se agotan.
- OpenRouter gratis: 50 pedidos/día; es el último respaldo.
- Los modelos gratuitos a veces citan una fuente que no corresponde.
- El token en localStorage de franco944796.github.io lo pueden leer las otras páginas de ese
  sitio (todas propias). La CSP de la copia de Pages limita a dónde se pueden mandar datos.
- Sin verificar: cómo responde Render a un pedido entre sitios mientras despierta (la página
  reintenta las lecturas por hasta 2 min; los POST no se reintentan).
- DuckDuckGo suele bloquear pedidos desde servidores.
- Local y Render comparten la base de Neon: al arrancar, cada servidor marca como "interrumpida"
  lo que figure en curso, aunque lo esté corriendo el otro (se corrige en su próximo guardado).
