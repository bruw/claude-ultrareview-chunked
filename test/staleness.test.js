import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpRepo, lines, cleanup } from './helpers/tmprepo.js'
import { layout } from '../src/paths.js'
import { readLedger, readRun, runState, TERMINAL, classifyChunk } from '../src/ledger.js'

const BIN = fileURLToPath(new URL('../bin/curc.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.js', import.meta.url))

const curc = (dir, args) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, CURC_CLAUDE_BIN: FAKE, NO_COLOR: '1' }
})

async function settle (L, ids, ms = 30000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (ids.every(id => TERMINAL.has(runState(readRun(L, id))))) return readLedger(L)
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('supervisor did not settle')
}

/** Plan, review everything, and hand back the ledger with coverage recorded. */
async function sweep (dir) {
  const L = layout(dir)
  const plan = JSON.parse(curc(dir, ['plan', '--json']).stdout)
  curc(dir, ['run', '--chunks', 'all', '--yes'])
  await settle(L, plan.chunks.map(c => c.id))
  return L
}

test('a file that moved but did not change stays covered', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a'), 'src/b.js': lines(20, 'b') })
  const L = await sweep(dir)
  assert.equal(Object.keys(readLedger(L).reviewed).length, 2)

  git('mv', 'src/a.js', 'src/renamed.js')
  git('commit', '-qm', 'rename only')

  const plan = JSON.parse(curc(dir, ['plan', '--json']).stdout)
  assert.equal(plan.chunks.length, 0, 'a pure rename must not cost another review')
  assert.equal(plan.coverage.covered, 2)
  cleanup(dir)
})

test('an edited file comes back into the plan; its untouched neighbours do not', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a'), 'src/b.js': lines(20, 'b'), 'src/c.js': lines(20, 'c') })
  const L = await sweep(dir)

  fs.writeFileSync(path.join(dir, 'src/b.js'), lines(20, 'b') + 'new logic\n')
  git('add', '-A'); git('commit', '-qm', 'edit b')

  const plan = JSON.parse(curc(dir, ['plan', '--json']).stdout)
  const paths = plan.chunks.flatMap(c => c.paths)
  assert.deepEqual(paths, ['src/b.js'])
  assert.equal(plan.coverage.covered, 2)
  cleanup(dir)
})

test('a new file is planned; chunk ids are never reused across re-plans', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  const L = await sweep(dir)
  const firstIds = readLedger(L).archive.map(a => a.id)

  fs.writeFileSync(path.join(dir, 'src/new.js'), lines(20, 'n'))
  git('add', '-A'); git('commit', '-qm', 'add new')

  const plan = JSON.parse(curc(dir, ['plan', '--json']).stdout)
  assert.deepEqual(plan.chunks.flatMap(c => c.paths), ['src/new.js'])
  for (const c of plan.chunks) {
    assert.ok(!firstIds.includes(c.id), `chunk id ${c.id} was reused — it would overwrite older findings`)
  }
  cleanup(dir)
})

test('drift is reported once HEAD moves past the plan', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  curc(dir, ['plan', '--json'])
  fs.writeFileSync(path.join(dir, 'src/z.js'), lines(5, 'z'))
  git('add', '-A'); git('commit', '-qm', 'move head')

  const plan = JSON.parse(curc(dir, ['plan', '--json']).stdout)
  assert.equal(plan.drift.state, 'drifted')
  cleanup(dir)
})

test('re-planning drops the old pending refs rather than leaking them', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a'), 'src/b.js': lines(20, 'b') })
  curc(dir, ['plan', '--json', '--max-lines', '25'])
  curc(dir, ['run', '--chunks', '1', '--dry-run'])

  fs.writeFileSync(path.join(dir, 'src/c.js'), lines(20, 'c'))
  git('add', '-A'); git('commit', '-qm', 'more')
  curc(dir, ['plan', '--json', '--max-lines', '25'])

  const refs = git('for-each-ref', '--format=%(refname:short)', 'refs/heads/curc/').stdout.trim()
  assert.equal(refs, '', `stale refs left behind: ${refs}`)
  cleanup(dir)
})

test('coverage is keyed by content, so an identical file elsewhere counts as reviewed', () => {
  const chunk = { files: [{ path: 'x/new.js', blob: 'deadbeef', lines: 3 }] }
  assert.equal(classifyChunk(chunk, { deadbeef: { path: 'y/old.js' } }), 'covered')
  assert.equal(classifyChunk(chunk, {}), 'new')
})
