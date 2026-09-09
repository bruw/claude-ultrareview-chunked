import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpRepo, lines, cleanup } from './helpers/tmprepo.js'
import { layout } from '../src/paths.js'
import { readLedger, classifyChunk } from '../src/ledger.js'
import { settle } from './helpers/settle.js'

const BIN = fileURLToPath(new URL('../bin/curc.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.js', import.meta.url))

const curc = (dir, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, CURC_CLAUDE_BIN: FAKE, NO_COLOR: '1', ...env }
})


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

/**
 * Exit 0 with a payload nobody can parse still counts as coverage — gating it
 * would quietly re-bill the chunk on the next plan. But it is not a clean
 * result either, so it has to be visible rather than showing up as a reviewed
 * chunk with "?" findings.
 */
test('an unparseable payload still covers, and says so', async () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  const L = layout(dir)
  const plan = JSON.parse(curc(dir, ['plan', '--json']).stdout)
  const id = plan.chunks[0].id
  assert.equal(curc(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_MODE: 'garbage' }).status, 0)
  await settle(L, [id])

  const ledger = readLedger(L)
  assert.equal(Object.keys(ledger.reviewed).length, 1, 'coverage is kept, so nothing silently re-bills')

  const status = JSON.parse(curc(dir, ['status', '--json']).stdout)
  const done = status.completed.find(r => r.id === id)
  assert.equal(done.findingsParsed, false, 'but the payload failure is on the record')
  assert.equal(done.findings, null)

  // A re-plan must not propose it again — that is what "still covers" means.
  assert.equal(JSON.parse(curc(dir, ['plan', '--json']).stdout).chunks.length, 0)
  cleanup(dir)
})

test('a chunk that may already have been billed is not re-run without --force', async () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(20, 'a'), 'src/b.js': lines(20, 'b') })
  const L = layout(dir)
  const plan = JSON.parse(curc(dir, ['plan', '--json']).stdout)
  const id = plan.chunks[0].id

  // An orphan: a review whose supervisor died while it was in flight. The
  // cloud side does not care that curc lost track, so it may already be paid.
  const { writeRun } = await import('../src/ledger.js')
  writeRun(L, id, { chunkId: id, runId: 'r-gone', startedAt: new Date().toISOString(), supervisorPid: 2 ** 30 })

  const refused = curc(dir, ['run', '--chunks', String(id), '--yes'])
  assert.equal(refused.status, 6)
  assert.match(refused.stderr, /may already have been billed/)
  assert.match(refused.stderr, /--force/)

  const forced = curc(dir, ['run', '--chunks', String(id), '--yes', '--force', '--dry-run'])
  assert.equal(forced.status, 0, '--force is the documented way through')
  cleanup(dir)
})

test('a ledger from another version says so instead of looking like a fresh repo', () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  const L = layout(dir)
  curc(dir, ['plan', '--json'])
  const l = JSON.parse(fs.readFileSync(L.ledger, 'utf8'))
  fs.writeFileSync(L.ledger, JSON.stringify({ ...l, version: 99 }))

  const r = curc(dir, ['status'])
  assert.equal(r.status, 0)
  assert.match(r.stderr, /version 99/)
  assert.doesNotMatch(r.stderr, /no plan yet/, 'a paid-for record must not read as "never planned"')
  cleanup(dir)
})

/**
 * The claim file is never released by the supervisor, so before this a chunk
 * whose review failed could not be retried at all: `--force` got past the
 * "may already have been billed" check and then came back `already-claimed`
 * from inside the run, where nobody was looking.
 */
test('a failed chunk is refused without --force, and actually re-runs with it', async () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  const L = layout(dir)
  const plan = JSON.parse(curc(dir, ['plan', '--json']).stdout)
  const id = plan.chunks[0].id

  curc(dir, ['run', '--chunks', String(id), '--yes'], { FAKE_CLAUDE_MODE: 'fail' })
  await settle(L, [id])
  const { readRun, runState, isClaimed } = await import('../src/ledger.js')
  assert.equal(runState(readRun(L, id)), 'failed')
  assert.equal(isClaimed(L, id), true, 'the review was launched, so the chunk is claimed')

  const refused = curc(dir, ['run', '--chunks', String(id), '--yes'])
  assert.equal(refused.status, 6)
  assert.match(refused.stderr, /may already have been billed/)

  curc(dir, ['run', '--chunks', String(id), '--yes', '--force'])
  const ledger = await settle(L, [id])
  const rec = readRun(L, id)
  assert.equal(runState(rec), 'done', `--force must reach the review, not stop at the claim: ${JSON.stringify(rec)}`)
  assert.notEqual(rec.reason, 'already-claimed')
  assert.equal(ledger.archive.length, 1, 'the forced review records coverage like any other')
  cleanup(dir)
})
