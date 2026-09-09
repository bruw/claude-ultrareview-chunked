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

const BIN = fileURLToPath(new URL('../bin/claude-ultrareview-chunked.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.js', import.meta.url))

const runCli = (dir, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_ULTRAREVIEW_CHUNKED_CLAUDE_BIN: FAKE, NO_COLOR: '1', ...env }
})

/** Plan, review everything, and hand back the ledger with coverage recorded. */
async function sweep (dir) {
  const L = layout(dir)
  const plan = JSON.parse(runCli(dir, ['plan', '--json']).stdout)
  runCli(dir, ['run', '--chunks', 'all', '--yes'])
  await settle(L, plan.chunks.map(c => c.id))
  return L
}

test('a file that moved but did not change stays covered', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a'), 'src/b.js': lines(20, 'b') })
  const L = await sweep(dir)
  assert.equal(Object.keys(readLedger(L).reviewed).length, 2)

  git('mv', 'src/a.js', 'src/renamed.js')
  git('commit', '-qm', 'rename only')

  const plan = JSON.parse(runCli(dir, ['plan', '--json']).stdout)
  assert.equal(plan.chunks.length, 0, 'a pure rename must not cost another review')
  assert.equal(plan.coverage.covered, 2)
  cleanup(dir)
})

test('an edited file comes back into the plan; its untouched neighbours do not', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a'), 'src/b.js': lines(20, 'b'), 'src/c.js': lines(20, 'c') })
  await sweep(dir)

  fs.writeFileSync(path.join(dir, 'src/b.js'), lines(20, 'b') + 'new logic\n')
  git('add', '-A'); git('commit', '-qm', 'edit b')

  const plan = JSON.parse(runCli(dir, ['plan', '--json']).stdout)
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

  const plan = JSON.parse(runCli(dir, ['plan', '--json']).stdout)
  assert.deepEqual(plan.chunks.flatMap(c => c.paths), ['src/new.js'])
  for (const c of plan.chunks) {
    assert.ok(!firstIds.includes(c.id), `chunk id ${c.id} was reused — it would overwrite older findings`)
  }
  cleanup(dir)
})

test('drift is reported once HEAD moves past the plan', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  runCli(dir, ['plan', '--json'])
  fs.writeFileSync(path.join(dir, 'src/z.js'), lines(5, 'z'))
  git('add', '-A'); git('commit', '-qm', 'move head')

  const status = JSON.parse(runCli(dir, ['status', '--json']).stdout)
  assert.equal(status.drift.state, 'drifted')

  // A plan just made cannot be behind HEAD, and must not say it is: the skill
  // reads 'drifted' as "offer a re-plan", which would loop.
  const plan = JSON.parse(runCli(dir, ['plan', '--json']).stdout)
  assert.equal(plan.drift.state, 'fresh')
  assert.equal(JSON.parse(runCli(dir, ['status', '--json']).stdout).drift.state, 'fresh')
  cleanup(dir)
})

test('re-planning drops the old pending refs rather than leaking them', async () => {
  const { dir, git } = tmpRepo({ 'src/a.js': lines(20, 'a'), 'src/b.js': lines(20, 'b') })
  runCli(dir, ['plan', '--json', '--max-lines', '25'])
  runCli(dir, ['run', '--chunks', '1', '--dry-run'])

  fs.writeFileSync(path.join(dir, 'src/c.js'), lines(20, 'c'))
  git('add', '-A'); git('commit', '-qm', 'more')
  runCli(dir, ['plan', '--json', '--max-lines', '25'])

  const refs = git('for-each-ref', '--format=%(refname:short)', 'refs/heads/claude-ultrareview-chunked/').stdout.trim()
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
  const plan = JSON.parse(runCli(dir, ['plan', '--json']).stdout)
  const id = plan.chunks[0].id
  assert.equal(runCli(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_MODE: 'garbage' }).status, 0)
  await settle(L, [id])

  const ledger = readLedger(L)
  assert.equal(Object.keys(ledger.reviewed).length, 1, 'coverage is kept, so nothing silently re-bills')

  const status = JSON.parse(runCli(dir, ['status', '--json']).stdout)
  const done = status.completed.find(r => r.id === id)
  assert.equal(done.findingsParsed, false, 'but the payload failure is on the record')
  assert.equal(done.findings, null)

  // A re-plan must not propose it again — that is what "still covers" means.
  assert.equal(JSON.parse(runCli(dir, ['plan', '--json']).stdout).chunks.length, 0)
  cleanup(dir)
})

