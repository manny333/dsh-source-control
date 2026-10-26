/**
 * dsh-source-control — local Git engine.
 * Runs `git` with execFile (never a shell), parses porcelain v2 status and log
 * output, and keeps error text free of credentials.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'

const execFileAsync = promisify(execFile)

export interface FileChange {
  path: string
  origPath?: string
  status: string
  staged: boolean
}

export interface GitStatus {
  root: string
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: string[]
  mergeState: string
  operationInProgress: boolean
}

export interface GitLogEntry {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
  refs: string
}

const MAX_BUFFER = 16 * 1024 * 1024

/** Strip userinfo from any https URL that reaches a message. */
export function redact(text: string): string {
  return text.replace(/https?:\/\/[^\s@]*@/gi, 'https://[credentials]@')
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  }
}

/** Run one git command in `cwd` and return stdout. */
export async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: gitEnv(),
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      signal,
    } as any)
    return String((result as any).stdout ?? '')
  } catch (error: any) {
    const stderr = redact(String(error?.stderr ?? error?.message ?? error)).trim()
    const message = stderr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)
    const wrapped = new Error(message || 'git failed')
    ;(wrapped as any).code = 'git-failed'
    throw wrapped
  }
}

/** Reject roots that are not absolute paths. */
export function assertRoot(root: string): string {
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
    throw Object.assign(new Error(`dsh-source-control: invalid workspace path "${root}"`), { code: 'invalid-root' })
  }
  return root
}

function letter(ch: string): string | null {
  return ch === '.' || ch === ' ' ? null : ch
}

function addChange(status: GitStatus, xy: string, path: string, origPath?: string): void {
  const [x, y] = [xy[0] ?? '.', xy[1] ?? '.']
  const staged = letter(x)
  const worktree = letter(y)
  if (staged !== null) status.staged.push({ path, origPath, status: staged, staged: true })
  if (worktree !== null) status.unstaged.push({ path, origPath, status: worktree, staged: false })
}

/** Parse `git status --porcelain=v2 --branch` output. */
export function parseStatus(raw: string, root = ''): GitStatus {
  const status: GitStatus = {
    root,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    mergeState: 'none',
    operationInProgress: false,
  }

  for (const line of raw.split(/\r?\n/)) {
    if (line === '') continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      status.branch = head === '(detached)' ? null : head
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim() || null
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line)
      if (match) {
        status.ahead = Number(match[1])
        status.behind = Number(match[2])
      }
      continue
    }
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      if (oid === '(initial)') status.branch = status.branch ?? null
      continue
    }

    const kind = line[0]
    if (kind === '1') {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const path = parts.slice(8).join(' ')
      addChange(status, xy, path)
    } else if (kind === '2') {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const tail = parts.slice(9).join(' ')
      const [path, origPath] = tail.split('\t')
      addChange(status, xy, path, origPath)
    } else if (kind === 'u') {
      const parts = line.split(' ')
      const xy = parts[1] ?? 'UU'
      const path = parts.slice(10).join(' ')
      status.mergeState = 'unmerged'
      status.unstaged.push({ path, status: 'U', staged: false })
      status.operationInProgress = true
      void xy
    } else if (kind === '?') {
      status.untracked.push(line.slice(2))
    }
  }

  return status
}

const LOG_SEP = '\x1e'
const FIELD_SEP = '\x1f'

/** Parse `git log` output produced by {@link logArgs}. */
export function parseLog(raw: string): GitLogEntry[] {
  return raw
    .split(LOG_SEP)
    .map(chunk => chunk.replace(/^\r?\n/, ''))
    .filter(chunk => chunk.trim() !== '')
    .map((chunk) => {
      const [sha, shortSha, subject, author, date, refs] = chunk.split(FIELD_SEP)
      return { sha: sha ?? '', shortSha: shortSha ?? '', subject: subject ?? '', author: author ?? '', date: date ?? '', refs: refs ?? '' }
    })
}

/** Arguments for a bounded, machine-readable log query. */
export function logArgs(limit: number): string[] {
  const count = Math.max(1, Math.min(200, Math.floor(limit || 30)))
  return ['log', `-n${count}`, '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1e']
}

/* ---------------------------------------------------------------- branches */

export interface BranchEntry {
  /** Short ref name: `main` for a local branch, `origin/main` for a remote one. */
  name: string
  kind: 'local' | 'remote'
  /** Remote name for a remote-tracking entry; null for a local branch. */
  remote: string | null
  /** Branch part of a remote-tracking ref (`main` out of `origin/main`). */
  branch: string | null
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  /** Upstream configured, but the branch was deleted on the remote. */
  gone: boolean
}

/**
 * Every head and remote-tracking ref in one machine-readable pass.
 * NUL separates the fields, so branch names may contain spaces.
 */
export function branchArgs(): string[] {
  return [
    'for-each-ref',
    '--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)',
    'refs/heads',
    'refs/remotes',
  ]
}

const AHEAD_RE = /ahead (\d+)/
const BEHIND_RE = /behind (\d+)/

/** Parse the output of {@link branchArgs} into local branches first, remotes after. */
export function parseBranches(raw: string): BranchEntry[] {
  const locals: BranchEntry[] = []
  const remotes: BranchEntry[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (line === '') continue
    const [refname = '', head = '', upstream = '', track = ''] = line.split('\x00')
    const ahead = Number(AHEAD_RE.exec(track)?.[1] ?? 0)
    const behind = Number(BEHIND_RE.exec(track)?.[1] ?? 0)
    const gone = track.includes('gone')

    if (refname.startsWith('refs/heads/')) {
      locals.push({
        name: refname.slice('refs/heads/'.length),
        kind: 'local',
        remote: null,
        branch: null,
        current: head.trim() === '*',
        upstream: upstream.trim() || null,
        ahead,
        behind,
        gone,
      })
      continue
    }

    if (!refname.startsWith('refs/remotes/')) continue
    const rest = refname.slice('refs/remotes/'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) continue
    const remote = rest.slice(0, slash)
    const branch = rest.slice(slash + 1)
    // `<remote>/HEAD` is a symbolic alias of the remote default branch.
    if (branch === 'HEAD') continue
    remotes.push({
      name: rest,
      kind: 'remote',
      remote,
      branch,
      current: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      gone: false,
    })
  }

  const byName = (a: BranchEntry, b: BranchEntry) => a.name.localeCompare(b.name)
  locals.sort((a, b) => (a.current === b.current ? byName(a, b) : a.current ? -1 : 1))
  remotes.sort(byName)
  return [...locals, ...remotes]
}

const BRANCH_NAME_RE = /^[A-Za-z0-9._/@+-]+$/

/**
 * Reject a branch name that git would read as an option or that is not a ref.
 * The panel never passes user text into a shell, but `git switch -x` would still
 * be parsed as a flag, so the leading dash is refused here.
 */
export function assertBranchName(name: unknown): string {
  const value = typeof name === 'string' ? name : ''
  const invalid = value === '' || value.length > 255 || !BRANCH_NAME_RE.test(value) ||
    value.startsWith('-') || value.startsWith('/') || value.endsWith('/') ||
    value.includes('..') || value.includes('//') || value.endsWith('.lock')
  if (invalid) {
    throw Object.assign(new Error(`dsh-source-control: invalid branch name "${value}"`), {
      code: 'invalid-branch',
    })
  }
  return value
}
