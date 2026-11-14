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
- Un solo tipo de investigación: exhaustiva (2026-11-12; para búsquedas comunes está Google u
  otro chat). Las guardadas antes como Normal/Profunda siguen en el historial con su rótulo.
  Con ~100 búsquedas cada una, Tavily gratis (1.000/mes) alcanza para ~10 por mes entre todos.
- Modelos (orden): NVIDIA Nemotron 3 Ultra → Mistral Large 4 → GPT-OSS 20B (~2,5 min) → GLM 5.3
  Flash (~5 min) → OpenRouter Nemotron 3 Ultra `:free`. Límite por pedido 30 min. Kimi K2.6 (404
  para la cuenta) y DeepSeek V4.1 Flash (error 500 / sin respuesta) no sirven.
- Solo claves API de planes gratuitos oficiales.
- Búsqueda: Tavily (trae el texto de cada página) + DuckDuckGo de respaldo.
- Pedidos: guía con plantilla Pregunta / Contexto / Aspectos / Excluir / Entrega / Fuentes.
- Diseño: tema oscuro; adaptado a celular. PDF como única descarga.
- Acceso: código por persona. Sin límite para nadie (LIMITE_DIARIO=0, decisión de Franco); el
  mecanismo de límite diario por código sigue (se reinicia con el servidor).
- Preguntas de seguimiento: hasta 8 búsquedas y 24 fuentes nuevas por pregunta.
- Sitios sugeridos (pedido 2026-11-12): se indican en el campo Fuentes (dominios o nombres; el
  modelo traduce nombres a dominios). La mitad de las búsquedas va a esos sitios (Tavily
  `include_domains`) o al buscador académico; si dejan de dar resultados nuevos, o se gasta esa
  mitad, el resto va a toda la web.
- Académico: Google Scholar no tiene API y prohíbe consultas automáticas. Si el pedido nombra
  Scholar, papers o fuentes académicas/científicas, se usa OpenAlex (clave gratis, $1/día;
  cada búsqueda cuesta $0,001; sin clave comparte $0,10/día por IP). Semantic Scholar descartado:
  sin clave dio 429 y la clave es por formulario. OpenAlex no gasta cuota de Tavily.
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
- La investigación (exhaustiva):
  - Busca en español, inglés y chino + hasta 2 idiomas que el modelo elija según el tema; consultas
    traducidas con la terminología de cada idioma. Si el pedido limita idiomas o países, se respeta.
    Notas e informe en el idioma del pedido.
  - Tavily cobra por búsqueda (1 crédito la básica), no por resultado ni por fuente. Máximo 100
    búsquedas (25 iniciales repartidas entre idiomas + rondas de 8 hasta agotarlas), 8 resultados
    por búsqueda, fuentes sin tope (cada una cuesta una llamada al modelo y tiempo). Termina al
    llegar a 100 búsquedas, o antes si el modelo da por cubierto el tema o si 20 fuentes
    seguidas no aportan. Si 20 fuentes seguidas no aportan al tema, deja de
    buscar y redacta (las que no se pudieron leer no cuentan); avisa en el progreso.
  - Informe por secciones: índice (con resumen corto de cada fuente; hasta 30 secciones) → cada
    sección con las notas de sus fuentes → resumen y conclusiones.
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

- Exhaustiva de prueba (id 33d45e5e…, energía solar) terminada: 8 h 12 min, 100 búsquedas (web
  53, papers 21, sitios 13, libros 13), 348 fuentes leídas, 13 secciones, PDF de 43 páginas, 31
  gráficos sin JSON roto (14 barras, 9 líneas, 5 líneas de tiempo, 1 mapa, 1 diagrama, 1
  imagen). Ya se puede hacer push.
