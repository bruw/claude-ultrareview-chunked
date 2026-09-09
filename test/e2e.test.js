import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpRepo, lines, cleanup } from './helpers/tmprepo.js'
import { layout } from '../src/paths.js'
import { readLedger, readRun, runState, TERMINAL } from '../src/ledger.js'

const BIN = fileURLToPath(new URL('../bin/curc.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.js', import.meta.url))

function curc (dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CURC_CLAUDE_BIN: FAKE, NO_COLOR: '1', ...env }
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

function repo () {
  return tmpRepo({
    'src/a.js': lines(30, 'a'),
    'src/b.js': lines(30, 'b'),
    'lib/c.js': lines(30, 'c')
  })
}

/**
 * The supervisor is detached, so tests wait on the filesystem exactly as
 * `status` does. Waiting on the lock file would race: it does not exist yet in
 * the moment between `run` returning and the supervisor starting.
 */
async function settle (L, ids, ms = 30000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const done = ids.filter(id => TERMINAL.has(runState(readRun(L, id))))
    if (done.length === ids.length) return readLedger(L)
    await new Promise(r => setTimeout(r, 100))
  }
  const states = ids.map(id => `${id}:${runState(readRun(L, id))}`).join(' ')
  throw new Error(`supervisor did not settle — ${states}`)
}

test('plan is free and reports what it dropped', () => {
  const { dir } = repo()
  const r = curc(dir, ['plan', '--json', '--max-lines', '40'])
  assert.equal(r.code, 0)
  const plan = JSON.parse(r.out)
  assert.equal(plan.totals.files, 3)
  assert.ok(plan.chunks.length >= 3)
  assert.deepEqual(plan.coverage, { files: 3, covered: 0, coveredLines: 0 })
  cleanup(dir)
})

test('run without --yes refuses and bills nothing', () => {
  const { dir } = repo()
  const log = path.join(dir, 'argv.log')
  curc(dir, ['plan', '--json'])
  const r = curc(dir, ['run', '--chunks', 'all'], { FAKE_CLAUDE_ARGV_LOG: log })
  assert.equal(r.code, 5)
  assert.ok(/--yes/.test(r.err))
  assert.ok(!fs.existsSync(log), 'claude must not have been invoked')
  cleanup(dir)
})

test('dry-run builds and proves every pair, launches nothing, leaves no refs', () => {
  const { dir, git } = repo()
  const log = path.join(dir, 'argv.log')
  curc(dir, ['plan', '--json'])
  const r = curc(dir, ['run', '--chunks', 'all', '--dry-run'], { FAKE_CLAUDE_ARGV_LOG: log })
  assert.equal(r.code, 0)
  assert.match(r.out, /claude ultrareview curc\/base-\d+ --json --no-post/)
  assert.ok(!fs.existsSync(log), 'claude must not have been invoked')
  assert.equal(git('for-each-ref', '--format=%(refname:short)', 'refs/heads/curc/').stdout.trim(), '')
  cleanup(dir)
})

test('a full run reviews every chunk, records findings and tidies up after itself', async () => {
  const { dir, git } = repo()
  const L = layout(dir)
  const log = path.join(dir, 'argv.log')

  const plan = JSON.parse(curc(dir, ['plan', '--json', '--max-lines', '40']).out)
  const r = curc(dir, ['run', '--chunks', 'all', '--yes', '--json'], { FAKE_CLAUDE_ARGV_LOG: log })
  assert.equal(r.code, 0)

  const ledger = await settle(L, plan.chunks.map(c => c.id))
  assert.equal(ledger.archive.length, plan.chunks.length)
  assert.equal(ledger.chunks.length, 0, 'reviewed chunks leave the pending plan')

  // Every reviewed blob is recorded, and each review ran inside its own worktree.
  assert.equal(Object.keys(ledger.reviewed).length, 3)
  const invocations = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(invocations.length, plan.chunks.length)
  for (const i of invocations) assert.match(i.cwd, /[/\\]\.claude[/\\]worktrees[/\\]curc-\d+$/)

  const findings = JSON.parse(curc(dir, ['findings', '--json']).out)
  assert.equal(findings.length, plan.chunks.length)
  assert.ok(findings.every(f => f._curc.chunkId && f._curc.sessionUrl))

  // Auto-cleanup: no worktree and no ref survives a completed chunk.
  assert.equal(git('for-each-ref', '--format=%(refname:short)', 'refs/heads/curc/').stdout.trim(), '')
  assert.equal(fs.readdirSync(path.join(dir, '.claude', 'worktrees')).length, 0)
  assert.equal(git('status', '--porcelain').stdout.includes('src/a.js'), false)
  cleanup(dir)
})

test('a failing review is recorded as failed and does not count as coverage', async () => {
  const { dir } = repo()
  const L = layout(dir)
  const plan = JSON.parse(curc(dir, ['plan', '--json']).out)
  curc(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_MODE: 'fail' })
  await settle(L, plan.chunks.map(c => c.id))

  const ledger = readLedger(L)
  assert.equal(ledger.archive?.length ?? 0, 0)
  assert.equal(Object.keys(ledger.reviewed).length, 0, 'a failed review must not mark files reviewed')
  const status = JSON.parse(curc(dir, ['status', '--json']).out)
  assert.ok(status.pending.every(p => p.state === 'failed'))
  cleanup(dir)
})

test('concurrency never exceeds three', async () => {
  const { dir } = tmpRepo(Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`d${i}/f.js`, lines(30, `f${i}`)])
  ))
  const L = layout(dir)
  const log = path.join(dir, 'argv.log')
  const plan = JSON.parse(curc(dir, ['plan', '--json', '--max-lines', '40']).out)
  assert.ok(plan.chunks.length >= 6)
  curc(dir, ['run', '--chunks', 'all', '--yes'], { FAKE_CLAUDE_ARGV_LOG: log, FAKE_CLAUDE_DELAY_MS: '300' })
  await settle(L, plan.chunks.map(c => c.id), 60000)

  const starts = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).at).sort((a, b) => a - b)
  // With a 300ms review, more than three starts inside one window would mean
  // the semaphore leaked.
  for (let i = 0; i + 3 < starts.length; i++) {
    assert.ok(starts[i + 3] - starts[i] >= 250, `four reviews started within ${starts[i + 3] - starts[i]}ms`)
  }
  cleanup(dir)
})
