/**
 * dsh-source-control — commit message drafting through the host LLM service.
 *
 * This is an auxiliary, user-initiated call: its output lands in the commit box
 * for the person to edit, so it is not part of the agent transcript. It uses the
 * same public seam as the auto-review or session-title generators — `ctx.llm`
 * with a provider/model route — and never reaches an adapter directly.
 */
import { git, parseStatus, redact, statusArgs } from './git.ts'

/** Plugin configuration, already normalized. */
export interface CommitMessageSettings {
  provider: string
  model: string
  maxDiffChars: number
  language: string
}

export interface CommitMessageRoute {
  provider: string
  model: string
}

export interface GeneratedCommitMessage extends CommitMessageRoute {
  message: string
}

/** A route the panel read from the session, which outranks every fallback. */
export interface RouteOverride {
  provider?: string
  model?: string
}

/** A failure the HTTP layer can turn into a status code. */
export class CommitMessageError extends Error {
  status: number

  constructor(message: string, status = 502) {
    super(redact(message))
    this.name = 'CommitMessageError'
    this.status = status
  }
}

const MIN_DIFF_CHARS = 1000
const MAX_DIFF_CHARS = 60_000
const DEFAULT_DIFF_CHARS = 12_000
const MAX_FILES = 60

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

/** Apply defaults and bounds to whatever the profile handed `apply`. */
export function normalizeSettings(raw: any = {}): CommitMessageSettings {
  return {
    provider: typeof raw?.provider === 'string' ? raw.provider.trim() : '',
    model: typeof raw?.model === 'string' ? raw.model.trim() : '',
    maxDiffChars: clampInt(raw?.maxDiffChars, MIN_DIFF_CHARS, MAX_DIFF_CHARS, DEFAULT_DIFF_CHARS),
    language: typeof raw?.language === 'string' ? raw.language.trim() : '',
  }
}

function providerIds(llm: any): string[] {
  try {
    const providers = llm?.listProviders?.() ?? []
    const ids: string[] = []
    for (const entry of providers) {
      const id = typeof entry === 'string' ? entry : entry?.id
      if (typeof id === 'string' && id !== '') ids.push(id)
    }
    return ids
  } catch {
    return []
  }
}

/**
 * Pick the route the call uses.
 *
 * Priority: the route the panel read from the session (the model the chat is
 * actually using), then the plugin's configured provider and model, then the
 * first model any mounted provider advertises.
 *
 * A route that names both fields is never checked against the catalog: account
 * providers list no models until they are fully configured, yet a session uses
 * them fine. Discovery, by contrast, skips a provider with an empty catalog
 * instead of failing on it.
 */
export async function resolveRoute(
  llm: any,
  settings: CommitMessageSettings,
  override: RouteOverride = {},
): Promise<CommitMessageRoute> {
  const wantedProvider = (override.provider ?? '').trim() || settings.provider
  const wantedModel = (override.model ?? '').trim() || settings.model
  const ids = providerIds(llm)

  if (wantedProvider !== '' && wantedModel !== '') {
    if (ids.length > 0 && !ids.includes(wantedProvider)) {
      throw new CommitMessageError(`the provider "${wantedProvider}" is not mounted`, 503)
    }
    return { provider: wantedProvider, model: wantedModel }
  }

  if (ids.length === 0) {
    throw new CommitMessageError('no model provider is mounted in this profile', 503)
  }
  if (wantedProvider !== '' && !ids.includes(wantedProvider)) {
    throw new CommitMessageError(`the configured provider "${wantedProvider}" is not mounted`, 503)
  }

  const candidates = wantedProvider === '' ? ids : [wantedProvider]
  for (const provider of candidates) {
    if (wantedModel !== '') return { provider, model: wantedModel }
    let models: any[] = []
    try {
      models = (await llm.listModels(provider)) ?? []
    } catch {
      models = []
    }
    const first = models.find((model: any) => typeof model?.id === 'string' && model.id !== '')
    if (first) return { provider, model: first.id }
  }

  throw new CommitMessageError(
    'no mounted provider advertises a model; set provider and model in the plugin config',
    503,
  )
}

/** Keep the prompt bounded without cutting a line in half. */
export function clipDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff
  return `${diff.slice(0, maxChars)}\n…[diff truncated at ${maxChars} characters]`
}

/**
 * Build the user-visible context: branch, changed files, the staged diff (or the
 * working tree one when nothing is staged) and the recent subjects the model
 * should imitate in tone and language.
 */
