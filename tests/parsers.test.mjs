import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertBranchName,
  literalPath,
  parseBranches,
  parseLog,
  parseStatus,
  redact,
  statusArgs,
} from '../lib/git.js'

test('status is asked for in NUL form, so git never quotes a path', () => {
  assert.deepEqual(statusArgs(), ['status', '--porcelain=v2', '--branch', '-z'])
})

test('parseStatus reads NUL records and keeps unicode paths verbatim', () => {
  const raw = [
    '# branch.oid 1111111111111111111111111111111111111111',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -3',
    '1 .M N... 100644 100644 100644 aaaa bbbb año.txt',
    '1 MM N... 100644 100644 100644 aaaa bbbb one two.txt',
    '2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt',
    'old name.txt',
    '? untracked ñ.txt',
    '',
  ].join('\0')

  const status = parseStatus(raw, '/repo')

  assert.equal(status.branch, 'main')
  assert.equal(status.upstream, 'origin/main')
  assert.equal(status.ahead, 2)
  assert.equal(status.behind, 3)
  assert.deepEqual(status.staged, [
    { path: 'one two.txt', origPath: undefined, status: 'M', staged: true },
    { path: 'new name.txt', origPath: 'old name.txt', status: 'R', staged: true },
  ])
  assert.deepEqual(status.unstaged, [
    { path: 'año.txt', origPath: undefined, status: 'M', staged: false },
    { path: 'one two.txt', origPath: undefined, status: 'M', staged: false },
  ])
  assert.deepEqual(status.untracked, ['untracked ñ.txt'])
})

test('parseStatus still reads newline records, where a rename uses a TAB', () => {
  const raw = [
    '# branch.head feature',
    '2 R. N... 100644 100644 100644 aaaa bbbb R100 nuevo.txt\tviejo.txt',
    '',
  ].join('\n')

  const status = parseStatus(raw)

  assert.equal(status.branch, 'feature')
  assert.deepEqual(status.staged, [
    { path: 'nuevo.txt', origPath: 'viejo.txt', status: 'R', staged: true },
  ])
})

test('parseStatus reports a conflict and a detached HEAD', () => {
  const raw = [
    '# branch.head (detached)',
    'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicto.txt',
    '',
  ].join('\0')

  const status = parseStatus(raw)

  assert.equal(status.branch, null)
  assert.equal(status.mergeState, 'unmerged')
  assert.equal(status.operationInProgress, true)
  assert.deepEqual(status.unstaged, [{ path: 'conflicto.txt', status: 'U', staged: false }])
})

test('parseStatus keeps a path with several consecutive spaces', () => {
  const status = parseStatus('1 .M N... 100644 100644 100644 a b dos  espacios.txt\0')
  assert.equal(status.unstaged[0].path, 'dos  espacios.txt')
})

test('parseLog splits the record and field separators', () => {
  const raw = 'aaa\x1fa1\x1ffeat: one\x1fAna\x1f2026-01-01T00:00:00-06:00\x1fHEAD -> main\x1e\n' +
    'bbb\x1fb1\x1ffix: two\x1fLuis\x1f2026-01-02T00:00:00-06:00\x1f\x1e'

  const entries = parseLog(raw)

  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], {
    sha: 'aaa',
    shortSha: 'a1',
    subject: 'feat: one',
    author: 'Ana',
    date: '2026-01-01T00:00:00-06:00',
    refs: 'HEAD -> main',
  })
  assert.equal(entries[1].refs, '')
})

test('parseBranches keeps locals first, marks the current one, and flags a gone upstream', () => {
  const raw = [
    'refs/heads/main\0*\0origin/main\0[ahead 1]',
    'refs/heads/rama-demo\0 \0origin/rama-demo\0[gone]',
    'refs/remotes/origin/main\0 \0\0',
    'refs/remotes/origin/HEAD\0 \0\0',
  ].join('\n')

  const branches = parseBranches(raw)

  assert.deepEqual(branches.map(b => b.name), ['main', 'rama-demo', 'origin/main'])
  assert.equal(branches[0].current, true)
  assert.equal(branches[0].ahead, 1)
  assert.equal(branches[1].gone, true)
  assert.equal(branches[2].kind, 'remote')
  assert.equal(branches[2].branch, 'main')
})

test('assertBranchName accepts unicode and refuses what git refuses', () => {
  for (const name of ['main', 'feature/año', 'release/1.0', 'user.name+tag@host']) {
    assert.equal(assertBranchName(name), name)
  }
  for (const name of ['', '-evil', 'a..b', 'a b', 'a~b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b',
    'x.lock', 'a/.lock', 'x/', '/x', 'x@{y', 'x.', 'a//b', 42]) {
    assert.throws(() => assertBranchName(name), /invalid branch name/)
  }
})

test('literalPath never lets a file name act as a glob or pathspec magic', () => {
  assert.equal(literalPath('a*b.txt'), ':(literal)a*b.txt')
  assert.equal(literalPath(':x'), ':(literal):x')
})

test('redact removes credentials a remote URL could carry', () => {
  assert.equal(
    redact('fatal: unable to access https://user:token@github.com/o/r.git'),
    'fatal: unable to access https://[credentials]@github.com/o/r.git',
  )
  assert.equal(redact('https://[credentials]@github.com/o/r.git'), 'https://[credentials]@github.com/o/r.git')
})
