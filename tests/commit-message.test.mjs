import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildMessageContext,
  clipDiff,
  CommitMessageError,
  generateCommitMessage,
  normalizeCommitMessage,
  normalizeSettings,
  resolveRoute,
  systemPrompt,
} from '../lib/commit-message.js'
import { serveMessage } from '../lib/routes.js'
import {
  actionBody,
  actionHeaders,
  createRepo,
  git,
  HOST,
  makeRequest,
  makeResponse,
  removeRepo,
  sameOriginHeaders,
} from './helpers.mjs'

const SETTINGS = normalizeSettings({})

/** A stand-in for `ctx.llm`: records the last request and replays fixed chunks. */
function stubLlm({ providers = ['provider-a'], models = { 'provider-a': [{ id: 'model-a' }] }, chunks = [], calls = [] } = {}) {
  return {
    listProviders: () => providers.map(id => ({ id, displayName: id })),
    listModels: async provider => models[provider] ?? [],
    stream(options) {
      calls.push(options)
      return (async function* replay() {
        for (const chunk of chunks) yield chunk
      })()
    },
    calls,
  }
}

const stop = { type: 'finish', reason: { kind: 'stop' } }
const delta = text => ({ type: 'text-delta', text })

test('normalizeSettings trims strings and bounds the diff budget', () => {
  const settings = normalizeSettings({ provider: ' p ', model: ' m ', maxDiffChars: 10, language: ' es ' })
  assert.equal(settings.provider, 'p')
  assert.equal(settings.model, 'm')
  assert.equal(settings.maxDiffChars, 1000)
  assert.equal(settings.language, 'es')

  assert.equal(normalizeSettings({ maxDiffChars: 10_000_000 }).maxDiffChars, 60_000)
  assert.equal(normalizeSettings({ maxDiffChars: 'nope' }).maxDiffChars, 12_000)
  assert.equal(normalizeSettings({}).provider, '')
})

test('clipDiff only truncates when it must, and says so', () => {
  assert.equal(clipDiff('short', 100), 'short')
  const long = 'x'.repeat(50)
  const clipped = clipDiff(long, 10)
  assert.ok(clipped.startsWith('x'.repeat(10)))
  assert.match(clipped, /diff truncated at 10 characters/)
})

test('normalizeCommitMessage strips fences, prefixes and wrapping quotes', () => {
  assert.equal(normalizeCommitMessage('feat: añade panel'), 'feat: añade panel')
  assert.equal(normalizeCommitMessage('```text\nfeat: añade panel\n```'), 'feat: añade panel')
  assert.equal(normalizeCommitMessage('Commit: fix: corrige\n\nCuerpo'), 'fix: corrige\n\nCuerpo')
  assert.equal(normalizeCommitMessage('"fix: corrige"'), 'fix: corrige')
  assert.equal(normalizeCommitMessage('a\r\n\r\n\r\n\r\nb'), 'a\n\nb')
  assert.equal(normalizeCommitMessage('   '), '')
})

test('systemPrompt asks for the configured language or follows the history', () => {
  assert.match(systemPrompt(''), /language of the existing commit subjects/)
  assert.match(systemPrompt('es'), /Write in es\./)
})

test('resolveRoute honours the configuration and falls back to the catalog', async () => {
  const llm = stubLlm()
  assert.deepEqual(await resolveRoute(llm, normalizeSettings({ provider: 'provider-a', model: 'model-z' })),
    { provider: 'provider-a', model: 'model-z' })
  assert.deepEqual(await resolveRoute(llm, SETTINGS), { provider: 'provider-a', model: 'model-a' })
})

test('resolveRoute explains a profile without a usable route', async () => {
  await assert.rejects(() => resolveRoute(stubLlm({ providers: [] }), SETTINGS), (error) => {
    assert.ok(error instanceof CommitMessageError)
    assert.equal(error.status, 503)
    return true
  })

  await assert.rejects(
    () => resolveRoute(stubLlm(), normalizeSettings({ provider: 'missing' })),
    /is not mounted/,
  )

  await assert.rejects(
    () => resolveRoute(stubLlm({ models: { 'provider-a': [] } }), SETTINGS),
    /no mounted provider advertises a model/,
  )
})

test('discovery skips a provider whose catalog is empty', async () => {
  const llm = stubLlm({
    providers: ['deepseek-official', 'deepseek-account'],
    models: { 'deepseek-official': [], 'deepseek-account': [{ id: 'deepseek-flash' }] },
  })
  assert.deepEqual(await resolveRoute(llm, SETTINGS), { provider: 'deepseek-account', model: 'deepseek-flash' })
})

test('an explicit route is used even when that provider advertises nothing', async () => {
  const llm = stubLlm({
    providers: ['deepseek-official', 'deepseek-account'],
    models: { 'deepseek-official': [], 'deepseek-account': [] },
  })
  assert.deepEqual(
    await resolveRoute(llm, SETTINGS, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
})

test('an explicit route from an unmounted provider is refused', async () => {
  await assert.rejects(
    () => resolveRoute(stubLlm(), SETTINGS, { provider: 'nope', model: 'm' }),
    /is not mounted/,
  )
})

test('generateCommitMessage streams the draft and reports the route it used', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'changed\n')
  git(dir, 'add', '-A')

  const llm = stubLlm({ chunks: [delta('feat: cambia a\n'), delta('\nDescribe el cambio.'), stop] })
  const result = await generateCommitMessage(llm, SETTINGS, dir)

  assert.equal(result.message, 'feat: cambia a\n\nDescribe el cambio.')
  assert.equal(result.provider, 'provider-a')
  assert.equal(result.model, 'model-a')

  const request = llm.calls[0]
  assert.equal(request.temperature, 0)
  assert.match(request.system, /Git commit messages/)
  assert.match(request.messages[0].content[0].text, /Changed files:/)
  assert.match(request.messages[0].content[0].text, /Staged diff:/)
})

