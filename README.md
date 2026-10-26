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
- **Publish Branch**: si la rama no existe en el remoto, se ofrece publicarla con `push -u origin HEAD`.
- **Commit**: caja de mensaje, `Commit` y `Commit & Push`.
- **Archivos modificados**: staged / changes / untracked, con preparar y quitar del índice.
- **Descartar cambios**: `↺` por archivo y `↺ Descartar todos los cambios` para el
  working tree completo. Ambos piden confirmación dentro del panel antes de tocar
  nada; si se descarta, se revierte índice y worktree a `HEAD` y se eliminan los
  archivos sin rastrear (los ignorados se respetan).
- **Historial**: últimos 30 commits con sha corto, asunto, autor y fecha relativa.
  La sección es colapsable y arranca **colapsada**: se expande con el encabezado.

La pestaña aparece en la lista de la barra lateral derecha y se abre desde ahí.

## Pendiente

- Mensaje de commit generado con IA.
- Visor de diff por archivo.

## Instalación de desarrollo

```sh
pnpm install
pnpm run build
dsh plugin --profile desktop add .
```

El plugin se enlaza con `link:`, así que los cambios en `lib/` y `client/` se aplican al reiniciar la app.

## Arquitectura

Dos mitades, cada una con su contrato real de DSH:

- **Host** (`src/host/`): plugin Cordis que registra dos rutas JSON en `ctx.webServer`
  (`/dsh-source-control/state` y `/dsh-source-control/action`) y ejecuta `git` con
  `execFile`, sin shell. Parsea `status --porcelain=v2 --branch`, un `git log` acotado
  y `for-each-ref` para listar ramas locales y remotas. La acción `checkout` valida el
  nombre de rama antes de llamar a `git switch`.
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
