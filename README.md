# dsh-source-control

Panel de control de código fuente para DeepSeek Harness, al estilo de VS Code, en la barra lateral derecha.

## Funciones

- **Estado de la rama**: rama actual, upstream, commits por delante/detrás.
- **Cambio de rama**: el nombre de la rama en la cabecera abre un selector con las
  **ramas locales** y las **ramas remotas** en grupos separados, con filtro de texto.
  Elegir una remota crea su rama local con seguimiento (`switch -c … --track`), o
  reutiliza la local si ya existe. Las ramas cuyo upstream fue borrado se marcan
  como *borrada*.
- **Pull**: si el remoto tiene commits nuevos, aparece un aviso con el contador y el botón.
- **Push**: si la rama tiene commits sin enviar, aparece el aviso simétrico con el
  contador y el botón (solo cuando hay upstream; sin él manda *Publish Branch*).
- **Publish Branch**: si la rama no existe en el remoto, se ofrece publicarla con `push -u origin HEAD`.
- **Commit**: caja de mensaje, `Commit` y `Commit & Push`. La caja se redimensiona
  arrastrando cualquier punto de su borde inferior (o con ↑/↓ cuando el tirador tiene
  el foco). Si no hay nada preparado, pregunta antes de preparar todo
  (**Sí / Siempre / Nunca / Cancelar**), como VS Code, y recuerda la respuesta en
  `localStorage`; *Nunca* deja un enlace para volver a preguntar. El botón **✨ IA**
  redacta el mensaje a partir del diff (ver
  [Mensaje de commit con IA](#mensaje-de-commit-con-ia)).
- **Archivos modificados**: staged / changes / untracked, con preparar y quitar del índice.
- **Descartar cambios**: `↺` por archivo y `↺ Descartar todos los cambios` para el
  working tree completo. Ambos piden confirmación dentro del panel antes de tocar
  nada; si se descarta, se revierte índice y worktree a `HEAD` y se eliminan los
  archivos sin rastrear (los ignorados se respetan).
- **Historial**: últimos 30 commits con sha corto, asunto, autor y fecha relativa.
  La sección es colapsable y arranca **colapsada**: se expande con el encabezado.

La pestaña aparece en la lista de la barra lateral derecha y se abre desde ahí.

## Seguridad

El servidor web del harness no aplica autenticación ni política de origen por su
cuenta: cada plugin que registra rutas pone la suya. Estas rutas mueven un
repositorio, así que rechazan todo lo que un navegador pueda mandar desde otro
origen:

- el `Host` tiene que ser de loopback (`127.0.0.1`, `localhost`, `[::1]`), lo que
  también corta el *DNS rebinding*;
- si llega `Origin`, tiene que venir del mismo host y puerto que el `Host`
  (el esquema se ignora: la frontera es el servidor que responde, y así una
  ventana que sirva la misma UI con otro esquema no se rompe);
- `Sec-Fetch-Site`, cuando viene, solo puede ser `same-origin` o `none`;
- el `POST` de acciones exige `Content-Type: application/json`, que una página
  ajena no puede enviar sin un *preflight* que este servidor nunca aprueba.

`git` se ejecuta con `execFile` y argumentos en array (nunca un shell), con
`GIT_TERMINAL_PROMPT=0`, y los errores se redactan (`https://[credentials]@`).
Los descartes piden confirmación en el panel.

Límites conocidos y deliberados:

- Las rutas solo responden en loopback. Si publicas el servidor web en la LAN, el
  panel no funcionará desde otro equipo; es preferible a que cualquiera en la red
  pueda hacer `discardAll`.
- No hay token propio: un proceso local puede llamar a las rutas igual que el
  panel. El navegador es la frontera que se cierra; un token de sesión exigiría
  un servicio del host que hoy no se expone a las rutas.
- `root` se valida como ruta absoluta y existente, no contra el workspace de la
  sesión: la capa de rutas no recibe contexto de sesión.

## Pendiente

- Visor de diff por archivo.

## Mensaje de commit con IA

El botón **✨ IA** pide al host que redacte el mensaje desde el diff y lo deja en la
caja para editar; no commitea nada por su cuenta. El modelo se llama con
`ctx.llm.stream()` — el servicio neutral del harness —, nunca contra un adaptador.

La ruta del modelo es, por orden:

1. **la del chat**, leída del proyector `modelSelection` de la sesión en el cliente
   (`next` si acabas de cambiar de modelo, si no `lastUsed`). Así redacta con el
   mismo proveedor y modelo que estás usando;
2. la config del plugin (`provider` y `model`);
3. el primer modelo que anuncie algún proveedor montado, saltando los que tienen el
   catálogo vacío: las rutas de cuenta no listan nada hasta configurarse, pero una
   sesión las usa sin problema.

Lo que recibe el modelo: rama, lista de archivos por estado, el diff preparado (o el
del working tree si no hay nada preparado) recortado a `maxDiffChars`, y los últimos
ocho asuntos de commit para imitar tono e idioma. El resultado se normaliza: sin
cercas de código, sin prefijo `Commit:` y sin comillas envolventes.

Configuración opcional, en la entrada del plugin dentro del patch del perfil:

```yaml
- id: source-control
  name: dsh-source-control
  config:
    provider: deepseek-account    # opcional: normalmente lo aporta la sesión
    model: deepseek-flash         # opcional: normalmente lo aporta la sesión
    maxDiffChars: 12000           # 1 000–60 000
    language: es                  # vacío: sigue el idioma del historial
```

Detalles del contrato:

- Sin proveedor montado, o sin ninguno que anuncie un modelo cuando no hay ruta de
  sesión, la ruta responde `503` y el panel lo muestra en su línea de error; el resto
  del panel sigue funcionando.
- La llamada termina a los 30 s (`504` si el modelo no cerró el stream).
- Es una llamada auxiliar y deliberadamente **no** queda en el log de la sesión: el
  texto lo edita y firma la persona, igual que las llamadas de auto-review.
- El diff es entrada del modelo, así que trata el contenido del repositorio como
  datos: se envía al proveedor configurado en el perfil.

## Instalación de desarrollo

```sh
pnpm install
pnpm run build
dsh plugin --profile desktop add .
```

El plugin se enlaza con `link:`, así que los cambios en `lib/` y `client/` se aplican al reiniciar la app.

`pnpm test` compila y ejecuta la suite de `tests/`: parseo de porcelain v2 con
fixtures, la política de las rutas, acciones reales contra repositorios temporales
(stage, commit, discard, checkout, nombres con Unicode y con globs) y el contrato del
mensaje con IA contra un servicio de modelo simulado (rutas, chunks y finales de
error).

## Arquitectura

Dos mitades, cada una con su contrato real de DSH:

- **Host** (`src/host/`): plugin Cordis que registra tres rutas JSON en `ctx.webServer`
  (`/dsh-source-control/state`, `/action` y `/message`) y ejecuta `git` con
  `execFile`, sin shell. Lee `status --porcelain=v2 --branch -z`: con NUL los nombres
  llegan sin comillas ni escapes, así que `año.txt` es `año.txt` y no
  `"a\303\261o.txt"`. Un `git log` acotado y `for-each-ref` completan el estado. Las
  rutas de archivo viajan como `:(literal)…`, para que un nombre con `*`, `?` o `[`
  no se lea como glob. La acción `checkout` valida el nombre de rama antes de llamar
  a `git switch`.
- **Cliente** (`client/index.js`): módulo cargado por el web module loader mediante
  `window.__ModuleLoader__.load({ id, factory })`. Solo `react` es alcanzable por
  `require`. Registra el tipo de pestaña en `sidebarRightTabs` con una entrada `guide`
  (sin ella la pestaña existe pero no se lista) y monta el cuerpo en
  `sidebar.right.pane.tab`.

```js
ctx.inject(['sidebarRightTabs'], (owner) => {
  const tabs = owner.get('sidebarRightTabs')
  owner.effect(() => tabs.register({
    id: 'dsh-source-control',
    kind: 'source-control',
    priority: 'extension',
    title: () => 'Source Control',
    guide: [{ id: 'source-control', order: 90, title: () => 'Source Control' }],
  }), 'dsh-source-control: tab type')
  owner.slots.inject('sidebar.right.pane.tab', () => owner.slots.register({
    name: 'sidebar.right.pane.tab',
    key: 'dsh-source-control',
  }, Panel))
})
```

Ese `inject` estático debe contener solo servicios reales: una dependencia que nunca
resuelve deja el plugin aparcado y `apply` jamás corre.
