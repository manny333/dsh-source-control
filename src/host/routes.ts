/**
 * dsh-source-control — HTTP surface for the sidebar panel.
 * Same-origin, JSON, bounded bodies. Every Git call runs through execFile in
 * `git.ts`; nothing here accepts a shell string.
 *
 * The harness web server ships no global origin or authentication policy — each
 * route owner decides its own (see `@deepseek-ai/dsh-host-webserver`). These
 * routes mutate a repository, so they refuse anything a browser could send from
 * another origin: the Host must be loopback, an Origin header must match that
 * Host, and a POST must arrive as `application/json` (which a cross-origin
 * request cannot send without a preflight this server never approves).
 */
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import {
  assertBranchName,
  branchArgs,
  git,
  literalPath,
  logArgs,
  parseBranches,
  parseLog,
  parseStatus,
  redact,
  statusArgs,
} from './git.ts'
import { CommitMessageError } from './commit-message.ts'

export const STATE_ROUTE = '/dsh-source-control/state'
export const ACTION_ROUTE = '/dsh-source-control/action'
export const MESSAGE_ROUTE = '/dsh-source-control/message'

/** The panel waits on this route; a stalled model call must not hold it open. */
export const MESSAGE_TIMEOUT_MS = 30_000

/** What `index.ts` supplies once the model service is mounted. */
export type MessageGenerator = (
  root: string,
  signal: AbortSignal,
  route: { provider?: string; model?: string },
) => Promise<{ message: string; provider: string; model: string }>

const MAX_BODY_BYTES = 64 * 1024
const MAX_LIMIT = 200

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Hostname with its port removed, brackets kept for IPv6 literals. */
export function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    return close > 0 ? trimmed.slice(0, close + 1) : trimmed
  }
  const colon = trimmed.lastIndexOf(':')
  return colon > 0 ? trimmed.slice(0, colon) : trimmed
}

/**
 * Null when the request may proceed, or the status and message to refuse it.
 *
 * A browser page on any other origin can reach a loopback port, so these checks
 * are the only thing standing between a web page and `discardAll`. The Origin is
 * compared by host and port rather than by scheme: the trust boundary is the
 * server that answers on that host, and comparing the whole origin would break a
 * window that renders the same UI over another scheme.
 */
export function policyViolation(
  req: IncomingMessage,
): { status: number; message: string } | null {
  const rawHost = req.headers.host
  if (typeof rawHost !== 'string' || rawHost.trim() === '') {
    return { status: 403, message: 'a Host header is required' }
  }
  const host = rawHost.trim().toLowerCase()
  if (!LOOPBACK_HOSTS.has(hostnameOf(host))) {
    return { status: 403, message: 'requests must address the loopback interface' }
  }

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return { status: 403, message: 'cross-origin requests are refused' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { status: 403, message: 'cross-origin requests are refused' }
    }
    if (parsed.host !== host) {
      return { status: 403, message: 'cross-origin requests are refused' }
    }
  }

  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return { status: 403, message: 'cross-site requests are refused' }
  }

  return null
}

function isJson(req: IncomingMessage): boolean {
  const raw = req.headers['content-type']
  return typeof raw === 'string' && /^application\/json\b/i.test(raw.trim())
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: redact(message) })
}

/**
 * Absolute existing directory, or a thrown 400-shaped error.
 *
 * The path comes from the panel's session workspace; this route layer has no
 * session context to compare it against, so it only proves the directory is
 * absolute and real. The origin policy above is what keeps a foreign page from
 * choosing it.
 */
async function rootOf(raw: string | null): Promise<string> {
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw)) {
    throw new Error('the root parameter must be an absolute path')
  }
  const info = await stat(raw)
  if (!info.isDirectory()) throw new Error('the root parameter is not a directory')
  return raw
}

/** Relative repo path, never absolute and never empty. */
function repoPathOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || isAbsolute(raw) || raw.includes('\0')) {
    throw new Error('the path parameter must be a relative repository path')
  }
  return raw
}

async function snapshot(root: string, limit: number): Promise<unknown> {
  const [rawStatus, rawLog, rawBranches] = await Promise.all([
    git(statusArgs(), root),
    // A repository without commits still reports a useful status.
    git(logArgs(limit), root).catch(() => ''),
    git(branchArgs(), root).catch(() => ''),
  ])
  return {
    ok: true,
    status: parseStatus(rawStatus, root),
    log: parseLog(rawLog),
    branches: parseBranches(rawBranches),
  }
}

/** True when `ref` resolves in this repository. */
async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', ref], root)
    return true
  } catch {
    return false
  }
}

/** True when the path only matches files git does not track yet. */
async function isUntracked(root: string, path: string): Promise<boolean> {
  const raw = await git(['status', '--porcelain=v1', '-z', '--', literalPath(path)], root)
  return raw.startsWith('??')
}

function limitOf(url: URL): number {
  const raw = Number(url.searchParams.get('limit') ?? '30')
  return Number.isFinite(raw) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw))) : 30
}