- Revisión con Fable 5.2 (2026-11-12/13) sobre el código y esa prueba. Mejoras hechas (sin
  push), con 60 pruebas automáticas pasando:
  1. Pasajes relevantes (`src/pasajes.js`): de cada página se analizan hasta 9.000 caracteres
     elegidos por la búsqueda que la trajo y el tema (antes, los primeros 7.000). En un informe
     real de IRENA de 474.000 caracteres: menciones de LCOE de 1 a 15, cifras con unidad de 4 a 68.
  2. Destino por consulta: el modelo marca "destino" (academico/libros/sitios); `site:x` pasa
     a filtro de dominios; un destino inactivo va a la web. Fallo de un buscador → aviso una vez
     + respaldo en la web; con 2 fallos seguidos se deja de dirigir ahí.
  3. Calidad: `DOMINIOS_EXCLUIDOS` (video y redes), corte por puntaje de Tavily al 30 % del
     mejor (al 50 % se perdían eia.gov e iea.org), notas con Fecha/Tipo (`interpretarNotas`),
     fichas y lista de fuentes con tipo y fecha; el informe prioriza oficial/académico/reciente.
  4. Consultas: `parecidas` descarta las casi iguales en el mismo buscador; sin año forzado;
     `"reciente": true` → `time_range: year`; la revisión ve qué rindió cada búsqueda.
  5. Subpreguntas (`aspectos`, 6 a 12, evento «aspectos», nodo en el árbol): cada nota dice
     cuáles responde; la revisión ve la cobertura por subpregunta (ya no 90.000 caracteres de
     notas) y puede sumar hasta 2 nuevas por ronda (máx. 15); el índice las usa de guía.
  6. Papers y libros con búsqueda semántica de OpenAlex (en fila, 1 por segundo; respaldo en la
     común).
  7. Robustez: `completar` continúa las respuestas cortadas por largo (hasta 2 veces);
     guardado en Neon cada 2 min; secciones redactadas de a 3 en paralelo; etapas con hora.
  Además: gráficos de líneas con eje de tiempo ordenado y a escala; el prompt pide no titular
  los gráficos ni dibujar menos de 4 datos. Descartado por ahora: lector de PDF propio.
  Tras la corrida real: el año en curso se quita de las consultas por código y pasa a
  `reciente`; mínimo de secciones proporcional a las fuentes; gráficos con mínimo de 3 datos,
  máximo 2 por sección y sin título duplicado (`depurarGraficos`, `graficoValido`). 62 pruebas.
- Corrida corta real en local (2026-11-13, 7 búsquedas, sin base): 12 subpreguntas, dirigidas a
  papers y a iea.org, las 7 búsquedas con fuentes útiles, 15 de 15 notas con fecha, tipo y
  subpreguntas, informe de 9 secciones que marca las fuentes interesadas. Cada sección tarda
  45–170 s con los modelos gratuitos.

- Sin push: progreso como árbol (pedido 2026-11-12; Franco eligió árbol y que reemplace la
  lista). Raíz = pregunta; cada búsqueda es una burbuja (etiqueta Busca/Papers/Libros/En sitio +
  idioma) que crece con su texto; sus fuentes cuelgan a la derecha (abajo en celular) con punto y
  estado Leyendo/Leída/Omitida (+ motivo) y se abren con clic. Avisos como nota punteada. Líneas
  con bordes CSS (`.arbol`, `.rama`, `.hoja` en `public/estilos.css`). El servidor numera cada
  búsqueda (`consulta.id`) y cada fuente dice la suya (`fuente.consulta`); las investigaciones
  viejas sin esos números agrupan las fuentes en «Fuentes de estas búsquedas». Probado en
  navegador (chino, japonés, coreano, celular, eventos viejos). Ejemplo previo en el scratchpad
  de la sesión (`demo-nodos/demo.html`).

- Orden de trabajo pedido (2026-11-12): 1) «Ver informe» en HTML; 2) libros y bibliotecas;
  3) gráficos, diagramas, mapas e imágenes. Después, push y verificación en Render.
