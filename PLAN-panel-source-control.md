# Plan — Panel Source Control para DeepSeek Harness

**Estado:** borrador para revisión · **Fecha:** 2026-10-26 · **Host objetivo:** DSH `0.2.1-rc.3`
**Nombre propuesto:** `dsh-source-control` (id de plugin: `source-control`)

---

## 1. Objetivo

Un panel de control de código fuente dentro de DSH, en la barra lateral derecha, con la ergonomía de VS Code pero acotado a cinco tareas. No es un cliente GitHub: no habla con la API, no pide tokens y no reemplaza a `git`.

| # | Función | Comportamiento esperado |
|---|---|---|
| 1 | Cambios en el remoto | Tras un `fetch`, si la rama está *behind*, mostrar banner con contador y botón **Pull** |
| 2 | Rama sin publicar | Si la rama no tiene upstream, banner con **Publish Branch** (`git push -u origin HEAD`) |
| 3 | Commit con IA | Input de mensaje + botón ✨ que genera asunto y cuerpo desde el diff; botón Commit y Commit & Push |
| 4 | Archivos modificados | Lista staged/unstaged/untracked con badge de estado, stage/unstage por archivo y diff al hacer clic |
| 5 | Historial | Commits recientes (sha corto, asunto, autor, fecha relativa, refs), paginado |

### No objetivos (v1)

PRs, issues, Actions, merge/rebase interactivo, tags, stashes, multi-repositorio, force push, edición de archivos. Todo eso queda fuera para que la v1 sea pequeña y confiable.

---

## 2. Decisiones tomadas

- **UI:** barra lateral derecha, como pestaña propia (`sidebar.right.pane.tab` + `.title`), abierta con `ctx.layout.openRightbar(...)` y el registro de tipos de pestaña (`tabs.register` / `openTab(kind)`).
- **Autenticación:** **ninguna**. Las operaciones usan el `git` del usuario y su credential helper/SSH. Esto elimina el manejo de PAT, el riesgo de filtrar tokens y la lógica de OAuth. Si algún día se agrega API de GitHub, ahí sí entra PAT vía `ctx.credentials`.
- **Sin herramientas de agente en v1.** El panel lo opera la persona; el agente no recibe tools de git. Así no hace falta el seam de aprobación y se evita que un turno del modelo haga `push` por su cuenta.
- **Escrituras peligrosas** (descartar cambios, forzar algo) piden confirmación explícita en la UI.

---

## 3. UX del panel

```
┌──────────────────────────────────────┐
│  main → origin/main        ↑1 ↓3  ⟳  │   rama, upstream, ahead/behind, refresh
├──────────────────────────────────────┤
│  ⚠ 3 commits nuevos en origin/main   │   banner Pull (si behind > 0)
│  [ Pull ]                            │
│  ⚠ La rama no existe en el remoto     │   banner Publish (si no upstream)
│  [ Publish Branch ]                  │
├──────────────────────────────────────┤
│  Mensaje de commit…            ✨     │   textarea + generar con IA
│  [ Commit ]  [ Commit & Push ▾ ]      │
├──────────────────────────────────────┤
│  STAGED (2)                      + − │
│   M  src/panel.tsx                    │
│   A  src/git/status.ts                │
│  CHANGES (4)                     + − │
│   M  README.md                        │
│   D  docs/old.md                      │
│   ?  scratch.txt                      │
├──────────────────────────────────────┤
│  HISTORIAL                            │
│  a1b2c3d  fix: parse porcelain v2  2h │
│  9f8e7d6  feat: panel shell        1d │
└──────────────────────────────────────┘
```

Estados: vacío ("sin cambios"), carga, error de git, repo inexistente, merge en curso (solo aviso, sin resolver).

---

## 4. Arquitectura

```
┌──────────────── cliente (React, web) ────────────────┐
│  Tab "Source Control"                                │
│   ├─ useSourceControl()  → polling + estado          │
│   └─ acciones → remote sourceControl.<method>()      │
└───────────────────────┬──────────────────────────────┘
                        │ Typert Remote (JSON estricto)
┌───────────────────────▼──────────────────────────────┐
│  host (Cordis)                                       │
│   ├─ GitExecutor   (execFile, sin shell)             │
│   ├─ StatusParser  (porcelain v2 --branch)           │
│   ├─ LogParser                                       │
│   └─ CommitMessage (ctx.llm, opcional)               │
└──────────────────────────────────────────────────────┘
```

