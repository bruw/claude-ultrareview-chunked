import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { tmpRepo, lines, cleanup } from './helpers/tmprepo.js'
import { layout } from '../src/paths.js'
import { lockState, acquire, release } from '../src/lock.js'
import { stopAll } from '../src/supervisor.js'

const BIN = fileURLToPath(new URL('../bin/curc.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.js', import.meta.url))
const ENV = { CURC_CLAUDE_BIN: FAKE, NO_COLOR: '1' }

const curc = (dir, args, env = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ...ENV, ...env }
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

/** Two `curc run` at once, started as close together as the OS allows. */
function raceTwoRuns (dir, env) {
  const start = args => new Promise(resolve => {
    const c = spawn(process.execPath, [BIN, ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, ...ENV, ...env }
    })
    let err = ''
    c.stderr.on('data', d => { err += d })
    c.stdout.resume()
    c.on('close', code => resolve({ code, err }))
  })
  return Promise.all([
    start(['run', '--chunks', 'all', '--yes']),
    start(['run', '--chunks', 'all', '--yes'])
  ])
}

/**
 * The regression test for the whole launch design.
 *
 * The lock used to be taken by the detached child, while the parent only
 * *checked* it before spawning — a window wide enough for two `curc run --yes`
 * to both pass the check and both launch. At $5-$25 a review, that window is
 * the most expensive line in the program.
 */
test('two runs launched at once bill every chunk exactly once', async () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20, 'a'), 'b/1.js': lines(20, 'b'), 'c/1.js': lines(20, 'c') })
  const L = layout(dir)
  const log = path.join(dir, 'argv.log')
  const plan = JSON.parse(curc(dir, ['plan', '--json', '--max-lines', '25']).out)
  assert.equal(plan.chunks.length, 3)

  const [a, b] = await raceTwoRuns(dir, { FAKE_CLAUDE_ARGV_LOG: log, FAKE_CLAUDE_DELAY_MS: '250' })
  const codes = [a.code, b.code].sort()
  assert.deepEqual(codes, [0, 6], `exactly one launch may win — got ${JSON.stringify([a, b])}`)

  const { settle } = await import('./helpers/settle.js')
  await settle(L, plan.chunks.map(c => c.id))

  const billed = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(billed.length, plan.chunks.length, 'no chunk may be reviewed twice')
  assert.equal(new Set(billed.map(i => i.argv[1])).size, plan.chunks.length)
  cleanup(dir)
})

test('a chunk already claimed is skipped rather than reviewed again', async () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20, 'a'), 'b/1.js': lines(20, 'b') })
  const L = layout(dir)
  const log = path.join(dir, 'argv.log')
  const plan = JSON.parse(curc(dir, ['plan', '--json', '--max-lines', '25']).out)
  const [first, second] = plan.chunks.map(c => c.id)

  // Stand in for a chunk an earlier run already paid for.
  fs.mkdirSync(L.runs, { recursive: true })
  fs.writeFileSync(path.join(L.runs, `${String(first).padStart(4, '0')}.claim`), '')

  // The parent sees the claim and refuses the whole spend without --force.
  const refused = curc(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_ARGV_LOG: log })
  assert.equal(refused.code, 6)
  assert.match(refused.err, /may already have been billed/)
  assert.equal(fs.existsSync(log), false, 'nothing was launched')

  // The supervisor's own guard is the last line, and holds even when the
  // parent's check is bypassed — here by calling launch() directly, which is
  // what a claim appearing between the parent's check and the spawn looks like.
  Object.assign(process.env, ENV, { FAKE_CLAUDE_ARGV_LOG: log })
  try {
    const { launch } = await import('../src/supervisor.js')
    assert.equal(launch(L, { chunkIds: [first, second], concurrency: 2, timeout: 1 }).ok, true)
  } finally { for (const k of [...Object.keys(ENV), 'FAKE_CLAUDE_ARGV_LOG']) delete process.env[k] }
  const { settle } = await import('./helpers/settle.js')
  await settle(L, [first, second])

  const billed = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(billed.length, 1, 'only the unclaimed chunk may be reviewed')
  assert.match(billed[0].argv[1], new RegExp(String(second).padStart(4, '0')))
  cleanup(dir)
})

/* ---- the predicate ------------------------------------------------------- */

