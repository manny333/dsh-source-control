/**
 * dsh-source-control — local Git engine.
 * Runs `git` with execFile (never a shell), parses NUL-separated porcelain v2
 * status and log output, and keeps error text free of credentials.
 *
 * Status is read with `-z` on purpose: without it git C-quotes any path that is
 * not plain ASCII (`"a\303\261o.txt"`), and the panel would show — and act on —
 * an escaped string instead of the file name.
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

/**
 * Pathspec that matches the bytes given and nothing else.
 *
 * The panel receives exact paths from `status`, but git reads a bare argument
 * after `--` as a glob with pathspec magic: a file named `a*b.txt` would also
 * match `axb.txt`, and one named `:x` would be a magic error.
 */
export function literalPath(path: string): string {
  return `:(literal)${path}`
}

function letter(ch: string): string | null {
  return ch === '.' || ch === ' ' ? null : ch
}

function addChange(status: GitStatus, xy: string, path: string, origPath?: string): void {
  if (path === '') return
  const [x, y] = [xy[0] ?? '.', xy[1] ?? '.']
  const staged = letter(x)
  const worktree = letter(y)
  if (staged !== null) status.staged.push({ path, origPath, status: staged, staged: true })
  if (worktree !== null) status.unstaged.push({ path, origPath, status: worktree, staged: false })
}

/** Everything after the first `count` space-separated fields — paths may hold spaces. */
function afterFields(line: string, count: number): string {
  let index = 0
  for (let seen = 0; seen < count; seen += 1) {
    index = line.indexOf(' ', index)
    if (index < 0) return ''
    index += 1
  }
  return line.slice(index)
}

/** Arguments for a NUL-terminated, unquoted, machine-readable status query. */
export function statusArgs(): string[] {
  return ['status', '--porcelain=v2', '--branch', '-z']
}

/**
 * Parse `git status --porcelain=v2 --branch` output.
 *
 * Both shapes are understood: NUL records (`-z`, what {@link statusArgs}
 * asks for) and newline records, which keep the TAB separator before a
 * rename's original path.
 */
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

  const nul = raw.includes('\0')
  const records = nul ? raw.split('\0') : raw.split(/\r?\n/)

  for (let i = 0; i < records.length; i += 1) {
    const line = records[i]
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

    const kind = line[0]
    if (kind === '1') {
      addChange(status, line.slice(2, 4), afterFields(line, 8))
    } else if (kind === '2') {
      // `<path>` then, with -z, the original path as the next NUL record;
      // without -z, one field `path<TAB>origPath`.
      const current = afterFields(line, 9)
      if (nul) {
        const original = records[i + 1] ?? ''
        if (original !== '') i += 1
        addChange(status, line.slice(2, 4), current, original || undefined)
      } else {
        const tab = current.indexOf('\t')
        if (tab < 0) addChange(status, line.slice(2, 4), current)
        else addChange(status, line.slice(2, 4), current.slice(0, tab), current.slice(tab + 1))
      }
    } else if (kind === 'u') {
      status.mergeState = 'unmerged'
      status.operationInProgress = true
      status.unstaged.push({ path: afterFields(line, 10), status: 'U', staged: false })
    } else if (kind === '?') {
      const path = afterFields(line, 1)
      if (path !== '') status.untracked.push(path)
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

/** Bytes git refuses in a ref name: control, space, and the shell-glob set. */
const INVALID_BRANCH_CHARS = /[\u0000-\u0020\u007f~^:?*[\\]/

/**
 * Reject a branch name that git would read as an option or that is not a ref.
 * Unicode is allowed — git accepts it, and this project lives in Spanish. The
 * panel never passes user text into a shell, but `git switch -x` would still
 * be parsed as a flag, so the leading dash is refused here.
 */
export function assertBranchName(name: unknown): string {
  const value = typeof name === 'string' ? name : ''
  const invalid = value === '' || value.length > 255 ||
    INVALID_BRANCH_CHARS.test(value) ||
    value.startsWith('-') || value.startsWith('/') || value.endsWith('/') ||
    value.endsWith('.') || value.includes('..') || value.includes('//') ||
    value.includes('@{') || value.split('/').some(segment => segment.endsWith('.lock'))
  if (invalid) {
    throw Object.assign(new Error(`dsh-source-control: invalid branch name "${value}"`), {
      code: 'invalid-branch',
    })
  }
  return value
}