export async function buildMessageContext(
  root: string,
  maxDiffChars: number,
  signal?: AbortSignal,
): Promise<string> {
  const [rawStatus, staged, worktree, subjects] = await Promise.all([
    git(statusArgs(), root, signal),
    git(['diff', '--cached', '--patch', '--no-color', '--no-ext-diff'], root, signal).catch(() => ''),
    git(['diff', '--patch', '--no-color', '--no-ext-diff'], root, signal).catch(() => ''),
    git(['log', '-n8', '--pretty=format:%s'], root).catch(() => ''),
  ])

  const status = parseStatus(rawStatus, root)
  const files = [
    ...status.staged.map(change => `staged   ${change.status}  ${change.path}`),
    ...status.unstaged.map(change => `unstaged ${change.status}  ${change.path}`),
    ...status.untracked.map(path => `untracked ?  ${path}`),
  ]

  const stagedDiff = staged.trim()
  const diff = stagedDiff !== '' ? staged : worktree
  const label = stagedDiff !== '' ? 'Staged diff' : 'Working tree diff (nothing staged)'

  const parts = [
    `Branch: ${status.branch ?? '(detached HEAD)'}`,
    '',
    'Changed files:',
    files.slice(0, MAX_FILES).join('\n') || '(none)',
  ]
  if (files.length > MAX_FILES) parts.push(`… and ${files.length - MAX_FILES} more`)

  const clipped = clipDiff(diff, maxDiffChars).trim()
  if (clipped !== '') parts.push('', `${label}:`, clipped)
  if (subjects.trim() !== '') parts.push('', 'Recent commit subjects:', subjects.trim())

  return parts.join('\n')
}

/** The fixed policy; only the language rule changes between calls. */
export function systemPrompt(language: string): string {
  const languageRule = language === ''
    ? 'Write in the language of the existing commit subjects; if there are none, write in English.'
    : `Write in ${language}.`
  return [
    'You write Git commit messages from a diff.',
    'Rules:',
    '- First line: imperative subject, at most 72 characters, no trailing period.',
    '- Then, only when the change needs explanation, a blank line and a body wrapped at 72 characters.',
    '- Say what the change does and why; never list the files.',
    '- Output only the message: no code fences, no quotes, no "Commit:" prefix.',
    languageRule,
  ].join('\n')
}

/** Strip what models habitually wrap around a message. */
export function normalizeCommitMessage(raw: string): string {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n').trim()
  const fenced = /^```[A-Za-z]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  text = text.replace(/^(?:commit(?: message)?|message)\s*:\s*/i, '')
  if (text.length > 1 && /^["'`]/.test(text) && /["'`]$/.test(text)) text = text.slice(1, -1).trim()
  return text.replace(/\n{3,}/g, '\n\n')
}

interface StreamFailure {
  kind: string
  code?: string
  message?: string
}

/**
 * Stream one completion and return the drafted message.
 *
 * The chunk protocol is the documented one: `text-delta` carries the tokens and
 * exactly one terminal `finish` closes the stream with `stop`, `error` or
 * `aborted`.
 */
export async function generateCommitMessage(
  llm: any,
  settings: CommitMessageSettings,
  root: string,
  signal?: AbortSignal,
  override: RouteOverride = {},
): Promise<GeneratedCommitMessage> {
  const route = await resolveRoute(llm, settings, override)
  const context = await buildMessageContext(root, settings.maxDiffChars, signal)

  const parts: string[] = []
  let failure: StreamFailure | null = null
  let finished = false

  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: systemPrompt(settings.language),
      messages: [{ role: 'user', content: [{ type: 'text', text: context }] }],
      temperature: 0,
      ...(signal === undefined ? {} : { signal }),
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        parts.push(chunk.text)
      } else if (chunk?.type === 'finish') {
        finished = true
        const kind = String(chunk.reason?.kind ?? 'error')
        if (kind !== 'stop') {
          failure = {
            kind,
            code: typeof chunk.reason?.failure?.code === 'string' ? chunk.reason.failure.code : undefined,
            message: typeof chunk.reason?.failure?.message === 'string' ? chunk.reason.failure.message : undefined,
          }
        }
      }
    }
  } catch (cause) {
    throw new CommitMessageError(cause instanceof Error ? cause.message : String(cause), 502)
  }

  if (!finished) throw new CommitMessageError('the model stream ended without a terminal finish', 502)
  if (failure !== null) {
    const detail = [failure.kind, failure.code].filter(Boolean).join(' ')
    throw new CommitMessageError(
      `the model call failed (${detail})${failure.message === undefined ? '' : `: ${failure.message}`}`,
      502,
    )
  }

  const message = normalizeCommitMessage(parts.join(''))
  if (message === '') throw new CommitMessageError('the model returned an empty message', 502)

  return { message, provider: route.provider, model: route.model }
}