- Libros: se buscan cuando el tema lo amerite (lo decide el modelo al planear: "libros": true) o
  si el pedido nombra libros/bibliotecas/bibliografía. Destino dirigido «libros»: OpenAlex con
  `type:book,has_abstract:true` + Google Books si hay `GOOGLE_BOOKS_CLAVE` (gratis, Google Cloud →
  Books API; sin clave da 429). Open Library descartado (0 de 5 obras con descripción). Si solo
  hay libros, una cuarta parte de las búsquedas; con otros destinos, comparten la mitad.
- Gráficos (cuando haga falta, datos siempre de las fuentes con cita): barras y líneas, línea de
  tiempo, diagramas (cajas y flechas), mapas por país. Se ven en todo: chat, HTML (también el
  descargado) y PDF. Además imágenes de las fuentes (figuras, planos, fotos) con crédito y enlace.
- Sin push: «Ver informe» hecho. `public/informe.html|css|js` (documento claro, índice lateral
  que en celular va arriba plegado, datos de la investigación, citas con vista previa: mouse =
  pasar por encima y clic a la lista; táctil = primer toque muestra), preguntas de seguimiento,
  Descargar HTML (un archivo sin scripts; citas con `title`) y PDF. API
  `GET /api/conversaciones/:id/informe`. `public/comun.js` con lo compartido (sesión, pedidos,
  descargas, Markdown). `scripts/pagina.js` procesa index.html e informe.html. Probado en
  navegador (mouse, táctil, celular, descargas, archivo descargado sin internet).
- Sin push: libros hechos (`crearBuscadorDeLibros`, `deGoogleBooks`, destino rotativo en
  `conDestino`, etiqueta «Libros»). 39 pruebas pasan; búsqueda real: 8 de 8 libros con resumen.