/** GET /dsh-source-control/state?root=<abs>&limit=<n> */
export async function serveState(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const violation = policyViolation(req)
  if (violation) {
    fail(res, violation.status, violation.message)
    return
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const root = await rootOf(url.searchParams.get('root'))
    sendJson(res, 200, await snapshot(root, limitOf(url)))
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : String(error))
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('malformed JSON body')
  }
}

/** POST /dsh-source-control/action — one user-initiated Git operation. */
export async function serveAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const violation = policyViolation(req)
  if (violation) {
    fail(res, violation.status, violation.message)
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  // A cross-origin page cannot set this header without a preflight that this
  // server never answers, so requiring it blocks the no-preflight form POST.
  if (!isJson(req)) {
    fail(res, 415, 'the action route only accepts application/json')
    return
  }
  try {
    const body = await readJson(req)
    const root = await rootOf(typeof body.root === 'string' ? body.root : null)
    const action = String(body.action ?? '')
    const limit = 30

    switch (action) {
      case 'stage':
        await git(['add', '--', literalPath(repoPathOf(body.path))], root)
        break
      case 'unstage':
        await git(['restore', '--staged', '--', literalPath(repoPathOf(body.path))], root)
        break
      case 'stageAll':
        await git(['add', '-A'], root)
        break
      case 'unstageAll':
        await git(['reset'], root)
        break
      case 'commit': {
        const message = String(body.message ?? '').trim()
        if (message === '') throw new Error('the commit message is empty')
        await git(['commit', '-m', message], root)
        break
      }
      case 'push':
        await git(['push'], root)
        break
      case 'pull':
        await git(['pull', '--ff-only'], root)
        break
      case 'publish':
        await git(['push', '-u', 'origin', 'HEAD'], root)
        break
      case 'checkout': {
        const name = assertBranchName(body.name)
        if (body.kind !== 'remote') {
          await git(['switch', name], root)
          break
        }
        // Remote-tracking name: `origin/feature/x` -> remote `origin`, branch `feature/x`.
        const slash = name.indexOf('/')
        if (slash <= 0 || slash === name.length - 1) {
          throw new Error(`invalid remote branch "${name}"`)
        }
        const local = assertBranchName(name.slice(slash + 1))
        if (await refExists(root, `refs/heads/${local}`)) {
          await git(['switch', local], root)
          break
        }
        try {
          await git(['switch', '-c', local, '--track', name], root)
        } catch {
          // `--track` needs the remote to be configured; without it the ref still
          // names a commit, so the local branch is created without an upstream.
          if (await refExists(root, `refs/heads/${local}`)) await git(['switch', local], root)
          else await git(['switch', '-c', local, name], root)
        }
        break
      }
      case 'discard': {
        // A rename leaves two paths behind: the new name and the deleted original.
        const path = repoPathOf(body.path)
        const paths = [literalPath(path)]
        if (typeof body.origPath === 'string' && body.origPath !== '') {
          paths.push(literalPath(repoPathOf(body.origPath)))
        }
        if (await isUntracked(root, path)) {
          // Nothing to restore: an untracked file only goes away when removed.
          await git(['clean', '-f', '-d', '--', ...paths], root)
        } else {
          await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths], root)
        }
        break
      }
      case 'discardAll': {
        try {
          await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'], root)
        } catch {
          // An unborn HEAD has nothing to restore to; only the index can be reset.
          await git(['reset'], root).catch(() => {})
        }
        // `clean` leaves ignored files alone: only what git reports as untracked.
        await git(['clean', '-f', '-d'], root)
        break
      }
      case 'fetch':
        try {
          await git(['fetch', '--prune'], root)
        } catch {
          // Offline or no remote: the status below is still useful.
        }
        break
      default:
        throw new Error(`unknown action "${action}"`)
    }

    sendJson(res, 200, await snapshot(root, limit))
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : String(error))
  }
}

/**
 * POST /dsh-source-control/message — draft a commit message with the host model.
 *
 * `generate` is absent while the model service is not mounted, which answers 503
 * instead of guessing a route. The panel keeps working without it: staging,
 * commits and history never touch this route.
 */
export async function serveMessage(
  req: IncomingMessage,
  res: ServerResponse,
  generate?: MessageGenerator,
  timeoutMs = MESSAGE_TIMEOUT_MS,
): Promise<void> {
  const violation = policyViolation(req)
  if (violation) {
    fail(res, violation.status, violation.message)
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (!isJson(req)) {
    fail(res, 415, 'the message route only accepts application/json')
    return
  }
  if (typeof generate !== 'function') {
    fail(res, 503, 'no model service is mounted in this profile')
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const body = await readJson(req)
    const root = await rootOf(typeof body.root === 'string' ? body.root : null)
    // The panel reads the session's current route; the host never has that context.
    const route = {
      provider: typeof body.provider === 'string' ? body.provider.slice(0, 200) : undefined,
      model: typeof body.model === 'string' ? body.model.slice(0, 200) : undefined,
    }
    const result = await generate(root, controller.signal, route)
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    if (controller.signal.aborted) {
      fail(res, 504, 'the model call timed out')
      return
    }
    const status = error instanceof CommitMessageError ? error.status : 400
    fail(res, status, error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}