test('a live-but-stalled supervisor still counts as in flight', () => {
  const { dir } = tmpRepo({ 'a.js': lines(4) })
  const L = layout(dir)
  fs.mkdirSync(L.home, { recursive: true })
  // Our own pid is certainly alive; backdate the heartbeat well past the window.
  fs.writeFileSync(L.lock, JSON.stringify({ runId: 'r-stalled', pid: process.pid }))
  const old = new Date(Date.now() - 600_000)
  fs.utimesSync(L.lock, old, old)

  const held = lockState(L)
  assert.equal(held.alive, true, 'a stalled heartbeat must not make a live run look finished')
  assert.equal(held.stalled, true, 'but it is worth saying out loud')

  // …and the commands that delete things defer to it.
  assert.equal(curc(dir, ['plan', '--json']).code, 6)
  assert.equal(curc(dir, ['clean', '--yes']).code, 6)
  cleanup(dir)
})

test('a dead holder with a fresh heartbeat is still not reclaimed automatically', () => {
  const { dir } = tmpRepo({ 'a.js': lines(4) })
  const L = layout(dir)
  fs.mkdirSync(L.home, { recursive: true })
  fs.writeFileSync(L.lock, JSON.stringify({ runId: 'r-dead', pid: 2 ** 30 }))

  assert.equal(lockState(L).alive, true, 'quiet for less than a minute is not evidence of death')
  const r = curc(dir, ['plan', '--json'])
  assert.equal(r.code, 6)
  cleanup(dir)
})

test('curc unlock is the way out, and refuses a holder that looks alive', () => {
  const { dir } = tmpRepo({ 'a.js': lines(4) })
  const L = layout(dir)
  fs.mkdirSync(L.home, { recursive: true })
  fs.writeFileSync(L.lock, JSON.stringify({ runId: 'r-alive', pid: process.pid }))

  assert.equal(curc(dir, ['unlock']).code, 6)
  assert.ok(fs.existsSync(L.lock))

  const forced = curc(dir, ['unlock', '--yes'])
  assert.equal(forced.code, 0)
  assert.ok(!fs.existsSync(L.lock))
  assert.equal(curc(dir, ['plan', '--json']).code, 0, 'the repo is usable again')
  cleanup(dir)
})

test('acquire refuses rather than reclaiming, and release only drops our own', () => {
  const { dir } = tmpRepo({ 'a.js': lines(4) })
  const L = layout(dir)
  fs.mkdirSync(L.home, { recursive: true })

  const mine = acquire(L, 'r-one', 1234)
  assert.equal(mine.ok, true)
  fs.closeSync(mine.fd)

  const theirs = acquire(L, 'r-two', 5678)
  assert.equal(theirs.ok, false)
  assert.equal(theirs.reason, 'in-flight')

  assert.equal(release(L, 'r-two'), false, 'a stranger may not release a lock')
  assert.ok(fs.existsSync(L.lock))
  assert.equal(release(L, 'r-one'), true)
  assert.ok(!fs.existsSync(L.lock))
  cleanup(dir)
})

/* ---- stop ---------------------------------------------------------------- */

/**
 * `kill(-0, …)` signals the caller's own process group, and -0 is a perfectly
 * valid integer, so a lock record without a usable pid must never reach the
 * negation. Getting this wrong makes `curc stop` terminate the shell it was
 * typed into.
 */
test('stop refuses a lock record with no usable pid instead of signalling itself', async () => {
  const { dir } = tmpRepo({ 'a.js': lines(4) })
  const L = layout(dir)
  fs.mkdirSync(L.home, { recursive: true })

  // A sentinel in this process group that must survive the call.
  const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 3000)'], { stdio: 'ignore' })
  const died = new Promise(resolve => sentinel.on('close', (_, sig) => resolve(sig)))

  for (const pid of [null, 0, -0, 'nonsense', undefined]) {
    fs.writeFileSync(L.lock, JSON.stringify({ runId: 'r-x', pid }))
    const r = stopAll(L)
    assert.equal(r.stopped, false, `pid ${JSON.stringify(pid)} must not be signalled`)
  }

  assert.equal(sentinel.killed, false)
  sentinel.kill('SIGKILL')
  await died
  cleanup(dir)
})

test('stop reports honestly when there is nothing to signal', () => {
  const { dir } = tmpRepo({ 'a.js': lines(4) })
  const L = layout(dir)
  assert.deepEqual(stopAll(L), { stopped: false, reason: 'no supervisor running' })

  fs.mkdirSync(L.home, { recursive: true })
  fs.writeFileSync(L.lock, JSON.stringify({ runId: 'r-gone', pid: 2 ** 30 }))
  const r = stopAll(L)
  assert.equal(r.stopped, false, 'a pid that cannot be signalled is not a stop')
  assert.match(r.reason, /could not signal/)
  cleanup(dir)
})