test('generateCommitMessage prefers the route the session is using', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'changed\n')

  const llm = stubLlm({
    providers: ['deepseek-official', 'deepseek-account'],
    models: { 'deepseek-official': [], 'deepseek-account': [{ id: 'deepseek-flash' }] },
    chunks: [delta('fix: usa el modelo actual'), stop],
  })

  const result = await generateCommitMessage(llm, SETTINGS, dir, undefined, {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })

  assert.equal(result.provider, 'deepseek-account')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(llm.calls[0].provider, 'deepseek-account')
  assert.equal(llm.calls[0].model, 'deepseek-flash')
})

test('generateCommitMessage turns terminal failures into typed errors', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'changed\n')

  await assert.rejects(
    () => generateCommitMessage(stubLlm({
      chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }],
    }), SETTINGS, dir),
    /model call failed \(error AUTH\): bad key/,
  )

  await assert.rejects(
    () => generateCommitMessage(stubLlm({ chunks: [{ type: 'finish', reason: { kind: 'aborted' } }] }), SETTINGS, dir),
    /aborted/,
  )

  await assert.rejects(
    () => generateCommitMessage(stubLlm({ chunks: [delta('nunca termina')] }), SETTINGS, dir),
    /without a terminal finish/,
  )

  await assert.rejects(
    () => generateCommitMessage(stubLlm({ chunks: [stop] }), SETTINGS, dir),
    /empty message/,
  )
})

test('buildMessageContext labels the diff it used and includes the recent subjects', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'changed\n')

  const unstaged = await buildMessageContext(dir, 12_000)
  assert.match(unstaged, /Working tree diff \(nothing staged\)/)
  assert.match(unstaged, /unstaged M  a\.txt/)
  assert.match(unstaged, /Recent commit subjects:\s*init/)

  git(dir, 'add', '-A')
  const staged = await buildMessageContext(dir, 12_000)
  assert.match(staged, /Staged diff:/)
  assert.match(staged, /staged   M  a\.txt/)
})

test('buildMessageContext keeps untracked files visible and truncates the diff', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'nuevo.txt'), 'linea\n'.repeat(400))

  const untracked = await buildMessageContext(dir, 1000)
  assert.match(untracked, /untracked \?  nuevo\.txt/)
  // Git leaves untracked files out of its diffs, so there is nothing to clip yet.
  assert.doesNotMatch(untracked, /diff truncated/)

  git(dir, 'add', '-A')
  const staged = await buildMessageContext(dir, 1000)
  assert.match(staged, /Staged diff:/)
  assert.match(staged, /diff truncated at 1000 characters/)
})

test('the message route refuses foreign origins and non-JSON bodies', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  let calls = 0
  const generate = async () => { calls += 1; return { message: 'x', provider: 'p', model: 'm' } }

  const foreign = makeResponse()
  await serveMessage(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/message',
    headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: actionBody(dir, 'nope'),
  }), foreign, generate)
  assert.equal(foreign.status, 403)

  const plain = makeResponse()
  await serveMessage(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/message',
    headers: { host: HOST, 'content-type': 'text/plain' },
    body: JSON.stringify({ root: dir }),
  }), plain, generate)
  assert.equal(plain.status, 415)

  assert.equal(calls, 0)
})

test('the message route answers 503 without a model service', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))

  const res = makeResponse()
  await serveMessage(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/message',
    headers: actionHeaders(),
    body: JSON.stringify({ root: dir }),
  }), res)

  assert.equal(res.status, 503)
  assert.match(res.json().error, /no model service/)
})

test('the message route returns the draft and validates the root', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  let seen = null
  const generate = async (root, signal, route) => {
    seen = route
    return { message: `feat: ${root.length}`, provider: 'p', model: 'm' }
  }

  const ok = makeResponse()
  await serveMessage(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/message',
    headers: actionHeaders(),
    body: JSON.stringify({ root: dir, provider: 'deepseek-account', model: 'deepseek-flash' }),
  }), ok, generate)
  assert.equal(ok.status, 200)
  assert.equal(ok.json().ok, true)
  assert.equal(ok.json().provider, 'p')
  assert.deepEqual(seen, { provider: 'deepseek-account', model: 'deepseek-flash' })

  const relative = makeResponse()
  await serveMessage(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/message',
    headers: actionHeaders(),
    body: JSON.stringify({ root: 'relative/path' }),
  }), relative, generate)
  assert.equal(relative.status, 400)
  assert.match(relative.json().error, /absolute path/)

  const wrongMethod = makeResponse()
  await serveMessage(makeRequest({ url: '/dsh-source-control/message', headers: sameOriginHeaders() }), wrongMethod, generate)
  assert.equal(wrongMethod.status, 405)
})

test('the message route gives up when the model call outlives its timeout', async () => {
  const generate = (root, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted by caller')))
  })

  const res = makeResponse()
  const started = Date.now()
  await serveMessage(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/message',
    headers: actionHeaders(),
    body: JSON.stringify({ root: process.cwd() }),
  }), res, generate, 25)

  assert.equal(res.status, 504)
  assert.match(res.json().error, /timed out/)
  assert.ok(Date.now() - started < 2000)
})
