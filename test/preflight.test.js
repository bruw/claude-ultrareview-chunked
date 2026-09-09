import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpRepo, lines, cleanup } from './helpers/tmprepo.js'

const BIN = fileURLToPath(new URL('../bin/claude-ultrareview-chunked.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.js', import.meta.url))

const runCli = (dir, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_ULTRAREVIEW_CHUNKED_CLAUDE_BIN: FAKE, NO_COLOR: '1', ...env }
})

test('outside a git repository, claude-ultrareview-chunked refuses before doing anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ultrareview-chunked-nogit-'))
  const r = runCli(dir, ['plan'])
  assert.equal(r.status, 3)
  assert.match(r.stderr, /must run inside a git repository/)
  cleanup(dir)
})

test('a repository with no commits is refused, with the reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ultrareview-chunked-empty-'))
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  const r = runCli(dir, ['run', '--chunks', 'all', '--yes'])
  assert.notEqual(r.status, 0)
  cleanup(dir)
})

test('a missing Claude Code is caught before any chunk is built', () => {
  const { dir } = tmpRepo({ 'a.js': lines(5) })
  runCli(dir, ['plan', '--json'])
  const r = runCli(dir, ['run', '--chunks', 'all', '--yes'], { CLAUDE_ULTRAREVIEW_CHUNKED_CLAUDE_BIN: '/nonexistent/claude' })
  assert.equal(r.status, 4)
  assert.match(r.stderr, /claude code/i)
  assert.match(r.stderr, /install Claude Code|CLAUDE_ULTRAREVIEW_CHUNKED_CLAUDE_BIN/)
  cleanup(dir)
})

test('a Claude Code without ultrareview is caught, and names the fix', () => {
  const { dir } = tmpRepo({ 'a.js': lines(5) })
  runCli(dir, ['plan', '--json'])
  const r = runCli(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_NO_ULTRAREVIEW: '1' })
  assert.equal(r.status, 4)
  assert.match(r.stderr, /claude update/)
  cleanup(dir)
})

test('being logged out is caught before spending', () => {
  const { dir } = tmpRepo({ 'a.js': lines(5) })
  runCli(dir, ['plan', '--json'])
  const r = runCli(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_LOGGED_OUT: '1' })
  assert.equal(r.status, 4)
  assert.match(r.stderr, /login/)
  cleanup(dir)
})

test('the guided mode refuses to hang when there is no terminal', () => {
  const { dir } = tmpRepo({ 'a.js': lines(5) })
  const r = runCli(dir, [])
  assert.equal(r.status, 5)
  assert.match(r.stderr, /needs a terminal/)
  cleanup(dir)
})

test('planning never invokes claude at all', () => {
  const { dir } = tmpRepo({ 'a.js': lines(5) })
  const log = path.join(dir, 'argv.log')
  const r = runCli(dir, ['plan', '--json'], { FAKE_CLAUDE_ARGV_LOG: log })
  assert.equal(r.status, 0)
  assert.ok(!fs.existsSync(log))
  cleanup(dir)
})