/* ---- the supervisor entry point ------------------------------------------ */

test('__supervise refuses a run it does not own, and one with no id', () => {
  const { dir } = tmpRepo({ 'a.js': lines(4) })
  const L = layout(dir)
  curc(dir, ['plan', '--json'])
  fs.mkdirSync(L.home, { recursive: true })
  fs.writeFileSync(L.lock, JSON.stringify({ runId: 'r-someone-else', pid: process.pid }))
  const before = fs.readFileSync(L.lock, 'utf8')

  assert.notEqual(curc(dir, ['__supervise', 'r-not-mine']).code, 0)
  assert.equal(fs.readFileSync(L.lock, 'utf8'), before, 'it must not touch a lock it does not hold')
  assert.notEqual(curc(dir, ['__supervise']).code, 0)
  cleanup(dir)
})

test('run ids do not collide within the same second', () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20, 'a'), 'b/1.js': lines(20, 'b') })
  const L = layout(dir)
  curc(dir, ['plan', '--json', '--max-lines', '25'])

  // Two ids minted back to back; the timestamp alone has one-second resolution.
  // --force because the first launch leaves its chunks in flight, which the
  // may-already-be-billed guard is quite right to refuse on the second pass.
  const ids = new Set()
  for (let i = 0; i < 2; i++) {
    const r = JSON.parse(curc(dir, ['run', '--chunks', 'all', '--yes', '--force', '--json']).out)
    ids.add(r.runId)
    stopAll(L)
    fs.rmSync(L.lock, { force: true })
  }
  assert.equal(ids.size, 2, 'a shared id means a shared queue file')
  cleanup(dir)
})

/* ---- the watchdog -------------------------------------------------------- */

/**
 * claude takes its own --timeout, but nothing made it keep to one: a review
 * that never returned held a concurrency slot and the lock for as long as the
 * process lived, and `runState`'s 'timeout' branch was unreachable code.
 */
test('a review that never returns is killed and recorded as a timeout', async () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20, 'a') })
  const L = layout(dir)
  const plan = JSON.parse(curc(dir, ['plan', '--json']).out)
  const id = plan.chunks[0].id

  assert.equal(curc(dir, ['run', '--chunks', 'all', '--yes'], {
    FAKE_CLAUDE_DELAY_MS: '600000', // a review that will never come back
    CURC_WATCHDOG_MS: '700'
  }).code, 0)

  const { settle } = await import('./helpers/settle.js')
  await settle(L, [id], 20000)

  const { readRun, runState } = await import('../src/ledger.js')
  const rec = readRun(L, id)
  assert.equal(rec.reason, 'timeout')
  assert.equal(runState(rec), 'timeout', "the 'timeout' state was unreachable before")
  assert.equal(lockState(L), null, 'a hung review must not keep the lock forever')

  const ledger = JSON.parse(fs.readFileSync(L.ledger, 'utf8'))
  assert.equal(Object.keys(ledger.reviewed).length, 0, 'a killed review is not coverage')
  cleanup(dir)
})

test('a stopped review reads as interrupted rather than failed', async () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20, 'a') })
  const L = layout(dir)
  const plan = JSON.parse(curc(dir, ['plan', '--json']).out)
  const id = plan.chunks[0].id

  assert.equal(curc(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_DELAY_MS: '10000' }).code, 0)
  // Wait for the review to actually be in flight before stopping it.
  const until = Date.now() + 10000
  while (Date.now() < until && !lockState(L)?.pid) await new Promise(resolve => setTimeout(resolve, 50))
  await new Promise(resolve => setTimeout(resolve, 400))

  assert.equal(curc(dir, ['stop']).code, 0)
  const { settle } = await import('./helpers/settle.js')
  await settle(L, [id], 20000)

  const { readRun, runState } = await import('../src/ledger.js')
  const rec = readRun(L, id)
  assert.equal(runState(rec), 'interrupted', `SIGTERM is 143, not 130 — got ${JSON.stringify(rec)}`)
  cleanup(dir)
})

/* ---- an unreadable lock file --------------------------------------------- */