- **Host:** plugin Cordis con `inject: ['typert', 'llm']` (llm opcional: si falta, el botón ✨ se deshabilita y se explica por qué).
- **Cliente:** plugin de UI que registra la pestaña y consume el namespace remoto.
- **Transporte:** contribución Typert con codecs `strict` **y fábrica `create: () => schema` en cada codec**. Esto no es opcional: en 0.2.x el registro lanza `strict codec has no create() factory` y el namespace nunca monta. Es exactamente el fallo que sufrimos con el plugin de PivotStack.
- **Refresco:** al abrir, al recuperar foco y cada 3 s mientras la pestaña está visible; se pausa al ocultarla. `fetch` automático cada 60 s es configurable y viene apagado por defecto.

---

## 5. Modelo de datos

```ts
type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unmerged' | 'untracked'

interface FileChange { path: string; origPath?: string; status: FileStatus; staged: boolean }

interface GitStatus {
  root: string
  branch: string | null          // null = detached HEAD
  upstream: string | null        // null = rama sin publicar
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  mergeState: 'none' | 'merging' | 'rebasing' | 'cherry-picking'
  operationInProgress: boolean   // bloquea pull/commit
}

interface GitLogEntry { sha: string; shortSha: string; subject: string; author: string; date: string; refs: string[] }

interface GitDiff { path: string; staged: boolean; text: string; truncated: boolean }
```

---

## 6. Superficie remota (métodos)

| Método | Git por debajo | Escribe |
|---|---|---|
| `getStatus(root)` | `git status --porcelain=v2 --branch` | no |
| `getDiff(root, path, staged)` | `git diff --cached --` / `git diff --` | no |
| `stage(root, path)` / `unstage(root, path)` | `git add --` / `git restore --staged --` | índice |
| `discard(root, path)` | `git restore --` / `git clean -f --` (untracked) | sí, destructivo |
| `commit(root, message, amend)` | `git commit -m` | sí |
| `push(root)` | `git push` | sí |
| `pull(root)` | `git pull --ff-only` | sí |
| `publishBranch(root)` | `git push -u origin HEAD` | sí |
| `log(root, limit, cursor)` | `git log --pretty=format:…` | no |
| `generateCommitMessage(root)` | `ctx.llm` sobre el diff staged | no |

Reglas transversales: `root` se valida contra el workspace de la sesión; los argumentos van como array (nunca string de shell); la salida se redacta (`https://[credentials]@`); cada método respeta `AbortSignal` y devuelve errores tipados (`not-a-repo`, `no-upstream`, `dirty-index`, `auth-failed`, `conflict`).

---

## 7. Detección de estado remoto

1. `git fetch --prune` (silencioso, con timeout de 10 s; si falla por red, se muestra aviso y no se bloquea el panel).
2. `porcelain=v2 --branch` entrega `# branch.upstream` y `# branch.ab +A -B`.
3. **Behind > 0** → banner Pull. **Sin upstream** → banner Publish. **Ahead > 0** → badge `↑n` en el header y `Commit & Push` como acción sugerida.
4. Pull es `--ff-only` por defecto: si no es posible, se explica y se ofrece abrir la terminal, sin inventar merges automáticos.

---

## 8. Mensaje de commit con IA

- Entrada: diff staged (si no hay staged, diff de working tree) recortado a ~12 000 caracteres, más la lista de archivos y la rama.
- Salida esperada: `subject` (≤72 caracteres, imperativo) + `body` opcional. Se parsea y se rellena el textarea, editable.
- Proveedor: `ctx.llm` (servicio neutral del host). Config: `provider`/`model` opcionales; si se omiten, se usa el modelo por defecto del perfil.
- Prompt del sistema corto y fijo; temperatura baja; timeout de 20 s con cancelación.
- **Riesgo a validar en el spike:** si `ctx.llm` exige que toda entrada sea reconstruible desde el log de sesión, una llamada lateral podría ensuciar la sesión. Plan B: generar el mensaje con un `subagent` de un solo turno, o con una tool invocada por el agente.

---

## 9. Seguridad

