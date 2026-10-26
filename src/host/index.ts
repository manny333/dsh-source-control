/**
 * dsh-source-control — host plugin entry.
 * Contributes three same-origin JSON routes consumed by the sidebar panel.
 */
import type {} from '@deepseek-ai/dsh-host-webserver'
import { generateCommitMessage, normalizeSettings } from './commit-message.ts'
import { ACTION_ROUTE, MESSAGE_ROUTE, STATE_ROUTE, serveAction, serveMessage, serveState } from './routes.ts'

export const name = 'source-control'

/** Plugin configuration, as written in the profile's cordis patch. */
export interface Config {
  /** Provider route for the commit-message draft; empty picks the first mounted one. */
  provider?: string
  /** Model id; empty picks the first model the provider advertises. */
  model?: string
  /** Diff budget handed to the model, in characters. */
  maxDiffChars?: number
  /** Force the output language; empty follows the repository's recent subjects. */
  language?: string
}

/** No static service requirement: both services are picked up lazily. */
export function apply(ctx: any, config: Config = {}): void {
  const settings = normalizeSettings(config)

  // The model service may mount after this plugin, so it is captured lazily: a
  // static inject that never resolves would park the plugin and `apply` would
  // never register the panel's routes.
  let llm: any = null

  ctx.inject(['llm'], (llmCtx: any) => {
    const service = llmCtx.llm ?? (typeof llmCtx.get === 'function' ? llmCtx.get('llm') : null)
    llm = service ?? null
    llmCtx.effect(() => () => { llm = null }, 'dsh-source-control: llm handle')
  })

  ctx.inject(['webServer'], (webCtx: any) => {
    const server = webCtx.webServer

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: (req: any, res: any) => { void serveState(req, res) },
    }), 'dsh-source-control: state route')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: ACTION_ROUTE,
      handler: (req: any, res: any) => { void serveAction(req, res) },
    }), 'dsh-source-control: action route')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: MESSAGE_ROUTE,
      handler: (req: any, res: any) => {
        // Read the service per request: it may mount or unmount while the panel is open.
        const service = llm
        void serveMessage(req, res, service === null
          ? undefined
          : (root: string, signal: AbortSignal, route: { provider?: string; model?: string }) =>
              generateCommitMessage(service, settings, root, signal, route))
      },
    }), 'dsh-source-control: message route')
  })
}
