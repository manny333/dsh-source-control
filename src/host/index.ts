/**
 * dsh-source-control — host plugin entry.
 * Contributes two same-origin JSON routes consumed by the sidebar panel.
 */
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ACTION_ROUTE, STATE_ROUTE, serveAction, serveState } from './routes.ts'

export const name = 'source-control'

/** No static service requirement: the web server is picked up lazily. */
export function apply(ctx: any): void {
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: (req: any, res: any) => { void serveState(req, res) },
    }), 'dsh-source-control: state route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ACTION_ROUTE,
      handler: (req: any, res: any) => { void serveAction(req, res) },
    }), 'dsh-source-control: action route')
  })
}
