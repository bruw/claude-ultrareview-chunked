import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { tmpRepo, lines, cleanup } from './helpers/tmprepo.js'
import { layout, ensureDirs } from '../src/paths.js'
import { buildPair, dropPair, pairSize } from '../src/branches.js'
import { git, headSha, treeOf } from '../src/git.js'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const BIN = fileURLToPath(new URL('../bin/curc.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./helpers/fake-claude.js', import.meta.url))
const curcBin = (dir, args) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, CURC_CLAUDE_BIN: FAKE, NO_COLOR: '1' }
})
const L2 = dir => { const l = layout(dir); ensureDirs(l); return l }

function fixture () {
  const { dir, git: g } = tmpRepo({
    'src/a.js': lines(20, 'a'),
    'src/b.js': lines(20, 'b'),
    'lib/c.js': lines(20, 'c')
  })
  const L = layout(dir)
  ensureDirs(L)
  return { dir, L, g }
}

const chunkOf = (L, paths) => paths.map(p => ({ path: p, blob: git(['rev-parse', `HEAD:${p}`], { cwd: L.root }), lines: 20 }))

test('the pair diffs to exactly the chunk, as pure additions', () => {
  const { dir, L } = fixture()
  const snapshot = headSha(dir)
  const snapshotTree = treeOf(dir, snapshot)
  const files = chunkOf(L, ['src/a.js', 'src/b.js'])

  const { base, chunk } = buildPair(L, { id: 1, snapshot, snapshotTree, files })

  assert.equal(git(['merge-base', chunk, base], { cwd: dir }), base)
  assert.equal(git(['rev-parse', `${chunk}^{tree}`], { cwd: dir }), snapshotTree)
  assert.deepEqual(
    git(['diff', '--name-only', base, chunk], { cwd: dir }).split('\n').sort(),
    ['src/a.js', 'src/b.js']
  )
  assert.equal(git(['diff', '--name-only', '--diff-filter=a', base, chunk], { cwd: dir }), '')
  assert.deepEqual(pairSize(L, 1), { files: 2, lines: 40 })

  // The base keeps everything outside the chunk, which is what gives the
  // reviewer its context.
  assert.equal(git(['cat-file', '-t', `${base}:lib/c.js`], { cwd: dir }), 'blob')
  cleanup(dir)
})

test('the base is an orphan, so the chunk is the entire history it sees', () => {
  const { dir, L } = fixture()
  const snapshot = headSha(dir)
  const { base, chunk } = buildPair(L, {
    id: 1, snapshot, snapshotTree: treeOf(dir, snapshot), files: chunkOf(L, ['src/a.js'])
  })
  assert.equal(git(['rev-list', '--count', base], { cwd: dir }), '1')
  assert.equal(git(['rev-list', '--count', chunk], { cwd: dir }), '2')
  cleanup(dir)
})

test('the caller index, working tree and HEAD are untouched — even when dirty', () => {
  const { dir, L, g } = fixture()

  // Leave the repo in a realistically messy state first.
  fs.writeFileSync(path.join(dir, 'src/a.js'), lines(20, 'a') + 'unstaged edit\n')
  fs.writeFileSync(path.join(dir, 'staged.js'), 'staged\n')
  fs.writeFileSync(path.join(dir, 'untracked.js'), 'untracked\n')
  g('add', 'staged.js')

  const indexPath = path.join(dir, '.git', 'index')
  const before = {
    index: crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex'),
    status: g('status', '--porcelain').stdout,
    head: headSha(dir),
    branch: g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(),
    a: fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8')
  }

  const snapshot = headSha(dir)
  buildPair(L, { id: 7, snapshot, snapshotTree: treeOf(dir, snapshot), files: chunkOf(L, ['src/a.js', 'lib/c.js']) })

  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex'), before.index,
    'the git index was modified')
  assert.equal(g('status', '--porcelain').stdout, before.status, 'the working tree changed')
  assert.equal(headSha(dir), before.head, 'HEAD moved')
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), before.branch, 'the branch changed')
  assert.equal(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8'), before.a, 'an unstaged edit was lost')
  cleanup(dir)
})