- Sin push: gráficos hechos. Bloques ```grafico con JSON en el Markdown (barras, lineas,
  linea-de-tiempo, diagrama flujo/partes, mapa, imagen), cada dato con "cita". Dibujante único
  `public/graficos.js` (SVG en texto; tema oscuro en el chat, claro en informe y PDF); mapa con
  `public/mapa.json` (174 países, generado con `node scripts/mapa.js` desde world-atlas +
  i18n-iso-countries, dependencias de desarrollo). PDF: nodo `svg` de pdfmake; imágenes bajadas
  con `descargarImagen` (solo PNG/JPEG, 3 MB, sin direcciones internas); si no se puede, aviso +
  enlace. Página: si la imagen no carga, aviso «Imagen no disponible aquí (por derechos de autor
  o porque el sitio no permite mostrarla): verla en …». Tavily `include_images` (1 crédito igual)
  → `figurasDe` (alt descriptivo, sin logos, hasta 3 por fuente) → `fuente.imagenes` → «Imágenes:»
  en las fichas. Las citas de los gráficos cuentan para la lista de fuentes. CSP con
  `img-src https:`. 46 pruebas pasan; revisado en chat, informe HTML y PDF.

- Sin push: sitios sugeridos + OpenAlex hechos (`destinosDe`, reparto mitad/mitad con paso a la
  web, consultas «dirigidas» en plan y revisión, `crearBuscadorAcademico` con filtro
  `has_abstract:true`, etiquetas Papers / En sitio, guía y ejemplo). 36 pruebas pasan; búsqueda
  real a OpenAlex: 8 de 8 con resumen. Falta la clave de OpenAlex de Franco: va en `.env` y en
  Render → Environment (`OPENALEX_CLAVE`; al ser nueva, se agrega a mano en el panel).

- Publicado (commit 1290004): Pages y Render con panel, PDF arreglado y Exhaustiva nueva.
  Verificado en la página real: CORS, entrar, historial desde Neon, PDF (7 págs., sin desbordes).
- Exhaustiva real terminada (id e88e1822…, baterías de estado sólido, versión anterior: sin
  gráficos/libros/sitios): 2 h 17 min, 40 búsquedas (es 18, en 14, zh 6, ko 2), 195 fuentes
  leídas, 60 descartadas, 10 secciones + resumen + conclusiones, 151 fuentes citadas, PDF de 40
  páginas sin desbordes. El modelo dio el tema por cubierto en la ronda 4 (usó 40 de ~97).
  «Ver informe» probado con este informe desde Pages: 14 entradas de índice, 804 citas, 52
  tablas, descargas HTML 305 KB y PDF 1,1 MB.
- Push hecho (8f7d7b9): Render y Pages con árbol, informe HTML, gráficos, libros, sitios.
  Código de acceso nuevo en Render y en `.env` (el valor completo es franco:<código>:0).
- Sin push: arreglos tras la revisión: japonés elegido sin búsquedas → `porTurnos` reparte las
  consultas por idioma al recortar; página con HTML roto rompía Readability → «sin contenido
  legible»; PDF dejaba «(, China)» al quitar chino → `aptoParaPDF` limpia esos restos; índice
  del informe HTML se recalcula con el scroll (también al saltar y al final). Mínimo de 60
  búsquedas antes de aceptar «ya alcanza» (`MIN_BUSQUEDAS`, decisión de Franco); igual corta si
  20 fuentes seguidas no aportan. 48 pruebas pasan.
- Push hecho (fa5c014): Render y Pages con los arreglos y el mínimo de 60 búsquedas.
- Exhaustiva de prueba lanzada en Render el 2026-11-12 a las 14:36 (id 33d45e5e-9687-4960-a7d6-
  af5937e4def3): energía solar fotovoltaica 2010–2026, con Fuentes iea.org, irena.org, Google
  Scholar y libros, y Entrega con gráficos, mapa y línea de tiempo. Sin clave de OpenAlex todavía
  (presupuesto compartido). Franco avisa cuando termina; no hacer push mientras corre. Revisar:
  reparto de búsquedas (sitios/papers/libros/web), gráficos e imágenes en chat, HTML y PDF,
  árbol en vivo, mínimo de 60 búsquedas.
- Bloqueo por intentos NO funcionaba en Render (9 fallos → 401, el código correcto entró): detrás
  de Cloudflare, `req.ip` con CONFIAR_EN_PROXY=1 es el borde de Cloudflare, que cambia. Arreglado
  sin push: `CABECERA_IP=cf-connecting-ip` (render.yaml) y `ipDe()` en `src/app.js`; prueba nueva.
  NO hacer push hasta que termine la Exhaustiva (el redespliegue la cortaría).
- Sin push también: tope de 100 búsquedas y fuentes sin límite; corte en 20 irrelevantes; un
  solo tipo (sin selector; `config.investigacion` es la exhaustiva, con variables de entorno
  para ajustarla); sin límite por persona; seguimiento con 8 búsquedas. 32 pruebas pasan y la
  página se revisó en el navegador. La Exhaustiva que corre usa la configuración anterior.

## Pendiente

1. Franco: push de todo lo de la revisión (sin push desde fa5c014). No hay nada corriendo en
   Render.
2. Franco: clave de OpenAlex (openalex.org → Settings → API key) en `.env` y en Render →
   Environment (`OPENALEX_CLAVE`); opcional `GOOGLE_BOOKS_CLAVE`. Sin clave, papers y libros
   dejaron de responder en Render tras 2 búsquedas.
3. Verificar en Render con una Exhaustiva real: subpreguntas en el árbol, destinos, avisos de
   fallo, fecha y tipo en las fuentes, gráficos depurados, y las horas de cada etapa (la de
   prueba tardó 8 h 12 min sin esperas por cupo: ver dónde se va el tiempo).
4. Prueba del bloqueo por intentos en Render (8 códigos malos; Franco pidió hacerla al final).
5. Despertar de Render tras 15 min sin uso desde la página de Pages.

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
