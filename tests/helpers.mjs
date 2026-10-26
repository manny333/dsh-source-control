/**
 * Test helpers: throwaway repositories and the request/response shapes the
 * route handlers actually touch (method, url, headers, body; writeHead/end).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

export const HOST = '127.0.0.1:64283'

/** Run git in `cwd` and return stdout; throws on a non-zero exit. */
export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C' },
  })
}

/** A repository with one commit and a clean working tree. */
export function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sc-test-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  // Keep bytes as written: a Windows global autocrlf would rewrite the fixtures.
  git(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

export function removeRepo(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

export function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

export function makeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
      return this
    },
    end(payload) {
      if (payload !== undefined) {
        this.body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
      }
    },
    json() {
      return this.body === '' ? null : JSON.parse(this.body)
    },
  }
}

export function stateUrl(root, limit) {
  const suffix = limit === undefined ? '' : `&limit=${limit}`
  return `/dsh-source-control/state?root=${encodeURIComponent(root)}${suffix}`
}

/** Same-origin headers a browser on the panel sends. */
export function sameOriginHeaders(extra = {}) {
  return { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin', ...extra }
}

/** Headers a POST from the panel carries. */
export function actionHeaders(extra = {}) {
  return sameOriginHeaders({ 'content-type': 'application/json', ...extra })
}

export function actionBody(root, action, extra = {}) {
  return JSON.stringify({ root, action, ...extra })
}