/**
 * `acquire` opens the file with `wx` and then writes it, so for a moment the
 * lock exists and is empty — and a crash in that moment leaves it that way.
 * Reading an empty or corrupt lock as "no lock" used to send `acquire` into
 * unbounded recursion, and let `plan` and `clean --yes` walk past it.
 */
test('an empty lock file is held while fresh, stale once quiet, and never a stack overflow', () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(20, 'a') })
  const L = layout(dir)
  curc(dir, ['plan', '--json'])
  fs.writeFileSync(L.lock, '')

  const fresh = lockState(L)
  assert.equal(fresh.state, 'unreadable')
  assert.equal(fresh.alive, true, 'a fresh unreadable lock is somebody mid-acquire')
  const refused = acquire(L, 'r-new', 1)
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'in-flight')

  const busy = curc(dir, ['run', '--chunks', 'all', '--yes'])
  assert.equal(busy.code, 6, 'run refuses rather than recursing')

  const old = new Date(Date.now() - 5 * 60_000)
  fs.utimesSync(L.lock, old, old)
  const quiet = lockState(L)
  assert.equal(quiet.state, 'stale')
  assert.equal(quiet.alive, false)

  const cleared = curc(dir, ['unlock'])
  assert.equal(cleared.code, 0)
  assert.equal(fs.existsSync(L.lock), false, 'unlock removes a lock it cannot read')
  cleanup(dir)
})

/**
 * `curc stop` drained the queue but left every not-yet-started chunk's record
 * saying 'queued', with no supervisor behind it: unselectable in the guided
 * flow, and refused on the CLI as a chunk that may already have been billed.
 */
test('a stop leaves never-started chunks pending, not queued forever', async () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20, 'a'), 'b/1.js': lines(20, 'b'), 'c/1.js': lines(20, 'c') })
  const L = layout(dir)
  const plan = JSON.parse(curc(dir, ['plan', '--json', '--max-lines', '25']).out)
  const ids = plan.chunks.map(c => c.id)

  assert.equal(curc(dir, ['run', '--chunks', 'all', '--yes', '--concurrency', '1'], { FAKE_CLAUDE_DELAY_MS: '10000' }).code, 0)
  const until = Date.now() + 10000
  while (Date.now() < until && !lockState(L)?.pid) await new Promise(resolve => setTimeout(resolve, 50))
  await new Promise(resolve => setTimeout(resolve, 400))
  stopAll(L)
  const gone = Date.now() + 10000
  while (Date.now() < gone && lockState(L)) await new Promise(resolve => setTimeout(resolve, 50))

  const { readRun, runState } = await import('../src/ledger.js')
  const states = ids.map(id => runState(readRun(L, id)))
  assert.equal(states[0], 'interrupted')
  assert.deepEqual(states.slice(1), ['pending', 'pending'], 'chunks the stop reached first were never launched')

  const again = curc(dir, ['run', '--chunks', ids.slice(1).join(','), '--yes', '--dry-run'])
  assert.equal(again.code, 0, `never-launched chunks are not "may already have been billed": ${again.err}`)
  cleanup(dir)
})

/**
 * Planning deletes every pending chunk's refs and worktree. It used to check
 * the lock and then survey, and a run that started during the survey had its
 * review torn down mid-flight. Now the plan holds the lock itself.
 */
test('a run cannot start while a plan is being made, and a plan cannot start under a run', async () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20, 'a') })
  const L = layout(dir)
  curc(dir, ['plan', '--json'])

  const { withLock } = await import('../src/lock.js')
  const r = await withLock(L, 'plan-test', async () => {
    const run = curc(dir, ['run', '--chunks', 'all', '--yes'])
    assert.equal(run.code, 6, 'the plan lock refuses a run')
    assert.match(run.err, /in flight/)
    return 'done'
  })
  assert.equal(r.value, 'done')
  assert.equal(lockState(L), null, 'the plan releases its lock')

  assert.equal(curc(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_DELAY_MS: '3000' }).code, 0)
  const until = Date.now() + 10000
  while (Date.now() < until && !lockState(L)?.pid) await new Promise(resolve => setTimeout(resolve, 50))
  const plan = curc(dir, ['plan', '--json'])
  assert.equal(plan.code, 6, 'a run in flight refuses a plan')
  stopAll(L)
  const gone = Date.now() + 10000
  while (Date.now() < gone && lockState(L)) await new Promise(resolve => setTimeout(resolve, 50))
  cleanup(dir)
})