test('a chunk that may already have been billed is not re-run without --force', async () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(20, 'a'), 'src/b.js': lines(20, 'b') })
  const L = layout(dir)
  const plan = JSON.parse(runCli(dir, ['plan', '--json']).stdout)
  const id = plan.chunks[0].id

  // An orphan: a review whose supervisor died while it was in flight. The
  // cloud side does not care that claude-ultrareview-chunked lost track, so it may already be paid.
  const { writeRun } = await import('../src/ledger.js')
  writeRun(L, id, { chunkId: id, runId: 'r-gone', startedAt: new Date().toISOString(), supervisorPid: 2 ** 30 })

  const refused = runCli(dir, ['run', '--chunks', String(id), '--yes'])
  assert.equal(refused.status, 6)
  assert.match(refused.stderr, /may already have been billed/)
  assert.match(refused.stderr, /--force/)

  const forced = runCli(dir, ['run', '--chunks', String(id), '--yes', '--force', '--dry-run'])
  assert.equal(forced.status, 0, '--force is the documented way through')
  cleanup(dir)
})

test('a ledger from another version says so instead of looking like a fresh repo', () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  const L = layout(dir)
  runCli(dir, ['plan', '--json'])
  const l = JSON.parse(fs.readFileSync(L.ledger, 'utf8'))
  fs.writeFileSync(L.ledger, JSON.stringify({ ...l, version: 99 }))

  const r = runCli(dir, ['status'])
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
  const plan = JSON.parse(runCli(dir, ['plan', '--json']).stdout)
  const id = plan.chunks[0].id

  runCli(dir, ['run', '--chunks', String(id), '--yes'], { FAKE_CLAUDE_MODE: 'fail' })
  await settle(L, [id])
  const { readRun, runState, isClaimed } = await import('../src/ledger.js')
  assert.equal(runState(readRun(L, id)), 'failed')
  assert.equal(isClaimed(L, id), true, 'the review was launched, so the chunk is claimed')

  const refused = runCli(dir, ['run', '--chunks', String(id), '--yes'])
  assert.equal(refused.status, 6)
  assert.match(refused.stderr, /may already have been billed/)

  runCli(dir, ['run', '--chunks', String(id), '--yes', '--force'])
  const ledger = await settle(L, [id])
  const rec = readRun(L, id)
  assert.equal(runState(rec), 'done', `--force must reach the review, not stop at the claim: ${JSON.stringify(rec)}`)
  assert.notEqual(rec.reason, 'already-claimed')
  assert.equal(ledger.archive.length, 1, 'the forced review records coverage like any other')
  cleanup(dir)
})

/**
 * The claim is keyed by chunk id and a re-plan mints new ids, so the same
 * content used to come back unclaimed: one re-plan between a failed review
 * and the next `claude-ultrareview-chunked run` was enough to launch it again with no --force.
 */
test('a re-plan does not forget that a chunk\'s content was launched before', async () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  const L = layout(dir)
  const first = JSON.parse(runCli(dir, ['plan', '--json']).stdout).chunks[0].id
  runCli(dir, ['run', '--chunks', String(first), '--yes'], { FAKE_CLAUDE_MODE: 'fail' })
  await settle(L, [first])

  const second = JSON.parse(runCli(dir, ['plan', '--json']).stdout).chunks[0].id
  assert.notEqual(second, first, 'a re-plan mints a new id')

  const refused = runCli(dir, ['run', '--chunks', String(second), '--yes'])
  assert.equal(refused.status, 6, 'the new id still carries the old launch')
  assert.match(refused.stderr, /may already have been billed/)
  assert.equal(runCli(dir, ['run', '--chunks', String(second), '--yes', '--force', '--dry-run']).status, 0)
  cleanup(dir)
})