test('the chunk reviews HEAD, not the dirty working tree', () => {
  const { dir, L } = fixture()
  const snapshot = headSha(dir)
  const files = chunkOf(L, ['src/a.js'])
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'totally different\n')

  const { base, chunk } = buildPair(L, { id: 1, snapshot, snapshotTree: treeOf(dir, snapshot), files })
  const reviewed = git(['show', `${chunk}:src/a.js`], { cwd: dir })
  assert.ok(reviewed.startsWith('a line 0'), 'the chunk should carry the committed content')
  assert.ok(!reviewed.includes('totally different'))
  assert.equal(git(['merge-base', chunk, base], { cwd: dir }), base)
  cleanup(dir)
})

test('building the same chunk twice yields the same commits', () => {
  const { dir, L } = fixture()
  const snapshot = headSha(dir)
  const args = { id: 1, snapshot, snapshotTree: treeOf(dir, snapshot), files: chunkOf(L, ['src/a.js']) }
  const first = buildPair(L, args)
  const second = buildPair(L, args)
  assert.deepEqual(first, second)
  cleanup(dir)
})

test('dropPair removes only the curc namespace', () => {
  const { dir, L, g } = fixture()
  const snapshot = headSha(dir)
  buildPair(L, { id: 3, snapshot, snapshotTree: treeOf(dir, snapshot), files: chunkOf(L, ['src/a.js']) })
  g('branch', 'feature/keep-me')
  dropPair(L, 3)
  const branches = g('for-each-ref', '--format=%(refname:short)', 'refs/heads/').stdout.split('\n')
  assert.ok(!branches.includes('curc/base-0003'))
  assert.ok(branches.includes('feature/keep-me'))
  cleanup(dir)
})

/**
 * `clean` counted from the repository and deleted from the ledger, so the refs
 * most in need of cleaning — the ones a re-plan orphaned, which no ledger entry
 * points at any more — were reported and then left exactly where they were.
 */
test('clean removes the stray refs it counts, not just the ones the ledger knows', () => {
  const { dir, g } = fixture()
  const snapshot = headSha(dir)
  buildPair(L2(dir), { id: 1, snapshot, snapshotTree: treeOf(dir, snapshot), files: chunkOf(L2(dir), ['src/a.js']) })
  // A pair from an earlier numbering, of the kind a re-plan leaves behind.
  g('branch', 'curc/base-9999', 'HEAD')
  g('branch', 'curc/chunk-9999', 'HEAD')
  g('branch', 'feature/keep-me')

  const r = curcBin(dir, ['clean', '--yes'])
  assert.equal(r.status, 0)
  assert.equal(g('for-each-ref', '--format=%(refname:short)', 'refs/heads/curc/').stdout.trim(), '')
  assert.match(g('for-each-ref', '--format=%(refname:short)', 'refs/heads/').stdout, /feature\/keep-me/)
  cleanup(dir)
})

test('clean reports nothing to do when there is nothing, rather than "cleaned"', () => {
  const { dir } = fixture()
  const r = curcBin(dir, ['clean', '--yes'])
  assert.equal(r.status, 0)
  assert.match(r.stderr, /nothing to clean/)
  cleanup(dir)
})

test('a branch named curc is caught before any pair is built', () => {
  const { dir, g } = fixture()
  g('branch', 'curc')
  const r = curcBin(dir, ['plan', '--json'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /blocks the `curc\/` namespace/)
  assert.equal(g('for-each-ref', '--format=%(refname:short)', 'refs/heads/curc/').stdout.trim(), '')
  cleanup(dir)
})

test('the stray-ref check runs for plan, not only when claude is probed', async () => {
  const { dir, g } = fixture()
  g('branch', 'curc/base-9999', 'HEAD')
  // plan asks for the repository checks only, and used to skip this entirely.
  const { preflight } = await import('../src/preflight.js')
  const pre = preflight(dir, { claudeChecks: false })
  const refs = pre.checks.find(c => c.name === 'curc/ refs')
  assert.ok(refs, 'the check must be present without the claude probes')
  assert.equal(refs.ok, false)
  assert.match(refs.remedy, /curc clean --yes/)
  cleanup(dir)
})
