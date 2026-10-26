/**
 * dsh-source-control — client half (right-sidebar tab).
 *
 * Loaded by the DSH web module loader, not by Node: the loader calls
 * `factory(require)` and only `react` is reachable that way. Every service
 * arrives on the `ctx` that `apply` receives.
 *
 * The panel talks to the host through two same-origin JSON routes. It polls the
 * state route while visible and posts one action per user gesture.
 */
window.__ModuleLoader__.load({
  id: 'dsh-source-control',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const TAB_ID = 'dsh-source-control'
    const TAB_KIND = 'source-control'
    const STATE_ROUTE = '/dsh-source-control/state'
    const ACTION_ROUTE = '/dsh-source-control/action'
    const MESSAGE_ROUTE = '/dsh-source-control/message'
    const POLL_MS = 3000
    // The message box resizes from its whole bottom edge, not the native corner grip.
    const DRAFT_MIN_HEIGHT = 54
    const DRAFT_MAX_HEIGHT = 320

    /** The plugin context, captured in `apply` so the panel can reach services. */
    let pluginCtx = null

    const S = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12, lineHeight: 1.45 },
      header: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid rgba(127,127,127,.22)' },
      branchBtn: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '68%', padding: 0, background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit' },
      branchName: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      caret: { flex: 'none', opacity: 0.6, fontSize: 9 },
      counts: { marginLeft: 'auto', display: 'flex', gap: 6, opacity: 0.75, fontSize: 11 },
      iconBtn: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.7, fontSize: 13 },
      banner: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid rgba(127,127,127,.18)', background: 'rgba(210,160,40,.12)' },
      bannerText: { flex: 1, minWidth: 0 },
      primary: { cursor: 'pointer', border: '1px solid rgba(127,127,127,.4)', background: 'rgba(80,140,255,.18)', color: 'inherit', borderRadius: 5, padding: '2px 9px', fontSize: 11, fontWeight: 600 },
      body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 10 },
      textarea: { width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 54, maxHeight: 140, background: 'rgba(127,127,127,.08)', color: 'inherit', border: '1px solid rgba(127,127,127,.28)', borderRadius: 6, padding: '6px 8px', font: 'inherit' },
      row: { display: 'flex', alignItems: 'center', gap: 6, padding: '1px 4px', margin: '0 -4px', borderRadius: 4, transition: 'background-color 120ms ease' },
      rowHover: { background: 'rgba(127,127,127,.14)' },
      sectionTitle: { display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.65 },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', margin: '2px 0', padding: 0, background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left', font: 'inherit', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.8 },
      chevron: { flex: 'none', width: 8, opacity: 0.7, fontSize: 8 },
      letter: { width: 12, textAlign: 'center', fontWeight: 700, fontSize: 10 },
      path: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      mini: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.6, fontSize: 12, padding: '0 3px', transition: 'opacity 120ms ease' },
      muted: { opacity: 0.6 },
      err: { color: '#e07070', padding: '6px 10px', fontSize: 11, whiteSpace: 'pre-wrap' },
      item: { padding: '3px 4px', margin: '0 -4px', borderRadius: 4, borderBottom: '1px solid rgba(127,127,127,.1)', transition: 'background-color 120ms ease' },
      sha: { fontFamily: 'ui-monospace, monospace', opacity: 0.75, marginRight: 6, fontSize: 11 },
      picker: { display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: 300, background: 'rgba(127,127,127,.06)', borderBottom: '1px solid rgba(127,127,127,.22)' },
      pickerHead: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' },
      filter: { flex: 1, minWidth: 0, background: 'rgba(127,127,127,.08)', color: 'inherit', border: '1px solid rgba(127,127,127,.28)', borderRadius: 5, padding: '3px 6px', font: 'inherit' },
      pickerList: { overflowY: 'auto', padding: '0 8px 8px', display: 'flex', flexDirection: 'column' },
      branchRow: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '2px 4px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit', textAlign: 'left', borderRadius: 4 },
      branchRowCurrent: { background: 'rgba(80,140,255,.16)' },
      check: { flex: 'none', width: 10, fontSize: 10, opacity: 0.85 },
      count: { flex: 'none', fontSize: 10, opacity: 0.7, whiteSpace: 'nowrap' },
      badge: { flex: 'none', fontSize: 9, padding: '0 4px', borderRadius: 3, background: 'rgba(224,112,112,.18)', color: '#e07070', whiteSpace: 'nowrap' },
      confirmRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 2px', borderRadius: 4, background: 'rgba(224,112,112,.10)' },
      confirmText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      confirmBox: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 6, background: 'rgba(224,112,112,.10)', border: '1px solid rgba(224,112,112,.35)', fontSize: 11 },
      danger: { cursor: 'pointer', border: '1px solid rgba(224,112,112,.5)', background: 'rgba(224,112,112,.18)', color: '#e07070', borderRadius: 5, padding: '1px 8px', fontSize: 11, fontWeight: 600 },
      dangerText: { background: 'transparent', border: 'none', color: '#e07070', cursor: 'pointer', font: 'inherit', fontSize: 11, padding: 0, opacity: 0.9 },
    }

    const LETTER = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'C', U: 'U', T: 'T' }

    function relative(iso) {
      const then = Date.parse(iso)
      if (Number.isNaN(then)) return ''
      const minutes = Math.round((Date.now() - then) / 60000)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h`
      const days = Math.round(hours / 24)
      if (days < 30) return `${days}d`
      return new Date(then).toLocaleDateString()
    }

    /** Workspace path of the current session, from the session standard kit. */
    function useCwd(props) {
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : null
      const snapshot = useSessions ? useSessions((state) => state) : undefined
      if (!snapshot || !snapshot.byId || !props.sessionId) return undefined
      const summary = snapshot.byId[props.sessionId]
      return summary ? summary.cwd : undefined
    }

    async function readJson(response) {
      let body = null
      try { body = await response.json() } catch { body = null }
      if (!response.ok || (body && body.ok === false)) {
        const message = body && body.error ? body.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body
    }

    async function getState(root) {
      return readJson(await fetch(`${STATE_ROUTE}?root=${encodeURIComponent(root)}&limit=30`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      }))
    }

    async function postAction(root, action, extra) {
      return readJson(await fetch(ACTION_ROUTE, {
        method: 'POST',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ root, action, ...extra }),
      }))
    }

    /** Draft a commit message from the diff; the host owns the model call. */
    async function draftMessage(root, route) {
      return readJson(await fetch(MESSAGE_ROUTE, {
        method: 'POST',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ root, ...(route || {}) }),
      }))
    }

    /**
     * The provider/model the composer is set to, read from the session's
     * `modelSelection` projection (`next` is a choice not yet sent).
     *
     * Returns null when the session or the projection is unreachable, so the host
     * falls back to its own configuration instead of failing the call.
     */
    function currentRoute(ctx, sessionId) {
      try {
        if (!ctx || !sessionId || typeof ctx.get !== 'function') return null
        const sessions = ctx.get('sessions')
        if (!sessions || typeof sessions.binding !== 'function') return null
        const binding = sessions.binding(sessionId)
        const projections = binding && binding.session && binding.session.projections
        if (!projections) return null
        const value = typeof projections.get === 'function'
          ? projections.get('modelSelection')
          : (typeof projections.faceOf === 'function'
            ? projections.faceOf('modelSelection').getSnapshot()
            : undefined)
        const selection = value && (value.next || value.lastUsed)
        if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null
        return { provider: selection.provider, model: selection.model }
      } catch {
        return null
      }
    }

    function Panel(props) {
      const cwd = useCwd(props)
      const [data, setData] = React.useState(null)
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(null)
      const [generating, setGenerating] = React.useState(false)
      const [error, setError] = React.useState(null)
      // The branch picker and the history are opt-in: both stay closed until asked.
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const [filter, setFilter] = React.useState('')
      const [historyOpen, setHistoryOpen] = React.useState(false)
      // `null` | { scope: 'all' } | { scope: 'file' }: nothing is discarded until confirmed.
      const [confirm, setConfirm] = React.useState(null)
      // Key of the file row under the pointer: inline styles cannot express `:hover`.
      const [hovered, setHovered] = React.useState(null)
      // `provider/model` the last draft came from, so the panel shows what it used.
      const [generatedBy, setGeneratedBy] = React.useState(null)
      // Height the person dragged the message box to; `null` keeps the CSS default.
      const [draftHeight, setDraftHeight] = React.useState(null)
      const [resizeHot, setResizeHot] = React.useState(false)
      const textareaRef = React.useRef(null)

      /** Clamp and paint one height; the drag writes the DOM directly to stay smooth. */
      const applyDraftHeight = (value) => {
        const next = Math.max(DRAFT_MIN_HEIGHT, Math.min(DRAFT_MAX_HEIGHT, Math.round(value)))
        if (textareaRef.current) textareaRef.current.style.height = `${next}px`
        return next
      }

      const startResize = (event) => {
        const textarea = textareaRef.current
        if (!textarea || (event.button !== undefined && event.button !== 0)) return
        event.preventDefault()
        const startY = event.clientY
        const startHeight = textarea.offsetHeight
        let latest = startHeight
        setResizeHot(true)

        const move = (moveEvent) => { latest = applyDraftHeight(startHeight + (moveEvent.clientY - startY)) }
        const finish = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          setResizeHot(false)
          setDraftHeight(latest)
        }

        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
      }

      /** Keyboard parity: focus the grip and use the arrow keys. */
      const resizeByKey = (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        const taken = textareaRef.current ? textareaRef.current.offsetHeight : DRAFT_MIN_HEIGHT
        setDraftHeight(applyDraftHeight(taken + (event.key === 'ArrowUp' ? -8 : 8)))
      }

      const refresh = React.useCallback(async () => {
        if (!cwd) return
        try {
          setData(await getState(cwd))
          setError(null)
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        }
      }, [cwd])

      React.useEffect(() => { void refresh() }, [refresh])

      React.useEffect(() => {
        const id = window.setInterval(() => {
          if (document.visibilityState === 'visible') void refresh()
        }, POLL_MS)
        return () => window.clearInterval(id)
      }, [refresh])

      /** Runs one action; false when it failed, so callers can chain safely. */
      const act = async (action, extra) => {
        if (!cwd) return false
        setBusy(action)
        try {
          const next = await postAction(cwd, action, extra)
          setData(next)
          setError(null)
          if (action === 'commit') setMessage('')
          return true
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
          return false
        } finally {
          setBusy(null)
        }
      }

      /** Draft the commit message from the diff; failure lands in the error line. */
      const generate = async () => {
        if (!cwd || generating) return
        setGenerating(true)
        try {
          // Use the model the chat is on; the host falls back when it is unknown.
          const result = await draftMessage(cwd, currentRoute(pluginCtx, props.sessionId))
          setMessage(String(result.message || ''))
          setGeneratedBy(result.provider && result.model ? `${result.provider}/${result.model}` : null)
          setError(null)
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        } finally {
          setGenerating(false)
        }
      }

      const togglePicker = () => {
        setPickerOpen((open) => !open)
        setFilter('')
      }

      const pick = async (branch) => {
        setPickerOpen(false)
        setFilter('')
        if (branch.current) return
        await act('checkout', { name: branch.name, kind: branch.kind })
      }

      /* Destructive actions only run once the panel shows its confirmation. */
      const discard = async (change) => {
        setConfirm(null)
        await act('discard', { path: change.path, origPath: change.origPath })
      }

      const discardAll = async () => {
        setConfirm(null)
        await act('discardAll')
      }

      if (!cwd) {
        return h('div', { style: S.root }, h('div', { style: { ...S.body, ...S.muted } },
          'Abre una sesión con una carpeta de trabajo para ver su repositorio.'))
      }

      const status = data ? data.status : null
      const log = data && Array.isArray(data.log) ? data.log : []
      const branches = data && Array.isArray(data.branches) ? data.branches : []
      const staged = status ? status.staged : []
      const unstaged = status ? status.unstaged : []
      const untracked = status ? status.untracked : []
      const ahead = status ? status.ahead : 0
      const behind = status ? status.behind : 0
      // `upstream === null` alone does not mean the branch is missing on the
      // remote: it can exist there without local tracking. Only offer publishing
      // when the remote-tracking ref is absent too.
      const remoteRef = status && status.branch !== null
        ? branches.find((branch) => branch.kind === 'remote' && branch.branch === status.branch)
        : undefined
      const unpublished = Boolean(status && status.branch !== null && status.upstream === null && !remoteRef)
      const dirty = staged.length + unstaged.length + untracked.length > 0
      const canCommit = busy === null && !generating && message.trim() !== '' && staged.length > 0
      const trackedChanged = staged.length + unstaged.length
      const discardSummary = [
        trackedChanged > 0 ? `${trackedChanged} archivo${trackedChanged === 1 ? '' : 's'} con cambios` : null,
        untracked.length > 0
          ? `${untracked.length} archivo${untracked.length === 1 ? '' : 's'} sin rastrear (se ${untracked.length === 1 ? 'elimina' : 'eliminan'})`
          : null,
      ].filter(Boolean).join(' y ')

      const branchLabel = status ? (status.branch || 'HEAD separado') : '…'

      const query = filter.trim().toLowerCase()
      const visible = branches.filter((branch) => query === '' || branch.name.toLowerCase().includes(query))
      const locals = visible.filter((branch) => branch.kind === 'local')
      const remotes = visible.filter((branch) => branch.kind === 'remote')

      const fileRow = (change, stagedRow) => {
        const key = `${stagedRow ? 's' : 'w'}:${change.path}`
        const pending = confirm !== null && confirm.scope === 'file' &&
          confirm.path === change.path && confirm.staged === stagedRow
        const question = change.untracked
          ? `¿Eliminar ${change.path}? Está sin rastrear.`
          : stagedRow
            ? `¿Descartar los cambios preparados de ${change.path}?`
            : `¿Descartar los cambios de ${change.path}?`

        if (pending) {
          return h('div', {
            key,
            style: S.confirmRow,
            onMouseEnter: () => setHovered(key),
            onMouseLeave: () => setHovered((current) => (current === key ? null : current)),
          },
            h('span', { style: { ...S.confirmText, opacity: 0.9 }, title: `\`${change.path}\`\nEsta acción no se puede deshacer` }, question),
            h('button', { type: 'button', style: S.danger, disabled: busy !== null, onClick: () => void discard(change) }, 'Descartar'),
            h('button', { type: 'button', style: S.mini, disabled: busy !== null, onClick: () => setConfirm(null) }, 'Cancelar'),
          )
        }

        const color = change.untracked || change.status === 'A' ? '#5fbf7f' : change.status === 'D' ? '#e07070' : '#d7a94a'
        const active = hovered === key
        return h('div', {
          key,
          style: active ? { ...S.row, ...S.rowHover } : S.row,
          onMouseEnter: () => setHovered(key),
          onMouseLeave: () => setHovered((current) => (current === key ? null : current)),
        },
          h('span', { style: { ...S.letter, color } }, LETTER[change.status] || change.status),
          h('span', { style: S.path, title: change.path }, change.path),
          h('button', {
            type: 'button',
            style: active ? { ...S.mini, opacity: 1 } : S.mini,
            title: 'Descartar los cambios de este archivo',
            disabled: busy !== null,
            onClick: () => setConfirm({ scope: 'file', path: change.path, staged: stagedRow }),
          }, '↺'),
          h('button', {
            type: 'button',
            style: active ? { ...S.mini, opacity: 1 } : S.mini,
            title: stagedRow ? 'Quitar del índice' : 'Preparar cambio',
            disabled: busy !== null,
            onClick: () => void act(stagedRow ? 'unstage' : 'stage', { path: change.path }),
          }, stagedRow ? '−' : '+'),
        )
      }

      const branchRow = (branch) => h('button', {
        key: `${branch.kind}:${branch.name}`,
        type: 'button',
        style: branch.current ? { ...S.branchRow, ...S.branchRowCurrent } : S.branchRow,
        disabled: busy !== null,
        title: branch.kind === 'remote'
          ? `Rama remota ${branch.name}`
          : (branch.upstream ? `Sigue a ${branch.upstream}` : 'Rama local sin upstream'),
        onClick: () => void pick(branch),
      },
        h('span', { style: S.check }, branch.current ? '✓' : ''),
        branch.kind === 'remote'
          ? h('span', { style: S.path, title: branch.name }, h('span', { style: S.muted }, `${branch.remote}/`), branch.branch)
          : h('span', { style: S.path, title: branch.name }, branch.name),
        branch.gone ? h('span', { style: S.badge, title: 'La rama ya no existe en el remoto' }, 'borrada') : null,
        branch.ahead > 0 ? h('span', { style: S.count, title: 'commits por enviar' }, `↑${branch.ahead}`) : null,
        branch.behind > 0 ? h('span', { style: S.count, title: 'commits por traer' }, `↓${branch.behind}`) : null,
      )

      const groupTitle = (label, count) => h('div', { style: { ...S.sectionTitle, marginTop: 6 } }, h('span', null, `${label} (${count})`))

      const picker = pickerOpen ? h('div', { style: S.picker },
        h('div', { style: S.pickerHead },
          h('input', {
            style: S.filter,
            placeholder: 'Filtrar ramas…',
            value: filter,
            autoFocus: true,
            onChange: (event) => setFilter(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Escape') togglePicker() },
          }),
          h('button', {
            type: 'button', style: S.mini, title: 'Actualizar las ramas del remoto', disabled: busy !== null,
            onClick: () => void act('fetch'),
          }, '⟳'),
        ),
        h('div', { style: S.pickerList },
          locals.length > 0 ? groupTitle('Locales', locals.length) : null,
          locals.map(branchRow),
          remotes.length > 0 ? groupTitle('Remotas', remotes.length) : null,
          remotes.map(branchRow),
          visible.length === 0 ? h('div', { style: { ...S.muted, padding: '4px 0' } }, 'Sin coincidencias.') : null,
        ),
      ) : null

      return h('div', { style: S.root },
        h('div', { style: S.header },
          h('button', { type: 'button', style: S.branchBtn, title: 'Cambiar de rama', onClick: togglePicker },
            h('span', { style: S.branchName, title: (status && status.upstream) || 'sin upstream' }, branchLabel),
            h('span', { style: S.caret }, pickerOpen ? '▴' : '▾'),
          ),
          h('span', { style: S.counts },
            ahead > 0 ? h('span', { title: 'commits por enviar' }, `↑${ahead}`) : null,
            behind > 0 ? h('span', { title: 'commits por traer' }, `↓${behind}`) : null),
          h('button', { type: 'button', style: S.iconBtn, title: 'Actualizar', disabled: busy !== null, onClick: () => void act('fetch') }, '⟳'),
        ),

        picker,

        behind > 0 ? h('div', { style: S.banner },
          h('span', { style: S.bannerText }, `${behind} commit${behind === 1 ? '' : 's'} nuevo${behind === 1 ? '' : 's'} en el remoto`),
          h('button', { type: 'button', style: S.primary, disabled: busy !== null, onClick: () => void act('pull') }, 'Pull'),
        ) : null,

        unpublished ? h('div', { style: S.banner },
          h('span', { style: S.bannerText }, `La rama ${status.branch} no existe en el remoto`),
          h('button', { type: 'button', style: S.primary, disabled: busy !== null, onClick: () => void act('publish') }, 'Publish Branch'),
        ) : null,

        error !== null ? h('div', { style: S.err }, error) : null,

        h('div', { style: S.body },
          confirm !== null && confirm.scope === 'all' ? h('div', { style: S.confirmBox },
            h('div', null, `Se descartarán ${discardSummary}. Esta acción no se puede deshacer.`),
            h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
              h('button', { type: 'button', style: S.danger, disabled: busy !== null, onClick: () => void discardAll() }, 'Descartar todo'),
              h('button', { type: 'button', style: S.mini, disabled: busy !== null, onClick: () => setConfirm(null) }, 'Cancelar'),
            ),
          ) : null,

          h('div', null,
            h('textarea', {
              ref: textareaRef,
              style: {
                ...S.textarea,
                resize: 'none',
                maxHeight: DRAFT_MAX_HEIGHT,
                ...(draftHeight === null ? {} : { height: draftHeight }),
              },
              placeholder: dirty ? 'Mensaje de commit…' : 'Sin cambios para commitear',
              value: message,
              disabled: busy !== null,
              onChange: (event) => setMessage(event.target.value),
            }),
            /* The whole bottom edge drags; the native corner grip is off. */
            h('div', {
              role: 'separator',
              'aria-orientation': 'horizontal',
              'aria-label': 'Cambiar el alto de la caja de mensaje',
              tabIndex: 0,
              title: 'Arrastra el borde inferior para cambiar el alto',
              style: {
                height: 9,
                marginTop: -1,
                cursor: 'ns-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '0 0 6px 6px',
                touchAction: 'none',
                outline: 'none',
              },
              onPointerDown: startResize,
              onMouseEnter: () => setResizeHot(true),
              onMouseLeave: () => setResizeHot(false),
              onKeyDown: resizeByKey,
            },
              h('span', {
                style: {
                  width: 36,
                  height: 2,
                  borderRadius: 1,
                  background: resizeHot ? 'rgba(80,140,255,.9)' : 'rgba(127,127,127,.35)',
                  transition: 'background-color 120ms ease',
                },
              }),
            ),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
              h('button', {
                type: 'button', style: S.primary, disabled: !canCommit,
                onClick: () => void act('commit', { message }),
              }, busy === 'commit' ? 'Commit…' : 'Commit'),
              h('button', {
                type: 'button', style: { ...S.primary, background: 'rgba(127,127,127,.14)' }, disabled: !canCommit,
                onClick: async () => { if (await act('commit', { message })) await act('push') },
              }, 'Commit & Push'),
              h('button', {
                type: 'button',
                style: { ...S.primary, background: 'rgba(127,127,127,.14)', marginLeft: 'auto' },
                disabled: !dirty || busy !== null || generating,
                title: 'Redactar el mensaje con IA a partir del diff',
                onClick: () => void generate(),
              }, generating ? '✨ Generando…' : '✨ IA'),
              generatedBy !== null && !generating
                ? h('span', {
                  style: { ...S.muted, fontSize: 10, alignSelf: 'center', whiteSpace: 'nowrap' },
                  title: 'Proveedor y modelo que redactaron el mensaje',
                }, generatedBy)
                : null,
            ),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
              h('button', {
                type: 'button',
                style: S.dangerText,
                title: 'Descartar todos los cambios del working tree',
                disabled: !dirty || busy !== null,
                onClick: () => setConfirm({ scope: 'all' }),
              }, '↺ Descartar todos los cambios'),
            ),
          ),

          staged.length > 0 ? h('div', null,
            h('div', { style: S.sectionTitle },
              h('span', null, `STAGED (${staged.length})`),
              h('button', { type: 'button', style: { ...S.mini, marginLeft: 'auto' }, title: 'Quitar todo', disabled: busy !== null, onClick: () => void act('unstageAll') }, '−')),
            staged.map((change) => fileRow(change, true)),
          ) : null,

          (unstaged.length + untracked.length) > 0 ? h('div', null,
            h('div', { style: S.sectionTitle },
              h('span', null, `CHANGES (${unstaged.length + untracked.length})`),
              h('button', { type: 'button', style: { ...S.mini, marginLeft: 'auto' }, title: 'Preparar todo', disabled: busy !== null, onClick: () => void act('stageAll') }, '+')),
            unstaged.map((change) => fileRow(change, false)),
            untracked.map((path) => fileRow({ path, status: 'U', untracked: true }, false)),
          ) : null,

          !dirty && status !== null ? h('div', { style: { ...S.muted, padding: '4px 0' } }, 'Sin cambios en el working tree.') : null,

          h('div', null,
            h('button', {
              type: 'button',
              style: S.sectionHead,
              title: historyOpen ? 'Contraer el historial' : 'Expandir el historial',
              onClick: () => setHistoryOpen((open) => !open),
            },
              h('span', { style: S.chevron }, historyOpen ? '▾' : '▸'),
              h('span', null, 'HISTORIAL'),
              h('span', { style: { opacity: 0.6 } }, `(${log.length})`),
            ),
            historyOpen
              ? (log.length === 0
                ? h('div', { style: S.muted }, 'Sin commits todavía.')
                : log.map((entry) => {
                  const rowKey = `h:${entry.sha}`
                  return h('div', {
                    key: entry.sha,
                    style: hovered === rowKey ? { ...S.item, ...S.rowHover } : S.item,
                    title: `${entry.sha}\n${entry.author}`,
                    onMouseEnter: () => setHovered(rowKey),
                    onMouseLeave: () => setHovered((current) => (current === rowKey ? null : current)),
                  },
                    h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                      h('span', { style: S.sha }, entry.shortSha),
                      h('span', { style: S.path }, entry.subject),
                      h('span', { style: { ...S.muted, fontSize: 10, whiteSpace: 'nowrap' } }, relative(entry.date))),
                    entry.refs ? h('div', { style: { ...S.muted, fontSize: 10 } }, entry.refs) : null,
                  )
                }))
              : null,
          ),
        ),
      )
    }

    function apply(ctx) {
      pluginCtx = ctx
      // The tab registry is reached lazily: a static inject that never resolves
      // parks the plugin forever and `apply` never runs.
      ctx.inject(['sidebarRightTabs'], (owner) => {
        const tabs = owner.get('sidebarRightTabs')
        if (!tabs) {
          console.error('[dsh-source-control] sidebarRightTabs is not available')
          return
        }

        owner.effect(() => tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'Source Control',
          guide: [{ id: 'source-control', order: 90, title: () => 'Source Control' }],
        }), 'dsh-source-control: tab type')

        const register = owner.slots.register.bind(owner.slots)
        owner.slots.inject('sidebar.right.pane.tab', () => register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, Panel))
      })
    }

    return { apply, inject: ['slots'] }
  },
})