- Sin tokens propios: `git` usa el credential helper del usuario.
- `execFile` con array de argumentos, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`; nada de `shell: true`.
- Validación de rutas: `realpath` dentro del workspace, sin `..`; se rechazan rutas absolutas externas.
- Redacción de credenciales y de URLs con userinfo en cualquier salida mostrada o registrada.
- Límites: 200 archivos, 200 KB por diff, 4 KB por salida de comando registrada.
- Destructivos (discard, clean) con confirmación en línea y sin atajo de teclado.
- Sin `force push`, sin `reset --hard`, sin `checkout -- .` en v1.

---

## 10. Hitos

| Hito | Contenido | Criterio de salida | Estimación |
|---|---|---|---|
| **M0 — Spike** | Scaffold del repo, host que monta, pestaña vacía en la barra derecha, namespace remoto con un método `ping` y codecs con `create` | La pestaña abre en `desktop` y `ping` responde desde el cliente | 0.5–1 d |
| **M1 — Lectura** | Parser porcelain v2 + log, UI de archivos, header con ahead/behind, historial, polling | Panel usable en un repo real sin escribir nada | 1–2 d |
| **M2 — Escrituras** | stage/unstage/discard, commit, commit & push, push, pull ff-only, publish | Flujo completo commit→push y pull desde el panel | 1–2 d |
| **M3 — IA** | `generateCommitMessage` con `ctx.llm`, estados de carga/error, ajuste de prompt | Botón ✨ produce mensajes utilizables en 3 repos distintos | 0.5–1 d |
| **M4 — Pulido** | i18n es/en, estados vacíos, ajustes (auto-fetch, modelo), tests, README | Instalable con `dsh plugin add` y sin warnings | 1 d |

Total: **4–6 días** de trabajo efectivo, con M0 como compuerta: si el registro de pestaña o `ctx.llm` no se comportan como esperamos, se replantea antes de invertir en M1–M3.

---

## 11. Estructura del repo

```
dsh-source-control/
├─ package.json            # dsh.bundle.patch + dsh.client (platform: web)
├─ cordis.patch.yml        # inserta la fila del plugin host
├─ src/
│  ├─ host/
│  │  ├─ index.ts          # plugin Cordis, inject ['typert','llm']
│  │  ├─ git.ts            # executor + redacción
│  │  ├─ status.ts         # parser porcelain v2
│  │  ├─ log.ts
│  │  ├─ commit-message.ts # ctx.llm
│  │  └─ remote.ts         # manifiesto Typert (codecs con create)
│  ├─ client/
│  │  ├─ index.tsx         # registra pestaña + mount del namespace
│  │  ├─ panel.tsx         # header, banners, lista, commit box, historial
│  │  ├─ diff.tsx
│  │  └─ locales.ts
│  └─ contract.ts          # descriptores compartidos host/cliente
├─ tests/                  # fixtures de porcelain, repos temporales
└─ docs/
```

Build: TypeScript + esbuild (el mismo camino que ya validamos en esta máquina). Sin dependencias de runtime salvo `zod`/schemastery para el schema de config.

---

## 12. Pruebas

- **Unitarias:** parser de porcelain v2 con fixtures (staged, untracked, rename, conflicto, detached HEAD, sin upstream); parser de log; redacción de credenciales.
- **Integración:** repos temporales creados en el test (init, commit, remoto bare local) para stage/commit/push/pull/publish.
- **E2E manual:** instalar con `link:` en el perfil `desktop`, abrir la pestaña, ejecutar los cinco flujos.
- **Compatibilidad:** fijar `engines.dsh` a `>=0.2.1-rc.2 <0.3.0` y añadir un test que arranque el host y verifique que el namespace monta (el fallo que nos costó dos reinicios).

---

## 13. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| API de pestañas poco documentada | Alto | Spike M0 antes de escribir UI |
| `ctx.llm` exige log de sesión | Medio | Plan B: subagent de un turno o tool |
| Drift de versión del host | Alto | Pinear peers, codecs con `create`, test de montaje |
| Diff grande o binario | Medio | Presupuesto de 200 KB, marcar binarios, truncar |
| Git del usuario con config exótica (hooks, firmas) | Medio | Respetar config, no pasar `--no-verify`, informar fallos |
| Ramas con nombre raro / unicode | Bajo | Parseo por líneas NUL de porcelain v2 |

---

## 14. Preguntas abiertas

1. ¿Nombre `dsh-source-control` o prefieres otro (por ejemplo `dsh-git-panel`)?
2. ¿UI en español, inglés o ambos?
3. ¿Pull solo fast-forward o permitir merge cuando no sea FF?
4. ¿Un repositorio (workspace actual) o quieres ver varios a la vez?
5. ¿El mensaje de IA en español por defecto, o en el idioma del historial del repo?
