import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpRepo, lines, cleanup } from './helpers/tmprepo.js'
import { resolveIds, parseSpec } from '../src/prompt.js'

const BIN = fileURLToPath(new URL('../bin/claude-ultrareview-chunked.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.js', import.meta.url))

const runCli = (dir, args, env = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_ULTRAREVIEW_CHUNKED_CLAUDE_BIN: FAKE, NO_COLOR: '1', ...env }
  })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

/* ---- pathspec flags ------------------------------------------------------ */

test('--scope accepts both documented shapes and they agree', () => {
  const { dir } = tmpRepo({ 'src/a.js': lines(5), 'tests/b.js': lines(5), 'lib/c.js': lines(5) })
  const comma = JSON.parse(runCli(dir, ['plan', '--json', '--scope', 'src,tests']).out)
  const repeated = JSON.parse(runCli(dir, ['plan', '--json', '--scope', 'src', '--scope', 'tests']).out)

  // The comma form is what the README has always shown; it used to be read as
  // one pathspec literally named "src,tests" and quietly planned nothing.
  assert.equal(comma.totals.files, 2)
  assert.deepEqual(comma.scope.include, ['src', 'tests'])
  assert.deepEqual(comma.totals, repeated.totals)
  cleanup(dir)
})

/* ---- integer flags ------------------------------------------------------- */

for (const bad of ['0', '-1', 'banana', '2.5', '']) {
  test(`--concurrency ${JSON.stringify(bad)} is refused before anything launches`, () => {
    const { dir } = tmpRepo({ 'a/1.js': lines(20) })
    const log = path.join(dir, 'argv.log')
    runCli(dir, ['plan', '--json'])
    const r = runCli(dir, ['run', '--chunks', 'all', '--yes', '--concurrency', bad], { FAKE_CLAUDE_ARGV_LOG: log })
    assert.equal(r.code, 2)
    assert.match(r.err, /--concurrency/)
    assert.ok(!fs.existsSync(log), 'nothing may be billed for a bad flag')
    cleanup(dir)
  })
}

test('a non-numeric --timeout never reaches the billed command line', () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20) })
  const log = path.join(dir, 'argv.log')
  runCli(dir, ['plan', '--json'])
  const r = runCli(dir, ['run', '--chunks', 'all', '--yes', '--timeout', 'soon'], { FAKE_CLAUDE_ARGV_LOG: log })
  assert.equal(r.code, 2)
  assert.match(r.err, /--timeout/)
  assert.ok(!fs.existsSync(log))
  cleanup(dir)
})

test('--max-files 0 is refused rather than silently ignored', () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20) })
  const r = runCli(dir, ['plan', '--json', '--max-files', '0'])
  assert.equal(r.code, 2)
  assert.match(r.err, /--max-files/)
  cleanup(dir)
})

/* ---- cost ---------------------------------------------------------------- */

test('the cost band honours its overrides and shrugs off a bad one', () => {
  const { dir } = tmpRepo({ 'a/1.js': lines(20, 'a'), 'b/1.js': lines(20, 'b') })
  const tuned = JSON.parse(runCli(dir, ['plan', '--json', '--max-lines', '25'], {
    CLAUDE_ULTRAREVIEW_CHUNKED_COST_LOW: '2', CLAUDE_ULTRAREVIEW_CHUNKED_COST_HIGH: '4'
  }).out)
  assert.deepEqual(tuned.costEstimateUsd, { low: tuned.chunks.length * 2, high: tuned.chunks.length * 4 })

  const junk = JSON.parse(runCli(dir, ['plan', '--json', '--max-lines', '25'], { CLAUDE_ULTRAREVIEW_CHUNKED_COST_LOW: 'abc' }).out)
  assert.equal(junk.costEstimateUsd.low, junk.chunks.length * 5, 'a bad override falls back, never to NaN')
  cleanup(dir)
})

/* ---- id resolution ------------------------------------------------------- */

test('resolveIds returns ids, and names what it did not recognise', () => {
  assert.deepEqual(resolveIds('3,5', [3, 4, 5]), { ids: [3, 5], unknown: [] })
  assert.deepEqual(resolveIds('all', [7, 3]), { ids: [3, 7], unknown: [] })
  assert.deepEqual(resolveIds('4-6', [3, 4, 5]), { ids: [4, 5], unknown: [] })
  assert.deepEqual(resolveIds('9', [3, 4]), { ids: [], unknown: [9] })
  assert.equal(resolveIds('1-99999999', [3]).malformed, true, 'an absurd span is rejected, not walked')
  assert.equal(resolveIds('nonsense', [3]).malformed, true)
  assert.equal(resolveIds('', [3]).malformed, true)
})

test('parseSpec still means positions, for the numbered menu that uses it', () => {
  assert.deepEqual(parseSpec('1,3', 4), [0, 2])
  assert.deepEqual(parseSpec('all', 3), [0, 1, 2])
  assert.deepEqual(parseSpec('2-99', 3), [1, 2], 'a range is clamped rather than walked')
})

/* ---- version ------------------------------------------------------------- */

test('every place that states a version states the same one', () => {
  const at = p => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'))
  const pkg = at('../package.json')
  const plugin = at('../.claude-plugin/plugin.json')
  const market = at('../.claude-plugin/marketplace.json')
  const cli = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }).stdout.trim()

  assert.equal(cli, pkg.version)
  assert.equal(plugin.version, pkg.version)
  assert.equal(market.plugins[0].version, pkg.version)
})

/* ---- the scope picker ---------------------------------------------------- */

test("the scope picker's root bucket selects the root files, not the whole repo", async () => {
  const { includeFor } = await import('../src/app.js')
  const files = [
    { path: 'README.md' }, { path: 'package.json' },
    { path: 'src/a.js' }, { path: 'lib/b.js' }
  ]

  // An empty include means "the whole repo", so dropping '.' turned "only the
  // root files" into its exact opposite.
  assert.deepEqual(includeFor([{ name: '.' }], files), ['README.md', 'package.json'])

  // And picking it alongside a directory used to lose the root files silently.
  assert.deepEqual(includeFor([{ name: 'src' }, { name: '.' }], files),
    ['src', 'README.md', 'package.json'])

  assert.deepEqual(includeFor([{ name: 'src' }, { name: 'lib' }], files), ['src', 'lib'])
})

test('the picked root files really do scope a plan to themselves', () => {
  const { dir } = tmpRepo({ 'README.md': lines(5), 'src/a.js': lines(5), 'lib/b.js': lines(5) })
  const plan = JSON.parse(runCli(dir, ['plan', '--json', '--scope', 'README.md']).out)
  assert.deepEqual(plan.chunks.flatMap(c => c.paths), ['README.md'])
  cleanup(dir)
})
