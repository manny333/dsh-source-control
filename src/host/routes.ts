/**
 * dsh-source-control — HTTP surface for the sidebar panel.
 * Same-origin, JSON, bounded bodies. Every Git call runs through execFile in
 * `git.ts`; nothing here accepts a shell string.
 */
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { assertBranchName, branchArgs, git, logArgs, parseBranches, parseLog, parseStatus, redact } from './git.ts'

export const STATE_ROUTE = '/dsh-source-control/state'
export const ACTION_ROUTE = '/dsh-source-control/action'

const MAX_BODY_BYTES = 64 * 1024
const MAX_LIMIT = 200

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

/** Absolute existing directory, or a thrown 400-shaped error. */
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
  if (typeof raw !== 'string' || raw === '' || isAbsolute(raw)) {
    throw new Error('the path parameter must be a relative repository path')
  }
  return raw
}

async function snapshot(root: string, limit: number): Promise<unknown> {
  const [rawStatus, rawLog, rawBranches] = await Promise.all([
    git(['status', '--porcelain=v2', '--branch'], root),
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

/** True when the pathspec only matches files git does not track yet. */
async function isUntracked(root: string, path: string): Promise<boolean> {
  const raw = await git(['status', '--porcelain=v1', '--', path], root)
  return raw.startsWith('??')
}

function limitOf(url: URL): number {
  const raw = Number(url.searchParams.get('limit') ?? '30')
  return Number.isFinite(raw) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw))) : 30
}

/** GET /dsh-source-control/state?root=<abs>&limit=<n> */
export async function serveState(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  try {
    const body = await readJson(req)
    const root = await rootOf(typeof body.root === 'string' ? body.root : null)
    const action = String(body.action ?? '')
    const limit = 30

    switch (action) {
      case 'stage':
        await git(['add', '--', repoPathOf(body.path)], root)
        break
      case 'unstage':
        await git(['restore', '--staged', '--', repoPathOf(body.path)], root)
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
        const paths = [repoPathOf(body.path)]
        if (typeof body.origPath === 'string' && body.origPath !== '') {
          paths.push(repoPathOf(body.origPath))
        }
        if (await isUntracked(root, paths[0])) {
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
