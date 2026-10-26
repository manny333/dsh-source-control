import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { serveAction, serveState } from '../lib/routes.js'
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
  stateUrl,
} from './helpers.mjs'

test('state reads a clean repository', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))

  const res = makeResponse()
  await serveState(makeRequest({ url: stateUrl(dir), headers: sameOriginHeaders() }), res)

  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.status.branch, 'main')
  assert.deepEqual(body.status.staged, [])
  assert.deepEqual(body.status.unstaged, [])
  assert.equal(body.log[0].subject, 'init')
  assert.equal(body.branches[0].name, 'main')
  assert.equal(body.branches[0].current, true)
})

test('a cross-origin request never reaches git', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'dirty\n')

  const state = makeResponse()
  await serveState(makeRequest({
    url: stateUrl(dir),
    headers: { host: HOST, origin: 'https://evil.example' },
  }), state)
  assert.equal(state.status, 403)

  const action = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: actionBody(dir, 'discardAll'),
  }), action)
  assert.equal(action.status, 403)
  // Still dirty: the discardAll never ran.
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'dirty\n')
})

test('a non-JSON POST is refused, which forces a preflight a foreign page cannot pass', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'dirty\n')

  const res = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: { host: HOST, 'content-type': 'text/plain' },
    body: actionBody(dir, 'discardAll'),
  }), res)

  assert.equal(res.status, 415)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'dirty\n')
})

test('a non-loopback Host is refused', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))

  const res = makeResponse()
  await serveState(makeRequest({
    url: stateUrl(dir),
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  }), res)

  assert.equal(res.status, 403)
})

test('stage and unstage move a file between the two lists', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'changed\n')

  const staged = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'stage', { path: 'a.txt' }),
  }), staged)

  assert.equal(staged.status, 200)
  // JSON drops `origPath: undefined`, so the key is simply absent here.
  assert.deepEqual(staged.json().status.staged, [{ path: 'a.txt', status: 'M', staged: true }])

  const unstaged = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'unstage', { path: 'a.txt' }),
  }), unstaged)

  assert.deepEqual(unstaged.json().status.staged, [])
  assert.equal(unstaged.json().status.unstaged[0].path, 'a.txt')
})

test('unicode and spaced paths survive the round trip verbatim', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'informe año.txt'), 'contenido\n')
  mkdirSync(join(dir, 'carpeta ñ'))
  writeFileSync(join(dir, 'carpeta ñ', 'ñandú.txt'), 'x\n')

  const state = makeResponse()
  await serveState(makeRequest({ url: stateUrl(dir), headers: sameOriginHeaders() }), state)
  const untracked = state.json().status.untracked
  assert.deepEqual(untracked.sort(), ['carpeta ñ/', 'informe año.txt'])

  const staged = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'stage', { path: 'carpeta ñ/ñandú.txt' }),
  }), staged)

  assert.equal(staged.status, 200)
  assert.deepEqual(staged.json().status.staged.map((change) => change.path), ['carpeta ñ/ñandú.txt'])
})

test('a file name git would read as a glob stages only that file', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  // `a[1].txt` is a legal Windows name and a real glob: it matches `a1.txt`.
  writeFileSync(join(dir, 'a[1].txt'), 'bracket\n')
  writeFileSync(join(dir, 'a1.txt'), 'other\n')

  const res = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'stage', { path: 'a[1].txt' }),
  }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(res.json().status.staged.map((change) => change.path), ['a[1].txt'])
  assert.deepEqual(res.json().status.untracked, ['a1.txt'])
})

test('commit writes the message and leaves the tree clean', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'changed\n')
  git(dir, 'add', '-A')

  const res = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'commit', { message: 'feat: prueba' }),
  }), res)

  assert.equal(res.status, 200)
  assert.equal(res.json().log[0].subject, 'feat: prueba')
  assert.deepEqual(res.json().status.staged, [])
  assert.deepEqual(res.json().status.unstaged, [])
})

test('discard restores a tracked file and deletes only the untracked one', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, 'a.txt'), 'dirty\n')
  writeFileSync(join(dir, 'nuevo.txt'), 'tmp\n')

  const tracked = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'discard', { path: 'a.txt' }),
  }), tracked)

  assert.equal(tracked.status, 200)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n')
  assert.equal(existsSync(join(dir, 'nuevo.txt')), true)

  const untracked = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'discard', { path: 'nuevo.txt' }),
  }), untracked)

  assert.equal(untracked.status, 200)
  assert.equal(existsSync(join(dir, 'nuevo.txt')), false)
  assert.deepEqual(untracked.json().status.untracked, [])
})

test('discardAll clears the tree but respects ignored files', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  writeFileSync(join(dir, '.gitignore'), 'ignorado.txt\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'ignore')
  writeFileSync(join(dir, 'a.txt'), 'dirty\n')
  writeFileSync(join(dir, 'nuevo.txt'), 'tmp\n')
  writeFileSync(join(dir, 'ignorado.txt'), 'keep\n')

  const res = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'discardAll'),
  }), res)

  assert.equal(res.status, 200)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n')
  assert.equal(existsSync(join(dir, 'nuevo.txt')), false)
  assert.equal(existsSync(join(dir, 'ignorado.txt')), true)
})

test('checkout switches branch and refuses an option-looking name', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))
  git(dir, 'branch', 'demo')

  const switched = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'checkout', { name: 'demo', kind: 'local' }),
  }), switched)

  assert.equal(switched.status, 200)
  assert.equal(switched.json().status.branch, 'demo')

  const refused = makeResponse()
  await serveAction(makeRequest({
    method: 'POST',
    url: '/dsh-source-control/action',
    headers: actionHeaders(),
    body: actionBody(dir, 'checkout', { name: '-evil', kind: 'local' }),
  }), refused)

  assert.equal(refused.status, 400)
  assert.match(refused.json().error, /invalid branch name/)
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'demo')
})

test('bad input answers a 400 instead of throwing', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))

  const cases = [
    { body: actionBody('relative/path', 'fetch'), error: /absolute path/ },
    { body: actionBody(dir, 'nope'), error: /unknown action/ },
    { body: actionBody(dir, 'commit', { message: '   ' }), error: /commit message is empty/ },
    { body: actionBody(dir, 'stage', { path: 'C:\\Windows\\win.ini' }), error: /relative repository path/ },
    { body: '{oops', error: /malformed JSON/ },
  ]

  for (const entry of cases) {
    const res = makeResponse()
    await serveAction(makeRequest({
      method: 'POST',
      url: '/dsh-source-control/action',
      headers: actionHeaders(),
      body: entry.body,
    }), res)
    assert.equal(res.status, 400, `expected 400 for ${entry.body}`)
    assert.match(res.json().error, entry.error)
  }
})

test('wrong methods answer a 405 with an allow header', async (t) => {
  const dir = createRepo()
  t.after(() => removeRepo(dir))

  const getOnAction = makeResponse()
  await serveAction(makeRequest({
    url: '/dsh-source-control/action',
    headers: sameOriginHeaders(),
  }), getOnAction)
  assert.equal(getOnAction.status, 405)
  assert.equal(getOnAction.headers.allow, 'POST')

  const postOnState = makeResponse()
  await serveState(makeRequest({
    method: 'POST',
    url: stateUrl(dir),
    headers: sameOriginHeaders(),
    body: '{}',
  }), postOnState)
  assert.equal(postOnState.status, 405)
  assert.equal(postOnState.headers.allow, 'GET')
})
